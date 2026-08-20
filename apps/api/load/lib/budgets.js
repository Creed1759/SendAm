'use strict';

/**
 * Service-level objectives per scenario, and the pass/fail evaluation.
 *
 * These are budgets, not predictions: a run that comes in under them is
 * acceptable, and a run that breaches one is a regression to investigate
 * before shipping. Every number is annotated with the reasoning that produced
 * it so a future maintainer can argue with the reasoning rather than guess at
 * the intent. Re-derive them on real hardware (see docs/LOAD-TESTING.md) —
 * the defaults are sized for the documented reference environment.
 */

/**
 * The webhook path is the one Meta itself measures. Meta retries an event that
 * is not acknowledged quickly and will mark a webhook unhealthy if that keeps
 * happening, so the acknowledgement budget is set well inside Meta's tolerance
 * rather than at the edge of it. The endpoint only claims idempotency and
 * enqueues, so p99 is dominated by one INSERT plus one Redis round trip.
 */
const BUDGETS = {
  'webhook-burst': {
    description: 'Meta webhook delivery burst — signature check, dedup claim, enqueue.',
    maxP95Ms: 250,
    maxP99Ms: 500,
    maxErrorRate: 0.001,
    minThroughputRps: 50,
  },
  'sender-sequence': {
    description: 'One sender issuing a realistic message sequence, exercising per-sender rate limiting.',
    maxP95Ms: 300,
    maxP99Ms: 600,
    // Per-sender throttling deliberately drops excess messages, so this
    // scenario tolerates a higher non-2xx share by design.
    maxErrorRate: 0.02,
    minThroughputRps: 10,
  },
  'duplicate-storm': {
    description: 'Concurrent redelivery of one message id — the financial idempotency invariant.',
    maxP95Ms: 300,
    maxP99Ms: 600,
    maxErrorRate: 0.0,
    minThroughputRps: 20,
  },
  'admin-read': {
    description: 'Admin dashboard reads — the heaviest database queries in the product.',
    maxP95Ms: 400,
    maxP99Ms: 800,
    maxErrorRate: 0.001,
    minThroughputRps: 20,
  },
  'health-read': {
    description: 'Liveness path, including its database round trip. The floor for all other numbers.',
    maxP95Ms: 100,
    maxP99Ms: 200,
    maxErrorRate: 0.0,
    minThroughputRps: 100,
  },
};

/**
 * Queue lag budget. Applied only when a Redis URL is configured — without it
 * the harness cannot observe the queue and reports lag as unmeasured rather
 * than as zero, which would be a false pass.
 */
const QUEUE_BUDGET = {
  maxDepth: 500,
  maxOldestJobAgeMs: 30000,
};

const evaluate = (scenarioName, summary, queueLag) => {
  const budget = BUDGETS[scenarioName];
  if (!budget) return { scenario: scenarioName, passed: true, checks: [], unbudgeted: true };

  const checks = [];
  const check = (name, actual, limit, comparator, unit) => {
    const passed = actual === null ? true : comparator(actual, limit);
    checks.push({ name, actual, limit, unit, passed, skipped: actual === null });
  };

  const atMost = (actual, limit) => actual <= limit;
  const atLeast = (actual, limit) => actual >= limit;

  check('p95 latency', summary.latencyMs.p95, budget.maxP95Ms, atMost, 'ms');
  check('p99 latency', summary.latencyMs.p99, budget.maxP99Ms, atMost, 'ms');
  check('error rate', summary.errorRate, budget.maxErrorRate, atMost, 'fraction');
  check('throughput', summary.throughputRps, budget.minThroughputRps, atLeast, 'rps');

  if (queueLag?.measured) {
    check('queue depth', queueLag.depth, QUEUE_BUDGET.maxDepth, atMost, 'jobs');
    check('oldest job age', queueLag.oldestJobAgeMs, QUEUE_BUDGET.maxOldestJobAgeMs, atMost, 'ms');
  }

  return {
    scenario: scenarioName,
    description: budget.description,
    passed: checks.every((c) => c.passed),
    checks,
  };
};

module.exports = { BUDGETS, QUEUE_BUDGET, evaluate };
