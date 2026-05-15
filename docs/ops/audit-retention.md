# Operations — Audit Log Retention & Growth Model

This runbook models how fast the `audit_log` table grows under Phase 2
load, computes the disk footprint at the default retention windows, and
documents the tunables operators have for adjusting the budget.

References:

- `src/sweeper/index.ts:130-203` — Tier 1 + Tier 2 retention sweep.
- `src/security/audit-events.ts` — Tier 1 / Tier 2 inventory.
- `src/security/audit.ts` — `audit()` entry point + tier routing.
- `src/security/audit-queue.ts` — Tier 2 buffered writes.
- V4 §17.7 (sweeper), V2 §C.12 (SQL examples), V3 §B-NEW-6 (queue policy).

## TL;DR

Default retention is 365 days for Tier 1 (security-critical) and 90
days for Tier 2 (operational). At 100 active users and 50 events per
user per day, the steady-state `audit_log` footprint is approximately
**290 MB** with a Tier 1 / Tier 2 row split of roughly 1 : 2.2. The
sweeper (`src/sweeper/index.ts`) trims aged rows on a 60s cadence with
a 1000-row batch limit. Tune retention via the per-org settings
`audit_retention_days` and `audit_tier2_retention_days`.

## Background

### Tiering recap

Every audit row's `action` column is classified at sweep time against
the Tier 1 / Tier 2 allow-lists in `src/security/audit-events.ts`:

- **Tier 1** (synchronous emission, never dropped, long retention):
  `auth.refresh.chain_revoked`, `auth.refresh.suspicious_replay`,
  `auth.login.locked`, `auth.token.revoked`, `auth.logout.global`,
  `auth.service_token.issued/revoked`, `auth.admin.bootstrapped`,
  `auth.idp.token_revoked`, `recovery.completed`, `config.boot`,
  `config.key_rotation`, `system.shutdown.audit_loss`,
  `migration.audit_backfill`, ...

- **Tier 2** (queued emission, may drop under pressure, short
  retention): `auth.login.success/failure`, `auth.refresh.rotated`,
  `auth.refresh.idle_expired`, `auth.device.*`, `auth.user.created`,
  `auth.logout.local`, `auth.invalid_token`,
  `auth.service_token.used`, `auth.idp.stale_served`, ...

### Default tunables

| Setting                       | Default | Source                                        |
| ----------------------------- | ------- | --------------------------------------------- |
| `audit_retention_days`        | 365     | `src/sweeper/index.ts:132`                    |
| `audit_tier2_retention_days`  | 90      | `src/sweeper/index.ts:135`                    |
| Sweep cadence                 | 60s     | `src/sweeper/index.ts:46` (`SWEEP_INTERVAL_MS`) |
| Sweep batch size              | 1000    | `src/sweeper/index.ts:47` (`BATCH_SIZE`)      |
| Max chained sweep iterations  | 3       | `src/sweeper/index.ts:48` (`MAX_CHAINED_RUNS`) |

## Procedure

### 1. Estimate event volume

```
events_per_user_per_day  ≈ 1 login
                         + ~10 refresh-token rotations (auth.refresh.rotated)
                         + ~30 reads (auth.service_token.used sampled hourly)
                         + 10 misc (logout, csrf, lockout, IdP cache, ...)
                         = ~50 events / user / day
```

Tier mix in steady state:

```
tier_1_fraction ≈ 0.10   (logins denied + token revocations + bootstraps)
tier_2_fraction ≈ 0.90   (successful logins + rotations + service-token uses)
```

### 2. Compute rows / year

```
active_users            = 100
events_per_user_per_day = 50

Total events / year = 100 × 50 × 365            = 1,825,000

Tier 1 rows / year  = 1,825,000 × 0.10          =   182,500
Tier 2 rows / year  = 1,825,000 × 0.90          = 1,642,500
```

### 3. Compute retained-row count at default windows

```
Tier 1 retained = Tier 1 rows/year × (365 / 365) = 182,500
Tier 2 retained = Tier 2 rows/year × (90  / 365) = 405,000
                                                   -------
Total retained                                   = 587,500
```

### 4. Compute disk footprint

Average row size ≈ 500 bytes (SQLite encodes the integer/text columns
compactly; the variance is in `metadata_json` — denial reasons,
IP/UA on failed logins, lockout-policy decisions).

```
Disk = (182,500 + 405,000) × 500 B
     = 587,500 × 500 B
     = 293,750,000 B
     ≈ 290 MB
```

Add ~10% for SQLite page overhead + per-row indexes (`audit_log` has
indexes on `created_at` and `action`) → **~320 MB** total `audit_log`
footprint for a 100-user deployment.

### 5. Scaling table

| Active users | Tier 1 retained | Tier 2 retained | Approx disk (audit_log + idx) |
| -----------: | --------------: | --------------: | ----------------------------: |
|           10 |          18,250 |          40,500 |                        ~32 MB |
|          100 |         182,500 |         405,000 |                       ~320 MB |
|        1,000 |       1,825,000 |       4,050,000 |                       ~3.2 GB |
|       10,000 |      18,250,000 |      40,500,000 |                        ~32 GB |

NOTE: at 1,000+ active users the audit budget dominates the database
size. Plan disk provisioning around this row rather than around the
operational tables (`refresh_tokens`, `oauth_state`, etc.).

## Verification

### Current population by tier

```sh
sqlite3 data/coordinator.db <<'SQL'
.mode column
.headers on
WITH tiers AS (
  SELECT 'tier1' AS tier, action FROM (VALUES
    ('auth.refresh.chain_revoked'),
    ('auth.refresh.suspicious_replay'),
    ('auth.state.replay'),
    ('auth.state.mixup'),
    ('auth.login.denied.not_in_org'),
    ('auth.login.locked'),
    ('auth.token.revoked'),
    ('auth.logout.global'),
    ('auth.service_token.issued'),
    ('auth.service_token.revoked'),
    ('auth.admin.bootstrapped'),
    ('auth.bootstrap.admin_assigned'),
    ('auth.idp.token_revoked'),
    ('auth.idp.unknown_kid'),
    ('recovery.token_epoch_global_bump'),
    ('recovery.completed'),
    ('config.boot'),
    ('config.key_rotation'),
    ('system.shutdown.audit_loss'),
    ('migration.audit_backfill')
  )
)
SELECT
  COALESCE(t.tier, 'tier2') AS tier,
  COUNT(*) AS rows,
  MIN(a.created_at) AS oldest,
  MAX(a.created_at) AS newest
FROM audit_log a
LEFT JOIN tiers t USING (action)
GROUP BY 1;
SQL
```

### Disk footprint snapshot

```sh
sqlite3 data/coordinator.db \
  "SELECT name, SUM(pgsize) AS bytes FROM dbstat
   WHERE name LIKE 'audit_log%' GROUP BY name;"
```

`dbstat` is a built-in virtual table; the SQLite build must be
compiled with `SQLITE_ENABLE_DBSTAT_VTAB`. better-sqlite3 ships with
it enabled by default.

### Tunable read-back

```sh
sqlite3 data/coordinator.db <<'SQL'
SELECT key, value
FROM org_settings
WHERE org_id IS NULL
  AND key IN ('audit_retention_days', 'audit_tier2_retention_days');
SQL
```

A missing row means the default is in effect (365 / 90).

## When to enlarge

Increase retention when:

- **Compliance posture demands it.** SOC 2, HIPAA, and most regulated
  frameworks expect 1 year of security-relevant audit retention (Tier 1
  already meets this). Tier 2 to 180 days is a defensible enhancement
  if disk budget allows.

- **Forensics workflow requires it.** If your incident-response
  playbook routinely queries audit rows older than 90 days, raise the
  Tier 2 window — querying a missing row produces zero forensic value.

- **You ship audit rows externally** (e.g., SIEM forwarder). Lower
  local retention is fine if the SIEM is the authoritative store; just
  don't drop below 30 days for emergency local triage.

Set a tunable:

```sh
sqlite3 data/coordinator.db <<'SQL'
INSERT INTO org_settings (org_id, key, value, updated_at)
VALUES (NULL, 'audit_tier2_retention_days', '180', CURRENT_TIMESTAMP)
ON CONFLICT(org_id, key) DO UPDATE
  SET value = excluded.value, updated_at = excluded.updated_at;
SQL
```

NOTE: change takes effect on the next sweep tick (≤ 60s). No restart
required; `getOrgSetting` is read per-tick from
`src/sweeper/index.ts:128`.

## Failure modes

- **Sweeper not running**: rows accumulate past retention. Confirm
  `coordinator_sweeper_last_run_timestamp` updates every 60s and that
  `coordinator_sweeper_circuit_open` is `0`. See
  `docs/ops/sweeper-circuit-recovery.md`.

- **Aggressive tunable lowering**: setting `audit_retention_days` from
  365 to 30 schedules a large delete; the sweeper batches 1000 rows
  per pass with 3 chained runs per tick (= 3000 rows / minute). For a
  large catch-up, the chained pass mechanism in
  `src/sweeper/index.ts:107-112` is what drains the backlog.

- **`metadata_json` bloat**: a future regression that puts large
  payloads into `metadata_json` would invalidate the 500-byte
  per-row assumption. Re-measure with `dbstat` if you change
  `audit()` callers.

- **WAL growth during a large delete**: a 365 → 30 day retention
  change may produce a large WAL. See `docs/ops/sqlite-operations.md`
  for the manual `PRAGMA wal_checkpoint(TRUNCATE)` procedure.
