# Phase 2 perf bench + chaos suite (T33)

Operator-facing performance benchmarks and chaos-injection scripts for
the Phase 2 OAuth + Device Flow + audit hot paths. Use these to spot
regressions before/after touching the auth code, and to validate that
the resilience patterns (stale-on-error, bounded audit queue) behave
under the failure modes they were designed for.

## TL;DR

```bash
# Refresh-token rotation: end-to-end latency (JWT verify + DB + mint + audit)
npm run perf:rotation

# Tier 2 audit queue: throughput + drop accounting
npm run perf:audit

# token_epoch direct DB read (V4 CUT 1): confirms it stays in microseconds
npm run perf:token-epoch

# MembershipCache stale-on-error under 50% IdP failure
npm run chaos:idp

# AuditQueue overflow + recovery (V3 §B-NEW-6)
npm run chaos:audit
```

Each script prints a `JSON_SUMMARY: { ... }` line as the **final stdout
line** — easy to grep/pipe into a dashboard or regression-tracking
tool. Example:

```bash
npm run perf:rotation | grep ^JSON_SUMMARY
# JSON_SUMMARY: {"bench":"refresh-rotation","n":10000,"p50_ms":0.789,...}
```

## How to run each bench

All scripts are standalone TypeScript run via `tsx`; no Vitest. They
spin up their own in-memory or temp-dir SQLite, do their work, and
clean up.

### bench-refresh-rotation

```bash
npm run perf:rotation
# or:
npx tsx tests/perf/bench-refresh-rotation.ts

# Override iteration count (default 10000):
BENCH_N=50000 npx tsx tests/perf/bench-refresh-rotation.ts
```

Measures the full HTTP boundary of `refreshTokenGrant()`:
form-body parse, JWT verify (HS256 + kid allowlist + clock skew),
DB SELECT, idle-timeout check, atomic rotation UPDATE, `mintTokenPair`,
parent_jti UPDATE, and Tier 2 audit emission. The IdP membership
re-check is short-circuited by seeding the user with
`idp_access_token=NULL` (Phase 1 migrated user path) — adding mocked
GitHub round-trips would conflate two unrelated costs. To bench the
IdP-included path, swap in the MSW handler from
`tests/helpers/idp.ts` (~1.5ms additional p50 per call in local runs).

### bench-audit-queue

```bash
npm run perf:audit

BENCH_N_NORMAL=10000 BENCH_N_BURST=20000 npx tsx tests/perf/bench-audit-queue.ts
```

Two scenarios:
* **A. Normal load**: 10K rows enqueued. Verifies enqueue stays
  sub-microsecond on the fast path; drain time bounded.
* **B. Burst**: 20K rows in a tight synchronous loop. The internal
  auto-flush at BATCH_SIZE=50 fires synchronously each time the buffer
  fills, so in practice no drops occur unless the underlying flush is
  slowed down (see `chaos/audit-queue-overflow` for the overflow
  scenario).

### bench-token-epoch

```bash
npm run perf:token-epoch

BENCH_N=500000 BENCH_USERS=10000 npx tsx tests/perf/bench-token-epoch.ts
```

100K `readTokenEpoch()` calls against a 1K-row users table with a
deterministic random access pattern (so PK index pages aren't trivially
hot in CPU cache). Confirms the V4 CUT 1 decision (direct DB read per
request, no cache) stays in the tens-of-microseconds range — easily
under the 1ms budget for auth hot paths.

### chaos/idp-failure-injection

```bash
npm run chaos:idp

CHAOS_N=5000 CHAOS_FAIL_EVERY=2 npx tsx tests/perf/chaos/idp-failure-injection.ts
```

Stubs `IdPProvider.listMemberships` to throw `IdPTransientError` on a
deterministic pattern (every Nth call; default 50% rate). Walks the
`FakeClock` forward 1s per iteration so the 60s positive TTL is
exercised. Asserts `hard_failure == 0` once the cache is seeded —
the cache's 10-min stale window keeps refresh rotation functional
through transient IdP outages (V3 §B-NEW-5).

### chaos/audit-queue-overflow

```bash
npm run chaos:audit

CHAOS_N=15000 CHAOS_N_RECOVERY=500 npx tsx tests/perf/chaos/audit-queue-overflow.ts
```

Disables the internal flush hook on a single `AuditQueue` instance,
enqueues 15K rows so the buffer fills past CAPACITY=10000. Asserts:

* `dropped == 5000` (exact; deterministic — no race window)
* `enqueued == 10000` (buffer caps at capacity)
* Restoring flush + draining writes exactly 10000 rows to the DB
* Post-recovery enqueues succeed with `dropped == 0`

## Reference numbers

Captured on a developer workstation (Windows 11, Node 24,
better-sqlite3 12.8, no other load). Treat as a "circa" baseline,
not a contract — rerun on your own hardware and pin the JSON to a
file before/after auth-hot-path changes.

| Bench | Metric | Value |
|---|---|---|
| refresh-rotation | n | 10000 |
| refresh-rotation | p50 | ~0.8 ms |
| refresh-rotation | p95 | ~1.5 ms |
| refresh-rotation | p99 | ~15 ms (GC tail) |
| refresh-rotation | throughput | ~840 ops/sec |
| audit-queue (normal) | enqueue p50 | ~0.3 µs |
| audit-queue (normal) | enqueue p99 | ~150 µs (flush-included) |
| audit-queue (normal) | drain | <1 ms |
| audit-queue (burst, 20K) | total | ~70 ms |
| audit-queue (burst, 20K) | dropped | 0 (sync flush keeps up) |
| token-epoch | n | 100000 |
| token-epoch | p50 | ~8 µs |
| token-epoch | p95 | ~14 µs |
| token-epoch | p99 | ~40 µs |
| token-epoch | throughput | ~98K ops/sec |
| chaos/idp | hard_failure | 0 |
| chaos/idp | stale_served | ~16 (per 1000 iter) |
| chaos/audit | dropped | 5000 (exact) |

The audit-queue burst scenario showing 0 drops is **expected** under
synchronous flush — better-sqlite3's per-row write cost is well below
the BATCH_SIZE=50 trigger interval. The overflow chaos test is the
companion that exercises the actual drop accounting by suppressing
flush.

## When to re-run

Re-run before merging changes that touch any of:

* `src/auth/refresh-rotation.ts`
* `src/auth/oauth-finalize.ts` (`mintTokenPair`)
* `src/auth/jwt-mint.ts` / `src/auth/jwt-keys.ts`
* `src/auth/token-epoch.ts`
* `src/auth/membership-cache.ts`
* `src/security/audit.ts` / `src/security/audit-queue.ts`

Pin the JSON_SUMMARY from main, run the same bench on the topic branch,
and diff. Anything beyond ~20% regression deserves a look. Tail
latencies (p99) are noisier than p50 — re-run a few times before
declaring a regression.

## NOT for CI

These scripts are **operator tooling**, not CI. Reasons:

1. **Variance on shared runners.** GitHub Actions / Buildkite agents
   have noisy neighbors and unpredictable CPU contention; p99 tail
   latencies swing 5-10x run-to-run, producing flaky regression alerts
   that operators learn to ignore.
2. **Heavy.** The full suite is ~15 seconds of CPU; running on every
   PR is wasteful given the noise floor.
3. **Better to run on dedicated hardware.** Performance work warrants
   a quiet machine with known baseline characteristics. The JSON_SUMMARY
   line is designed to be parseable so a dedicated bench host can
   ingest results into a dashboard.

A future iteration may add a weekly cron run on a dedicated benchmark
host with regression alerts gated by significance threshold. Out of
scope for Phase 2.

## See also

* `tests/perf/README.md` — quick command reference
* V3 §B-NEW-5 — MembershipCache stale-on-error semantics
* V3 §B-NEW-6 — AuditQueue bounded-buffer + drop policy
* V4 CUT 1 — `readTokenEpoch` direct DB read decision
