const logger = require('../utils/logger');
const { increment } = require('../observability/metrics');

// Plain open-source BullMQ (this repo pins "bullmq": "^5.79.3", not BullMQ
// Pro) has no built-in "group"/ordering primitive, so per-sender ordering is
// implemented here at the processor level.
//
// Design (see issue #157):
//  - A per-sender advisory lock ensures at most one job per canonical sender
//    is ever executing at a time, so same-sender jobs cannot race each other
//    even though the Worker itself runs many jobs concurrently.
//  - A per-sender cursor (last processed provider timestamp + message id)
//    rejects any job whose provider timestamp is not newer than what has
//    already been applied for that sender. This is what keeps a delayed or
//    duplicated delivery from reversing a confirmed/cancelled payment: by
//    the time a stale "confirm" redelivery is picked up, a later "cancel"
//    has already advanced the cursor past it, so the stale job is dropped
//    before it ever reaches assistant.service.js.
//  - A job that finds its sender's lock held does not occupy a worker slot
//    waiting: it re-delays itself (BullMQ's documented moveToDelayed +
//    DelayedError pattern) and frees the slot for unrelated senders, which
//    is what keeps one blocked customer from stalling everybody else.
//
// The lock/cursor store defaults to an in-memory Map. That is correct for
// this codebase today because apps/api/src/worker.js runs a single Node
// process per deployment (see registerJobs/startWorker) — there is no
// cross-process fan-out to coordinate. If the worker is ever horizontally
// scaled to multiple processes/machines, this store must be swapped for a
// shared backend (Redis or a Postgres `SenderCursor` table with row locks);
// the `store` option exists specifically so that swap doesn't require
// touching this module's ordering logic, only the store implementation.

const DEFAULT_REQUEUE_DELAY_MS = 250;
const DEFAULT_MAX_REQUEUES = 40;

const canonicalSender = (from) => String(from ?? '').trim();

const createInMemoryOrderingStore = () => {
  const locks = new Set();
  const cursors = new Map();
  return {
    tryAcquire(key) {
      if (locks.has(key)) return false;
      locks.add(key);
      return true;
    },
    release(key) {
      locks.delete(key);
    },
    getCursor(key) {
      return cursors.get(key) || null;
    },
    // Only advances when the new message is strictly newer, so a late/duplicate
    // arrival can never rewind what "already processed" means for this sender.
    advanceCursor(key, cursor) {
      const existing = cursors.get(key);
      if (existing && existing.timestamp > cursor.timestamp) return false;
      if (existing && existing.timestamp === cursor.timestamp && existing.messageId === cursor.messageId) return false;
      cursors.set(key, cursor);
      return true;
    },
    reset() {
      locks.clear();
      cursors.clear();
    },
  };
};

/**
 * Pure decision function over the store's current state — deliberately has
 * no dependency on BullMQ, Redis, or Prisma so it can be unit tested with a
 * fake store. See apps/api/test/ordering.service.test.js.
 */
const evaluateOrdering = (store, senderKey, providerTimestamp, messageId) => {
  const cursor = store.getCursor(senderKey);
  if (cursor) {
    if (providerTimestamp < cursor.timestamp) return { action: 'stale', reason: 'older-than-cursor' };
    if (providerTimestamp === cursor.timestamp && messageId && messageId === cursor.messageId) {
      return { action: 'stale', reason: 'duplicate' };
    }
  }
  if (!store.tryAcquire(senderKey)) return { action: 'requeue' };
  return { action: 'process' };
};

/**
 * Wrap a BullMQ-style job processor `(job, token) => Promise<result>` with
 * per-sender ordering. Returns a processor with the same signature, so it
 * can be passed straight to queue.service's registerProcessor.
 */
const withOrdering = (processor, options = {}) => {
  const {
    store = createInMemoryOrderingStore(),
    requeueDelayMs = DEFAULT_REQUEUE_DELAY_MS,
    maxRequeues = DEFAULT_MAX_REQUEUES,
    senderOf = (job) => canonicalSender(job.data?.from),
    // Provider (Meta) timestamps arrive as unix seconds; normalize to ms so
    // they're comparable with Date.now()-based fallbacks. Messages without a
    // provider timestamp (should not happen in production, but webhook
    // payloads are attacker-influenced input) fall back to enqueue time so
    // ordering degrades to FIFO instead of throwing.
    timestampOf = (job) => {
      const provided = Number(job.data?.providerTimestamp);
      if (Number.isFinite(provided)) return provided;
      const enqueuedAt = Number(job.timestamp);
      return Number.isFinite(enqueuedAt) ? enqueuedAt : Date.now();
    },
    messageIdOf = (job) => job.data?.whatsappMessageId || job.id,
  } = options;

  return async (job, token) => {
    const senderKey = senderOf(job);
    // Nothing to key ordering on (shouldn't happen for real WhatsApp
    // webhooks) — fail open rather than wedge the message forever.
    if (!senderKey) return processor(job, token);

    const providerTimestamp = timestampOf(job);
    const messageId = messageIdOf(job);
    const isDelayableBullMqJob = typeof job.moveToDelayed === 'function';
    let attempt = isDelayableBullMqJob ? Number(job.data?.__orderingRequeueCount || 0) : 0;

    for (;;) {
      const decision = evaluateOrdering(store, senderKey, providerTimestamp, messageId);

      if (decision.action === 'stale') {
        increment('sendam_whatsapp_ordering_violations_total', { reason: decision.reason });
        logger.warn('whatsapp_message_ordering_stale_drop', {
          senderKey, providerTimestamp, messageId, reason: decision.reason,
        });
        return { skipped: true, reason: decision.reason };
      }

      if (decision.action === 'process') {
        // Queue-age is recorded generically by queue.service's
        // registerProcessor on every worker pickup (including each
        // ordering-requeue cycle), so it is not duplicated here.
        try {
          const result = await processor(job, token);
          store.advanceCursor(senderKey, { timestamp: providerTimestamp, messageId });
          return result;
        } finally {
          // Always release, including on failure/retry — a job that throws
          // must not leave its sender permanently locked out.
          store.release(senderKey);
        }
      }

      // decision.action === 'requeue': another job for this sender is
      // in-flight. Never process concurrently and never skip — just wait.
      attempt += 1;
      if (attempt > maxRequeues) {
        // The in-flight job is taking unusually long. Keep waiting (never
        // force a takeover — that would risk reordering or double
        // processing) but surface it so it can be alerted on.
        logger.error('whatsapp_message_ordering_requeue_exhausted', { senderKey, messageId, attempt });
        increment('sendam_whatsapp_ordering_violations_total', { reason: 'requeue-exhausted' });
      }

      if (isDelayableBullMqJob && token) {
        // BullMQ v5's supported "give back the worker slot and try later"
        // mechanism: move the job to the delayed state and throw
        // DelayedError so BullMQ does not count this as a failed attempt.
        if (typeof job.updateData === 'function') {
          await job.updateData({ ...job.data, __orderingRequeueCount: attempt });
        }
        // Required lazily: only reachable when bullmq is installed, since
        // job.moveToDelayed only exists on real BullMQ Job instances.
        const { DelayedError } = require('bullmq');
        await job.moveToDelayed(Date.now() + requeueDelayMs, token);
        throw new DelayedError();
      }

      // Inline/no-Redis fallback (dev, tests): there is no worker-slot
      // concept to free, so just wait and re-check.
      await new Promise((resolve) => setTimeout(resolve, requeueDelayMs));
    }
  };
};

module.exports = {
  canonicalSender,
  createInMemoryOrderingStore,
  evaluateOrdering,
  withOrdering,
  DEFAULT_REQUEUE_DELAY_MS,
  DEFAULT_MAX_REQUEUES,
};
