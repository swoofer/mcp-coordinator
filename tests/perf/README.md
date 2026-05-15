# Perf bench + chaos suite (T33)

Operator-only performance benchmarks and chaos-injection scripts for
Phase 2 hot paths. Not part of `npm test`; not for shared-runner CI.

## Run

From the repo root:

```bash
npm run perf:rotation       # 10K refresh-token rotations
npm run perf:audit          # 10K + 20K audit-queue throughput / drops
npm run perf:token-epoch    # 100K readTokenEpoch() against 1K users
npm run chaos:idp           # 50% IdP failure rate; stale-on-error
npm run chaos:audit         # 15K-row overflow; drop accounting + recovery
```

Or directly via `tsx`:

```bash
npx tsx tests/perf/bench-refresh-rotation.ts
npx tsx tests/perf/bench-audit-queue.ts
npx tsx tests/perf/bench-token-epoch.ts
npx tsx tests/perf/chaos/idp-failure-injection.ts
npx tsx tests/perf/chaos/audit-queue-overflow.ts
```

## Output

Each script prints a human-readable summary to stdout, followed by a
single `JSON_SUMMARY: { ... }` line as the final stdout line — easy to
grep/parse for dashboard or regression-tracking ingestion.

## Environment overrides

| Script | Variable | Default |
|---|---|---|
| bench-refresh-rotation | `BENCH_N` | 10000 |
| bench-audit-queue | `BENCH_N_NORMAL` | 10000 |
| bench-audit-queue | `BENCH_N_BURST` | 20000 |
| bench-token-epoch | `BENCH_N` | 100000 |
| bench-token-epoch | `BENCH_USERS` | 1000 |
| chaos/idp-failure-injection | `CHAOS_N` | 1000 |
| chaos/idp-failure-injection | `CHAOS_FAIL_EVERY` | 2 (i.e. 50%) |
| chaos/audit-queue-overflow | `CHAOS_N` | 15000 |
| chaos/audit-queue-overflow | `CHAOS_N_RECOVERY` | 100 |

See `docs/ops/perf-bench.md` for interpretation guidance, reference
numbers, and when to re-run.
