#!/usr/bin/env node
'use strict';

const { parseArgs, usage, UsageError } = require('./lib/cli');
const { resolveTarget, TargetRefused } = require('./lib/target');
const { byName } = require('./scenarios');
const { run } = require('./lib/runner');
const { evaluate } = require('./lib/budgets');
const { sampleQueueLag } = require('./lib/queueLag');
const { renderText } = require('./lib/report');

/**
 * Entry point for `npm run load`.
 *
 * Exits non-zero when any scenario breaches its budget or violates its
 * invariant, so this is usable as a gate in a scheduled capacity job rather
 * than only as something a human reads.
 */
const main = async (argv) => {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const { url, isLocal } = resolveTarget({ target: options.target });
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const adminToken = process.env.LOAD_ADMIN_TOKEN;
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL;

  if (!options.json) {
    process.stdout.write(`\nSendAm load harness → ${url.origin}${isLocal ? ' (local)' : ' (REMOTE)'}\n`);
    if (!appSecret) {
      process.stdout.write(
        '  WHATSAPP_APP_SECRET is unset: webhook payloads are sent unsigned, which the\n'
        + '  service only accepts outside production. Numbers exclude signature verification.\n',
      );
    }
  }

  const results = [];
  let allPassed = true;

  for (const name of options.scenarios) {
    const scenario = byName.get(name);
    const built = scenario.build({ url, appSecret, adminToken });

    const summary = await run({
      request: built.request,
      concurrency: options.concurrency,
      durationMs: options.durationMs,
      iterations: options.iterations,
      warmupIterations: options.warmupIterations,
    });

    const queueLag = await sampleQueueLag({ redisUrl });
    const invariant = built.invariant?.();
    const evaluation = evaluate(name, summary, queueLag);
    const passed = evaluation.passed && (invariant?.passed ?? true);
    if (!passed) allPassed = false;

    const result = { scenario: name, summary, evaluation, queueLag, invariant, passed };
    results.push(result);

    if (!options.json) {
      process.stdout.write(renderText({
        scenario,
        summary,
        evaluation,
        queueLag,
        invariant,
        meta: { target: url.origin, note: built.note },
      }));
    }
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      target: url.origin,
      startedAt: new Date().toISOString(),
      concurrency: options.concurrency,
      passed: allPassed,
      results,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Overall: ${allPassed ? 'PASS' : 'FAIL'}\n\n`);
  }

  return allPassed ? 0 : 1;
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      if (error instanceof UsageError || error instanceof TargetRefused) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`Load run failed: ${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { main };
