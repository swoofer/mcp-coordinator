# Operations — admin UI

This runbook describes how operators bootstrap, use, and recover the
browser-based admin console shipped in mcp-coordinator v0.10.6+. The
console covers organization management, user role changes, and
allowlist configuration — all backed by audited `/api/admin/*`
endpoints behind a Phase 2 JWT + CSRF + rate-limit chain.

References:

- `src/routes/admin.ts` — endpoint handlers (`/api/admin/orgs`,
  `/api/admin/users`).
- `src/auth/csrf.ts` — double-submit CSRF token issued on login.
- `src/auth/rate-limit.ts` — per-IP token bucket (`RateLimiter`).
- `src/security/audit-events.ts` — `admin.org.*`,
  `admin.user.role_changed`, `admin.orgs.duplicate_names_accepted`.
- `docs/onboarding-self-host.md` — first-boot bootstrap + endpoint
  reference card.
- `docs/security/threat-model.md` — Asset 7 (operator surface) —
  why the admin UI introduces no new threats.
- `dashboard/admin.html` — static page served from the dashboard
  bundle.

> **v0.10.6 scope.** The admin UI manages **orgs** and **user roles**.
> Service-token issuance, audit log inspection, and refresh-token
> revocation remain CLI-only in this release; the UI surface is
> intentionally minimal so each addition gets its own audit-event +
> rate-limit review. See "What's NOT in v0.10.6" below.

## Overview

### What the admin UI lets you do

- List and create organizations (`organizations` table).
- Edit org allowlists (`allowlist_github_org`, `allowlist_idp_org_id`).
- Set org status (active / inactive).
- List users with their current org and role.
- Promote a user to `admin` or demote back to `member`.

### What it does NOT do

- It does NOT issue, list, or revoke service tokens — use
  `mcp-coordinator service-token {issue,list,revoke}`.
- It does NOT show the audit log inline — query SQLite directly
  (examples below).
- It does NOT manage encryption keys or run migrations — use the
  encryption CLI (`docs/ops/encryption-key-management.md`).
- It does NOT cover refresh-token revocation — use the existing
  `auth.refresh.chain_revoked` flow.

### Trust model

Every endpoint under `/api/admin/*` is gated by, in order:

1. Phase 2 JWT verification (`authenticateRequest`).
2. Explicit role check — must be `role = 'admin'`.
3. CSRF double-submit on mutations (`POST` / `PATCH`).
4. Per-IP rate limit on mutations (30 / minute).

Reads (`GET`) skip the CSRF + rate-limit checks but still require the
admin role. See `docs/security/threat-model.md` Asset 7 (operator
surface) for the full STRIDE walk.

## Initial setup

### Bootstrap admin

The **first** user to complete the OAuth flow on a fresh deployment is
promoted to `role = 'admin'` automatically (T16b atomic check; V4 FIX
24 guarantees exactly one admin under concurrent first-time logins).
There is no separate admin-creation step.

```sh
# Browse to your deployment's login page:
xdg-open "${COORDINATOR_PUBLIC_URL}/auth/login"
```

After landing on `/auth/success`, confirm the role:

```sql
SELECT id, idp_provider, role
FROM users
WHERE role = 'admin';
-- expect exactly one row on a fresh deployment
```

### Navigate to the admin console

```
${COORDINATOR_PUBLIC_URL}/dashboard/admin.html
```

The page is served statically with:

- `Content-Security-Policy: default-src 'self'`
- `X-Frame-Options: DENY` (no iframe embedding)
- no `Access-Control-Allow-Origin` (no cross-origin reads)

The page itself contains no secrets — it fetches data at runtime via
the authenticated `/api/admin/*` endpoints, sending the session cookie
and the CSRF token issued on login.

## Daily usage

### Manage organizations

From the admin console:

- **Create**: pick a name and (optionally) one or both allowlist
  values. The handler accepts duplicate names but logs
  `admin.orgs.duplicate_names_accepted` so an operator can later
  reconcile. Org IDs are server-assigned.
- **Edit**: change the display name, toggle status, or update the
  allowlists. Last writer wins on concurrent edits — see "Stale-state
  behavior" below.
- **Inactivate** rather than delete. The schema preserves history;
  `status = 'inactive'` blocks new logins to that org while keeping
  audit references intact.

### Manage user roles

From the admin console:

- Locate the user (search by email or primary org).
- Toggle role between `admin` and `member`. The change is committed
  inline and emits `admin.user.role_changed` (Tier 1 audit).

The "last-admin protection" rule (next section) applies on demote.

### Allowlist semantics

The `organizations` table carries two independent allowlist columns —
they answer different questions and are NOT redundant:

- **`allowlist_github_org`** — the GitHub *organization login*
  (e.g. `acme-co`) the user must be a public or visible member of, as
  reported by GitHub's `read:org` scope. Used by the
  `memberships` strategy. Set this when you are gating on
  *GitHub-side org membership*.
- **`allowlist_idp_org_id`** — the IdP-issued organization ID (e.g.
  the `org_id` claim returned by an OIDC provider, or a Google
  Workspace `hd` domain). Used by the `idp_org_id` strategy. Set this
  when the IdP itself is your source of truth for "who belongs in
  this organization".

Set one or both depending on which providers you have wired:

| Provider type    | Typical column to populate          |
| ---------------- | ----------------------------------- |
| GitHub OAuth     | `allowlist_github_org`              |
| Google Workspace | `allowlist_idp_org_id` (the `hd`)   |
| Generic OIDC     | `allowlist_idp_org_id`              |
| GitHub App       | `allowlist_github_org`              |

If both columns are set, BOTH must match for a user to be admitted —
the strategies AND together. Leave a column NULL if you do not want it
to participate in the check.

## Rate limit behavior

Mutations (`POST` / `PATCH` under `/api/admin/*`) are gated by a
shared per-IP token bucket: **30 requests / minute**. Exceeding the
quota returns:

```
HTTP/1.1 429 Too Many Requests
Retry-After: <seconds>
Content-Type: application/json

{"error":"rate_limit_exceeded"}
```

The bucket is keyed by the client IP (`X-Forwarded-For` after the
reverse-proxy trust list applies). The admin UI does not auto-retry;
operators driving bulk updates from a script should sleep between
calls or batch via direct SQL.

Reads are unthrottled — list endpoints can be polled freely.

## Last-admin protection

The role-change handler refuses to demote the only remaining admin:

```
HTTP/1.1 409 Conflict
Content-Type: application/json

{"error":"last_admin_demotion_blocked"}
```

This is intentional — total admin lockout is the worst-case operator
state because recovery requires direct SQL (see "Disaster recovery"
below).

### How to demote yourself safely

1. Promote at least one other user to `admin` first.
2. Confirm via `SELECT COUNT(*) FROM users WHERE role = 'admin'` — the
   count must be `>= 2`.
3. Then demote yourself. The handler now permits the change.

This also applies to the bootstrap admin. If you are the bootstrap
admin and want to hand off, promote your successor before demoting
yourself.

## Audit log

Every successful admin mutation writes a Tier 1 audit row (synchronous,
never dropped, covered by the SHA-256 hash chain — see
`docs/ops/audit-integrity.md`). Query examples:

### All admin actions in the last day

```sql
SELECT ts, actor_user_id, action, target_id, outcome, metadata
FROM audit_log
WHERE action LIKE 'admin.%'
  AND ts > strftime('%s','now') - 86400
ORDER BY ts DESC;
```

### Who changed which user's role

```sql
SELECT ts, actor_user_id, target_id, metadata
FROM audit_log
WHERE action = 'admin.user.role_changed'
ORDER BY ts DESC
LIMIT 50;
```

### Org create / update history for one org

```sql
SELECT ts, actor_user_id, action, metadata
FROM audit_log
WHERE action LIKE 'admin.org.%'
  AND target_id = '<org_id>'
ORDER BY ts ASC;
```

### Duplicate-name acceptances

```sql
SELECT ts, actor_user_id, metadata
FROM audit_log
WHERE action = 'admin.orgs.duplicate_names_accepted'
ORDER BY ts DESC;
```

Event reference:

| Action                                  | Tier | Emitted when                                  |
| --------------------------------------- | ---- | --------------------------------------------- |
| `admin.org.created`                     | 1    | `POST /api/admin/orgs` succeeds               |
| `admin.org.updated`                     | 1    | `PATCH /api/admin/orgs/:id` succeeds          |
| `admin.user.role_changed`               | 1    | `PATCH /api/admin/users/:id` changes role     |
| `admin.orgs.duplicate_names_accepted`   | 1    | Org create accepted a name already in use     |
| `admin.access.denied`                   | 2    | Non-admin caller hit an `/api/admin/*` route  |

## Stale-state behavior

The admin endpoints do not implement optimistic concurrency control.
If two admins edit the same org row concurrently:

- The HTTP layer serialises requests through SQLite's write lock.
- The **last writer wins** at the row level — there is no
  `If-Match` / `ETag` check.
- BOTH writes emit independent `admin.org.updated` audit rows, so the
  history is preserved even though only the second update is visible
  in the current row.

To reconcile a confused state, read the audit history for the org
(see "Org create / update history for one org" above) and replay the
intended end-state manually. The audit hash chain guarantees the
sequence is tamper-evident.

For user role changes the same rule applies — last writer wins, with
both transitions audited. The last-admin guard reads the live
`COUNT(*)` of admins inside the same transaction as the demote, so
two concurrent demote attempts cannot race past it (one will see
`COUNT(*) = 1` and refuse).

## Disaster recovery

### Locked out of the admin role

You signed out and there is no admin user — or the only admin's
account is disabled — and the admin UI now refuses every request.
Recover via direct SQL on the SQLite file:

```sh
# Stop the daemon first to avoid write contention:
mcp-coordinator server stop

# Promote yourself by email. The users.role column is plain TEXT,
# no encryption gate.
sqlite3 ~/.mcp-coordinator/coordinator.db \
  "UPDATE users SET role = 'admin' WHERE email = '<your-email>';"

# Restart:
mcp-coordinator server start
```

After the restart, log in normally and use the admin UI to verify
the role change took effect (`GET /api/admin/users`). This SQL
fallback works because:

- `users.role` is a plain TEXT column with no encryption (only the
  IdP token columns are encrypted in v0.10.5+).
- The role check at `/api/admin/*` reads `users.role` on every
  request — there is no in-memory cache that would stale the
  promotion.
- The audit chain remains intact because no rows were deleted; the
  promotion is simply unaudited (it bypassed the admin endpoint).

**Recommended follow-up**: write a Tier 1 audit row by hand so the
unaudited promotion is at least recorded in-band:

```sql
INSERT INTO audit_log (ts, actor_user_id, action, target_id, outcome, metadata)
VALUES (strftime('%s','now'), '<your_user_id>', 'admin.user.role_changed.manual',
        '<your_user_id>', 'success',
        json_object('reason', 'disaster_recovery_sql_fallback'));
```

This row will pick up `prev_hash` + `row_hash` from the chain trigger
on the next normal write. Document the recovery in your operations
journal.

### Admin UI returns 500 / blank page

1. Confirm the daemon is up (`/healthz`), Phase 2 is on
   (`COORDINATOR_OAUTH_ENABLED=true`), and your session reports
   `role: 'admin'` via `/api/auth/me`.
2. Check the daemon log for `admin.*` lines around the failed request.
   Most failures surface as 403 (CSRF / role) or 500 (handler bug —
   file a bug report with the request id).

### Admin UI 429s every request

You hit the per-IP rate limit. Wait `Retry-After`, or bypass the UI
with direct SQL for bulk work — record an out-of-band note since the
per-row `admin.org.*` audit events will be missing.

## What's NOT in v0.10.6

The following are deliberately out of scope and tracked for later
releases:

- **Service-token management in the UI** — use the
  `mcp-coordinator service-token` CLI.
- **Audit-log viewer inline** — query SQLite (examples above) or
  scrape `/metrics/auth` for counters.
- **Optimistic concurrency control** — no `If-Match` / `ETag`. Last
  writer wins; audit log preserves history.
- **Bulk operations** — one row at a time. For bulk changes, drop to
  SQL with operator approval.
- **Per-admin scoping** — all admins are equal; no "org admin" vs
  "global admin" distinction in v0.10.6.

## Open gaps tracked for later releases

- `mcp-coordinator admin doctor` CLI for admin count, last `admin.*`
  audit timestamp, and per-IP rate-limit occupancy.
- ETag / If-Match on PATCH endpoints to detect stomped concurrent
  edits before commit.
- In-UI service-token issuance and audit-log viewer.

## Closed in v0.10.6

- Browser-based admin console at `/dashboard/admin.html`. ✓
- `/api/admin/orgs` (GET, POST, PATCH) endpoints. ✓
- `/api/admin/users` (GET, PATCH) endpoints. ✓
- CSRF double-submit on admin mutations. ✓
- Per-IP rate limit of 30 mutations / minute. ✓
- Last-admin demote protection. ✓
- Tier 1 audit events: `admin.org.created`, `admin.org.updated`,
  `admin.user.role_changed`, `admin.orgs.duplicate_names_accepted`. ✓
- CSP + `X-Frame-Options: DENY` + no ACAO on the static admin page. ✓
