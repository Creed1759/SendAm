# Load testing and capacity limits

SendAm moves money on a path that starts with a webhook Meta will retry and
ends with a Stellar submission that must never happen twice. This document
describes how to generate repeatable load against the payment-critical paths,
what the pass/fail budgets are, and which signals mean "add capacity" rather
than "tune a query".

The harness lives in `apps/api/load/` and has no dependencies beyond what the
API already installs.

## Running it

```bash
# Everything, against a locally running API, with defaults
npm run load

# One scenario, heavier, for longer
npm run load -- --scenario webhook-burst --concurrency 100 --duration 60

# A fixed request count instead of a duration, for run-to-run comparison
npm run load -- --scenario duplicate-storm --iterations 5000

# Machine-readable, for diffing between runs
npm run load -- --json > run-$(date +%s).json
```

`npm run load -- --help` lists every flag. From inside `apps/api/` the same
command is `npm run load -- <options>`.

The harness exits `0` when every scenario met its budget, `1` when one did not,
and `2` when it refused to run at all (bad arguments, or a target it will not
point at). That makes it usable as a gate in a scheduled capacity job, not just
as something a human reads.

### It will not target production by default

Two independent locks, because they fail differently:

| Guard | Trips when | Unlock |
|---|---|---|
| Remote target | the target host is not `localhost`/`127.0.0.1`/`[::1]`/`0.0.0.0`/`host.docker.internal` | `LOAD_ALLOW_REMOTE=true` |
| Production process | `NODE_ENV=production` | `LOAD_ALLOW_PRODUCTION=true` |

Opting into one does not unlock the other. The default target is
`http://127.0.0.1:3002`. Point the harness at a staging environment you own, or
at a local stack — never at the environment serving real users.

### Environment

| Variable | Effect when set |
|---|---|
| `LOAD_TARGET` | Base URL (same as `--target`) |
| `WHATSAPP_APP_SECRET` | Signs webhook payloads, so runs exercise the real signature-verification middleware instead of the development bypass |
| `LOAD_ADMIN_TOKEN` | Bearer token for `admin-read`; without it that scenario measures the 401 path and says so |
| `REDIS_URL` | Enables queue depth and oldest-job-age sampling |

Without `REDIS_URL` the report states that queue lag was **not measured**. It
never reports an unobserved queue as an empty one — a missing measurement must
not read as a healthy one.

### An isolated environment

Run against a stack with external providers stubbed: Postgres and Redis local
or containerised (`docker-compose.yml`), `MESSAGE_TRANSPORT=sim` so no messages
reach Meta, and Stellar pointed at testnet. The synthetic senders the harness
generates sit in a `+23480000xxxxx` range so rows from a run are easy to find
and delete afterwards.

## Scenarios

| Scenario | What it models | Why it is payment-critical |
|---|---|---|
| `webhook-burst` | Many senders delivering independent messages at once | Meta retries anything it cannot deliver promptly and will mark a slow webhook unhealthy |
| `sender-sequence` | One sender working through greeting → balance → send → history | Exercises per-sender throttling and the conversational state machine |
| `duplicate-storm` | The same message id redelivered concurrently | The dedup claim is what stops a Meta retry becoming a double payment |
| `admin-read` | Concurrent operators loading stats, users, transactions | The heaviest database reads in the product; they compete with payment writes |
| `health-read` | Liveness, including its database round trip | The floor every other number is measured against |

## Budgets

Defined in `apps/api/load/lib/budgets.js`; the harness fails a run that breaches
one.

| Scenario | p95 | p99 | Max error rate | Min throughput |
|---|---|---|---|---|
| `webhook-burst` | 250ms | 500ms | 0.1% | 50 rps |
| `sender-sequence` | 300ms | 600ms | 2% | 10 rps |
| `duplicate-storm` | 300ms | 600ms | 0% | 20 rps |
| `admin-read` | 400ms | 800ms | 0.1% | 20 rps |
| `health-read` | 100ms | 200ms | 0% | 100 rps |

Queue lag, when Redis is configured: **depth ≤ 500 jobs**, **oldest waiting job
≤ 30s**.

Two notes on the numbers. `sender-sequence` tolerates a higher non-2xx share
because per-sender throttling deliberately drops excess messages — that is the
feature working. `duplicate-storm` tolerates none: contention on the dedup claim
must never surface as a failed request, because Meta reads a 5xx as an unhealthy
webhook.

> **These budgets are starting points, not measurements.** They were chosen from
> the shape of each path — one indexed insert plus a Redis round trip for the
> webhook, unbounded aggregate queries for admin reads — and validated against a
> stub, not against a full stack with Postgres, Redis and Horizon. Before
> treating a breach as a regression, calibrate them on the hardware you actually
> deploy to, using the procedure below, and commit the numbers you get.

### Calibrating on real hardware

1. Bring up an isolated stack with production-shaped data volumes. Aggregate
   queries behave differently against 100 rows than against 100,000.
2. Run each scenario at low concurrency (`-c 5`) to establish an unloaded
   baseline. `health-read` p50 is your floor — no other path can beat a bare
   database round trip.
3. Step concurrency up (10, 25, 50, 100, 200), holding duration constant, and
   record throughput and p99 at each step.
4. Find the knee: the concurrency past which throughput stops rising but p99
   keeps climbing. That is the saturation point.
5. Set budgets at roughly 50% of the knee. That headroom absorbs a burst without
   the service falling over while autoscaling reacts.

## Capacity settings

These are the knobs the measurements above should decide. All live in
`apps/api/src/config/env.js` and are documented in `.env.example`.

| Setting | Default | What it trades off |
|---|---|---|
| `WORKER_CONCURRENCY` | 5 | Jobs in parallel per worker process. Each holds a database connection for part of its life, so this must stay **below** the per-process Prisma pool size, or jobs queue on connections instead of doing work |
| `WORKER_LOCK_DURATION_MS` | 30000 | How long a job may run before BullMQ assumes the worker died. Must exceed the slowest realistic job — a Horizon submission plus retries — or the same payment is processed twice |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MIN` | 100 / 15min | REST traffic per IP |
| `BOT_RATE_MAX` / `BOT_RATE_WINDOW_SEC` | 20 / 60s | Inbound WhatsApp messages per sender |

The two worker settings interact with the database pool and with each other:
raising `WORKER_CONCURRENCY` without raising the pool converts queue lag into
connection-wait latency, which looks like a slow database rather than an
undersized pool. Measure both.

See `docs/BACKGROUND-WORKERS.md` for how the worker process is deployed.

## Scaling signals and what to do about them

Read these in order — the first matching row is usually the real bottleneck.

| Signal | Likely cause | Remediation |
|---|---|---|
| Queue depth grows steadily while webhook p99 stays flat | Consumers are undersized; the edge is fine | Add worker processes first; raise `WORKER_CONCURRENCY` only if the database pool has room |
| Oldest job age climbs but depth is flat | A few slow jobs are blocking; likely Horizon latency | Check Stellar submission latency; consider a separate queue so slow submissions do not head-of-line-block fast replies |
| Webhook p99 climbs while p50 stays flat | Tail contention — usually the dedup insert or connection acquisition | Check `ProcessedMessage` index health and pool saturation before adding instances |
| Both p50 and p99 climb together | The service is genuinely saturated | Add API instances; the webhook path is stateless and scales horizontally |
| Error rate rises with `ECONNREFUSED`/`timeout` | Connection or file-descriptor exhaustion | Check pool size, ulimits, and Redis `maxclients` |
| `admin-read` degrades while webhook paths are healthy | Unbounded aggregate queries competing with payment writes | Paginate and index the admin queries; consider a read replica |
| 503s from the webhook under duplicate load | Working as designed — a concurrent request holds the dedup claim | Nothing, unless the rate is rising; then look at claim-holding duration |

## Idempotency under concurrency

The invariant that matters most is not a latency number: **one message id must
produce at most one payment**, no matter how many times Meta redelivers it or
how many instances receive it simultaneously.

`duplicate-storm` exercises this against a running service and asserts it stays
responsive without 5xx-ing while the contention happens. The exactly-once
property itself is asserted deterministically in
`apps/api/test/load.idempotency.test.js`, which fires 50 simultaneous deliveries
of one message id at the real controller and asserts exactly one reaches the
queue. That test runs in normal CI, so the invariant is protected on every PR
rather than only when someone remembers to run a load test.

There are two independent defences, and the tests cover both: the unique index
on `ProcessedMessage.messageId`, and BullMQ's own deduplication on `jobId`,
which the controller sets to the WhatsApp message id.
