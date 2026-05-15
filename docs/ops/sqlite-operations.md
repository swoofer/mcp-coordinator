# Operations — SQLite Configuration & Maintenance

This runbook documents the SQLite PRAGMAs the coordinator sets at boot,
the periodic maintenance procedures (integrity check, WAL checkpoint,
VACUUM), and disk-usage monitoring.

References:

- `src/database.ts:244-264` — `createBetterSqlite3` / `createBunSqlite`
  PRAGMA configuration.
- `src/database.ts:275-285` — `user_version` downgrade guard.
- `src/sweeper/index.ts` — periodic retention pruning (separate runbook).
- `docs/ops/backup-restore.md` — backup, restore, and NR12 reconciliation.
- `docs/ops/audit-retention.md` — disk growth model.

## TL;DR

The coordinator runs SQLite in WAL mode with a 5-second busy-timeout,
foreign-key enforcement enabled, and `synchronous=NORMAL`. The schema
is at `user_version = 8` for Phase 2; the binary refuses to start
against a higher user_version (forward-incompatible downgrade guard).
Run `PRAGMA integrity_check` quarterly, watch WAL file size, and
`VACUUM` annually or after a large retention drop. None of these
operations require downtime when run with the coordinator process
holding its busy_timeout.

## PRAGMA configuration

Set at boot in `src/database.ts:244-264` for both better-sqlite3 and
Bun's `bun:sqlite` driver:

| PRAGMA               | Value    | Rationale                                                                 |
| -------------------- | -------- | ------------------------------------------------------------------------- |
| `journal_mode`       | `WAL`    | Concurrent reads alongside a single writer; required for the audit queue + sweeper coexistence. |
| `busy_timeout`       | `5000`   | 5-second wait on write-lock contention before throwing `SQLITE_BUSY`.     |
| `foreign_keys`       | `ON`     | Cascades are enforced (e.g., delete user → cascades to `refresh_tokens`). |
| `synchronous`        | `NORMAL` | WAL-mode default; durable across process crashes; corrupts only on OS/disk failure. NORMAL is faster than FULL and equally safe for WAL. |
| `user_version`       | `8`      | Phase 2 schema marker. The binary refuses to boot against `user_version > 8` (`src/database.ts:281-285`). |

NOTE: `synchronous=NORMAL` is the WAL recommendation per
[sqlite.org/wal.html](https://www.sqlite.org/wal.html). It is durable
across application crashes; durability across power loss requires
`synchronous=FULL` but doubles fsync cost on every commit. For a
multi-tenant deployment that runs on cloud VMs with battery-backed
storage, NORMAL is the correct trade-off.

### Read-back

```sh
sqlite3 data/coordinator.db <<'SQL'
PRAGMA journal_mode;
PRAGMA busy_timeout;
PRAGMA foreign_keys;
PRAGMA synchronous;
PRAGMA user_version;
SQL
```

Expected output:

```
wal
5000
1
1        -- 1 = NORMAL
8
```

If a value differs, the coordinator was not the last writer to open the
file. WAL mode and `user_version` persist across processes; the others
are per-connection and reset on each open. The coordinator re-applies
all PRAGMAs on every boot in `src/database.ts:249-251` (better-sqlite3)
or `src/database.ts:260-262` (Bun).

## Procedures

### Integrity check (quarterly)

```sh
sqlite3 data/coordinator.db "PRAGMA integrity_check;"
```

Expected: `ok`.

Any other output (e.g., `*** in database main ***`) indicates
corruption. Treat as a P0 incident:

1. Stop the coordinator (`systemctl stop mcp-coordinator`).
2. Take a defensive `cp` of the corrupted DB file (do not work on it
   in place).
3. Attempt recovery via `.recover`:

   ```sh
   sqlite3 data/coordinator.db ".recover" > recovered.sql
   sqlite3 recovered.db < recovered.sql
   ```

4. If `.recover` cannot reconstruct, restore from Litestream / snapshot
   per `docs/ops/backup-restore.md` and run the NR12 reconciliation
   procedure.

Frequency: quarterly is the SOC 2 baseline. After any unclean shutdown
(power loss, OOM kill, kernel panic), run the check ad-hoc.

### WAL checkpoint (on demand)

WAL files (`coordinator.db-wal`) grow as writes accumulate and shrink
on checkpoints. Auto-checkpoints fire every ~1000 pages by default; in
normal operation the WAL stays under ~4 MB. After a large delete (e.g.,
retention tunable lowered, mass user de-provision), the WAL can grow
substantially.

Force a checkpoint:

```sh
sqlite3 data/coordinator.db "PRAGMA wal_checkpoint(TRUNCATE);"
```

Expected output: three integers — `busy_flag pages_in_wal pages_moved`.
`busy_flag=0` and `pages_in_wal` ≈ `pages_moved` means a full
checkpoint completed. The `-wal` file shrinks back to 0 bytes after a
TRUNCATE checkpoint.

NOTE: the coordinator does not need to be stopped. `PRAGMA
wal_checkpoint` plays cooperatively with the busy_timeout.

### VACUUM (annual or after large deletions)

The sweeper's retention deletions leave SQLite pages marked free but
do not shrink the file. Over time, especially after a retention-window
lowering, fragmentation accumulates (≈ 5% / month under typical sweep
load). Reclaim space with:

```sh
sqlite3 data/coordinator.db "VACUUM;"
```

WARNING: `VACUUM` rewrites the entire database to a temp file and then
swaps. It needs **2× the DB size** in free disk space, holds a write
lock for the duration, and can take minutes on a multi-GB DB. Schedule
it during a maintenance window.

Cadence:

- Annual minimum.
- After any retention tunable lowering that produces > 10% of the
  total rows in a single sweep run.
- Before a backup if you want a compact snapshot.

### `PRAGMA optimize` (every restart)

The coordinator does NOT run `PRAGMA optimize` automatically today.
Operators with long-running deployments (> 6 months without restart)
may schedule it:

```sh
sqlite3 data/coordinator.db "PRAGMA optimize;"
```

This is a cheap, online operation — recompiles `ANALYZE` stats for any
table whose row count has changed materially. No lock, no
maintenance window required.

## Disk-usage monitoring

### File sizes

```sh
ls -lh data/coordinator.db*
```

Expected layout:

- `coordinator.db` — main DB file. Grows with row count.
- `coordinator.db-wal` — WAL log. Should stay < 16 MB in steady
  state; transient growth during sweeps is normal.
- `coordinator.db-shm` — shared-memory index for WAL. Always ~32 KB.

### Per-table breakdown

```sh
sqlite3 data/coordinator.db <<'SQL'
.mode column
.headers on
SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
FROM dbstat
GROUP BY name
ORDER BY bytes DESC;
SQL
```

`audit_log` and `refresh_tokens` usually dominate. See
`docs/ops/audit-retention.md` for the growth model and
`docs/ops/single-instance-constraints.md` for the operational
implications.

### WAL file alarm

A WAL file > 100 MB is anomalous in normal operation. Likely causes:

1. A long-running read transaction blocking checkpoint advancement.
2. A massive single-transaction write (rare; the audit queue uses
   50-row batches and the sweeper uses 1000-row batches).
3. A disk-full event that aborted the last checkpoint mid-flight.

Force a TRUNCATE checkpoint as above. If the WAL doesn't shrink, look
for a process holding a long-running snapshot read.

## Migration & version pinning

The `user_version` PRAGMA acts as a forward-compatibility guard.

| Direction               | Behaviour                                                          |
| ----------------------- | ------------------------------------------------------------------ |
| Older binary → newer DB | Refuses to boot (`src/database.ts:281-285`); explicit error.       |
| Newer binary → older DB | Runs migrations forward; idempotent if already at target version.  |
| Same version            | No-op; PRAGMAs re-applied.                                         |

To verify the schema version:

```sh
sqlite3 data/coordinator.db "PRAGMA user_version;"
```

`8` indicates Phase 2 schema. `0` through `7` are Phase 1 ancestors;
the upgrade is documented in `docs/ops/upgrade-phase1-to-phase2.md`.

## Failure modes

- **`SQLITE_BUSY` errors in logs**: a write took > 5 seconds to
  acquire the write lock. Usually caused by a runaway read query or
  a stuck sweeper. Check `coordinator_sweeper_consecutive_failures`
  and slow-query logs.

- **`SQLITE_CORRUPT` on read**: the DB file is damaged. Stop the
  coordinator immediately and follow the integrity-check recovery
  path above. Do NOT attempt to `VACUUM` a corrupted DB — `VACUUM`
  reads every page and a corrupt page will abort it mid-rewrite.

- **`disk image is malformed` after restore**: the backup was taken
  while the source coordinator was writing AND the backup tool did
  not use SQLite's online backup API. Always use
  `sqlite3 .backup` (online backup API) or Litestream — never `cp`
  on a running DB. See `docs/ops/backup-restore.md`.

- **`user_version` mismatch refusing boot**: the operator ran a
  newer build, then tried to downgrade. The forward-incompatible
  guard fires; the operator must roll forward or restore from a
  snapshot predating the migration.

- **WAL file persists after coordinator stop**: this is normal for ~1
  checkpoint cycle. If the WAL is non-empty for hours after a clean
  stop, the last writer crashed mid-transaction; the next coordinator
  start will replay the WAL.

## Tuning notes

The defaults are tuned for a single-instance Phase 2 deployment on
modern SSD storage. Operators may tune the following at their own
risk:

| PRAGMA          | Default | Higher-throughput alternative   | Trade-off                                  |
| --------------- | ------- | ------------------------------- | ------------------------------------------ |
| `synchronous`   | NORMAL  | OFF                             | Loses durability on OS crash; not recommended for production. |
| `cache_size`    | -2000   | -10000 (~10 MB page cache)      | More RAM per connection; faster reads.     |
| `mmap_size`     | 0       | 30000000000 (30 GB)             | Larger working set; not portable to 32-bit. |

These are NOT set by the coordinator and require either an
out-of-process `sqlite3` script or a runtime patch.
