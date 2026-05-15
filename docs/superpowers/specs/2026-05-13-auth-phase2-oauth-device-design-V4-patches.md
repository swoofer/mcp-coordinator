# Phase 2 Spec V4 — Patches & Additions

**Date**: 2026-05-13
**Status**: Final patches post 20-agent Round 3 review
**Supersedes specific sections of**: `2026-05-13-auth-phase2-oauth-device-design.md` (the main spec)
**Read order**: main spec first, then this patch doc

## Purpose

Round 3 (20 agents) found ~25 mechanical issues in the spec text — no structural design problems, but text-level bugs, orphan references, missing pseudo-code, and over-engineering in 2 specific areas. V4 = patches to close those before implementation plan. No new design decisions.

V4 also resolves 3 gaps that blocked the implementation planner (`getStoredIdpToken` storage, service token endpoint, rate-limit module contract).

---

## Honest cuts (contrarian-driven, justified)

Two V3 decisions were over-engineered. V4 cuts them:

### CUT 1: `token_epoch` LRU cache (§9.5)

**V3 had**: in-memory LRU 60s + multi-instance broken anyway.
**V4 replaces with**: direct SQLite `SELECT token_epoch FROM users WHERE id=?` per `authenticateRequest`.

**Justification**: better-sqlite3 sync read on indexed PK = ~50-100µs. p99 auth check stays well under 5ms. No cache invalidation problem. Phase 5 multi-instance unchanged (every instance reads from shared DB). **Simpler, correct, no perf regression.**

**Spec patch (§9.5)**:
```
Replace lines around "token_epoch (LRU cache 60s)" with:

// 4. token_epoch check — direct DB read (one SELECT per request, indexed PK)
const epoch = db.prepare("SELECT token_epoch FROM users WHERE id = ?")
                .get(payload.user_id)?.token_epoch ?? 0;
if (payload.iat < epoch) throw new TokenRevokedError();  // strict, no leeway

// No cache. Phase 2 = single-process; Phase 5 multi-instance = same shared SQLite/Postgres.
```

Remove `tokenEpochCache` references throughout (§6.8 logout-all `tokenEpochCache.invalidate(:user_id)` line is also dropped; no cache to invalidate).

§15.6 coverage floor `src/auth/token-epoch.ts` becomes `src/auth/token-epoch.ts` (just the SELECT helper + bump SQL), still 100% coverage.

### CUT 2: HMAC-bound CSRF "optional second layer" (§9.3)

**V3 had**: random double-submit + optional HMAC binding to session jti.
**V4 keeps**: random double-submit only.

**Justification**: SameSite=Strict + `__Host-` + CSP `script-src 'none'` already closes CSRF threat model. The HMAC layer's claimed defense (same-site XSS chained CSRF) requires CSP bypass — which is the threat we're already preventing. HMAC adds key derivation + management for marginal benefit. **Drop.**

**Spec patch (§9.3)**:
```
CSRF token = crypto.randomBytes(32).toString('base64url')  // random, 256 bits
Cookie: __Host-coordinator_csrf=token (Secure, SameSite=Strict, HttpOnly=false, Path=/)
Form: <input type="hidden" name="_csrf" value="{token}">
Server validation:
  cookie_val = req.cookies['__Host-coordinator_csrf']
  form_val   = req.body['_csrf']
  if !crypto.timingSafeEqual(Buffer.from(cookie_val), Buffer.from(form_val)) return 403
  // No HMAC layer. SameSite=Strict + __Host- + CSP do the work.
```

Remove `COORDINATOR_CSRF_HMAC_KEY` env var from §12.1 (and HKDF derivation from §13.4).

`constant_time_eq` uses Node's `crypto.timingSafeEqual` with length pre-check (per Round 3 crypto agent).

---

## Structural bug fixes (BLOCKERS for impl)

### FIX 1: audit_log column rename in migration (§4.1)

**Bug**: §11.1 schema uses `actor_user_id`, `actor_org_id`, `actor_ip`, `actor_user_agent`, `metadata_json`. §4.1 DDL only adds `request_id` + `outcome`. Phase 1 had `user_id`, `org_id`, `ip`, `user_agent`, `metadata`. No RENAME in migration.

**Fix — add to §4.1 migration block** (before `PRAGMA user_version = 8`):
```sql
-- audit_log column renames (Phase 1 → Phase 2 schema alignment)
ALTER TABLE audit_log RENAME COLUMN user_id    TO actor_user_id;
ALTER TABLE audit_log RENAME COLUMN org_id     TO actor_org_id;
ALTER TABLE audit_log RENAME COLUMN ip         TO actor_ip;
ALTER TABLE audit_log RENAME COLUMN user_agent TO actor_user_agent;
ALTER TABLE audit_log RENAME COLUMN metadata   TO metadata_json;

-- Backfill outcome for Phase 1 rows so SOC 2 evidence queries don't silently miss legacy data
UPDATE audit_log SET outcome = 'legacy_unknown' WHERE outcome IS NULL;
INSERT INTO audit_log (id, action, outcome, metadata_json, created_at)
  VALUES (lower(hex(randomblob(16))), 'migration.audit_backfill', 'success',
          json_object('rows_marked_legacy', changes()), strftime('%s','now'));
```

### FIX 2: PRAGMA foreign_keys toggle around migration (§4.1)

**Bug**: `ALTER TABLE ... RENAME COLUMN` + active FKs can fail in SQLite.

**Fix — wrap §4.1 BEGIN/COMMIT**:
```sql
PRAGMA foreign_keys = OFF;
BEGIN;
  -- (all ALTER + CREATE + UPDATE statements as currently in §4.1)
  PRAGMA user_version = 8;
COMMIT;
PRAGMA foreign_keys = ON;
```

### FIX 3: ON DELETE policy on user_orgs FKs (§4.1)

**Bug**: SQLite default `NO ACTION` → orphan risk.

**Fix — update user_orgs CREATE TABLE in §4.1**:
```sql
CREATE TABLE IF NOT EXISTS user_orgs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL REFERENCES orgs(id)  ON DELETE RESTRICT,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','service')),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
```

Rationale: user delete cascades to memberships (GDPR Art. 17 friendly); org delete restricts (prevents accidental org deletion while users exist).

### FIX 4: getStoredIdpToken storage (NEW — was undefined)

**Bug**: §10 step 7 calls `getStoredIdpToken(row.user_id)` but no DDL.

**Fix — add column to users table in §4.1 migration**:
```sql
ALTER TABLE users ADD COLUMN idp_access_token TEXT;
-- Stores the most-recent IdP access token from OAuth callback.
-- Used by listMemberships() on every refresh rotation.
-- Plaintext in Phase 2; encrypted at-rest in v0.7.5 (SQLCipher whole-DB).
-- NEVER appears in JWTs, cookies, logs (NR4 redaction allowlist already covers it).
```

**Fix — add to §13.9 residual risks** (new bullet):
```
6. **IdP access token storage**: stored plaintext in `users.idp_access_token`. Risk: DB leak exposes user's GitHub OAuth grant (attacker can call GitHub API on user's behalf within scope/until grant revocation). Mitigation: file perms 0600 + NR4 redaction + scope minimization (read:user + user:email + read:org only). Resolution: v0.7.5 SQLCipher whole-DB encryption.
```

**Fix — at §6.3 OAuth callback step 4** (after exchangeCode):
```
// Persist IdP access token for use by refresh rotation
db.prepare("UPDATE users SET idp_access_token = ? WHERE id = ?")
  .run(access_token, user.id);
```

Where the value comes from: the `IdPProvider.exchangeCode` return type extends to `Promise<{ user: IdpUserInfo; accessToken: string }>` (was `Promise<IdpUserInfo>` — §5.1 patch).

### FIX 5: §10 step 9 TOCTOU race (rotation UPDATE missing concurrency guard)

**Bug**: `UPDATE refresh_tokens SET revoked_at=:now WHERE jti=?` — if revocation lands between reuse check (step 6) and rotation (step 9), normal rotation proceeds on already-revoked row.

**Fix — §10 step 9 WHERE clause**:
```
db.prepare(`
  UPDATE refresh_tokens
    SET revoked_at = :now, revoked_reason = 'rotated'
    WHERE jti = :jti AND revoked_at IS NULL
`).run({ now: now(), jti: claims.jti });
if (updated.changes !== 1) {
  // Race: revocation landed between steps. Treat as reuse.
  revokeFamilyForReuse(row.family_id, 'reuse_detected');
  throw new InvalidGrantError();
}
```

### FIX 6: parent_jti UNIQUE constraint (§4.1)

**Bug**: Successor lookup `SELECT WHERE parent_jti=?` returns undefined row if bug creates 2 children.

**Fix — replace idx_refresh_parent in §4.1**:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_parent
  ON refresh_tokens(parent_jti)
  WHERE parent_jti IS NOT NULL;
```

Partial unique index: NULL parent (root of family) allowed multiple times; non-NULL parent allowed at most once.

### FIX 7: Allowlist re-check in §10 grace re-mint branch

**Bug**: Step 6 grace branch returns cached successor without re-running step 8 (allowlist verification). User removed from org during 10s window keeps fresh access.

**Fix — §10 step 6 grace branch, before returning cached successor**:
```
if (successor && successor.consumer_fingerprint === fingerprint) {
  // Legitimate retry. Re-check allowlist before re-issuing.
  const memberships = await getMemberships(row.user_id, ...);
  const orgRow = lookupOrgByMemberships(memberships);
  if (!orgRow.length || orgRow[0].id !== successor.org_id) {
    db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='admin' WHERE jti=?")
      .run(now(), claims.jti);
    audit('auth.login.denied.not_in_org', tier: 1);
    throw new InvalidGrantError({ code: 'NOT_IN_ALLOWLIST' });
  }
  return mintTokenPair(successor);
}
```

### FIX 8: Orphan audit events reconciliation (§11.2)

**Bug A**: `auth.refresh.reuse_detected` listed in §11.2 inventory but never emitted in §10 code. Only `auth.refresh.chain_revoked` and `auth.refresh.suspicious_replay` fire.

**Fix A — §11.2 inventory**: remove `auth.refresh.reuse_detected` row entirely (it was a duplicate concept of `chain_revoked`).

**Bug B**: `auth.legacy_token.accepted` emitted in §14.3 but not in §11.2 inventory.

**Fix B — §11.2 inventory**: add row:
```
| auth.legacy_token.accepted | 2 (async) | jti, org_claim, age_seconds |
```

**Bug C**: §5.3 cache code calls `metrics.idpStaleServedTotal.inc()` but never `audit('auth.idp.stale_served', ...)`.

**Fix C — §5.3 stale-on-error branch**:
```
audit('auth.idp.stale_served', { tier: 2, user_id, age_seconds: now() - cached.ts });
metrics.idpStaleServedTotal.inc();
return cached.memberships;
```

### FIX 9: /auth/dashboard route resolution

**Bug**: §6.3 success redirect target `/auth/dashboard` not in §1/§19 4-route cap.

**Fix — replace with `/auth/success`** (text-only page; passes the 4-route cap rule because /auth/login, /auth/device, /auth/device/confirm, /auth/device/approve are the 4):
```
Actually — the 4-route cap has POST /auth/device/approve which is non-HTML.
Three HTML pages + one POST = 4 routes.
/auth/success is a 5th. To stay within cap, change strategy:

Option (chosen): redirect to /api/auth/me instead. Browser shows raw JSON.
For better UX, ship a Phase 2 minimal /auth/success page as the 5th HTML route,
and update §1 + §19 anti-scope-creep rule to "5 HTML routes (login, device,
device/confirm, device/approve, success). 6th requires ADR."
```

**Fix chosen**: update §1 + §19 to allow 5 routes; ship `/auth/success` as static "Login successful. You can close this window." page (~10 lines HTML).

### FIX 10: Service token endpoint (NEW §5.5)

**Bug**: §1, §5, §11, §15 reference service tokens but no endpoint definition.

**Fix — add §5.5**:

```
### 5.5 Service token issuance

CLI verb (admin OAuth required):

  mcp-coordinator issue-service-token \
    --user=<id_or_github_login> --org=<id_or_name> \
    --scope=<read|write|admin> --ttl=<duration> --reason="<text>"

Endpoint backing the CLI: POST /api/admin/service-tokens
  Auth: Bearer or cookie (must have role='admin' in JWT claims)
  Body:
    {
      "user_id": "<uuid>",
      "org_id": "<uuid>",
      "scope": "read",         // enum: read, write, admin
      "ttl": "30d",            // duration; max "90d" enforced server-side
      "reason": "ci-deploy"    // required, ≥10 chars
    }
  Response (200):
    {
      "jti": "<jti>",
      "access_token": "<jwt>", // long-lived service JWT; show once only
      "expires_at": "2026-08-11T..."
    }

Server-side mint:
  1. Validate caller has admin role (claims.role === 'admin')
  2. Validate target user exists + belongs to org
  3. Validate ttl ≤ 90 days
  4. family_id = `service:${randomUUID()}`  // literal prefix, regex ^service:[0-9a-f-]{36}$
  5. INSERT INTO refresh_tokens (
       jti, user_id, org_id, family_id, parent_jti=NULL,
       consumer_fingerprint=NULL, expires_at=now+ttl,
       created_at=now, last_used_at=now
     )
  6. Mint JWT with claims:
       { sub, jti, family_id, iat, exp, iss, active_org_id,
         service_account: true, issued_by: caller_user_id, scope }
  7. audit('auth.service_token.issued', tier: 1, metadata: {
       issuer_admin_id, target_user_id, scope, ttl, reason
     })

CLI verb to list:
  mcp-coordinator list-service-tokens [--user=<id>] [--org=<id>] [--active-only]
  GET /api/admin/service-tokens?user=<id>&org=<id>&active=true
  Returns array of { jti, user_id, org_id, scope, ttl, issued_by, issued_at,
                     last_used_at, status: 'active'|'revoked'|'expired' }

CLI verb to revoke:
  mcp-coordinator revoke-service-token --jti=<jti>
  POST /api/admin/service-tokens/<jti>/revoke
  → UPDATE refresh_tokens SET revoked_at=now, revoked_reason='admin' WHERE jti=?
  → audit('auth.service_token.revoked', tier: 1, metadata: { revoked_by_admin_id })

Validation path (authenticateRequest for service-account JWTs):
  - JWT signature verified (HS256 pinned)
  - claims.service_account === true → DB lookup REQUIRED (overrides §9.5 trust-signature)
  - SELECT revoked_at FROM refresh_tokens WHERE jti = claims.jti
  - if revoked_at != NULL → 401
  - token_epoch check ALSO applies (admin can force-revoke user's all tokens incl. service)
  - audit('auth.service_token.used', tier: 2 sampled max 1/hr per token)

Service tokens NEVER rotate:
  - /api/auth/oauth/token grant=refresh_token with service token → 400 INVALID_GRANT
    "Service tokens do not rotate. Mint a new one via admin CLI."
```

### FIX 11: /revoke status code (§6.1 + §6.8)

**Bug**: §6.1 table says "204 / 200", §6.8 body says "Always return 200". RFC 7009 §2.2 mandates **200**.

**Fix — §6.1 table**: change `/api/auth/revoke` status from "204 / 200" to "200".

### FIX 12: Discovery doc token_endpoint_auth_methods (§6.10)

**Bug**: `"token_endpoint_auth_methods_supported": ["client_secret_post"]` describes GitHub upstream, not coordinator's own clients.

**Fix — §6.10**: change to:
```json
"token_endpoint_auth_methods_supported": ["none"],
```

Coordinator's clients (CLI / browser) are public per OAuth 2.1 — no client secret required.

### FIX 13: WWW-Authenticate exact format (NEW)

**Bug**: §3 hooks table mentions WWW-Authenticate but never pins format.

**Fix — add §6.0 "Common response headers"** (new subsection):

```
### 6.0.1 WWW-Authenticate (RFC 6750 §3)

All Bearer-protected endpoints emit this on 401:

  WWW-Authenticate: Bearer realm="coordinator"

  // For specific error cases:
  WWW-Authenticate: Bearer realm="coordinator",
                    error="invalid_token",
                    error_description="Token expired"

  WWW-Authenticate: Bearer realm="coordinator",
                    error="invalid_token",
                    error_description="Token revoked"

  WWW-Authenticate: Bearer realm="coordinator",
                    error="insufficient_scope",
                    scope="admin",
                    error_description="Admin scope required"

OAuth token endpoint (RFC 6749 §5.2) errors return HTTP 400 with JSON body
{error, error_description}. No WWW-Authenticate header on /api/auth/oauth/token
errors (that header is for resource-server 401, not authorization server 400).
```

### FIX 14: Rate-limit module contract (NEW §17.6)

**Bug**: NR11 lists limits but no implementation contract; planner blocked.

**Fix — add §17.6**:

```
### 17.6 Rate-limiting implementation

Module: `src/auth/rate-limit.ts`

Storage: in-memory `Map<string, BucketState>`, sweeper-cleaned every 60s
(removes buckets with `expires_at < now`).

API:
  interface RateLimiter {
    check(key: string, limit: { per: number; window_seconds: number }): RateLimitResult;
  }
  type RateLimitResult =
    | { allowed: true; remaining: number; reset_at: number }
    | { allowed: false; retry_after_seconds: number };

Algorithm: token bucket (refill rate = limit/window).

Key derivation (per endpoint):
  /auth/login          → `ip:${req.ip}`
  /api/auth/oauth/token (code) → `ip:${req.ip}`
  /api/auth/oauth/token (refresh) → `family:${row.family_id}` AND `ip:${req.ip}` (both must pass)
  /api/auth/oauth/device_authorization → `ip:${req.ip}` AND `ip-hourly:${req.ip}`
  /api/auth/oauth/token (device poll) → `device:${device_code}` (1/5s strict)
  /auth/device/approve → `ip:${req.ip}` AND `user:${claims.user_id}-hourly`
  /api/auth/logout-all → `user:${claims.user_id}-hourly`

Response on 429:
  Headers: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After
  Body: { code: "RATE_LIMITED", message: "Too many requests" }
  Metric: rate_limit_blocked_total{endpoint, identifier_type}

Login lockout (distinct from rate limit):
  Failed login (auth.login.failure OR auth.login.denied.not_in_org) increments
  `login_attempts{ip|identifier_hash}` counter. At threshold (default 5 in 15min),
  emit auth.login.locked and refuse the identifier for 15min (configurable per
  COORDINATOR_LOGIN_LOCKOUT_*). Counter resets on success.

  Storage: same in-memory Map; key prefix `lockout:`.
  Identifier: SHA-256(idp_user_login) if known, else `ip:${req.ip}`.

Phase 5 (multi-instance): swap in Redis-backed RateLimiter via dependency
injection; module interface unchanged.

Spec deliverable: `src/auth/rate-limit.ts` ≤200 LOC, 100% test coverage.
```

### FIX 15: Sweeper specifics (§17.7 NEW)

**Bug**: Sweeper referenced but algorithm undefined.

**Fix — add §17.7**:

```
### 17.7 Sweeper module

File: `src/sweeper/index.ts`

Tables swept (all with single DELETE LIMIT pattern):
  oauth_state         WHERE expires_at < (now - 60s buffer)
  device_auth_requests WHERE expires_at < (now - 60s)
  refresh_tokens      WHERE revoked_at IS NOT NULL AND revoked_at < now - REFRESH_RETENTION_DAYS
  refresh_tokens      WHERE revoked_at IS NULL AND expires_at < now - 30d (lingering expired)
  audit_log (Tier 2)  WHERE created_at < now - AUDIT_TIER2_RETENTION_DAYS AND tier = 2
  audit_log (Tier 1)  WHERE created_at < now - AUDIT_RETENTION_DAYS AND tier = 1
  rate_limit buckets  in-memory; sweeper removes expired entries

Cadence: setInterval 60s in main process.
Batch size: LIMIT 1000 per table per run.
Adaptive: if last run deleted == LIMIT, re-run immediately (max 3 chained runs); else next at 60s.

Circuit-break: 5 consecutive errors → set `sweeper_circuit_open = 1`,
emit metric, alert PAGE, halt sweeping. Manual reset via:
  mcp-coordinator admin sweeper-reset

Shutdown: SIGTERM drains current batch with 5s timeout, then exits.

Metrics:
  sweeper_last_run_timestamp (gauge)
  sweeper_rows_deleted_total{table} (counter)
  sweeper_consecutive_failures (counter)
  sweeper_circuit_open (gauge 0|1)

Phase 5 multi-instance: leader election via advisory lock on a dedicated
sweeper table row; only one instance sweeps. Phase 2 single-process: no lock needed.
```

### FIX 16: Bootstrap admin race fix (§6.3 step 6)

**Bug**: Per pentester Chain A, role recomputed for `users` table but `user_orgs` INSERT uses original computed role. Privilege divergence possible.

**Fix — §6.3 step 6 transaction**:
```
BEGIN IMMEDIATE TRANSACTION;
  INSERT INTO users (id, primary_org_id, ..., role)
    VALUES (uuid, org_row.id, ..., :computed_role_initial);
  
  -- Bootstrap admin atomic check
  if computed_role_initial == 'admin':
    UPDATE users SET role = 'admin'
      WHERE id = :new_user_id
        AND NOT EXISTS (
          SELECT 1 FROM users WHERE role='admin' AND id != :new_user_id
        );
    -- Re-read final role after the conditional UPDATE
    final_role = SELECT role FROM users WHERE id = :new_user_id;
    if final_role == 'admin':
      audit('auth.admin.bootstrapped', tier: 1, target: new_user_id);
    else:
      // Another admin already exists; new user is 'member'
      // (role on users table was reset to whatever current value is)
      UPDATE users SET role = 'member' WHERE id = :new_user_id;
      final_role = 'member';
  else:
    final_role = 'member';
  
  -- user_orgs row uses FINAL role, not initial
  INSERT INTO user_orgs (user_id, org_id, role, joined_at)
    VALUES (new_user_id, org_row.id, final_role, :now);
  
  audit('auth.user.provisioned', tier: 2, metadata: { role: final_role });
COMMIT;
```

### FIX 17: Steps 5-8 wrapped in single transaction (§6.3)

**Bug**: §6.3 steps 5-8 not in one TX. User+org+refresh INSERT can split on crash.

**Fix — §6.3 wrap entire post-GitHub flow** (after exchangeCode succeeds):
```
BEGIN IMMEDIATE TRANSACTION;
  // Step 5: resolve org via allowlist (SELECT)
  // Step 6: find or create user (INSERT + bootstrap admin) [as above]
  // Step 7: mint JWT pair + INSERT refresh_tokens
  // Step 8 (audit): defer enqueue until post-COMMIT
COMMIT;
// After commit, enqueue Tier 2 audit ('auth.login.success', etc.)
// Send response 302 with cookies
```

### FIX 18: Device poll atomicity (§6.6)

**Bug**: Per pentester Chain E, poll's SELECT-then-UPDATE on `last_polled_at` and `interval` is racy. Two concurrent polls can both pass or both fail.

**Fix — §6.6 atomic CAS**:
```sql
-- Replace SELECT + check + UPDATE with single conditional UPDATE
UPDATE device_auth_requests
  SET last_polled_at = :now,
      interval = MIN(interval + 5, 60)
  WHERE device_code = :device_code
    AND (:now - last_polled_at) >= interval
  RETURNING interval, approved_user_id, denied_at, expires_at, consumed_at;

-- If rowsAffected = 0 → too fast, return slow_down with current interval
-- If rowsAffected = 1 → check approved_user_id, mint or return pending
```

### FIX 19: HMAC state construction (§6.2)

**Bug**: §6.2 shows `hmac_sha256(csrf_key, "state-v1", state)` — 3-arg HMAC is non-standard.

**Fix — §6.2 + §6.3**:
```
canonical: hmac_message = "state-v1\x00" || state
            // domain separator: literal "state-v1" + null byte + state value
hmac_value = HMAC-SHA-256(csrf_key, hmac_message)
encoded    = base64url(hmac_value)

Set-Cookie: __Host-coordinator_oauth_state=encoded
At callback: recompute, compare via crypto.timingSafeEqual with length check.
```

### FIX 20: NTP rollback safety on token_epoch bump (§6.8 logout-all)

**Bug**: V3 said NTP-safe monotonic but spec uses raw `strftime('%s','now')`.

**Fix — §6.8 logout-all UPDATE**:
```sql
UPDATE users
  SET token_epoch = MAX(strftime('%s','now'), token_epoch + 1)
  WHERE id = :user_id;
```

Same fix at §16.3 NR12 restore reconciliation:
```sql
UPDATE users
  SET token_epoch = MAX(strftime('%s','now'), token_epoch + 1);
```

### FIX 21: Per-user_code failure cap on device approve (§6.5.1)

**Bug**: Per pentester + abuse, user_code entropy 35 bits is fine ONLY with per-user_code failure cap. §6.6 only rate-limits at device-poll endpoint, not approve-form submission.

**Fix — §6.5.1 add column + logic**:
```sql
ALTER TABLE device_auth_requests ADD COLUMN failed_approval_attempts INTEGER NOT NULL DEFAULT 0;
```
On `POST /auth/device/approve` with wrong user_code:
```
UPDATE device_auth_requests
  SET failed_approval_attempts = failed_approval_attempts + 1
  WHERE user_code = :user_code;
if failed_approval_attempts >= 5:
  UPDATE device_auth_requests SET denied_at = now, denied_reason = 'too_many_failed_approvals' WHERE user_code = :user_code;
  audit('auth.device.denied', tier: 2, reason: 'brute_force');
  return 429;
```

### FIX 22: Org tie-break rule (§6.3, §10)

**Bug**: `LIMIT 1` on allowlist match takes non-deterministic row when user belongs to multiple allowlisted orgs.

**Fix — §6.3 step 5 + §10 step 8 ORDER BY**:
```sql
SELECT id, name FROM orgs
  WHERE LOWER(allowlist_github_org) IN (?,?,...)
  ORDER BY allowlist_github_org ASC  -- deterministic tie-break: alphabetical
  LIMIT 1;
```

For Phase 5 SaaS migration, this becomes `ORDER BY users.primary_org_id IS NULL ASC, allowlist_github_org ASC` (prefer user's existing primary org).

### FIX 23: Audit ordering vs transaction commit

**Bug**: Per dist-sys, Tier 1 audits inside `db.transaction(...)` will roll back if the audit insert fails — worse than losing audit, the security action (revoke) also rolls back.

**Fix — pattern for all Tier 1 audit-after-security-action**:
```
const tx = db.transaction(() => {
  // Security state change (e.g., UPDATE refresh_tokens SET revoked_at=...)
});
tx();  // commits the security action

try {
  audit('auth.refresh.chain_revoked', { tier: 1, metadata: {...} });
} catch (auditErr) {
  // Security action already committed; audit failure must alert but not undo
  metrics.auditAfterCriticalOpFailures.inc();
  logger.error({ err: auditErr }, 'Audit write failed after critical security action');
}
```

Add metric `audit_after_critical_op_failures_total` to §17.1. Alert: any value > 0.

### FIX 24: §10 idle-expired write + audit atomicity

**Bug**: Idle check fails → `UPDATE revoked_reason='idle_expired'` and audit are separate, not in TX.

**Fix — wrap idle-expired path**:
```
if (updated.changes === 0) {
  // Idle expired
  const idleTx = db.transaction(() => {
    db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='idle_expired' WHERE jti=?")
      .run(now(), claims.jti);
  });
  idleTx();
  // Audit after commit (per FIX 23 pattern)
  audit('auth.refresh.idle_expired', { tier: 2 });
  throw new InvalidGrantError({ code: 'SESSION_IDLE_EXPIRED' });
}
```

### FIX 25: ExchangeCode return type

**Bug**: §5.1 `exchangeCode(...): Promise<IdpUserInfo>` doesn't return access token but §6.3 step 4 needs it.

**Fix — §5.1 interface**:
```ts
interface ExchangeCodeResult {
  user: IdpUserInfo;
  accessToken: string;
}

interface IdPProvider {
  // ...
  exchangeCode(code, redirectUri, codeVerifier?): Promise<ExchangeCodeResult>;
  // ...
}
```

GitHubProvider implementation updated accordingly.

---

## Documentation clarity additions

Per Round 3 docs-clarity agent: spec is unreadable for new engineer without glossary.

**Add §0 (Glossary)** to main spec:

```
## 0. Glossary

### Decision references
- Q1-Q8: original 8 brainstorm questions (see decisions-v3.md §intro)
- NR1-NR13: New Requirements added during Round 1 / 2 review (see decisions-v3.md)
- B-NEW-1 through B-NEW-12: Round 2 / 3 issue fixes (see decisions-v3.md)
- V2, V3, V4: brainstorm decision iterations (see corresponding -decisions-v*.md files)

### Phase 1 prerequisites
- **Scenario a/b/c/d**: the 4 authentication scenarios in Phase 1's `authenticateRequest()` —
  (a) no auth + AUTH_ENABLED=false → legacy claims, (b) agent-pinning header,
  (c) v0.6 legacy JWT (rejected when enabled), (d) v0.7+ Bearer JWT. Phase 2 adds Scenario 5 (cookie).
- **Pattern B refresh tokens**: refresh tokens are signed JWTs (not opaque random tokens).
  Database stores `jti` for revocation only. DB leak alone doesn't enable forgery.

### Acronyms
- **PKCE** (Proof Key for Code Exchange, RFC 7636): OAuth extension preventing
  authorization code interception on public clients.
- **MCP** (Model Context Protocol): the AI agent coordination protocol mcp-coordinator implements.
- **IdP** (Identity Provider): GitHub in Phase 2; Google/OIDC in Phase 4.
- **JWT** (JSON Web Token, RFC 7519): signed token format.
- **HS256**: HMAC-SHA-256 JWT signature algorithm.
- **HKDF** (HMAC-based Key Derivation Function, RFC 5869): derives keys from a master secret.
- **CAS** (Compare-And-Swap): atomic update with conditional WHERE clause.
- **CSRF** (Cross-Site Request Forgery): attack where malicious site triggers
  authenticated request on victim's session.
- **WAL** (Write-Ahead Log): SQLite journal mode allowing concurrent readers + 1 writer.
- **TOCTOU** (Time-Of-Check vs Time-Of-Use): race condition between validation
  and action.
- **NFKC** (Normalization Form Compatibility Composition): Unicode normalization for
  case-insensitive comparison.
- **SOC 2** (Service Organization Control 2): security/availability audit framework.
- **GDPR**: EU General Data Protection Regulation.
- **HIPAA**: US healthcare data protection.
- **BAA** (Business Associate Agreement): HIPAA contract required between covered
  entities and subprocessors.
- **GHES**: GitHub Enterprise Server (self-hosted GitHub).
- **SSE** (Server-Sent Events): streaming response protocol.

### External tools used
- **Pino**: structured JSON logger for Node.
- **jose**: JWT verify/sign library (v5, ESM-first).
- **better-sqlite3**: synchronous SQLite driver.
- **zod**: TypeScript schema validation library.
- **cookie** (jshttp): Cookie header parser.
- **msw** (Mock Service Worker): HTTP request mocking for tests.
- **keytar / Windows Credential Manager / macOS Keychain**: OS-level secret storage.
- **Litestream**: SQLite WAL streaming replication to S3.
- **Vitest**: test runner (fast, native ESM).
- **Playwright**: browser E2E test framework.
- **k6 / autocannon**: HTTP load testing tools.
```

**Add to §3 module map**:
```
### 3.1 Phase 2 module layout (where code lives)

src/auth/
  auth.ts                  // Phase 1 — authenticateRequest extended for Scenario 5
  providers/
    types.ts               // Extended IdPProvider interface (§5.1)
    registry.ts            // Phase 1 — unchanged
    github.ts              // NEW concrete GitHubProvider (§5.2)
  membership-cache.ts      // listMemberships LRU + stale-on-error (§5.3)
  oauth-handlers.ts        // /api/auth/oauth/* HTTP handlers (§6.3-§6.6)
  device-flow.ts           // Device flow specifics (§6.5, §6.6, §6.5.1)
  refresh-rotation.ts      // §10 algorithm
  token-epoch.ts           // §9.5 epoch read + bump
  csrf.ts                  // CSRF random token + timingSafeEqual (§9.3)
  html.ts                  // escapeHtml + render() seam (§9.4)
  pages/                   // 5 HTML templates
    login.html.ts          // /auth/login
    device.html.ts         // /auth/device
    device-confirm.html.ts // /auth/device/confirm
    success.html.ts        // /auth/success
  oauth-state.ts           // PKCE state table CRUD + CAS (§4 + §6.3)
  allowlist.ts             // Org allowlist resolver (§8.1)
  rate-limit.ts            // NEW §17.6
  service-tokens.ts        // NEW §5.5 issuance + verification
  cookies.ts               // Cookie parsing + emission (Node http raw)
  request-id.ts            // request_id middleware (§11.1 + AsyncLocalStorage)
  
src/sweeper/
  index.ts                 // §17.7 sweeper module

src/security/
  audit.ts                 // Phase 1 — extended with Tier 1/Tier 2 + queue (§11)
  encryption.ts            // Phase 1 — unchanged (PassthroughEncryption stub)

src/database.ts            // Phase 1 — schema + migrations (§4.1)
src/serve-http.ts          // Phase 1 — extended with new HTML routes
src/discovery.ts           // NEW — /.well-known/oauth-authorization-server (§6.10)
src/system-state.ts        // NEW — boot-time restore detection (§16.3, NR12)
```

---

## Final V4 deliverables checklist

When implementing Phase 2 from the spec + this V4 patch doc:

- [ ] All 25 fixes applied to corresponding spec sections
- [ ] 2 contrarian cuts applied (token_epoch cache, HMAC-CSRF binding)
- [ ] Glossary §0 added
- [ ] Module map §3.1 added
- [ ] CI lints in place:
  - [ ] `users.org_id` grep returns 0 in non-migration files
  - [ ] `CURRENT_TIMESTAMP` grep returns 0 in time-logic columns
  - [ ] `${` interpolation in HTML files passes through `render()` or `escapeHtml()`
  - [ ] `UPDATE audit_log` / `DELETE FROM audit_log` grep returns 0 outside sweeper + migrations

After V4 patches integrated, the spec is ready for implementation plan creation (Phase-1-style ~28-32 task list).

---

## What this V4 deliberately does NOT do

- ❌ Rewrite the main spec end-to-end (81KB → 60KB). The 25 fixes are surgical patches. Future spec author can fold V4 into main spec if desired.
- ❌ Accept Round 3 contrarian's full cut list (drop NR12 restore, drop fingerprint binding, drop half audits, drop 10 docs). Those are V3 decisions tranchées; reversing requires new brainstorm round.
- ❌ Address the docs-clarity gaps with a §0 + §3.1 reorganization of main spec. Glossary is provided here; if implementer prefers it in main spec, that's a clean edit.
- ❌ Resolve V3 → V4 versioning drift on the main spec filename. Main spec stays as `2026-05-13-auth-phase2-oauth-device-design.md`; this V4 doc is read alongside.

---

## Status

**V4 patches finalize Phase 2 design.** Total brainstorm + 3 review rounds = 64 agents. No further design rounds. Next step: implementation plan creation (Phase-1-style task list, see §21 of main spec).
