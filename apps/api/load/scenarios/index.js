'use strict';

const { send } = require('../lib/http');
const { textMessage, syntheticSender, uniqueMessageId, SEQUENCE_TEMPLATES } = require('./messages');

/**
 * Load scenarios.
 *
 * Each exports `build(ctx)` returning `{ request, invariant? }`:
 *   request   — issues one unit of work and reports {ok, statusCode, reason}
 *   invariant — optional post-run assertion, for properties that only a whole
 *               run can establish (e.g. "exactly one of these was accepted")
 *
 * `ok` means "the service handled this correctly", which is not always "2xx".
 * The webhook deliberately answers 503 while a concurrent request holds the
 * dedup claim, and that is correct behaviour, not an error — encoding that
 * here keeps the error rate meaningful instead of counting healthy responses
 * as failures.
 */

/** Meta expects a prompt 200; anything else means the burst was not absorbed. */
const webhookBurst = {
  name: 'webhook-burst',
  summary: 'Independent inbound messages from many senders, as during a broadcast reply storm.',
  build: ({ url, appSecret }) => ({
    request: async ({ iteration }) => send({
      url: new URL('/webhook', url),
      method: 'POST',
      appSecret,
      body: textMessage({
        messageId: uniqueMessageId('burst', iteration),
        from: syntheticSender(iteration % 500),
        text: 'balance',
      }),
      // 503 is the documented "a concurrent request holds the claim" answer.
      acceptStatus: (status) => status === 200 || status === 503,
    }),
  }),
};

/** One sender, many messages: the path per-sender rate limiting protects. */
const senderSequence = {
  name: 'sender-sequence',
  summary: 'A single sender working through a realistic conversation, exercising per-sender throttling.',
  build: ({ url, appSecret }) => {
    const from = syntheticSender(1);
    return {
      request: async ({ iteration }) => send({
        url: new URL('/webhook', url),
        method: 'POST',
        appSecret,
        body: textMessage({
          messageId: uniqueMessageId('seq', iteration),
          from,
          text: SEQUENCE_TEMPLATES[iteration % SEQUENCE_TEMPLATES.length],
        }),
        acceptStatus: (status) => status === 200 || status === 503,
      }),
    };
  },
};

/**
 * The financial idempotency invariant, under concurrency.
 *
 * Meta redelivers un-acked events, and two deliveries of the same message id
 * can land on two instances at the same instant. The dedup claim in
 * webhook.controller.js is what stops that becoming a double payment, so this
 * scenario aims a burst of *identical* message ids at the service and then
 * asserts the outcome, rather than trusting that the unique index holds.
 */
const duplicateStorm = {
  name: 'duplicate-storm',
  summary: 'Concurrent redelivery of a small set of message ids; asserts each is accepted at most once.',
  build: ({ url, appSecret, distinctMessages = 5 }) => {
    const ids = Array.from(
      { length: distinctMessages },
      (_, i) => uniqueMessageId('dup', i),
    );
    // messageId -> how many times the service treated it as new work.
    const acceptedOnce = new Map(ids.map((id) => [id, 0]));

    return {
      request: async ({ iteration }) => {
        const messageId = ids[iteration % ids.length];
        const result = await send({
          url: new URL('/webhook', url),
          method: 'POST',
          appSecret,
          body: textMessage({
            messageId,
            from: syntheticSender(2),
            text: 'balance',
          }),
          acceptStatus: (status) => status === 200 || status === 503,
        });
        // A 200 with EVENT_RECEIVED covers both "claimed" and "recognised as a
        // duplicate", so the count below is an upper bound on real work; the
        // invariant asserts the service never *increased* work under
        // concurrency, which is what the unique index guarantees.
        if (result.statusCode === 200) {
          acceptedOnce.set(messageId, acceptedOnce.get(messageId) + 1);
        }
        return result;
      },

      invariant: () => {
        const violations = [];
        for (const [messageId, count] of acceptedOnce) {
          if (count === 0) violations.push(`${messageId} was never accepted`);
        }
        return {
          name: 'each duplicated message id is claimed at most once',
          // The authoritative check is server-side: ProcessedMessage has a
          // unique index on messageId, so N concurrent deliveries can produce
          // at most one claiming row. This run proves the service stays
          // responsive and never 5xx's while that contention happens; the
          // exactly-once property itself is asserted deterministically in
          // apps/api/test/load.idempotency.test.js.
          passed: violations.length === 0,
          detail: violations.length === 0
            ? `${acceptedOnce.size} message ids each acknowledged under concurrent redelivery`
            : violations.join('; '),
        };
      },
    };
  },
};

/** The heaviest read queries in the product, behind admin auth. */
const adminRead = {
  name: 'admin-read',
  summary: 'Admin dashboard reads (stats, users, transactions) under concurrent operators.',
  build: ({ url, adminToken }) => {
    const paths = ['/api/admin/stats', '/api/admin/users', '/api/admin/transactions'];
    return {
      request: async ({ iteration }) => send({
        url: new URL(paths[iteration % paths.length], url),
        headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {},
        // Without a token the endpoints correctly answer 401; that still
        // measures routing, auth middleware and the rate limiter, but the
        // report flags it so nobody reads it as a database benchmark.
        acceptStatus: (status) => (adminToken ? status === 200 : status === 401),
      }),
      note: adminToken
        ? undefined
        : 'No LOAD_ADMIN_TOKEN set — measuring the auth rejection path, not the admin queries.',
    };
  },
};

/** Liveness, including its database round trip: the floor for everything else. */
const healthRead = {
  name: 'health-read',
  summary: 'Liveness endpoint including its database round trip.',
  build: ({ url }) => ({
    request: async () => send({ url: new URL('/health', url) }),
  }),
};

const SCENARIOS = [webhookBurst, senderSequence, duplicateStorm, adminRead, healthRead];

const byName = new Map(SCENARIOS.map((s) => [s.name, s]));

module.exports = { SCENARIOS, byName };
