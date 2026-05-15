# Operations — Tier 2 Audit Queue Policy

This runbook documents the bounded Tier 2 audit queue: its capacity,
the backpressure semantics, the SIGTERM drain behaviour, and what to
do when `coordinator_audit_drops_total` increments.

References:

- `src/security/audit-queue.ts` — `AuditQueue` class, capacity, batch
  size, and drain semantics.
- `src/security/audit.ts` — `audit()` entry point + Tier 2 routing.
- `src/security/audit-events.ts:39-55` — Tier 2 inventory.
- `src/observability/metrics.ts:174-217` — `coordinator_audit_queue_depth`,
  `coordinator_audit_drops_total`, `coordinator_audit_after_critical_op_failures_total`.
- V3 §B-NEW-6 (queue policy), V4 §17.6 (durability).

## TL;DR

The Tier 2 audit queue is bounded at **10,000 rows** in memory
(`src/security/audit-queue.ts:24` — `CAPACITY = 10_000`) and flushes
to SQLite in batches of 50 every 100ms, or whenever it fills.
**Tier 1 audit rows do NOT go through this queue** — they're written
synchronously and never drop. When the queue is full, additional Tier 2
events are dropped and `coordinator_audit_drops_total` increments; this
is treated as **CRITICAL** because dropped rows indicate sustained
overload. On SIGTERM, `drain()` flushes pending rows and emits a final
`system.shutdown.audit_loss` Tier 1 row with the lifetime drop count.

## Background

### Why bounded

A Tier 2 audit emission is on the hot request path (e.g., every
successful login emits `auth.login.success`). An unbounded queue would
let a transient SQLite-lock spike accumulate enough rows to OOM the
process. The capacity of 10,000 rows is intentional: at 500 bytes per
row (see `docs/ops/audit-retention.md` row-size assumption), a full
queue is ~5 MB of heap — bounded, predictable.

### Capacity headroom math

At the 100-user / 50-events-per-day baseline:

```
Tier 2 events / second = 100 × 50 × 0.90 / 86400 ≈ 0.05 events/s
```

The queue's natural drain rate (50 rows per 100ms = 500 rows/s) is
**~10,000× faster** than the steady-state arrival rate. Drops should
never happen in normal operation; one drop is enough to investigate.

### What drops mean

A drop fires when `enqueue()` is called with the buffer at
`CAPACITY` (see `src/security/audit-queue.ts:82-85`). This happens
only if:

1. The flush worker is stuck (SQLite write lock contention) AND
2. ≥ 10,000 Tier 2 events arrived during the stall.

Both conditions are anomalous. The drop counter is therefore wired as a
**CRITICAL** alert — not a "noisy ops" alert.

## Procedure

### Investigating an alert

When `coordinator_audit_drops_total > 0`:

1. **Confirm the rate**. Check whether drops are still incrementing:

   ```sh
   curl -s http://localhost:8765/metrics/auth \
     | grep coordinator_audit_drops_total
   ```

   If the value is stable (single past spike), the queue has
   recovered; you only need to root-cause the spike. If the value is
   still climbing, the queue is actively losing data — escalate.

2. **Check queue depth**. The depth gauge tells you whether the queue
   is currently full or already drained:

   ```sh
   curl -s http://localhost:8765/metrics/auth \
     | grep coordinator_audit_queue_depth
   ```

   A non-zero stable depth = back-pressure persists. A zero depth +
   non-zero drops = burst is over.

3. **Look for the upstream stall**. The queue drops only when the
   flush worker can't keep up. The usual cause is a SQLite write-lock
   contention or a disk-I/O stall. Cross-reference:

   - Sweeper failures (`coordinator_sweeper_consecutive_failures > 0`)
   - WAL file size growing without bound
   - Slow `/metrics/auth` scrape (process is event-loop-blocked)

4. **Check the audit log itself** for the final drain marker (only
   present after a SIGTERM cycle):

   ```sql
   SELECT created_at, metadata_json
   FROM audit_log
   WHERE action = 'system.shutdown.audit_loss'
   ORDER BY created_at DESC LIMIT 5;
   ```

   `metadata_json` will contain `{"dropped_count": N}` for the
   lifetime of the previous process. A non-zero value here is the
   durable forensic record that rows were lost across that
   shutdown.

### SIGTERM drain procedure

`AuditQueue.drain(timeoutMs)` is wired as the SIGTERM hook (see
`src/security/audit-queue.ts:117-136`):

1. Flush all currently-buffered rows synchronously (better-sqlite3
   transactional batch insert).
2. Set the queue's `closed` flag — subsequent `enqueue()` calls
   bypass the buffer and write synchronously to avoid silent loss on
   the shutdown path (`src/security/audit-queue.ts:74-81`).
3. If any rows were dropped during the queue's lifetime, emit a
   single `system.shutdown.audit_loss` Tier 1 audit row with
   `metadata_json: {"dropped_count": N}`. This row is **never
   dropped** (it's written via a separate prepared statement that
   bypasses the queue entirely).

A graceful shutdown should complete in well under 1 second; the
`timeoutMs` parameter (default 5000) is reserved for a future async
driver swap.

### Manual drain (e.g., for diagnostics)

There's no admin endpoint to force a flush today, but the timer-driven
flush runs every 100ms (`FLUSH_INTERVAL_MS` at
`src/security/audit-queue.ts:26`) so a "manual" flush is to wait
0.1s. If you suspect the timer is wedged, restart the coordinator —
SIGTERM will drain through the shutdown path described above.

## Verification

### Healthy steady state

```sh
curl -s http://localhost:8765/metrics/auth | grep -E \
  'coordinator_audit_(queue_depth|drops_total|after_critical_op_failures_total)'
```

Expected values:

- `coordinator_audit_queue_depth` near 0 (briefly spikes to ≤ 50 during
  burst then drains).
- `coordinator_audit_drops_total` = 0.
- `coordinator_audit_after_critical_op_failures_total` = 0 (this is
  the V4 FIX 23 "telemetry-of-telemetry-loss" counter — increments
  when a Tier 1 audit fails to write AFTER its critical security op
  succeeded; any non-zero value is an emergency).

### After a SIGTERM cycle

```sql
SELECT
  created_at,
  json_extract(metadata_json, '$.dropped_count') AS dropped
FROM audit_log
WHERE action = 'system.shutdown.audit_loss';
```

Empty result = no drops ever observed. Non-empty rows are the durable
historical record of every shutdown that lost Tier 2 rows.

## Failure modes

- **Drop counter never increments but events feel missing**: a Tier 2
  event is also dropped if it's emitted from a code path that bypasses
  `audit()` (e.g., a future direct-INSERT regression). Periodically
  diff the rows in `audit_log` against the Tier 2 allow-list in
  `src/security/audit-events.ts`; an "unknown action" classification
  in the sweeper output is the trip-wire.

- **Queue depth perpetually elevated, no drops**: the flush worker is
  keeping up but slowly. Investigate SQLite write performance — usually
  a missing index, a `synchronous=FULL` regression, or contention with
  a long-running migration.

- **`system.shutdown.audit_loss` write itself fails**: the
  `writeBatchSync` swallow at `src/security/audit-queue.ts:128-132`
  is intentional (the alternative is failing SIGTERM cleanup), but
  it means a totally-broken DB at shutdown gives no durable trail. The
  in-memory `dropped` counter is still returned from `drain()` to the
  caller; ensure your shutdown logger captures this return value.

- **Post-drain enqueue path is sync**: a request that completes
  *after* the SIGTERM-initiated drain (e.g., an in-flight HTTP
  handler) emits Tier 2 events via the synchronous fallback at
  `src/security/audit-queue.ts:74-81`. This is correct (no silent
  loss) but adds latency to the in-flight request; design your
  shutdown grace period accordingly.

## Alert wiring

A representative Prometheus alert rule:

```yaml
- alert: AuditDropsObserved
  expr: increase(coordinator_audit_drops_total[5m]) > 0
  for: 1m
  labels:
    severity: critical
  annotations:
    summary: "Tier 2 audit drops detected on {{ $labels.instance }}"
    runbook: "docs/ops/audit-queue-policy.md"

- alert: AuditAfterCriticalFailure
  expr: increase(coordinator_audit_after_critical_op_failures_total[5m]) > 0
  for: 0m
  labels:
    severity: page
  annotations:
    summary: "Tier 1 audit write failed after critical op succeeded"
    runbook: "docs/ops/audit-queue-policy.md#tier-1-failures"
```

### Tier 1 failures

A `coordinator_audit_after_critical_op_failures_total` increment means
a security-critical operation succeeded in the DB but its audit row
failed to write. This violates the durability contract; treat as a
**page** severity and investigate immediately (DB likely degraded or
schema mismatch).
