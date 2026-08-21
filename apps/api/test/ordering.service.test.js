const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const injectMock = (relativeFromSrc, exports) => {
  const filename = path.resolve(__dirname, '../src', `${relativeFromSrc}.js`);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

injectMock('utils/logger', { info: () => {}, warn: () => {}, error: () => {} });

const {
  createInMemoryOrderingStore,
  evaluateOrdering,
  withOrdering,
} = require('../src/queues/ordering.service');

// ---- evaluateOrdering: pure decision function -----------------------------

test('evaluateOrdering lets the first message for a sender through', () => {
  const store = createInMemoryOrderingStore();
  const decision = evaluateOrdering(store, '+123', 1000, 'msg-1');
  assert.equal(decision.action, 'process');
});

test('evaluateOrdering requeues a second message while the first sender lock is held', () => {
  const store = createInMemoryOrderingStore();
  assert.equal(evaluateOrdering(store, '+123', 1000, 'msg-1').action, 'process');
  // Lock for +123 is now held (evaluateOrdering itself calls tryAcquire).
  assert.equal(evaluateOrdering(store, '+123', 1001, 'msg-2').action, 'requeue');
});

test('evaluateOrdering does not requeue messages from a different sender', () => {
  const store = createInMemoryOrderingStore();
  assert.equal(evaluateOrdering(store, '+123', 1000, 'msg-1').action, 'process');
  assert.equal(evaluateOrdering(store, '+456', 1000, 'msg-2').action, 'process');
});

test('evaluateOrdering marks a message older than the cursor as stale', () => {
  const store = createInMemoryOrderingStore();
  store.advanceCursor('+123', { timestamp: 5000, messageId: 'later' });
  const decision = evaluateOrdering(store, '+123', 4000, 'earlier');
  assert.equal(decision.action, 'stale');
  assert.equal(decision.reason, 'older-than-cursor');
});

test('evaluateOrdering marks an exact duplicate as stale', () => {
  const store = createInMemoryOrderingStore();
  store.advanceCursor('+123', { timestamp: 5000, messageId: 'dup' });
  const decision = evaluateOrdering(store, '+123', 5000, 'dup');
  assert.equal(decision.action, 'stale');
  assert.equal(decision.reason, 'duplicate');
});

test('advanceCursor refuses to move the cursor backwards', () => {
  const store = createInMemoryOrderingStore();
  assert.equal(store.advanceCursor('+123', { timestamp: 5000, messageId: 'b' }), true);
  assert.equal(store.advanceCursor('+123', { timestamp: 4000, messageId: 'a' }), false);
  assert.deepEqual(store.getCursor('+123'), { timestamp: 5000, messageId: 'b' });
});

// ---- withOrdering: end-to-end processor wrapping ---------------------------

const buildJob = ({ id, from, providerTimestamp, whatsappMessageId }) => ({
  id,
  data: { from, providerTimestamp, whatsappMessageId },
  timestamp: providerTimestamp,
});

test('withOrdering processes same-sender jobs strictly in order, one at a time', async () => {
  const store = createInMemoryOrderingStore();
  const processedOrder = [];
  const releases = new Map();

  const processor = async (job) => new Promise((resolve) => {
    releases.set(job.id, () => {
      processedOrder.push(job.id);
      resolve(`done-${job.id}`);
    });
  });

  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const jobA = buildJob({ id: 'a', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'a' });
  const jobB = buildJob({ id: 'b', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'b' });

  const pendingA = ordered(jobA);
  // Give the requeue loop a moment to observe the lock is held before B's
  // processor could possibly run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const pendingB = ordered(jobB);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processedOrder.length, 0, 'neither job should complete until released');

  releases.get('a')();
  await pendingA;

  // B's requeue loop polls every requeueDelayMs; wait for it to notice the
  // now-freed lock and actually invoke the processor before releasing it.
  const deadline = Date.now() + 2000;
  while (!releases.has('b')) {
    if (Date.now() > deadline) throw new Error('timed out waiting for job b to start processing');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  releases.get('b')();
  await pendingB;

  assert.deepEqual(processedOrder, ['a', 'b']);
});

test('withOrdering lets different senders run without waiting on each other', async () => {
  const store = createInMemoryOrderingStore();
  let concurrentCount = 0;
  let maxConcurrent = 0;

  const processor = async () => {
    concurrentCount += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrentCount);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrentCount -= 1;
    return 'ok';
  };

  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const jobA = buildJob({ id: 'a', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'a' });
  const jobB = buildJob({ id: 'b', from: '+456', providerTimestamp: 1000, whatsappMessageId: 'b' });

  await Promise.all([ordered(jobA), ordered(jobB)]);
  assert.equal(maxConcurrent, 2);
});

test('withOrdering drops a stale redelivery instead of reprocessing it', async () => {
  const store = createInMemoryOrderingStore();
  const seen = [];
  const processor = async (job) => { seen.push(job.id); return 'ok'; };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const confirm = buildJob({ id: 'confirm', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'confirm' });
  const cancel = buildJob({ id: 'cancel', from: '+123', providerTimestamp: 3000, whatsappMessageId: 'cancel' });
  // A late redelivery of the already-superseded "confirm" event — it must
  // not reprocess and reverse the newer "cancel" that already applied.
  const staleReplay = buildJob({ id: 'confirm', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'confirm' });
  // An exact duplicate of the newest applied event (e.g. a webhook retry).
  const exactDuplicate = buildJob({ id: 'cancel', from: '+123', providerTimestamp: 3000, whatsappMessageId: 'cancel' });

  await ordered(confirm);
  await ordered(cancel);
  const replayResult = await ordered(staleReplay);
  const duplicateResult = await ordered(exactDuplicate);

  assert.deepEqual(seen, ['confirm', 'cancel']);
  assert.equal(replayResult.skipped, true);
  assert.equal(replayResult.reason, 'older-than-cursor');
  assert.equal(duplicateResult.skipped, true);
  assert.equal(duplicateResult.reason, 'duplicate');
});

test('withOrdering releases the sender lock even when the processor throws, so later messages are not wedged', async () => {
  const store = createInMemoryOrderingStore();
  const processor = async (job) => {
    if (job.id === 'boom') throw new Error('processing failed');
    return 'ok';
  };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const failing = buildJob({ id: 'boom', from: '+123', providerTimestamp: 1000, whatsappMessageId: 'boom' });
  const next = buildJob({ id: 'next', from: '+123', providerTimestamp: 2000, whatsappMessageId: 'next' });

  await assert.rejects(() => ordered(failing), /processing failed/);
  const result = await ordered(next);
  assert.equal(result, 'ok');
});

test('withOrdering fails open (processes immediately) when a job has no sender to key on', async () => {
  const store = createInMemoryOrderingStore();
  let calls = 0;
  const processor = async () => { calls += 1; return 'ok'; };
  const ordered = withOrdering(processor, { store, requeueDelayMs: 5 });

  const job = { id: 'no-sender', data: {}, timestamp: 1000 };
  const result = await ordered(job);
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});
