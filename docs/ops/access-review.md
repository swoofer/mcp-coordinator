# Operations — Quarterly Access Review

This runbook describes the recurring privilege-review procedure for the
mcp-coordinator Phase 2 deployment. It enumerates every principal that
can authenticate to the coordinator (interactive users, admins, service
tokens), the SQL needed to enumerate them, and the promotion/demotion
flow.

References:

- `src/auth/oauth-callback.ts` — first-user bootstrap admin assignment
  (audit `auth.admin.bootstrapped`, `auth.bootstrap.admin_assigned`).
- `src/auth/service-tokens.ts` — service-token mint + revoke flow
  (audit `auth.service_token.issued`, `auth.service_token.revoked`,
  `auth.service_token.used`).
- `src/security/audit-events.ts` — Tier 1 / Tier 2 inventory.
- `docs/security/threat-model.md` — Asset 3 (admin credentials).
- SOC 2 CC6.2 (logical access provisioning and de-provisioning).

## TL;DR

Run the access review every 90 days. The procedure is: enumerate
admins, members, and service tokens via SQL; cross-reference with HR
data (departures, role changes); demote or revoke anything that no
longer maps to an authorised owner; confirm each action emits the
expected Tier 1 audit row. Document the run in your compliance system
with the date, the principal who ran it, and the SQL output snapshots.

## Background

Phase 2 has three classes of principal that can authenticate:

1. **Admins** — `users.role = 'admin'`. Can manage service tokens, run
   `/api/reset` (when `COORDINATOR_AUTH_ENABLED=true`), and view
   privileged surfaces.
2. **Members** — `users.role = 'member'`. Standard interactive users
   provisioned via the GitHub OAuth flow when their account is in the
   allow-listed org.
3. **Service tokens** — long-lived bearer credentials minted by an
   admin via the service-token API. Stored hashed in
   `service_tokens`; one row per active token.

A quarterly review of all three is required by SOC 2 CC6.2. The
coordinator does not auto-demote on inactivity (Phase 2 single-tenant
design); demotion is an explicit operator action.

## Procedure

### 1. Snapshot the current population

```sh
sqlite3 data/coordinator.db <<'SQL'
.mode column
.headers on
SELECT id, github_login, role, created_at, last_login_at
FROM users
WHERE role = 'admin'
ORDER BY created_at;

SELECT id, github_login, role, created_at, last_login_at
FROM users
WHERE role = 'member'
ORDER BY github_login;

SELECT id, name, scope, created_at, revoked_at, last_used_at
FROM service_tokens
WHERE revoked_at IS NULL
ORDER BY scope, created_at;
SQL
```

Save the three result sets to your compliance evidence store with the
date prefix (e.g., `access-review-2026Q2-admins.csv`).

### 2. Cross-reference with authoritative HR data

For each row in the three lists above, verify:

- **Admins**: principal is still employed in a role that requires
  coordinator-admin privileges.
- **Members**: principal is still in the allow-listed GitHub org. If
  the GitHub org membership has been removed, the user can no longer
  log in interactively, but their row is preserved (NR12 design) — flag
  for archival.
- **Service tokens**: each `name` maps to a documented system /
  pipeline owner. Tokens with no documented owner are revoked.

### 3. Demote / revoke

Demote an admin to a member:

```sh
sqlite3 data/coordinator.db \
  "UPDATE users SET role = 'member' WHERE github_login = 'alice';"
```

NOTE: the coordinator does not emit a dedicated audit row for in-place
role changes today (the `auth.admin.bootstrapped` row only fires on
first-user bootstrap). Document the change manually in the compliance
log and re-run the snapshot in step 1 to confirm.

Revoke a service token:

```sh
mcp-coordinator service-token revoke --id <token_id>
```

Expected audit row (Tier 1, synchronous, never dropped):

```sql
SELECT created_at, action, target, outcome
FROM audit_log
WHERE action = 'auth.service_token.revoked'
ORDER BY created_at DESC LIMIT 5;
```

### 4. Verify token-epoch invalidation

When a user is demoted from admin to member, their existing JWTs still
carry `role: admin` until expiry. If immediate cutoff is required, bump
their `token_epoch`:

```sh
sqlite3 data/coordinator.db \
  "UPDATE users SET token_epoch = token_epoch + 1 WHERE github_login = 'alice';"
```

The next request from that user's existing access token will return 401
once `src/auth/token-epoch.ts` reads the bumped epoch. The user must
re-authenticate via `/auth/login` to obtain a member-scoped token.

## Verification

After completing the review, confirm the expected audit trail is
present:

```sh
sqlite3 data/coordinator.db <<'SQL'
SELECT action, COUNT(*) AS n, MAX(created_at) AS last
FROM audit_log
WHERE action IN (
  'auth.service_token.issued',
  'auth.service_token.revoked',
  'auth.admin.bootstrapped',
  'auth.bootstrap.admin_assigned'
)
  AND created_at > datetime('now', '-100 days')
GROUP BY action;
SQL
```

Scrape the Prometheus registry for the service-token activity counters
(see `src/observability/metrics.ts`):

```sh
curl -s http://localhost:8765/metrics/auth | grep -E \
  'coordinator_auth_service_token_(issued|revoked|used)_total'
```

The `issued + revoked` deltas since the last review should account for
every change you made in step 3.

## Failure modes

- **Stale `last_login_at`**: the column is only updated on a successful
  interactive login. A user who never logs in (e.g., service-token
  owner) will show a `NULL` or very old timestamp; do not interpret
  this as inactivity for service-token owners.
- **Service-token usage sampling**: `auth.service_token.used` is
  sampled at most once per hour per token to avoid audit-log
  amplification (see Tier 2 events). The `last_used_at` column on
  `service_tokens` is the authoritative recency signal.
- **Bootstrap admin lingering**: the first user who completes the
  OAuth flow is auto-promoted to admin
  (`auth.admin.bootstrapped` audit row). If that operator has since
  left the team, ensure another admin exists BEFORE demoting them, or
  the deployment becomes admin-less and cannot mint new admins without
  direct SQL access.

## Cadence

| Cadence            | Action                                              |
| ------------------ | --------------------------------------------------- |
| Quarterly          | Full review per this runbook                        |
| On operator depart | Immediate review + epoch bump for departing admin   |
| On suspected abuse | Ad-hoc review + service-token rotation              |

The quarterly cadence is the SOC 2 CC6.2 minimum; tighter cadence is
encouraged for deployments with > 10 admins.
