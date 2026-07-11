# Operations — Backup, Restore & NR12 Reconciliation

This runbook documents two backup paths (Litestream WAL shipping and
manual snapshots), the restore procedure with the NR12 reconciliation
step that invalidates all sessions from before the restore, and the
quarterly restore drill required for SOC 2.

References:

- `src/boot.ts:190-227` — `performRestoreCheck()` NR12 implementation.
- `src/auth/token-epoch.ts` — `bumpTokenEpochAllUsers()`.
- `src/security/audit-events.ts` — `recovery.token_epoch_global_bump`,
  `recovery.completed` Tier 1 events.
- `docs/ops/sqlite-operations.md` — online backup, PRAGMA reference.
- V4 §16.3 (NR12 design), V3 §B-NEW-13 (recovery audit chain).
- [Litestream documentation](https://litestream.io/).

## TL;DR

Pick ONE of two backup paths:

- **Litestream** — continuous WAL shipping to S3. Targets RPO ≤ 1
  minute. Operator-managed config file outside this repo.
- **Manual snapshots** — daily `sqlite3 .backup` to local disk + offsite
  copy. Targets RPO ≤ 24 hours. Retain 30 days.

For local/dev use (no production RPO/retention guarantees) there is
also a built-in **CLI** path: `mcp-coordinator server backup` /
`server restore` — see Path C below.

Restore procedure (Litestream/manual paths): stop coordinator → copy /
restore DB → set `COORDINATOR_ALLOW_RESTORE=true` → boot → verify
`recovery.completed` Tier 1 audit row → unset env → notify users to
re-auth. Run a full restore drill quarterly for SOC 2 compliance.

## Why NR12 reconciliation matters

When you restore an older `coordinator.db`, every session token issued
between the snapshot time and the restore time is now in a paradoxical
state: the user's row exists, their `token_epoch` is the older snapshot
value, but their JWT was minted against a newer (now-lost) epoch.
Without intervention, the restored coordinator would happily accept
those tokens, including any that had been issued to actors who were
subsequently demoted or revoked.

NR12 closes this gap. At boot, the coordinator compares
`MAX(audit_log.created_at)` to wall-clock time. If the audit log is
> 5 minutes stale (`RESTORE_DETECTION_STALE_THRESHOLD_S = 300` at
`src/boot.ts:38`), boot refuses unless `COORDINATOR_ALLOW_RESTORE=true`
is set. When the override is set:

1. `bumpTokenEpochAllUsers()` increments every user's `token_epoch`,
   invalidating every outstanding JWT.
2. A `recovery.token_epoch_global_bump` Tier 1 audit row is written.
3. A `recovery.completed` Tier 1 audit row is written with metadata
   `{ stale_seconds, threshold_seconds }`.

This forces every user to re-authenticate via the IdP after a restore,
which re-verifies their identity and current org membership.

## Path A — Litestream (continuous WAL shipping)

Litestream is the recommended production backup path. It tails the
SQLite WAL and ships frames to S3 (or any compatible object store)
continuously, achieving RPO ≤ 1 minute with no application changes.

### Setup (operator-specific)

The Litestream config file is operator-specific and not shipped in
this repo. A reference shape:

```yaml
# /etc/litestream.yml
dbs:
  - path: /var/lib/mcp-coordinator/data/coordinator.db
    replicas:
      - type: s3
        bucket: my-org-coordinator-backups
        path: production
        region: us-east-1
        retention: 720h        # 30 days
        snapshot-interval: 24h
        sync-interval: 1s
```

Run Litestream as a sidecar / systemd unit alongside the coordinator.
Critically, Litestream and the coordinator must run on the same host
with read access to the same DB file.

### Verifying replication

```sh
litestream snapshots /var/lib/mcp-coordinator/data/coordinator.db
litestream wal       /var/lib/mcp-coordinator/data/coordinator.db
```

Expected: at least one snapshot per `snapshot-interval` and a WAL
position no more than `sync-interval × 2` behind the coordinator's
current write position.

### Restore from Litestream

```sh
systemctl stop mcp-coordinator
litestream restore -o data/coordinator.db.restored \
  s3://my-org-coordinator-backups/production
mv data/coordinator.db data/coordinator.db.bak
mv data/coordinator.db.restored data/coordinator.db
# proceed to "Restore reconciliation procedure" below
```

## Path B — Manual snapshots

For deployments where Litestream is not available (air-gapped,
on-prem with no object store, etc.), take daily snapshots using
SQLite's online backup API and copy them offsite.

### Daily snapshot script

```sh
#!/bin/sh
set -eu
DATA=/var/lib/mcp-coordinator/data/coordinator.db
BACKUP_DIR=/var/lib/mcp-coordinator/backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="${BACKUP_DIR}/coordinator-${STAMP}.db"

mkdir -p "${BACKUP_DIR}"
sqlite3 "${DATA}" ".backup ${DEST}"
sqlite3 "${DEST}" "PRAGMA integrity_check;"   # must print "ok"

# 30-day retention
find "${BACKUP_DIR}" -name 'coordinator-*.db' -mtime +30 -delete

# Offsite copy
aws s3 cp "${DEST}" s3://my-org-coordinator-backups/manual/
```

WARNING: do NOT use `cp` on the live DB file. `cp` is not aware of the
WAL and produces a corrupt snapshot under load. `sqlite3 .backup` uses
the online backup API, which is safe alongside live writers.

### Retention model

- Local: 30 days, daily snapshots → 30 files.
- Offsite: lifecycle policy on the S3 bucket (30d hot, 365d cold, then
  expire).

Disk budget: each snapshot is approximately the same size as the live
DB (no fragmentation reclaim until you VACUUM the snapshot). At 320 MB
for a 100-user deployment, 30 days = ~10 GB local + ~10 GB offsite.

### Restore from a manual snapshot

```sh
systemctl stop mcp-coordinator
cp data/coordinator.db data/coordinator.db.bak
cp backup/coordinator-20260513T0000Z.db data/coordinator.db
# proceed to "Restore reconciliation procedure" below
```

## Path C — CLI (`server backup` / `server restore`)

For local/dev setups or ad hoc snapshots, the CLI ships a built-in
backup/restore pair that tars up `~/.mcp-coordinator/` (config.json +
SQLite data dir) without any external tooling. This is not a
replacement for Litestream or the scheduled manual-snapshot script in
production — there is no automation or retention policy around it,
you run it by hand.

### `server backup`

```sh
mcp-coordinator server backup [--output <path>] [--data-dir <path>] [--force]
```

- `--output <path>` — output tarball path. Default:
  `./mcp-coordinator-backup-<YYYY-MM-DD-HHMMSS>.tar.gz` (UTC timestamp)
  in the current directory.
- `--data-dir <path>` — data directory to back up. Defaults to
  `COORDINATOR_DATA_DIR` or `config.server.data_dir` from
  `config.json`.
- `--force` — skip the running-coordinator safety check.

Like the manual-snapshot path, this refuses to run while the
coordinator daemon is up (detected via the pidfile in the config dir)
because a live SQLite WAL may have uncommitted writes that a plain
file copy would miss:

```
Coordinator is running (PID 12345).
Refusing to back up: live SQLite WAL writes may be in flight.
Either stop it first ('mcp-coordinator server stop') or pass --force.
```

Stop the coordinator first (`mcp-coordinator server stop`) rather than
reaching for `--force` unless you know the WAL is quiescent.

If `--data-dir` points at the default location (`<configDir>/data`),
`config.json` and the data dir are packed into one archive. If it
points somewhere else (a custom data dir), the data dir is packed
into a **separate sibling archive** named `<output>.data.tar.gz`,
since tar can only use one `cwd` per archive — the command prints the
path when this happens. Keep both files together; `server restore`
only takes one tarball argument, so restoring a custom-data-dir backup
requires manually extracting the `.data.tar.gz` into the target data
directory after restoring the config archive.

### `server restore`

```sh
mcp-coordinator server restore <tarball> [--force] [--no-backup] [--data-dir <path>]
```

- `<tarball>` — path to the archive produced by `server backup`
  (required).
- `--force` — skip the running-coordinator safety check.
- `--no-backup` — do not snapshot the existing `~/.mcp-coordinator/`
  before overwriting it (by default the existing dir is renamed to
  `<configDir>.bak-<YYYY-MM-DD-HHMMSS>`).
- `--data-dir <path>` — accepted but currently informational only:
  restore always extracts into the default config dir location; if you
  pass `--data-dir` the command prints a reminder to update
  `config.json`/`COORDINATOR_DATA_DIR` yourself if you need a
  non-default path.

The command validates the tarball contains a top-level `config.json`
or `data` entry before touching anything, refuses to run while the
coordinator is up (same PID check as `backup`, unless `--force`), and
on extraction failure attempts to roll back to the pre-restore
snapshot automatically.

```sh
mcp-coordinator server stop
mcp-coordinator server restore ./mcp-coordinator-backup-2026-07-11-120000.tar.gz
mcp-coordinator server start --daemon
```

Because this restores `config.json` and the SQLite data dir directly,
the same NR12 reconciliation applies as with Paths A/B: on the next
boot the coordinator will see a stale audit log and require
`COORDINATOR_ALLOW_RESTORE=true` (see the reconciliation procedure
below) unless the backup was taken and restored within the staleness
window.

## Restore reconciliation procedure (all paths)

This is the critical NR12 step. Do not skip any sub-step.

### 1. Confirm the coordinator is stopped

```sh
systemctl status mcp-coordinator   # expect "inactive (dead)"
ps aux | grep mcp-coordinator      # no processes
```

The coordinator MUST be stopped before restoring the DB. A running
coordinator holds the WAL open and a hot swap of the underlying file
causes immediate corruption.

### 2. Confirm the restored DB integrity

```sh
sqlite3 data/coordinator.db "PRAGMA integrity_check;"     # expect "ok"
sqlite3 data/coordinator.db "PRAGMA user_version;"        # expect 8 (Phase 2)
sqlite3 data/coordinator.db "SELECT COUNT(*) FROM users;" # sanity check
```

### 3. Set the override

```sh
export COORDINATOR_ALLOW_RESTORE=true
```

NOTE: this is a one-shot override. Boot with the flag set, then unset
it immediately after a successful boot. Leaving it set perpetually
defeats the NR12 guard.

### 4. Boot the coordinator

```sh
systemctl start mcp-coordinator
```

The boot will:

- Detect the stale audit log
  (`MAX(audit_log.created_at) < now - 300s`).
- Read `COORDINATOR_ALLOW_RESTORE=true` and proceed instead of
  throwing `BootValidationError`.
- Call `bumpTokenEpochAllUsers()` — every user row's
  `token_epoch` is incremented.
- Emit a `recovery.token_epoch_global_bump` Tier 1 audit row.
- Emit a `recovery.completed` Tier 1 audit row.

### 5. Verify the recovery audit chain

```sh
sqlite3 data/coordinator.db <<'SQL'
.mode column
.headers on
SELECT created_at, action,
       json_extract(metadata_json, '$.stale_seconds') AS stale_s,
       json_extract(metadata_json, '$.threshold_seconds') AS threshold_s
FROM audit_log
WHERE action IN ('recovery.token_epoch_global_bump', 'recovery.completed')
ORDER BY created_at DESC LIMIT 5;
SQL
```

Expected: at least one row of each action, with `stale_s > 300` and
`threshold_s = 300`. Save this output to your compliance evidence
store — it is the durable proof that NR12 reconciliation ran.

### 6. Unset the override

```sh
unset COORDINATOR_ALLOW_RESTORE
```

If you forget this, the next normal restart (which will have a fresh
audit log) is unaffected — the override only matters when boot
detects a stale audit log. But hygiene says unset it.

### 7. Notify users

Send the following to all users:

> The coordinator was restored from a backup at `${RESTORE_TIME}`.
> All sessions issued before this time have been invalidated. Please
> log in again at `https://${COORDINATOR_PUBLIC_URL}/auth/login`.

Without this step, users see opaque 401 errors and reach out to
on-call.

## Quarterly restore drill (SOC 2)

SOC 2 CC9.1 requires periodic validation that backups are actually
restorable. Run the following drill quarterly:

1. **In a non-production environment** (staging / dedicated drill
   host), provision a coordinator with the same env config as
   production.
2. **Restore** the most recent production snapshot following the
   procedure above.
3. **Validate**:

   - `PRAGMA integrity_check` returns `ok`.
   - `PRAGMA user_version` is the expected version.
   - `recovery.completed` audit row is present.
   - A test user can log in via OAuth and obtain a fresh session.
   - Row counts for `users`, `service_tokens`, and `audit_log` match
     the production snapshot expectations.
4. **Document** the drill in your compliance evidence store:
   - Date run, operator, source snapshot ID, target environment,
     time-to-restore, validation results.
5. **Tear down** the drill environment.

A successful drill closes a SOC 2 CC9.1 control instance for the
quarter.

## Verification

### Last successful Litestream snapshot

```sh
litestream snapshots /var/lib/mcp-coordinator/data/coordinator.db \
  | tail -n 1
```

### Last manual snapshot

```sh
ls -lt /var/lib/mcp-coordinator/backup/coordinator-*.db | head -n 1
```

### Recovery audit history

```sh
sqlite3 data/coordinator.db <<'SQL'
SELECT created_at, action, json_extract(metadata_json, '$.stale_seconds') AS stale_s
FROM audit_log
WHERE action = 'recovery.completed'
ORDER BY created_at DESC LIMIT 10;
SQL
```

Each row is a historical restore event. Rare in normal operation.

## Failure modes

- **NR12 override forgotten**: if you leave `COORDINATOR_ALLOW_RESTORE=true`
  in the env-var store and later do a NORMAL restart, the override is
  silently a no-op (audit log is not stale, so the guard doesn't
  trigger). But a future restore won't have any safety net — fix this
  during your next config-review pass.

- **Snapshot taken with `cp` instead of `.backup`**: the snapshot is
  likely corrupt, and `PRAGMA integrity_check` will catch it at
  step 2 of the restore procedure. Restore an older valid snapshot
  instead.

- **Restore from a very old snapshot** (months stale): the schema
  migration in `src/database.ts` runs forward at boot, so old
  Phase 1 backups can be restored into a Phase 2 binary. The NR12
  reconciliation still applies.

- **Restore drill not run for > 90 days**: SOC 2 control instance
  fails for that quarter. Schedule a make-up drill and document the
  miss.

- **Litestream replication paused** (e.g., transient network /
  credential issue): RPO drifts beyond the 1-minute target. Monitor
  `litestream wal` output for replication lag and alert on > 10
  minute lag.

- **Coordinator running during restore**: the WAL goes out of sync
  with the restored main file, producing `disk image is malformed`
  errors. Always confirm step 1 of the restore procedure (process
  stopped) before swapping files.

- **Multiple `COORDINATOR_ALLOW_RESTORE=true` boots in a row**: each
  re-bumps `token_epoch`, invalidating any sessions issued between
  the boots. This is correct behaviour (each boot represents a new
  reconciliation event) but is a noisy red flag — investigate why
  the audit log is repeatedly stale.
