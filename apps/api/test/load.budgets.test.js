const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluate, BUDGETS, QUEUE_BUDGET } = require('../load/lib/budgets');

const summaryWith = (overrides = {}) => ({
  requests: 1000,
  ok: 1000,
  failed: 0,
  errorRate: 0,
  throughputRps: 200,
  latencyMs: { min: 1, p50: 20, p95: 80, p99: 150, max: 400 },
  statusCounts: { 200: 1000 },
  errorsByReason: {},
  ...overrides,
});

test('a run inside every budget passes', () => {
  const result = evaluate('webhook-burst', summaryWith());
  assert.equal(result.passed, true);
  assert.ok(result.checks.every((c) => c.passed));
});

test('a p99 breach fails the run and names the offending check', () => {
  const result = evaluate('webhook-burst', summaryWith({
    latencyMs: { min: 1, p50: 20, p95: 80, p99: 9000, max: 9000 },
  }));
  assert.equal(result.passed, false);
  const failed = result.checks.filter((c) => !c.passed).map((c) => c.name);
  assert.deepEqual(failed, ['p99 latency']);
});

test('throughput is a floor, not a ceiling', () => {
  const tooSlow = evaluate('webhook-burst', summaryWith({ throughputRps: 1 }));
  assert.equal(tooSlow.passed, false);

  const fast = evaluate('webhook-burst', summaryWith({ throughputRps: 5000 }));
  assert.equal(fast.passed, true);
});

test('an error rate above budget fails even when latency looks healthy', () => {
  const result = evaluate('webhook-burst', summaryWith({ errorRate: 0.05, failed: 50 }));
  assert.equal(result.passed, false);
  assert.ok(result.checks.find((c) => c.name === 'error rate' && !c.passed));
});

test('duplicate-storm tolerates no errors at all', () => {
  // Idempotency contention must never surface as a failed request.
  assert.equal(BUDGETS['duplicate-storm'].maxErrorRate, 0);
  const result = evaluate('duplicate-storm', summaryWith({ errorRate: 0.001, failed: 1 }));
  assert.equal(result.passed, false);
});

test('queue lag is only checked when it was actually measured', () => {
  const unmeasured = evaluate('webhook-burst', summaryWith(), { measured: false, reason: 'no REDIS_URL' });
  assert.ok(!unmeasured.checks.some((c) => c.name === 'queue depth'));

  const breaching = evaluate('webhook-burst', summaryWith(), {
    measured: true,
    depth: QUEUE_BUDGET.maxDepth + 1,
    oldestJobAgeMs: 0,
  });
  assert.equal(breaching.passed, false);
  assert.ok(breaching.checks.find((c) => c.name === 'queue depth' && !c.passed));
});

test('an unmeasured percentile is skipped rather than counted as a pass at zero', () => {
  const result = evaluate('webhook-burst', summaryWith({
    latencyMs: { min: null, p50: null, p95: null, p99: null, max: null },
  }));
  const p95 = result.checks.find((c) => c.name === 'p95 latency');
  assert.equal(p95.skipped, true);
});

test('every scenario budget defines all four core limits', () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    for (const key of ['maxP95Ms', 'maxP99Ms', 'maxErrorRate', 'minThroughputRps']) {
      assert.equal(typeof budget[key], 'number', `${name}.${key}`);
    }
    assert.ok(budget.description, `${name} documents what it covers`);
  }
});
