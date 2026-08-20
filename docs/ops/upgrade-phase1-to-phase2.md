# Upgrade v0.7.0 -> v0.8.0 (Phase 1 -> Phase 2)

mcp-coordinator v0.8.0 ships Phase 2 of the auth roadmap: OAuth 2.1 + RFC
8628 device flow, cookie sessions, service tokens, audit pipeline, and
sweeper. This guide walks v0.7.x deployments through the upgrade with a
focus on operator safety: the migration is non-destructive, fully
opt-in, and reversible.

References:

- CHANGELOG v0.8.0 -- enumerates every shipped surface
- `tests/backcompat/` -- 31 cases proving the upgrade is non-destructive
  (Phase 1 endpoints, JWTs, and SQL views remain functional when Phase 2
  is disabled)
- `docs/onboarding-self-host.md` -- the green-field setup walkthrough,
  referenced from §"Activate Phase 2" below

## TL;DR

Phase 2 is feature-flagged behind `COORDINATOR_OAUTH_ENABLED`. If you leave
the flag unset (or set to `false`), v0.8.0 behaves IDENTICALLY to v0.7.0:

- Same `/api/*` surface
- Same Phase 1 Bearer JWT verification (`COORDINATOR_AUTH_ENABLED` and
  `COORDINATOR_JWT_SECRET` semantics unchanged)
- Same MQTT / MCP / SSE behaviors
- No new endpoints exposed, no new cookies issued

The schema migration runs automatically on first start and is idempotent:
existing rows are preserved with column renames and backfills. The
`tests/backcompat/` suite is the source-of-truth for this guarantee:

- `phase1-feature-flag-off.test.ts` -- v0.8.0 binary with flag unset
  produces identical responses to v0.7.0 baselines
- `phase1-jwt-acceptance.test.ts` -- v0.7.0-issued JWTs still verify
- `phase1-migration.test.ts` -- v7 -> v8 migration is idempotent and
  preserves every row count and column value
- `phase1-compat-view.test.ts` -- `users_legacy_v0_7` view exposes the
  pre-rename column names read-only

Run them locally before upgrading:

```bash
pnpm test -- tests/backcompat
```

All 31 must pass.

## Pre-flight

### 1. Backup the database

```bash
cp data/coordinator.db backup/coordinator-pre-v0.8.db
```

SQLite is a single file; this is the only state that matters. If anything
goes wrong, restoring this file fully reverts the deployment.

### 2. Snapshot current env vars

```bash
env | grep COORDINATOR_ > backup/env-pre-v0.8
```

You will not need to change any existing env var to complete the upgrade
(unless you choose to activate Phase 2, in which case you ADD new vars).
Keeping a snapshot makes rollback a single copy.

### 3. Note the current version

```bash
mcp-coordinator --version    # expect 0.7.x
```

### 4. Run the backcompat suite

If you have a checkout, verify the test suite against your target version:

```bash
git fetch
git checkout v0.8.0
pnpm install --frozen-lockfile
pnpm test -- tests/backcompat
```

This validates that the upgrade path is non-destructive against a fresh
v7 schema. Operators with a heavily-customized DB schema should also dump
the schema before and after migration:

```bash
sqlite3 data/coordinator.db .schema > schema-pre-v0.8.sql
```

## Update

### npm-installed deployments

```bash
mcp-coordinator server stop          # graceful SIGTERM
npm install -g mcp-coordinator@0.8.0
mcp-coordinator --version            # expect 0.8.x
```

### Source checkout

```bash
git fetch --tags
git checkout v0.8.0
pnpm install --frozen-lockfile
pnpm build
```

### Docker

Pull the new image tag and recreate the container with the same volume
mount:

```bash
docker pull mcp-coordinator:0.8.0
docker compose up -d
```

## First boot (Phase 1 compatibility mode)

Start the coordinator without changing any env var:

```bash
mcp-coordinator server start
```

The boot path runs the v7 -> v8 schema migration automatically. Key changes:

### audit_log column renames (V4 FIX 1)

| Old name      | New name             |
|---------------|----------------------|
| `user_id`     | `actor_user_id`      |
| `org_id`      | `actor_org_id`       |
| `ip`          | `actor_ip`           |
| `user_agent`  | `actor_user_agent`   |
| `metadata`    | `metadata_json`      |

The Phase 1 `auditLog(ev)` helper continues to work via in-helper
translation -- application code that uses the helper is untouched. Direct
SQL consumers must update column references.

### users.org_id -> users.primary_org_id

Renamed to anticipate Phase 5 multi-org membership (each user can belong
to multiple orgs via the new `user_orgs` join table, with one designated
as primary).

A read-only compat view ships for Phase 1 SQL consumers:

```sql
CREATE VIEW users_legacy_v0_7 AS
  SELECT id, idp_provider, idp_user_id, email, name, role,
         primary_org_id AS org_id, created_at, last_login_at
  FROM users;
```

Application code that reads `users.org_id` directly fails the
`scripts/lint-no-users-org-id.sh` CI lint -- update to `primary_org_id`
or to the `users_legacy_v0_7` view explicitly.

### New columns on existing tables

`users`:
- `token_epoch INTEGER NOT NULL DEFAULT 0` -- bumped to invalidate all
  sessions instantly (logout-all + NR12 restore)
- `idp_access_token TEXT` (NULL for Phase 1 users)

`refresh_tokens`:
- `family_id` -- backfilled with a random hex string for legacy rows
- `parent_jti`, `replay_count`, `consumer_fingerprint`, `revoked_reason`

`device_auth_requests`:
- `requester_ip`, `requester_ua`, `requester_country`
- `failed_approval_attempts`, `denied_at`, `denied_reason`
- `last_polled_at`, `interval`, `approved_at`

`audit_log`:
- `request_id` -- correlation across async chains (T10 ALS)
- `outcome` -- backfilled to `'legacy_unknown'` for pre-migration rows

### New tables

- `user_orgs` -- 1:1 backfill from current `users.primary_org_id`
- `oauth_state` -- PKCE state CAS table (T06)
- `system_state` -- key/value store for global flags (e.g.
  `token_epoch_global` for NR12)

Phase 1 rows are not modified destructively. Every backfill uses safe
defaults so the migration is idempotent (`PRAGMA user_version` advances
from 7 to 8 on first apply; subsequent boots no-op).

## Verify Phase 1 still works

With `COORDINATOR_OAUTH_ENABLED` unset, exercise the Phase 1 surface:

```bash
# Health remains 200
curl http://localhost:3100/healthz
curl http://localhost:3100/health/ready

# Phase 1 endpoints unchanged
curl -X POST http://localhost:3100/api/register \
  -H "Authorization: Bearer ${PHASE1_JWT}" \
  -d '...'

# JWT issued before upgrade still verifies (per phase1-jwt-acceptance.test.ts)
```

The `tests/backcompat/` suite codifies this guarantee:

```bash
ppnpm test -- tests/backcompat/phase1-feature-flag-off
ppnpm test -- tests/backcompat/phase1-jwt-acceptance
```

Both must pass. If they fail on your deployment, restore from backup and
file an issue.

## Activate Phase 2 (optional)

Phase 2 activation is decoupled from the upgrade. You can run on v0.8.0 with
the flag off for as long as you want, then enable Phase 2 on a future restart.

To activate, follow `docs/onboarding-self-host.md` from §2 onward. The
short version:

1. Create a GitHub OAuth app (`docs/onboarding-self-host.md` §2)
2. Set the 5 required env vars:
   - `COORDINATOR_OAUTH_ENABLED=true`
   - `COORDINATOR_PUBLIC_URL`
   - `COORDINATOR_JWT_SECRET` (entropy-validated; >=32 random bytes)
   - `COORDINATOR_GITHUB_CLIENT_ID`
   - `COORDINATOR_GITHUB_CLIENT_SECRET`
   - `COORDINATOR_GITHUB_ORG`
3. Restart
4. First user to sign in via OAuth becomes admin atomically (T16b + V4 FIX 24)

## Rollback

If Phase 2 misbehaves and you need to revert to v0.7.0:

```bash
mcp-coordinator server stop
cp backup/coordinator-pre-v0.8.db data/coordinator.db
npm install -g mcp-coordinator@0.7.0
mcp-coordinator server start
```

Restoring the pre-upgrade DB is the safer rollback path: the v8 schema
has columns and tables that v0.7.0 silently ignores when reading, but
writes from v0.7.0 against a v8 schema can produce surprising column
defaults. Always restore the v7-shaped DB before downgrading the binary.

If you must keep the v8 schema but downgrade the binary anyway (e.g. data
written during a brief Phase 2 trial you want to preserve), v0.7.0 reads
through the `users_legacy_v0_7` compat view and operates on it correctly.
The new Phase 2 columns (`token_epoch`, `idp_access_token`, etc.) are
ignored. Avoid this unless absolutely necessary.

## Verification queries

After migration, the following queries verify the upgrade completed cleanly:

```sql
-- Schema version advanced to 8
PRAGMA user_version;
-- expect 8

-- Compat view returns all users
SELECT COUNT(*) FROM users_legacy_v0_7;
-- expect same as SELECT COUNT(*) FROM users

-- Phase 1 audit rows tagged 'legacy_unknown'
SELECT COUNT(*) FROM audit_log WHERE outcome = 'legacy_unknown';
-- expect: pre-migration audit row count

-- All refresh_tokens backfilled with family_id
SELECT COUNT(*) FROM refresh_tokens WHERE family_id IS NULL;
-- expect 0

-- token_epoch initialized
SELECT COUNT(*) FROM users WHERE token_epoch IS NULL;
-- expect 0

-- New tables exist and are empty (no Phase 2 traffic yet)
SELECT COUNT(*) FROM oauth_state;          -- expect 0
SELECT COUNT(*) FROM user_orgs;            -- expect same as users count
SELECT COUNT(*) FROM system_state;         -- expect 0 or 1 (boot epoch)
```

If any count is unexpected, stop the coordinator, restore from backup,
and file an issue with the unexpected values and your prior schema dump.

## Open Phase 2 considerations

### audit_log row growth

Once Phase 2 is enabled, the audit pipeline produces Tier 2 rows for
every refresh rotation, every login, every device-flow approval, etc.
Default retention is 90 days; tune via `COORDINATOR_AUDIT_TIER2_RETENTION_DAYS`.

Tier 1 events (admin actions, config changes, boot, security-critical)
default to 365 days and are written synchronously -- they survive process
crashes by design.

### Phase 1 JWTs under Phase 2

Phase 1 JWTs continue to verify under Phase 2 (the four-scenario
authentication path from v0.7.0 is preserved as Scenarios 1-4; Phase 2
adds Scenario 5 for cookie sessions). However, Phase 1 JWTs lack
`family_id` and `active_org_id` claims, so they cannot be rotated via
`POST /api/auth/oauth/token` with `grant_type=refresh_token`.

The recommended path: have Phase 1 users sign in once via OAuth after
activation. The fresh tokens carry the Phase 2 claims and rotate cleanly.
Phase 1 Bearer tokens age out naturally as `COORDINATOR_JWT_EXPIRY`
elapses.

### Sweeper retention bucket choice

The sweeper runs **11 DELETE passes over 9 tables** every 60 s, at most
1000 rows per table per pass and at most 3 chained passes per tick. Six of
the buckets are the Phase 2 auth tables this guide is about; the other five
hold coordination data and apply to **every** deployment, Phase 2 or not:

| # | Bucket                       | Default | Env var                              |
|---|------------------------------|---------|--------------------------------------|
| 1 | oauth_state                  | `expires_at` + 60 s | (hardcoded, RFC 6749 §10.5 ceiling) |
| 2 | device_auth_requests         | `expires_at` + 60 s | (hardcoded)                 |
| 3 | refresh_tokens (revoked)     | 180d    | `COORDINATOR_REFRESH_RETENTION_DAYS` |
| 4 | refresh_tokens (expired, never revoked) | 30d | (hardcoded, orphan-row cap) |
| 5 | audit_log Tier 1             | 365d    | `COORDINATOR_AUDIT_RETENTION_DAYS`   |
| 6 | audit_log Tier 2             | 90d     | `COORDINATOR_AUDIT_TIER2_RETENTION_DAYS` |
| 7 | file_activity                | 7d      | `COORDINATOR_FILE_ACTIVITY_RETENTION_DAYS` |
| 8 | events                       | 7d      | `COORDINATOR_EVENTS_RETENTION_DAYS`  |
| 9 | thread_messages              | 30d     | `COORDINATOR_THREAD_MESSAGES_RETENTION_DAYS` |
| 10 | action_summaries            | 30d     | `COORDINATOR_ACTION_SUMMARIES_RETENTION_DAYS` |
| 11 | layer_firings               | 30d     | `COORDINATOR_LAYER_FIRINGS_RETENTION_DAYS` |

For regulated workloads consider raising the Tier 1 audit window to match
your retention policy. See `docs/gdpr.md` for the GDPR / SOC 2 tension
around audit-log immutability.

Two properties of the audit buckets are worth knowing before you tune them.
Both `audit_log` passes delete by **literal action-name membership** in the
Tier 1 / Tier 2 lists in `src/security/audit-events.ts` -- an action in
neither list is never swept at any age, which is deliberate (an unclassified
event is kept rather than silently dropped) and means `audit_log` can grow
past both windows. And sweeping audit rows breaks the hash chain by design;
see `docs/ops/audit-integrity.md` before pointing `verify-audit-chain` at a
swept database.

See [Data retention](../../README.md#data-retention) in the README for what
the five coordination buckets mean for a self-hoster, and for the tables
that are **never** swept.
