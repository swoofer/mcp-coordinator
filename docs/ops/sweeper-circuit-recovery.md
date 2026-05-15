# Operations — Sweeper Circuit-Breaker Recovery

This runbook explains the sweeper's 5-failure circuit-breaker, how to
detect a tripped circuit, and the manual reset procedure once the root
cause is fixed.

References:

- `src/sweeper/index.ts:49` — `CIRCUIT_BREAK_THRESHOLD = 5`.
- `src/sweeper/index.ts:104-123` — `runPass()` failure-counting logic.
- `src/sweeper/index.ts:229-232` — `resetCircuit()` admin helper.
- `src/observability/metrics.ts:180-196` —
  `coordinator_sweeper_circuit_open`, `coordinator_sweeper_consecutive_failures`,
  `coordinator_sweeper_last_run_timestamp`.
- `docs/ops/sqlite-operations.md` — DB integrity check + corruption recovery.
- `docs/ops/audit-retention.md` — what the sweeper sweeps.

## TL;DR

The sweeper runs every 60s and trims six tables (oauth_state,
device_auth_requests, refresh_tokens × 2, audit_log Tier 1 + Tier 2).
After 5 consecutive failed runs, the circuit opens, the sweeper stops,
`coordinator_sweeper_circuit_open` flips to 1, and `/health/ready` may
report 503. The fix is: investigate via logs + audit trail, address
the root cause (usually DB-lock contention or table corruption), then
manually reset via `Sweeper.resetCircuit()` (admin CLI / test helper)
or simply restart the coordinator. The breaker is intentionally a
trip-once-then-stay-tripped design — restart is the canonical reset
path in production.

## Background

### How the breaker works

`runPass()` in `src/sweeper/index.ts:104-123`:

```ts
runPass(): void {
  if (this._circuitOpen) return;
  try {
    let chained = 0;
    while (chained < MAX_CHAINED_RUNS) {
      const deletedThisRun = this.sweepAll();
      chained++;
      if (deletedThisRun < BATCH_SIZE) break;
    }
    this._lastRunTimestamp = this.clock.now();
    this._consecutiveFailures = 0;
    this._totalRuns++;
  } catch {
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
      this._circuitOpen = true;
      this.stop();
    }
  }
}
```

State transitions:

| `_consecutiveFailures` | Behaviour                                       |
| ---------------------: | ----------------------------------------------- |
|                      0 | Normal — successful run                         |
|                  1 – 4 | Transient failures; next tick retries           |
|                     ≥5 | **Trip**: `_circuitOpen=true`, `stop()` called  |

A single successful pass resets `_consecutiveFailures` to 0 — the
breaker only opens after 5 *consecutive* failures.

### Why 5?

The default of 5 (`CIRCUIT_BREAK_THRESHOLD` at
`src/sweeper/index.ts:49`) gives 5 minutes of grace for transient
SQLite-lock contention (e.g., a long-running migration, an external
backup tool holding a snapshot) before declaring the sweeper
permanently degraded. Below 5 you get noisy false-positive trips on
normal cloud-VM hiccups; above 5 you delay incident response.

### Why hard-stop instead of back-off?

A back-off scheme assumes the underlying fault is transient and
self-healing. The most common sweeper failure modes —
`DELETE LIMIT` syntax unsupported on a custom SQLite build, or
audit-table corruption — are persistent and require operator
intervention. Hard-stop forces the operator to investigate; a
back-off would silently hide the issue.

## Detection

### Prometheus alert

```yaml
- alert: SweeperCircuitOpen
  expr: coordinator_sweeper_circuit_open == 1
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "Sweeper circuit breaker open on {{ $labels.instance }}"
    runbook: "docs/ops/sweeper-circuit-recovery.md"

- alert: SweeperLagBehind
  expr: time() - coordinator_sweeper_last_run_timestamp > 300
  for: 1m
  labels:
    severity: warning
  annotations:
    summary: "Sweeper has not run for > 5 min on {{ $labels.instance }}"
```

The first alert fires when the breaker is open; the second catches a
silently-stopped sweeper (timer was killed but breaker is still 0,
e.g., during process degradation).

### Manual probe

```sh
curl -s http://localhost:8765/metrics/auth | grep -E \
  'coordinator_sweeper_(circuit_open|consecutive_failures|last_run_timestamp)'
```

Expected steady state:

```
coordinator_sweeper_circuit_open 0
coordinator_sweeper_consecutive_failures 0
coordinator_sweeper_last_run_timestamp 1715600000   # recent unix-seconds value
```

Tripped state:

```
coordinator_sweeper_circuit_open 1
coordinator_sweeper_consecutive_failures 5
coordinator_sweeper_last_run_timestamp 1715599700   # stale
```

## Procedure

### 1. Triage

Confirm the circuit is open and how long it has been open:

```sh
now=$(date +%s)
lr=$(curl -s http://localhost:8765/metrics/auth \
  | awk '/^coordinator_sweeper_last_run_timestamp/ { print int($2) }')
echo "Stale for $((now - lr)) seconds"
```

### 2. Identify the failure cause

The sweeper does not write to `audit_log` on each pass, so the audit
trail is not the right place. Check the coordinator process logs for
the last 5 minutes:

```sh
journalctl -u mcp-coordinator --since '5 min ago' | grep -i sweep
# OR
kubectl logs deploy/mcp-coordinator --since=5m | grep -i sweep
```

Typical patterns:

| Log signature                                              | Likely cause                                  |
| ---------------------------------------------------------- | --------------------------------------------- |
| `SQLITE_BUSY: database is locked`                          | DB-lock contention (see step 3a)              |
| `SQLITE_CORRUPT` / `database disk image is malformed`      | DB corruption (see step 3b)                   |
| `near "LIMIT": syntax error`                               | SQLite built without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (see step 3c) |
| Permission / disk-full errors                              | Infrastructure issue (see step 3d)            |

### 3a. DB-lock contention

Most common cause. Something is holding the write lock longer than
the 5-second `busy_timeout`:

- Long-running migration on a Phase 2 boot.
- Manual `VACUUM` or large `DELETE` ad-hoc query.
- Backup tool reading via long-lived snapshot transaction.
- Multi-instance deployment (see
  `docs/ops/single-instance-constraints.md`).

Investigate:

```sh
fuser -v data/coordinator.db   # who has the file open
lsof | grep coordinator.db
```

Fix: stop / complete the offending process, then proceed to step 4.

### 3b. DB corruption

Run the integrity check:

```sh
sqlite3 data/coordinator.db "PRAGMA integrity_check;"
```

Non-`ok` output indicates corruption. Follow the recovery procedure in
`docs/ops/sqlite-operations.md` (defensive copy → `.recover` → restore
from snapshot if needed). Do NOT reset the sweeper circuit until the
DB integrity is restored.

### 3c. `DELETE LIMIT` unsupported

The sweeper uses `DELETE ... LIMIT N` syntax which requires SQLite's
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT` compile flag. better-sqlite3 ships
with this enabled by default; Bun's `bun:sqlite` ships with it
enabled. If you've swapped to a custom SQLite build (e.g., system
sqlite3 on a minimal Linux distro), this will fail every tick.

The fix is build-side, not runtime: rebuild the driver with the flag
enabled or switch back to the shipped binding. See the warning at
`src/sweeper/index.ts:30-33`.

### 3d. Infrastructure failure

Disk full, permission change, filesystem remounted read-only, etc.
Diagnose with normal Linux tooling:

```sh
df -h data/
ls -la data/coordinator.db
stat data/coordinator.db
```

Resolve the infrastructure issue, then proceed.

### 4. Reset the breaker

The `Sweeper.resetCircuit()` method
(`src/sweeper/index.ts:229-232`) is the canonical reset path:

```ts
resetCircuit(): void {
  this._circuitOpen = false;
  this._consecutiveFailures = 0;
}
```

This is a test helper / future admin-CLI hook. **Today the production
reset path is a process restart** — restarting the coordinator
re-instantiates the `Sweeper` with a fresh state object and starts
its timer.

```sh
systemctl restart mcp-coordinator
```

After restart, the new `Sweeper` instance is wired by
`bootPhase2()` (`src/boot.ts:108-109`) and its timer starts
immediately.

NOTE: a future admin CLI / HTTP endpoint will expose `resetCircuit()`
directly so operators can clear the breaker without dropping in-flight
HTTP connections. Until then, restart is the supported path.

## Verification

### 1. Breaker cleared

```sh
sleep 65   # wait one sweep cycle
curl -s http://localhost:8765/metrics/auth | grep -E \
  'coordinator_sweeper_(circuit_open|consecutive_failures)'
```

Expected:

```
coordinator_sweeper_circuit_open 0
coordinator_sweeper_consecutive_failures 0
```

### 2. Sweeper actively running

```sh
sleep 65   # second cycle
curl -s http://localhost:8765/metrics/auth | grep coordinator_sweeper_last_run_timestamp
```

The timestamp should be within the last 60 seconds and incrementing
on each scrape.

### 3. Rows being deleted

```sh
curl -s http://localhost:8765/metrics/auth | grep coordinator_sweeper_rows_deleted_total
```

If the backlog from the trip period is large, expect chained-pass
draining (up to 3 × 1000 rows per tick per table) until the queue is
empty. See `src/sweeper/index.ts:107-112`.

### 4. Health probe green

```sh
curl -fsS http://localhost:8765/readyz   # expect HTTP 200
```

A 503 here would indicate `/health/ready` is gating on the sweeper
circuit. Phase 2 wires the gauge but does NOT yet gate readiness on
it — `/readyz` gates only on DB + MQTT today (see
`src/http/handle-health.ts:117`). The wiring of sweeper-circuit-open
into readiness is a future enhancement.

## Failure modes

- **Breaker trips immediately on restart**: the root cause was not
  resolved. Re-run step 2 (cause identification). Common
  oversight: corruption was repaired in the staging copy but the
  live DB file still has the bad pages.

- **Breaker keeps re-tripping intermittently**: under load, the
  busy_timeout is being exceeded sporadically. Tune the SQLite
  config (consider raising `busy_timeout` to 10s for high-write
  workloads) or address the upstream contention source.

- **Sweeper running but no rows deleted**: not a circuit-breaker
  fault, but a similar symptom. Check `coordinator_sweeper_last_run_timestamp`
  is fresh AND `coordinator_sweeper_rows_deleted_total` is climbing
  for active tables. A zero-delete steady state on
  `audit_log_tier2` may mean the retention window is too long
  (rows haven't aged out yet) — see `docs/ops/audit-retention.md`.

- **No metrics for the sweeper at all**: confirm
  `COORDINATOR_OAUTH_ENABLED=true` is set; Phase 1 deployments do
  not initialise the sweeper and `/metrics/auth` returns 404.

- **`resetCircuit()` called via test helper in production**: should
  not happen — the method is `public` for testability but is not
  wired to any HTTP / CLI surface today. If you've reached for it,
  prefer process restart instead.

## Root-cause analysis hints

| Symptom                                       | Most likely root cause                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| Trips after a deploy with no other changes    | Schema migration ran longer than 5×60s — manual long-run        |
| Trips during nightly backup window            | Backup tool's snapshot transaction holds the write lock         |
| Trips alongside high login rate               | Audit-queue flush contention starves sweeper writes             |
| Trips after a power loss / OOM kill           | WAL replay produced a bad page; run integrity check             |
| Trips on a brand-new deployment               | SQLite build missing `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`        |
| Trips simultaneously on multiple instances    | Multi-instance violation; see single-instance-constraints.md    |
