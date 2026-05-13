# Auth Phase 2 — OAuth (GitHub) + Device Flow + Audit Wiring — Design

**Status**: Design (pre-implementation)
**Version target**: mcp-coordinator@0.8.0
**Date**: 2026-05-13
**Owner**: swoofer
**Parent spec**: `docs/superpowers/specs/2026-05-11-auth-saas-ready-design.md` (Phase 1 + roadmap)
**Bootstrap**: `docs/superpowers/specs/2026-05-13-v0.7.1-phase2-bootstrap.md`
**Decisions**: `docs/superpowers/specs/2026-05-13-v0.7.1-phase2-decisions-v3.md` (Round 1 + Round 2 = 44 reviewer agents)

---

## 1. Scope, Goals, Non-Goals

### Scope

Phase 2 ships v0.7.0 → v0.8.0 with the following net-new capabilities:

- **GitHub OAuth 2.1 Authorization Code + PKCE** flow for browser-based sign-in
- **RFC 8628 Device Authorization Grant** for CLI / IDE / headless device sign-in (with browser-side approval)
- **Refresh token rotation with family-revoke on reuse detection** (RFC 9700 §4.14.2)
- **Audit log wiring**: 18 audit events written across auth boundaries, with synchronous/async durability tiers
- **HTML auth pages** (4 routes): `/auth/login`, `/auth/device`, `/auth/device/confirm`, `POST /auth/device/approve`
- **Session cookie** path in `authenticateRequest` (5th scenario)
- **Local + global logout** with immediate-effect via `token_epoch` mechanism
- **Service account tokens** for non-interactive consumers (CI/CD)
- **`.well-known/oauth-authorization-server`** discovery doc (RFC 8414)
- **Rate limiting + login lockout** across all auth surfaces
- **Backup/restore detection** with global re-auth on suspected restore

### Goals

1. Self-host onboarding from `npm install` to working `mcp-cli login` in ≤ 10 minutes
2. Defense-in-depth against OWASP Top 10 + OAuth 2.1 BCP threat model
3. SOC 2 Type I evidence-grade audit log (Type II requires Phase 4 + Postgres)
4. Backward-compatible upgrade from v0.7.0 (Phase 1 deployments unaffected unless `COORDINATOR_OAUTH_ENABLED=true`)
5. Phase 5 SaaS transition = feature evolution, not rewrite (schema is N:M-ready)
6. Cryptographic agility (kid header in JWT for future RS256/EdDSA upgrade)

### Non-Goals

- Google OAuth / generic OIDC providers — **Phase 4**
- `BaseOAuthProvider` abstract class extraction — **Phase 4** (when 2+ concrete providers exist)
- Admin UI, per-org admin pages — **Phase 5** (SaaS)
- N:M org membership UX (schema ready, invariant 1:1 enforced at app layer) — **Phase 5**
- MFA, SSO, SAML — **Phase 4+**
- HIPAA-eligible IdP swap + Postgres audit role — **Phase 4 (regulated workloads)**
- Column-level encryption, BYOK, GDPR /export, /delete — **v0.8**
- Audit log tamper-evident chain (HMAC-of-previous) — **v0.8.1**
- Encryption-at-rest (SQLCipher whole-DB) — **v0.7.5** (spec exists; known gap in Phase 2 docs)
- Email verification (assumed IdP-verified)
- Multi-instance deployment / Redis migration — **Phase 5**

### Known weaknesses shipped with Phase 2 (explicit acknowledgement)

1. **Encryption-at-rest deferred to v0.7.5**: `users.email`, `audit_log.metadata_json`, `refresh_tokens.device_label` are stored plaintext. Mitigations: DB file permissions 0600, parent dir 0700 (enforced at boot); JWT/cookie payload minimization (no PII); NR4 redaction allowlist; no raw tokens persisted. EU and regulated operators directed to wait for v0.7.5.
2. **HS256 signing key**: symmetric. JWT_SECRET leak = forgery. Mitigations: `kid` header forward-compat for RS256/EdDSA Phase 4+; rotation via `COORDINATOR_JWT_SECRET_PREV` (≥REFRESH_TTL overlap enforced at boot).
3. **Single-instance only**: SQLite local, audit queue per-process, `token_epoch` cache per-process. Multi-instance = Phase 5 (Redis pub/sub for cache invalidation; Postgres for audit role).
4. **No tamper-evident audit chain**: `audit_log` append-only by convention; DB-level write-only-role requires Postgres (Phase 4 for regulated).
5. **GitHub IdP dependency**: `listMemberships` called on every refresh (with 60s positive cache + 10min stale-on-error). GitHub outage > 10min = mass forced re-auth.

---

## 2. Architecture overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│  mcp-coordinator v0.8.0  (Node 20+, TypeScript strict, ESM, single-process)│
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  HTML auth pages (NEW)                                                     │
│    GET  /auth/login              ── one-button "Login with GitHub"         │
│    GET  /auth/device             ── code entry form                        │
│    GET  /auth/device/confirm     ── approve UI (requires auth via cookie)  │
│    POST /auth/device/approve     ── approval handler (CSRF protected)      │
│                                                                            │
│  OAuth API endpoints (NEW)                                                 │
│    GET  /api/auth/oauth/callback ── GitHub redirect target                 │
│    POST /api/auth/oauth/token    ── unified token endpoint (RFC 6749 §6)   │
│                                     accepts grant_type=                    │
│                                       authorization_code | refresh_token | │
│                                       urn:ietf:params:oauth:grant-type:    │
│                                       device_code                          │
│    POST /api/auth/oauth/device_authorization (RFC 8628 §3.1)               │
│                                                                            │
│  Session API endpoints (NEW)                                               │
│    POST /api/auth/logout           ── revoke current refresh jti           │
│    POST /api/auth/logout-all       ── revoke all + bump token_epoch        │
│    POST /api/auth/revoke           ── RFC 7009 alias for /logout           │
│    GET  /api/auth/me               ── userinfo (active org, role, ...)     │
│                                                                            │
│  Discovery (NEW, RFC 8414)                                                 │
│    GET  /.well-known/oauth-authorization-server                            │
│                                                                            │
│  Existing Phase 1 surfaces (extended, not replaced)                        │
│    authenticateRequest() ── adds Scenario 5 (cookie-based)                 │
│    audit() helper        ── writes 18 event types in 2 durability tiers    │
│    IdPProvider interface ── adds optional listMemberships +                │
│                              requestDeviceCode + pollDeviceToken           │
│    GitHubProvider        ── concrete impl (Phase 4 will extract base)      │
│                                                                            │
│  Persistence (SQLite WAL, single-process Phase 2)                          │
│    Phase 1 tables (extended)                                               │
│      users               ── token_epoch col, primary_org_id rename         │
│      orgs                ── allowlist_github_org col (B-NEW-4)             │
│      refresh_tokens      ── family_id, parent_jti, revoked_reason,         │
│                              replay_count, consumer_fingerprint cols       │
│      device_auth_requests── requester_ip, requester_user_agent,            │
│                              requester_country cols                        │
│      audit_log           ── 10-column row schema (see §11)                 │
│    Phase 2 NEW tables                                                      │
│      user_orgs           ── (user_id, org_id, role) — N:M-ready, 1:1       │
│                              invariant enforced at app layer               │
│      oauth_state         ── PKCE state storage (10min TTL, atomic CAS)     │
│      system_state        ── boot-time recovery markers (NR12)              │
└────────────────────────────────────────────────────────────────────────────┘

Request flow (browser OAuth, happy path):
  Browser  ───GET /auth/login───────────────────────────►  coordinator
  Browser  ◄──302 to GitHub /login/oauth/authorize──────  coordinator
           ───authorize with state+code_challenge──────►  GitHub
           ◄──302 to /api/auth/oauth/callback?code+state  GitHub
  Browser  ───GET callback───────────────────────────►   coordinator
                                                          coordinator → GitHub
                                                                exchange code
                                                                fetch /user
                                                                fetch /user/orgs (cached 60s)
                                                          coordinator → SQLite
                                                                INSERT users (if new)
                                                                INSERT user_orgs (1 row)
                                                                INSERT refresh_tokens (root family_id)
                                                                INSERT audit_log auth.login.success
  Browser  ◄──302 to /auth/dashboard + Set-Cookie──────  coordinator
                  __Host-coordinator_session (JWT)
                  __Host-coordinator_csrf (random token)

CLI device flow:
  CLI      ───POST /oauth/device_authorization──────►    coordinator
           ◄──{device_code, user_code, verification_uri, verification_uri_complete}
  CLI      shows user: "Open <uri_complete> or visit <uri> and enter <user_code>"
  CLI      ───POLL POST /oauth/token (device_code grant)─►  authorization_pending
           ───POLL (every 5s, slow_down respected)──────►   ...
                                                  meanwhile:
  User     ───GET /auth/device/confirm?user_code=...──►   coordinator
                                                          (redirect via /auth/login if no session)
           ◄──HTML form "Approve device from <ip><ua>?"
  User     ───POST /auth/device/approve+CSRF────────►    coordinator
                                                          UPDATE device_auth_requests
                                                                  SET approved_user_id, approved_at
                                                          INSERT audit auth.device.approved
  CLI      ───POLL─────────────────────────────────►    coordinator
           ◄──{access_token, refresh_token, expires_in}  (one-shot, request consumed)
```

---

## 3. Phase 1 hooks consumed

(Captured for traceability; full detail in bootstrap doc)

| Hook | Location | Phase 2 use |
|---|---|---|
| `IdPProvider` interface | `src/auth/providers/types.ts` | Extended with 3 optional methods (§5) |
| Empty `providers` registry | `src/auth/providers/registry.ts` | `registerProvider(new GitHubProvider(cfg))` at boot |
| `users` table | `src/database.ts` | INSERT on first OAuth callback; rename `org_id`→`primary_org_id`; add `token_epoch` |
| `orgs` table | `src/database.ts` | Add `allowlist_github_org` column |
| `refresh_tokens` table | `src/database.ts` | Add `family_id`, `parent_jti`, `revoked_reason`, `replay_count`, `consumer_fingerprint` |
| `device_auth_requests` table | `src/database.ts` | Add `requester_ip`, `requester_user_agent`, `requester_country` |
| `audit_log` table + `audit()` helper | `src/security/audit.ts` | Add columns for 10-row schema; durability tiers per §11 |
| `AuthClaims` shape | `src/auth.ts` | Populated with real `users.id` UUID; `agent_id` preserved for legacy scenario-c tokens |
| 4-scenario `authenticateRequest` | `src/auth.ts` | Scenario 5 added: HttpOnly session cookie |
| `WWW-Authenticate` RFC 6750 | `src/auth.ts` + `serve-http.ts` | OAuth 401s reuse with RFC-compliant params |
| Org scoping (Tasks 15-19) | various | OAuth populates `claims.active_org_id` from `user_orgs` (1 row in Phase 2) |
| `COORDINATOR_JWT_SECRET` rotation via `_PREV_SECRET` | Phase 1 audit fix | Boot validates ≥REFRESH_TTL overlap |

---

## 4. Schema changes

### 4.1 DDL (consolidated; single migration transaction)

```sql
BEGIN;

-- Q1: N:M-ready schema, 1:1 enforced at app layer
ALTER TABLE users RENAME COLUMN org_id TO primary_org_id;
ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_orgs (
  user_id    TEXT NOT NULL REFERENCES users(id),
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','service')),
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_user_orgs_org ON user_orgs(org_id);

-- Backfill user_orgs from primary_org_id (each Phase 1 user → 1 row)
INSERT INTO user_orgs (user_id, org_id, role, joined_at)
SELECT id, primary_org_id, COALESCE(role, 'member'), COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%S','now'))
FROM users
ON CONFLICT DO NOTHING;

-- B-NEW-4: allowlist as DB column for Phase 5 readiness
ALTER TABLE orgs ADD COLUMN allowlist_github_org TEXT;
CREATE INDEX IF NOT EXISTS idx_orgs_allowlist ON orgs(allowlist_github_org);

-- Q4: PKCE state storage
CREATE TABLE IF NOT EXISTS oauth_state (
  state           TEXT PRIMARY KEY,
  code_verifier   TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  provider        TEXT NOT NULL,  -- 'github' Phase 2; RFC 9700 §4.4 mix-up defense
  org_id          TEXT REFERENCES orgs(id),  -- nullable, resolved post-callback (B-NEW-cost)
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at);

-- Q7 + B-NEW-2: refresh rotation lineage + fingerprint binding
ALTER TABLE refresh_tokens ADD COLUMN family_id             TEXT;
ALTER TABLE refresh_tokens ADD COLUMN parent_jti            TEXT;
ALTER TABLE refresh_tokens ADD COLUMN revoked_reason        TEXT
  CHECK (revoked_reason IS NULL OR revoked_reason IN
    ('rotated','reuse_detected','suspicious_replay','logout','logout_all',
     'admin','key_rotation','idle_expired','restore_invalidation'));
ALTER TABLE refresh_tokens ADD COLUMN replay_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_tokens ADD COLUMN consumer_fingerprint  TEXT;

CREATE INDEX IF NOT EXISTS idx_refresh_family      ON refresh_tokens(family_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_parent      ON refresh_tokens(parent_jti);
CREATE INDEX IF NOT EXISTS idx_refresh_user_active ON refresh_tokens(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_expires     ON refresh_tokens(expires_at);

-- Backfill Phase 1 refresh tokens (assign unique family per row; parent NULL)
UPDATE refresh_tokens
   SET family_id = lower(hex(randomblob(16)))
 WHERE family_id IS NULL;

-- B-NEW-9: device flow forensics + cost attribution
ALTER TABLE device_auth_requests ADD COLUMN requester_ip          TEXT;
ALTER TABLE device_auth_requests ADD COLUMN requester_user_agent  TEXT;
ALTER TABLE device_auth_requests ADD COLUMN requester_country     TEXT;

-- NR12: restore detection
CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- audit_log column additions (NR6: 10-column row schema)
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN outcome    TEXT;
-- (existing Phase 1 columns: user_id, org_id, action, target, ip, user_agent, metadata, created_at)
-- Phase 1 rows have NULL request_id + NULL outcome; queries must tolerate.

CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id);

-- Migration version bump (replaces Phase 1's user_version)
PRAGMA user_version = 8;  -- (Phase 1 was 7; confirm before merge)

COMMIT;
```

### 4.2 Idempotency

Each `ALTER TABLE ... ADD COLUMN` is guarded by:
```ts
if (!hasColumn(db, 'refresh_tokens', 'family_id')) {
  db.exec("ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT");
}
```
via helper `hasColumn(db, table, col)` querying `PRAGMA table_info(?)`.

The backfill `UPDATE refresh_tokens SET family_id = ... WHERE family_id IS NULL` is idempotent (only fills NULLs).

Migration is wrapped in `BEGIN ... COMMIT`. On any error, transaction rolls back; on partial success across boots, idempotency guards prevent duplicate work.

**No down-migration.** Spec instructs: restore from backup (NR12 procedure) if rollback is needed. `docs/ops/sqlite-operations.md` documents.

### 4.3 SQLite version floor

Minimum: SQLite 3.25.0 (for `ALTER TABLE ... RENAME COLUMN`). Boot checks `SELECT sqlite_version()` and refuses to start if below. `package.json` engines:
```json
"engines": { "node": ">=20", "better-sqlite3": ">=11" }
```
(better-sqlite3 ≥11 bundles SQLite ≥3.42.)

### 4.4 Call-site enumeration for `users.org_id` rename

Pre-flight audit of references (to update in lockstep with migration):

- `src/auth.ts` — `createToken`, `verifyTokenStrict` populate `claims.org` from `users.primary_org_id` (via `user_orgs` Phase 5)
- `src/database.ts` — schema only
- `src/security/audit.ts` — audit row population
- `src/http/handle-rest.ts` — org-scoped queries
- All `src/tools/*.ts` reading `claims.org`
- All `tests/unit/*.test.ts` using `users.org_id`

CI lint check: `grep -rn "users.org_id\|users\\.org_id" src/ tests/` returns zero matches after migration (except in `users_org_id_legacy.sql` migration file).

Backward-compat shim for direct-DB integrators (one-minor-release deprecation):
```sql
CREATE VIEW IF NOT EXISTS users_legacy_v0_7 AS
  SELECT id, primary_org_id AS org_id, email, name, idp_provider, idp_user_id,
         role, created_at, last_login_at, token_epoch
  FROM users;
```
Documented in CHANGELOG as "v0.8.0 BREAKING for direct-DB consumers: column rename. View `users_legacy_v0_7` available for transition; removed in v0.9.0."

---

## 5. Provider model

### 5.1 Extended `IdPProvider` interface

```ts
// src/auth/providers/types.ts

export interface IdpUserInfo {
  idp_user_id: string;
  email: string;
  name?: string;
  idp_org_id?: string;  // legacy; superseded by listMemberships()
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;  // seconds; minimum poll cadence
}

export type DevicePollResult =
  | { status: 'authorization_pending' }
  | { status: 'slow_down'; new_interval: number }
  | { status: 'expired_token' }
  | { status: 'access_denied' }
  | { status: 'granted'; user: IdpUserInfo; accessToken: string };

export interface IdPProvider {
  readonly name: string;  // 'github'

  // Phase 1 (existing)
  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<IdpUserInfo>;

  // Phase 2 NEW (optional `?:` for backward compat with hypothetical external impls)
  listMemberships?(accessToken: string): Promise<string[]>;
  requestDeviceCode?(): Promise<DeviceCodeResponse>;
  pollDeviceToken?(deviceCode: string): Promise<DevicePollResult>;
}

export class IdPTokenRevoked extends Error {}
export class IdPTransientError extends Error {}
```

### 5.2 GitHubProvider

```ts
// src/auth/providers/github.ts (concrete; ~280 lines target)

export class GitHubProvider implements IdPProvider {
  readonly name = 'github';
  
  constructor(private readonly cfg: {
    clientId: string;
    clientSecret: string;
    authorizationEndpoint?: string;  // default https://github.com/login/oauth/authorize
    tokenEndpoint?: string;          // default https://github.com/login/oauth/access_token
    apiBaseUrl?: string;             // default https://api.github.com (GHES override)
    deviceAuthorizationEndpoint?: string; // default https://github.com/login/device/code
    deviceTokenEndpoint?: string;    // default https://github.com/login/oauth/access_token
  }) {}

  buildAuthUrl(state, redirectUri, codeChallenge) { /* per RFC 6749 §4.1.1 + RFC 7636 */ }
  async exchangeCode(code, redirectUri, codeVerifier) { /* client_secret_post per RFC 6749 §2.3 */ }
  
  async listMemberships(accessToken): Promise<string[]> {
    // GET /user/orgs (paginated; fetch all pages, no cap — typical user <50 orgs)
    // Required scope: read:org
    // Returns array of org logins (lowercase normalized)
    // On 401 (token revoked at IdP) → throw IdPTokenRevoked
    // On 5xx / timeout (5s, 1 retry) → throw IdPTransientError
  }
  
  async requestDeviceCode(): Promise<DeviceCodeResponse> { /* RFC 8628 §3.1 */ }
  async pollDeviceToken(deviceCode): Promise<DevicePollResult> { /* RFC 8628 §3.4 */ }
}
```

### 5.3 listMemberships cache (B-NEW-5)

```ts
// src/auth/providers/membership-cache.ts

interface CacheEntry {
  memberships: string[];
  ts: number;  // seconds since epoch
  stale: boolean;
}

const cache = new LRUCache<string, CacheEntry>({ max: 10_000, ttl: 60_000 });
// Key: sha256(user_id + "|" + provider_name)

export async function getMemberships(userId: string, provider: IdPProvider, accessToken: string): Promise<string[]> {
  const key = sha256(`${userId}|${provider.name}`);
  const cached = cache.get(key);
  
  if (cached && (now() - cached.ts) < 60) {
    return cached.memberships;
  }
  
  try {
    const memberships = await provider.listMemberships!(accessToken);
    cache.set(key, { memberships, ts: now(), stale: false });
    return memberships;
  } catch (err) {
    if (err instanceof IdPTransientError && cached && (now() - cached.ts) < 600) {
      // Stale-on-error window: 10 minutes
      metrics.idpStaleServedTotal.inc();
      return cached.memberships;
    }
    throw err;
  }
}
```

Removed-member access lag = max(60s, refresh interval) ≤ 16 minutes nominal; up to 10 additional minutes during IdP outage.

### 5.4 Phase 4 evolution note

When Google (Phase 4 Q1) or generic OIDC (Phase 4 Q2) ships, if 2 concrete providers exhibit 60-70%+ duplication in PKCE / state / fetch / error mapping, extract `abstract class BaseOAuthProvider implements IdPProvider`. Acceptance criterion: each concrete provider drops to ~30 LOC (constructor + endpoints + `parseUserInfo` + `listMemberships`).

---

## 6. Endpoints

### 6.1 Endpoint table

| Path | Method | Auth required | Status codes | Rate limit (NR11) |
|---|---|---|---|---|
| `GET /auth/login` | GET | none | 302 (→ GitHub) or 503 (IdP down) | 30/min per IP |
| `GET /api/auth/oauth/callback` | GET | none (state validates) | 302 (→ /auth/dashboard) or 400/401/403 | 10/min per IP |
| `POST /api/auth/oauth/token` | POST | per grant_type | 200 / 400 / 401 / 429 | varies by grant: code 10/min, refresh 60/min + 30/min per family, device-poll RFC 8628 |
| `POST /api/auth/oauth/device_authorization` | POST | none | 200 / 429 | 5/min per IP, 20/hr per IP |
| `GET /auth/device` | GET | optional (session) | 200 (HTML) | 30/min per IP |
| `GET /auth/device/confirm` | GET | session required | 200 (HTML) or 302 (→ /auth/login) | 30/min per IP |
| `POST /auth/device/approve` | POST | session + CSRF | 204 / 400 / 403 | 10/min per IP, 20/hr per user |
| `POST /api/auth/logout` | POST | Bearer or cookie | 204 (idempotent) | 30/min per IP |
| `POST /api/auth/logout-all` | POST | Bearer or cookie | 204 (idempotent) | 5/hr per user |
| `POST /api/auth/revoke` | POST | none (token in body) | 204 / 200 (RFC 7009) | 30/min per IP |
| `GET /api/auth/me` | GET | Bearer or cookie | 200 / 401 | 600/min per IP |
| `GET /.well-known/oauth-authorization-server` | GET | none | 200 | 60/min per IP |

### 6.2 OAuth init (`GET /auth/login`)

```
Request:  GET /auth/login
Response: 302 Found
          Location: https://github.com/login/oauth/authorize?
                      client_id={cfg.clientId}
                      &redirect_uri={PUBLIC_URL}/api/auth/oauth/callback
                      &response_type=code
                      &state={state_32_bytes_b64url}
                      &code_challenge={S256(code_verifier)}
                      &code_challenge_method=S256
                      &scope=read:user user:email read:org
          Set-Cookie: __Host-coordinator_oauth_state={HMAC(state, csrf_key)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600

Server-side:
  state = crypto.randomBytes(32).toString('base64url')          // 256 bits
  code_verifier = crypto.randomBytes(32).toString('base64url')  // 64-char b64url
  code_challenge = base64url(sha256(code_verifier))
  INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
    VALUES (?, ?, PUBLIC_URL || '/api/auth/oauth/callback', 'github', :now, :now + 600)
```

The `__Host-coordinator_oauth_state` cookie binds the state value to the browser (RFC 9700 §4.7 mitigation using signed cookie pattern instead of UA hash).

### 6.3 OAuth callback (`GET /api/auth/oauth/callback`)

```
Request:  GET /api/auth/oauth/callback?code={code}&state={state}
Response: 302 Found (success) or 400/401/403 (error)
          On success: Set-Cookie: __Host-coordinator_session={JWT}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={access_ttl_seconds}
                      Set-Cookie: __Host-coordinator_csrf={32_bytes_b64url}; Secure; SameSite=Strict; Path=/; Max-Age={access_ttl_seconds}
                      (HttpOnly NOT set on csrf cookie; intentional for double-submit pattern)
                      Location: /auth/dashboard

Handler (pseudo-code):
  // 1. Validate state binding (RFC 9700 §4.7)
  cookie_hmac = req.cookies['__Host-coordinator_oauth_state']
  if not constant_time_eq(cookie_hmac, hmac_sha256(csrf_key, "state-v1", state)):
    audit('auth.state.replay', sync=true)
    return 400 { error: "invalid_request", error_description: "state binding failed" }
  
  // 2. Atomic CAS on oauth_state row
  row = UPDATE oauth_state
        SET consumed_at = :now
        WHERE state = :state AND consumed_at IS NULL AND expires_at > :now
        RETURNING code_verifier, redirect_uri, provider
  if rowsAffected == 0:
    // Disambiguate via second SELECT (race-tolerant; state is known-bad)
    row = SELECT * FROM oauth_state WHERE state = :state
    if row is None: status = 400; error_code = STATE_UNKNOWN
    elif row.consumed_at: status = 409; error_code = STATE_REPLAY
    elif row.expires_at <= :now: status = 400; error_code = STATE_EXPIRED
    audit('auth.state.replay', sync=true)
    return status { error: error_code }
  
  // 3. Mix-up defense (RFC 9700 §4.4) — provider must match
  if row.provider != "github":
    audit('auth.state.mixup', sync=true)
    return 400 { error: "invalid_request" }
  
  // 4. Exchange code at GitHub
  try:
    user_info = await githubProvider.exchangeCode(code, row.redirect_uri, row.code_verifier)
    access_token = (returned by exchangeCode)
  except IdPTransientError:
    return 503 { error: "temporarily_unavailable" }
  except _:
    audit('auth.login.failure', sync=false, reason="idp_exchange_failed")
    return 401 { error: "invalid_grant" }
  
  // 5. Resolve org via allowlist
  memberships = await getMemberships(user_info.idp_user_id, githubProvider, access_token)
  // memberships: lowercase array of GitHub org logins
  
  org_row = SELECT id FROM orgs WHERE allowlist_github_org IN (?,?,...?) LIMIT 1  // membership intersection
  if org_row is None:
    audit('auth.login.denied.not_in_org', sync=true, metadata={
      idp_user_hash: sha256(user_info.idp_user_id),  // hashed identifier per GDPR
      memberships_count: memberships.length
    })
    return 403 { code: "NOT_IN_ALLOWLIST", message: "Your GitHub account is not in the configured allowlist." }
  
  // 6. Find or create user (auto-provisioning mode)
  user = SELECT * FROM users WHERE idp_provider='github' AND idp_user_id=?
  if user is None:
    if AUTO_PROVISION == 'false':
      audit('auth.login.failure', sync=false, reason="USER_NOT_PROVISIONED")
      return 403 { code: "USER_NOT_PROVISIONED", message: "Admin must pre-create your user account." }
    
    role = (idp_user_login == BOOTSTRAP_ADMIN_LOGIN_NFKC) ? 'admin' : 'member'
    BEGIN TRANSACTION
      INSERT INTO users (id, primary_org_id, email, name, idp_provider, idp_user_id, role, token_epoch)
        VALUES (uuid(), org_row.id, user_info.email, user_info.name, 'github', user_info.idp_user_id, role, 0)
      // Bootstrap admin atomic check (B-NEW-12 #14)
      if role == 'admin':
        UPDATE users SET role = 'admin'
          WHERE id = :new_user_id 
            AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND id != :new_user_id)
        if rowsAffected == 1:
          audit('auth.admin.bootstrapped', sync=true, target=user_id)
        else:
          // Another admin already exists; new user keeps 'member'
          UPDATE users SET role = 'member' WHERE id = :new_user_id
      INSERT INTO user_orgs (user_id, org_id, role, joined_at)
        VALUES (new_user_id, org_row.id, role, :now)
      audit('auth.user.provisioned', sync=false)
    COMMIT
    user = (newly inserted row)
  
  // 7. Mint JWT pair
  family_id = uuid()
  access_jwt = mintAccessJWT(user, org_row.id, family_id)
  refresh_jwt = mintRefreshJWT(user, family_id, parent_jti=null)
  
  // Compute fingerprint for theft defense (B-NEW-2)
  fingerprint = sha256(req.ip + "|" + req.headers['user-agent'])
  
  INSERT INTO refresh_tokens (
    id, org_id, user_id, jti, family_id, parent_jti,
    expires_at, consumer_fingerprint, created_at, last_used_at
  ) VALUES (uuid(), org_row.id, user.id, refresh_jti, family_id, null,
            :now + REFRESH_TTL, fingerprint, :now, :now)
  
  audit('auth.login.success', sync=false, actor_user_id=user.id, actor_org_id=org_row.id)
  
  // 8. Set cookies + redirect
  csrf_token = crypto.randomBytes(32).toString('base64url')
  return 302 Found
    Set-Cookie: __Host-coordinator_session=access_jwt; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900
    Set-Cookie: __Host-coordinator_csrf=csrf_token; Secure; SameSite=Strict; Path=/; Max-Age=900
    Set-Cookie: __Host-coordinator_oauth_state=; Max-Age=0  // clear
    Location: /auth/dashboard
```

### 6.4 Unified token endpoint (`POST /api/auth/oauth/token`)

RFC 6749 §6-compliant. `Content-Type: application/x-www-form-urlencoded`.

Switch on `grant_type`:
- `authorization_code` → CLI flow (rare; mostly browser uses callback redirect)
- `refresh_token` → token rotation (see §10)
- `urn:ietf:params:oauth:grant-type:device_code` → device flow polling (see §7)

Error responses follow RFC 6749 §5.2:
```json
{ "error": "invalid_grant", "error_description": "Refresh token reused — family revoked" }
```

### 6.5 Device authorization init (`POST /api/auth/oauth/device_authorization`)

```
Request:  POST /api/auth/oauth/device_authorization
          Content-Type: application/x-www-form-urlencoded
          client_id={coordinator's own ID, ignored Phase 2}&scope=read

Response: 200 OK
          {
            "device_code": "{43-char b64url}",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://coord.example.com/auth/device",
            "verification_uri_complete": "https://coord.example.com/auth/device/confirm?user_code=WDJB-MJHT",
            "expires_in": 600,
            "interval": 5
          }

Server-side:
  device_code = crypto.randomBytes(32).toString('base64url')
  user_code = generateUserCode()  // §6.5.1
  INSERT INTO device_auth_requests (
    device_code, user_code, nonce, requester_ip, requester_user_agent, requester_country,
    expires_at, created_at
  ) VALUES (?, ?, uuid(), req.ip, req.headers['user-agent'], geoLookup(req.ip), :now+600, :now)
  audit('auth.device.code_issued', sync=false)
```

#### 6.5.1 `user_code` generation

Alphabet: `BCDFGHJKLMNPQRSTVWXZ` (20 chars, no vowels, no 0/1/I/L/O — per RFC 8628 §6.1 recommendation).
Length: 8 chars, formatted `XXXX-XXXX`.
Entropy: log2(20^8) ≈ 35 bits — adequate with rate limiting + 10min TTL + 1/5s poll cap per device_code.

### 6.6 Device token polling

```
Request:  POST /api/auth/oauth/token
          grant_type=urn:ietf:params:oauth:grant-type:device_code
          &device_code={device_code}

Response (RFC 8628 §3.5):
  200 OK { access_token, refresh_token, expires_in } — once approved
  400 { error: "authorization_pending" } — still waiting
  400 { error: "slow_down" } — poll too fast (increment by 5s)
  400 { error: "expired_token" }
  400 { error: "access_denied" } — user denied

Server-side:
  row = SELECT * FROM device_auth_requests WHERE device_code=? AND expires_at > :now
  if not row: return 400 expired_token
  if row.denied_at: return 400 access_denied
  if not row.approved_user_id: 
    // Rate-limit check (per device_code, min 5s interval)
    if (:now - row.last_polled_at) < row.interval:
      UPDATE device_auth_requests SET interval = interval + 5
      return 400 slow_down (new_interval = row.interval + 5)
    UPDATE device_auth_requests SET last_polled_at = :now
    return 400 authorization_pending
  
  // Approved! Mint pair and consume
  ... (mint similar to OAuth callback §6.3)
  UPDATE device_auth_requests SET consumed_at = :now WHERE device_code = ? AND consumed_at IS NULL
  audit('auth.device.granted', sync=false)
  return 200 { access_token, refresh_token, expires_in }
```

### 6.7 Refresh grant — see §10 for rotation algorithm

### 6.8 Logout endpoints

```
POST /api/auth/logout
  Auth: Bearer or __Host-coordinator_session cookie required
  
  UPDATE refresh_tokens
    SET revoked_at = :now, revoked_reason = 'logout'
    WHERE jti = :claims.jti AND revoked_at IS NULL
  audit('auth.logout.local', sync=false, target=claims.jti)
  Set-Cookie: __Host-coordinator_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict
  Set-Cookie: __Host-coordinator_csrf=; Max-Age=0; Path=/; Secure; SameSite=Strict
  return 204

POST /api/auth/logout-all { "except_current": true }
  Auth: Bearer or cookie required
  
  except_jti = (except_current ? claims.jti : null)
  
  BEGIN TRANSACTION
    UPDATE refresh_tokens
      SET revoked_at = :now, revoked_reason = 'logout_all'
      WHERE user_id = :user_id AND revoked_at IS NULL AND jti != :except_jti
    revoked_count = rowsAffected
    
    // Bump token_epoch atomically (NTP-safe monotonic)
    UPDATE users
      SET token_epoch = MAX(strftime('%s','now'), token_epoch + 1)
      WHERE id = :user_id
    
    // Invalidate token_epoch cache locally
    tokenEpochCache.invalidate(:user_id)
  COMMIT
  
  audit('auth.logout.global', sync=true, target=user_id, metadata={ revoked_count })
  return 204

POST /api/auth/revoke (RFC 7009 alias)
  Content-Type: application/x-www-form-urlencoded
  token={refresh_or_access_token}
  &token_type_hint={refresh_token|access_token}  (optional)
  
  if token is refresh JWT: same as /logout for that jti
  if token is access JWT: 200 (no-op; access tokens not revocable individually, use logout-all)
  Always return 200 (RFC 7009: never reveal token validity)
```

### 6.9 `GET /api/auth/me`

```json
{
  "user": {
    "id": "{uuid}",
    "email": "alice@example.com",
    "name": "Alice",
    "role": "member"
  },
  "active_org": {
    "id": "{uuid}",
    "name": "acme"
  },
  "session": {
    "exp": 1715616000,
    "jti": "{jti}"
  }
}
```

### 6.10 `GET /.well-known/oauth-authorization-server` (RFC 8414)

```json
{
  "issuer": "https://coord.example.com",
  "authorization_endpoint": "https://coord.example.com/auth/login",
  "token_endpoint": "https://coord.example.com/api/auth/oauth/token",
  "device_authorization_endpoint": "https://coord.example.com/api/auth/oauth/device_authorization",
  "revocation_endpoint": "https://coord.example.com/api/auth/revoke",
  "userinfo_endpoint": "https://coord.example.com/api/auth/me",
  "grant_types_supported": [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:device_code"
  ],
  "response_types_supported": ["code"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post"],
  "revocation_endpoint_auth_methods_supported": ["none"],
  "service_documentation": "https://coord.example.com/docs/oauth-setup.md",
  "id_token_signing_alg_values_supported": ["HS256"]
}
```

All URLs computed from `COORDINATOR_PUBLIC_URL` (required env var; no trailing slash).

---

## 7. Flow sequences

### 7.1 Authorization Code flow (browser, first sign-in)

```
User    Browser   coordinator    GitHub
 │  click   │         │           │
 ├─────────►│         │           │
 │          ├─GET /auth/login────►│
 │          │◄─302───────────────│ Set-Cookie __Host-...oauth_state
 │          │ (GitHub authorize)  │
 │          ├──────────────────────────────►│
 │          │ (user signs in at GitHub)     │
 │          │◄──302 callback───────────────│
 │          ├─GET /api/auth/oauth/callback ►│
 │          │         │ validate state cookie + DB CAS
 │          │         │ exchange code
 │          │         │◄──POST /access_token─►│
 │          │         │──GET /user───────────►│
 │          │         │──GET /user/orgs──────►│ (cache 60s)
 │          │         │ allowlist check
 │          │         │ INSERT users + user_orgs + refresh_tokens
 │          │         │ audit auth.login.success (async tier 2)
 │          │◄─302 + Set-Cookie session + csrf
 │          │ (now at /auth/dashboard)
```

### 7.2 Device Flow (CLI bootstrap on new machine)

```
CLI            coordinator                 Browser (different device)
 │ mcp-cli login                              │
 ├─POST /oauth/device_authorization──►│       │
 │◄─{device_code, user_code, uri, uri_complete}│
 │ print: "Visit https://coord/auth/device and enter WDJB-MJHT"
 │                                            │ (user opens uri)
 ├─POLL /oauth/token (every 5s)────►│         ├──GET /auth/device─►│
 │◄─authorization_pending           │         │◄─HTML form
 │                                            │ (user enters WDJB-MJHT, redirected via /auth/login if no session)
 │                                            ├──GET /auth/device/confirm?user_code=WDJB-MJHT
 │                                            │ (browser session now authenticated)
 │                                            │◄─HTML "Approve device from <ip><ua><geo>?"
 │                                            ├──POST /auth/device/approve+csrf─►│
 │                                            │  UPDATE device_auth_requests SET approved_user_id, approved_at
 │                                            │  audit auth.device.approved (tier 2)
 │                                            │◄─204
 │                                            │ shows "Approved"
 ├─POLL─────────────────────────────►│
 │◄─200 { access_token, refresh_token, expires_in }
 │ store tokens in OS keychain (per NR9)
 │ ready
```

### 7.3 Refresh rotation (happy path)

```
CLI                  coordinator                     SQLite
 │ access JWT expires (after 15min)
 ├─POST /oauth/token grant=refresh_token─►│
 │                    │ jwt.verify(refresh, jose, HS256 pinned)
 │                    │ check kid in whitelist
 │                    │ idle_timeout check (last_used_at)
 │                    │◄─SELECT row WHERE jti=?────│
 │                    │ row.revoked_at IS NULL → normal path
 │                    │ fingerprint = sha256(req.ip+ua)
 │                    │◄─listMemberships() cached 60s ──►(GitHub if miss)
 │                    │ resolve org via memberships
 │                    │ BEGIN TX
 │                    │  UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='rotated' WHERE jti=?
 │                    │  INSERT INTO refresh_tokens (jti=newJti, family_id=row.family_id, parent_jti=row.jti, consumer_fingerprint=fp, ...)
 │                    │ COMMIT
 │                    │ audit auth.refresh.rotated (tier 2)
 │◄─{access_token, refresh_token, expires_in}
```

### 7.4 Refresh rotation — reuse detected (token theft scenario)

```
Attacker (stolen refresh)                         Victim
 │ presents stolen jti                              │ legitimate refresh
 ├─POST /oauth/token grant=refresh_token─►│         │
 │                    │                            │
 │                    │ Victim's request arrives first:
 │                    │  row.revoked_at IS NULL → normal rotation
 │                    │  row revoked, new jti issued, fingerprint stored
 │                    │
 │                    │ Attacker's stolen jti arrives 5s later:
 │                    │  row.revoked_at IS NOT NULL (just revoked)
 │                    │  row.revoked_reason = 'rotated'
 │                    │  (now - row.revoked_at) = 5s < 10s grace
 │                    │  successor = SELECT WHERE parent_jti = row.jti
 │                    │  attacker fingerprint = sha256(attacker_ip + attacker_ua)
 │                    │  successor.consumer_fingerprint != attacker fingerprint
 │                    │    → suspicious replay
 │                    │  UPDATE refresh_tokens SET replay_count = replay_count + 1
 │                    │    if replay_count + 1 >= 3:
 │                    │      UPDATE refresh_tokens SET revoked_at=:now,
 │                    │        revoked_reason='reuse_detected'
 │                    │        WHERE family_id = row.family_id AND revoked_at IS NULL
 │                    │      audit auth.refresh.chain_revoked (TIER 1 SYNC)
 │                    │      Bump user.token_epoch (immediate effect)
 │                    │    else:
 │                    │      audit auth.refresh.suspicious_replay (TIER 1 SYNC)
 │◄─401 invalid_grant (in all cases — never reveal successor to attacker)
```

### 7.5 Restore + re-auth (NR12)

```
Ops                  coordinator                     SQLite
 │ Detected DB corruption; restoring from t-1d backup
 │ stop coordinator
 │ overwrite coordinator.db from backup
 │ export COORDINATOR_ALLOW_RESTORE=true
 │ start coordinator
 │                    │ boot
 │                    │ Compute max_ts = MAX(MAX(audit.created_at), MAX(refresh.created_at), MAX(system_state.updated_at))
 │                    │ if (now - max_ts) > 5min AND COORDINATOR_ALLOW_RESTORE=true:
 │                    │   audit recovery.token_epoch_global_bump (TIER 1)
 │                    │   UPDATE users SET token_epoch = strftime('%s','now')
 │                    │   INSERT INTO system_state (key='last_restore_at', value=:now, updated_at=:now)
 │                    │   audit recovery.completed (TIER 1)
 │                    │   log WARN: "Restored from backup. All users must re-authenticate."
 │ unset COORDINATOR_ALLOW_RESTORE
 │ broadcast notice to users
```

---

## 8. Org assignment

### 8.1 Allowlist resolution (B-NEW-4)

At callback (§6.3 step 5):
```
SELECT o.id, o.name, o.allowlist_github_org
FROM orgs o
WHERE LOWER(o.allowlist_github_org) IN (LOWER(m1), LOWER(m2), ...)  -- membership intersection
LIMIT 1
```

Phase 2 invariant: exactly one row matches (single-tenant). Phase 5: multiple rows = SaaS multi-tenant. Schema unchanged.

### 8.2 Bootstrap admin (NR12 + B-NEW-12 #14)

Boot validation:
- If `COORDINATOR_BOOTSTRAP_ADMIN` set: case-fold + NFKC-normalize login string; log resolved value at boot
- At first OAuth callback where `LOWER(NFKC(idp_user_login)) == LOWER(NFKC(BOOTSTRAP_ADMIN))`:
  - Atomic SQL: `UPDATE users SET role='admin' WHERE id = :new AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND id != :new)`
  - If rowsAffected == 1: emit `auth.admin.bootstrapped` (TIER 1)
  - If rowsAffected == 0: another admin already exists; new user keeps `role='member'`; log warning
- Alternative (recommended for higher-security deployments): `COORDINATOR_BOOTSTRAP_ADMIN_TOKEN` = one-time token printed at first boot, consumed at matching login.

After bootstrap: spec instructs ops to UNSET the env var (subsequent admins assigned via CLI verb Phase 3).

### 8.3 Auto-provisioning modes (B-NEW-11)

`COORDINATOR_AUTO_PROVISION`:
- `"true"` (Phase 2 default): first OAuth callback creates `users` + `user_orgs` rows automatically (after allowlist check passes)
- `"false"`: callback fails with code `USER_NOT_PROVISIONED` if no row exists; admin must pre-create via `mcp-coordinator add-user --github-login=X --org=Y --role=member`
- `"approval_required"`: Phase 3 — callback creates row with `role='pending'`; admin approval moves to `member`

### 8.4 Audit events (this section)

`auth.user.provisioned`, `auth.user.created`, `auth.login.success`, `auth.login.denied.not_in_org`, `auth.admin.bootstrapped`, `auth.login.failure` — see §11.

---

## 9. Session cookie + CSRF design

### 9.1 Cookie inventory

| Cookie | HttpOnly | Secure | SameSite | Path | Max-Age | Purpose |
|---|---|---|---|---|---|---|
| `__Host-coordinator_session` | ✓ | ✓ | Strict | `/` | access TTL (default 900s) | JWT carrying claims |
| `__Host-coordinator_csrf` | ✗ | ✓ | Strict | `/` | access TTL | Double-submit token; HttpOnly=false so form JS can read |
| `__Host-coordinator_oauth_state` | ✓ | ✓ | Lax | `/` | 600s | HMAC binding of OAuth state; SameSite=Lax for cross-site redirect from GitHub |

`SameSite=Strict` on session: closes ALL cross-site POST/GET CSRF.
`__Host-` prefix: forbids `Domain` attribute, mandates `Path=/` + `Secure` — closes subdomain takeover.
HTML pages: `Cache-Control: no-store` (prevents code/state in browser history).

### 9.2 Cookie security invariant

The CSRF model **load-bearing assumption**: `__Host-coordinator_session` is HttpOnly. If ever made JS-readable (e.g. Phase 5 SPA architecture change), CSRF protection collapses. **Regression test required**: pin `HttpOnly=true` on session cookie.

### 9.3 CSRF mechanism (B-NEW-12 #17)

```
At session creation (OAuth callback, device approve, refresh):
  csrf_token = crypto.randomBytes(32).toString('base64url')  // random, NOT HMAC
  Set-Cookie: __Host-coordinator_csrf=csrf_token

At POST /auth/device/approve (form submission):
  Client-side JS: read document.cookie["__Host-coordinator_csrf"] (HttpOnly=false), submit as hidden field <input name="_csrf">
  
  Server validates:
    cookie_val = req.cookies['__Host-coordinator_csrf']
    form_val   = req.body['_csrf']
    if not constant_time_eq(cookie_val, form_val):
      return 403 { code: "CSRF_MISMATCH" }
    if not session_cookie_present:
      return 401
    # Optional second layer: HMAC-bind cookie to session
    expected_hmac = HMAC-SHA-256(csrf_key, session_jwt_value_hash)
    if not constant_time_eq(cookie_val, derived_from_expected_hmac):
      audit('auth.csrf.failed', sync=false)
      return 403
```

CSRF key:
- Derived: `csrf_key = HKDF-SHA256(JWT_SECRET, salt="", info="csrf-v1", L=32)`
- Override via env: `COORDINATOR_CSRF_HMAC_KEY` (32 bytes base64url) — for key-separation if operator prefers
- Algorithm: HMAC-SHA-256

### 9.4 HTML rendering and escaping

```ts
// src/auth/html.ts

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
};

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

export function render(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_, key) => escapeHtml(ctx[key] ?? ''));
}
```

CI lint: `grep -rn '\${.*}' src/auth/*.html.ts | grep -v 'render(' | grep -v 'escapeHtml('` → must return 0 matches outside `render()` template literals.

CSP for HTML routes:
```
Content-Security-Policy:
  default-src 'none';
  script-src 'none';
  style-src 'self' 'unsafe-inline';
  form-action 'self';
  frame-ancestors 'none';
```

`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.

### 9.5 authenticateRequest Scenario 5 (cookie)

```ts
// src/auth.ts — extend Phase 1 4-scenario authenticateRequest

async function authenticateRequest(req: IncomingMessage, options: AuthenticateOptions): Promise<AuthResult> {
  // Scenario a-d (Phase 1, unchanged):
  //  a. no auth header + AUTH_ENABLED=false → legacy claims
  //  b. agent-pinning header → scenario b
  //  c. legacy v0.6 JWT (rejected when AUTH_ENABLED=true)
  //  d. v0.7+ Bearer JWT → standard path
  
  // Scenario 5 (NEW Phase 2): __Host-coordinator_session cookie
  const sessionCookie = parseCookies(req)['__Host-coordinator_session'];
  if (sessionCookie && !authHeaderPresent(req)) {
    // Bearer header MUST take precedence; cookies are fallback for browser
    return validateJWTAndApplyTokenEpoch(sessionCookie);
  }
  
  // Fall through to scenarios a-d
}

function validateJWTAndApplyTokenEpoch(jwt: string) {
  // 1. Signature verify (HS256 pinned)
  const { payload } = await jwtVerify(jwt, signingKeyByKid(jwt.kid), { algorithms: ['HS256'] });
  
  // 2. Expiry check (with ±30s clock skew leeway)
  if (now() > payload.exp + 30) throw new TokenExpiredError();
  
  // 3. Service account scope: requires DB lookup (override trust-signature)
  if (payload.service_account === true) {
    const row = db.prepare("SELECT revoked_at FROM refresh_tokens WHERE jti = ?").get(payload.jti);
    if (!row || row.revoked_at) throw new TokenRevokedError();
  }
  
  // 4. token_epoch check (LRU cache 60s; B-NEW-1)
  const epoch = tokenEpochCache.get(payload.user_id) ?? db.prepare("SELECT token_epoch FROM users WHERE id = ?").get(payload.user_id)?.token_epoch ?? 0;
  tokenEpochCache.set(payload.user_id, epoch);
  if (payload.iat < epoch) throw new TokenRevokedError();  // strict ≥, no leeway
  
  return { authenticated: true, claims: payload };
}
```

`tokenEpochCache`: in-process LRU, max 10K entries, 60s TTL. Invalidated on local `/logout-all` (cross-instance invalidation = Phase 5 work).

---

## 10. Refresh rotation + chain revoke (full algorithm)

### 10.1 Algorithm (B-NEW-2)

```ts
async function refreshGrant(req, refreshToken: string): Promise<TokenResponse> {
  // 1. Verify JWT signature + kid + alg pinned
  const claims = await jwtVerify(refreshToken, signingKeyByKid(refreshToken.kid), {
    algorithms: ['HS256'],
    clockTolerance: 30
  });
  
  // 2. Look up row
  const row = db.prepare("SELECT * FROM refresh_tokens WHERE jti = ?").get(claims.jti);
  if (!row) {
    audit('auth.invalid_token', tier: 2, reason: 'jti_unknown');
    throw new InvalidGrantError();
  }
  
  // 3. Idle timeout (if configured)
  if (SESSION_IDLE_TIMEOUT && row.last_used_at) {
    const idleSec = now() - row.last_used_at;
    const updated = db.prepare(`
      UPDATE refresh_tokens SET last_used_at = :now
      WHERE jti = :jti AND (:now - last_used_at) <= :timeout
    `).run({ now: now(), jti: claims.jti, timeout: SESSION_IDLE_TIMEOUT });
    if (updated.changes === 0) {
      // Idle expired
      db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='idle_expired' WHERE jti=?")
        .run(now(), claims.jti);
      audit('auth.refresh.idle_expired', tier: 2);
      throw new InvalidGrantError({ code: 'SESSION_IDLE_EXPIRED' });
    }
  }
  
  // 4. Service account guard (NR1)
  if (claims.service_account === true || row.family_id?.startsWith('service:')) {
    return { error: 'invalid_grant', error_description: 'Service tokens do not rotate' };
  }
  
  // 5. Compute current fingerprint
  const fingerprint = sha256(req.ip + '|' + (req.headers['user-agent'] ?? ''));
  
  // 6. Reuse detection
  if (row.revoked_at !== null) {
    const sinceRevoked = now() - row.revoked_at;
    
    if (row.revoked_reason === 'rotated' && sinceRevoked < 10) {
      // Within grace window — check fingerprint
      const successor = db.prepare(
        "SELECT * FROM refresh_tokens WHERE parent_jti = ?"
      ).get(claims.jti);
      
      if (successor && successor.consumer_fingerprint === fingerprint) {
        // Legitimate concurrent retry from same client — re-mint deterministically
        return mintTokenPair(successor);
      }
      
      // Different fingerprint = suspicious replay
      db.prepare(
        "UPDATE refresh_tokens SET replay_count = replay_count + 1 WHERE jti = ?"
      ).run(claims.jti);
      const newCount = row.replay_count + 1;
      
      if (newCount >= 3) {
        revokeFamilyForReuse(row.family_id, 'reuse_detected');
      } else {
        audit('auth.refresh.suspicious_replay', tier: 1, metadata: { jti: claims.jti, replay_count: newCount, expected_fp: successor?.consumer_fingerprint, actual_fp: fingerprint });
      }
      throw new InvalidGrantError();  // never reveal successor to attacker
    } else {
      // Hard reuse (outside grace, or revoked for non-rotation reason)
      revokeFamilyForReuse(row.family_id, 'reuse_detected');
      throw new InvalidGrantError();
    }
  }
  
  // 7. Refresh GitHub membership (cached 60s, stale-on-error 10min)
  let memberships: string[];
  try {
    memberships = await getMemberships(row.user_id, githubProvider, await getStoredIdpToken(row.user_id));
  } catch (e) {
    if (e instanceof IdPTokenRevoked) {
      // User revoked GitHub OAuth grant — force re-auth
      db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='admin' WHERE jti=?")
        .run(now(), claims.jti);
      audit('auth.idp.token_revoked', tier: 1);
      throw new InvalidGrantError({ code: 'IDP_TOKEN_REVOKED' });
    }
    throw e;
  }
  
  // 8. Re-verify allowlist
  const orgRow = db.prepare(
    "SELECT id FROM orgs WHERE LOWER(allowlist_github_org) IN (?,?,...) LIMIT 1"
  ).all(...memberships.map(s => s.toLowerCase()));
  if (!orgRow.length) {
    db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='admin' WHERE jti=?")
      .run(now(), claims.jti);
    audit('auth.login.denied.not_in_org', tier: 1);
    throw new InvalidGrantError({ code: 'NOT_IN_ALLOWLIST' });
  }
  
  // 9. Normal rotation
  const newJti = randomUUID();
  const tx = db.transaction(() => {
    db.prepare("UPDATE refresh_tokens SET revoked_at=:now, revoked_reason='rotated' WHERE jti=?")
      .run(now(), claims.jti);
    db.prepare(`
      INSERT INTO refresh_tokens (id, org_id, user_id, jti, family_id, parent_jti,
        expires_at, consumer_fingerprint, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), orgRow[0].id, row.user_id, newJti, row.family_id, claims.jti,
           now() + REFRESH_TTL, fingerprint, now(), now());
  });
  tx();
  
  audit('auth.refresh.rotated', tier: 2);
  return mintTokenPair({ jti: newJti, family_id: row.family_id, user_id: row.user_id, org_id: orgRow[0].id });
}

function revokeFamilyForReuse(family_id: string, reason: string) {
  const tx = db.transaction(() => {
    const affected = db.prepare(`
      UPDATE refresh_tokens
        SET revoked_at = :now, revoked_reason = :reason
        WHERE family_id = :family_id AND revoked_at IS NULL
    `).run({ now: now(), reason, family_id });
    
    audit('auth.refresh.chain_revoked', tier: 1, metadata: { family_id, revoked_count: affected.changes });
  });
  tx();
}
```

### 10.2 Test seams

Clock injection (mandatory): all SQL uses `:now` parameter, never `CURRENT_TIMESTAMP` on time-logic columns. CI lint:
```
grep -rn "CURRENT_TIMESTAMP" src/auth/ src/database.ts
# zero hits in time-logic columns (refresh_tokens.revoked_at, oauth_state.consumed_at, ...)
```

ID generator injection: `randomUUID()` reads from `idGen` (injected). Tests pass a deterministic fake.

GitHub IdP: all calls through `IdPProvider`; tests use msw or in-memory fake.

---

## 11. Audit wiring

### 11.1 Audit row schema (NR6)

```sql
audit_log (
  id              TEXT PRIMARY KEY,           -- uuid
  actor_user_id   TEXT,                       -- NULL for system events
  actor_org_id    TEXT,
  actor_ip        TEXT,
  actor_user_agent TEXT,
  request_id      TEXT,                       -- correlation ID for req/audit
  action          TEXT NOT NULL,              -- 'auth.login.success', ...
  target          TEXT,                       -- subject identifier (user_id, jti, ...)
  outcome         TEXT,                       -- 'success' | 'failure' | 'denied'
  metadata_json   TEXT,                       -- per-event structured payload
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_org_time   ON audit_log(actor_org_id, created_at);
CREATE INDEX idx_audit_user_time  ON audit_log(actor_user_id, created_at);
CREATE INDEX idx_audit_action     ON audit_log(action, created_at);
CREATE INDEX idx_audit_request_id ON audit_log(request_id);
```

### 11.2 Audit events (full inventory)

| Event | Tier | Metadata fields |
|---|---|---|
| `auth.login.success` | 2 (async) | provider, idp_user_id_hash |
| `auth.login.failure` | 2 | reason |
| `auth.login.denied.not_in_org` | **1 (sync)** | idp_user_id_hash, memberships_count |
| `auth.login.locked` | **1** | identifier_hash, attempts_count |
| `auth.refresh.rotated` | 2 | old_jti, new_jti, family_id |
| `auth.refresh.chain_revoked` | **1** | family_id, revoked_count, trigger_jti |
| `auth.refresh.reuse_detected` | **1** | jti, family_id |
| `auth.refresh.suspicious_replay` | **1** | jti, replay_count, expected_fp, actual_fp |
| `auth.refresh.idle_expired` | 2 | jti, idle_seconds |
| `auth.token.revoked` | **1** | jti, revoked_by |
| `auth.logout.local` | 2 | jti |
| `auth.logout.global` | **1** | user_id, revoked_count |
| `auth.device.code_issued` | 2 | device_code_hash, requester_ip |
| `auth.device.approved` | 2 | user_code, approver_user_id, requester_ip, requester_user_agent |
| `auth.device.denied` | 2 | user_code, approver_user_id, reason |
| `auth.user.created` | 2 | user_id, idp_user_id |
| `auth.user.provisioned` | 2 | user_id, role, auto |
| `auth.admin.bootstrapped` | **1** | user_id, mechanism (`login_match` or `token`) |
| `auth.invalid_token` | 2 | reason |
| `auth.state.replay` | **1** | state_hash, reason |
| `auth.state.mixup` | **1** | state_hash, expected_provider, actual_provider |
| `auth.csrf.failed` | 2 | endpoint, session_jti_hash |
| `auth.idp.token_revoked` | **1** | user_id |
| `auth.idp.stale_served` | 2 | user_id, age_seconds |
| `auth.service_token.issued` | **1** | issuer_admin_id, target_user_id, scope, ttl, reason |
| `auth.service_token.used` | 2 (sampled, max 1/hr per token) | jti |
| `auth.service_token.revoked` | **1** | jti, revoked_by |
| `recovery.token_epoch_global_bump` | **1** | trigger ('restore'/'manual'), affected_users_count |
| `recovery.completed` | **1** | restore_marker_ts |
| `config.boot` | **1** | env_vars_hash, jwt_kid, oauth_enabled, allowlist_org_hash, idle_timeout |
| `system.shutdown.audit_loss` | **1** (best-effort) | dropped_count |

Tier 1 (sync write before HTTP response): 13 events listed.
Tier 2 (async batched 50/100ms queue): rest.

### 11.3 Pino redaction allowlist (NR4)

```ts
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'req.body.code',
  'req.body.state',
  'req.body.device_code',
  'req.body.user_code',
  'req.body.refresh_token',
  'req.body.access_token',
  'req.body._csrf',
  'res.body.token',
  'res.body.access_token',
  'res.body.refresh_token',
  'req.idpAccessToken',
  '*.access_token',
  '*.refresh_token'
];
```

CI lint forbids `console.log(req.body)` / `logger.info(req)` — must use redacted logger.

### 11.4 SQLite vs Postgres audit immutability (B-NEW-7)

Phase 2 SQLite: app-layer enforcement. CI lint: `grep -rn "UPDATE audit_log\|DELETE FROM audit_log" src/` outside migrations returns zero. File permissions 0600 on DB.

Phase 4 regulated (Postgres): `REVOKE UPDATE, DELETE ON audit_log FROM coordinator_app` + separate `coordinator_audit_writer` role. Documented in `docs/ops/sqlite-operations.md` and `docs/security/threat-model.md`.

---

## 12. Configuration

### 12.1 Environment variables

**Required (when `COORDINATOR_OAUTH_ENABLED=true`):**

| Var | Type | Description |
|---|---|---|
| `COORDINATOR_JWT_SECRET` | bytes | ≥32 random bytes, validated entropy at boot |
| `COORDINATOR_GITHUB_CLIENT_ID` | string | GitHub OAuth App Client ID |
| `COORDINATOR_GITHUB_CLIENT_SECRET` | string | GitHub OAuth App Client Secret |
| `COORDINATOR_GITHUB_ORG` | string | Seeds bootstrap org (B-NEW-4); written to `orgs.allowlist_github_org` once |
| `COORDINATOR_PUBLIC_URL` | URL | Used for cookie domain inference, redirect URI, JWT issuer, discovery doc; no trailing slash |

**Optional:**

| Var | Default | Bounded | Description |
|---|---|---|---|
| `COORDINATOR_OAUTH_ENABLED` | `false` | `true|false` | Master flag — disables all Phase 2 surfaces when false (Phase 1 unchanged) |
| `COORDINATOR_JWT_SECRET_PREV` | unset | bytes | Previous JWT secret for rotation overlap |
| `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT` | unset | unix ts | Required if PREV set; boot validates `now - rotated_at < REFRESH_TTL` |
| `COORDINATOR_JWT_ACCESS_TTL` | `"15m"` | max `"60m"` | Access JWT lifetime |
| `COORDINATOR_JWT_REFRESH_TTL` | `"30d"` | max `"90d"` | Refresh JWT lifetime |
| `COORDINATOR_SESSION_IDLE_TIMEOUT` | unset | optional `"15m"` | Idle-based forced re-auth (regulated workloads) |
| `COORDINATOR_BOOTSTRAP_ADMIN` | unset | github login | One-shot admin assignment at first login |
| `COORDINATOR_BOOTSTRAP_ADMIN_TOKEN` | unset | base64url(32 bytes) | Alternative: one-time token printed at first boot |
| `COORDINATOR_AUTO_PROVISION` | `"true"` | `true|false|approval_required` | User auto-creation policy |
| `COORDINATOR_CSRF_HMAC_KEY` | derived | bytes | HKDF-derived from JWT_SECRET by default |
| `COORDINATOR_LOGIN_LOCKOUT_THRESHOLD` | `5` | 1-50 | Failed login attempts before lockout |
| `COORDINATOR_LOGIN_LOCKOUT_WINDOW` | `"15m"` | duration | Count window |
| `COORDINATOR_LOGIN_LOCKOUT_DURATION` | `"15m"` | duration | Lockout effect duration |
| `COORDINATOR_REFRESH_RETENTION_DAYS` | `180` | 30-3650 | Retain revoked refresh rows for forensics |
| `COORDINATOR_AUDIT_RETENTION_DAYS` | `365` | 30-3650 | Tier 1 audit retention |
| `COORDINATOR_AUDIT_TIER2_RETENTION_DAYS` | `90` | 30-365 | Tier 2 audit retention |
| `COORDINATOR_INSECURE_COOKIES` | `false` | `true|false` | Required `true` for `http://` non-localhost deployments |
| `COORDINATOR_ALLOW_RESTORE` | unset | `true|false` | Boot-time only; unset after restore (NR12) |
| `COORDINATOR_IDP_STALE_MAX` | `"10m"` | duration | listMemberships stale-on-error window |

### 12.2 Boot validation (fail-closed list)

If `COORDINATOR_OAUTH_ENABLED=true`:
- Refuse to start if any required var missing
- Refuse to start if `JWT_SECRET` < 32 bytes or low entropy
- Refuse to start if `JWT_SECRET_PREV` set but `..._ROTATED_AT` missing OR `now - rotated_at > REFRESH_TTL`
- Refuse to start if `PUBLIC_URL` scheme is `http://` and host is not `localhost`/`127.0.0.1`/`::1` AND `INSECURE_COOKIES != true`
- Refuse to start if `ACCESS_TTL > 60m` or `REFRESH_TTL > 90d`
- Refuse to start if SQLite version < 3.25
- Refuse to start if `ALLOW_RESTORE=true` is set AND the boot-time restore detection check does NOT fire (operator misconfiguration)

Emit `config.boot` audit event with all effective values (hashed where sensitive).

---

## 13. Security threat model

(Detailed in `docs/security/threat-model.md` co-shipped per NR7 #6.)

### 13.1 Pattern B refresh tokens (Q7)

Refresh tokens are signed JWTs. DB stores `jti` for revocation only. Threat: DB leak alone does NOT enable forgery (signing key required). Mitigations:
- JWT_SECRET stored in env var only (not in DB)
- Rotation via PREV_SECRET overlap (≥ REFRESH_TTL)
- `kid` header for asymmetric upgrade Phase 4+

### 13.2 Refresh chain reuse (B-NEW-2)

Stolen refresh + 10s race against legit user: defended by `consumer_fingerprint` (sha256(ip+ua)). Attacker with different fingerprint cannot get successor; counter increments; family revoked at threshold 3. SSE reconnect false-positive bounded.

### 13.3 PKCE state replay (Q4)

Atomic CAS with `consumed_at IS NULL` + `expires_at > now` enforces one-time use. State binding via signed cookie (`__Host-coordinator_oauth_state`). Mix-up defense via `provider` column.

### 13.4 CSRF (Q5)

Three layers:
1. `SameSite=Strict` on session cookie — closes top-level POST CSRF
2. `__Host-` prefix forbids `Domain` — closes subdomain takeover
3. Double-submit CSRF token in JS-readable cookie + hidden form field — defense-in-depth vs same-site XSS chained CSRF (CSP `script-src 'none'` prevents XSS execution)

### 13.5 Device flow phishing (B-NEW-9)

Defenses:
- Rate limit on `/oauth/device_authorization`
- Per-user pending device cap (≤3 unapproved at any time)
- Approval page shows requester context: IP, User-Agent, country
- Distinct CSRF token per `user_code`

### 13.6 Token theft from disk (refresh in `~/.mcp-coordinator/auth.json`)

Mitigation: SDK uses OS keychain (keytar/Win Credential Manager/macOS Keychain). Plaintext fallback chmod 600 with loud warning. Documented in NR9 SDK spec + onboarding.

### 13.7 Backup-restore security regression (B-NEW-10)

NR12 boot-time detection: if `max(timestamps) > 5min` old and `COORDINATOR_ALLOW_RESTORE=true`, bump all users' `token_epoch` and emit recovery audit events. Forces global re-auth post-restore.

### 13.8 IdP outage cascading failure (B-NEW-5)

60s positive cache + 10min stale-on-error window on `listMemberships`. Reduces GitHub SLA dependency. Documented trade-off in threat model.

### 13.9 Documented residual risks

1. Encryption-at-rest: plaintext DB. Risk: backup theft. Mitigation: file perms 0600, no PII in JWT, redaction. **Resolution**: v0.7.5 SQLCipher.
2. HS256 symmetric: secret leak = forgery. Mitigation: rotation runbook, `kid` forward-compat. **Resolution**: Phase 4 RS256/EdDSA.
3. Audit log mutability (SQLite): no DB role system. Mitigation: CI lint + WAL. **Resolution**: Phase 4 Postgres for regulated.
4. Multi-instance not supported: `token_epoch` cache per-process, audit queue per-process. **Resolution**: Phase 5 Redis pub/sub.
5. HIPAA: GitHub IdP has no BAA. **Resolution**: Phase 4 BAA-eligible IdP swap (Okta, Azure AD).

---

## 14. Backward compatibility

### 14.1 Feature flag (NR8)

`COORDINATOR_OAUTH_ENABLED=false` (default): Phase 2 surfaces disabled. Phase 1 behavior bit-for-bit unchanged. Schema migration runs unconditionally (additive, idempotent) — flag gates request handlers + route registration only.

### 14.2 AuthClaims semantics

Phase 1 set `user_id = "legacy"` or `agent_id`. Phase 2 with OAuth populates `user_id = users.id` (UUID). For non-OAuth scenarios (a, b, c), `agent_id` claim preserved alongside `user_id`. SDK 0.8.x accepts both shapes.

### 14.3 Phase 1 JWTs with `org="default"`

Accepted with deprecation warning for 1 minor release. Emit `auth.legacy_token.accepted` (Tier 2) on each acceptance + bump `legacy_token_acceptance_total` metric. Removed in 0.9.0. CHANGELOG flags.

### 14.4 IdPProvider interface evolution

3 new methods added as optional (`?:`). External implementers (hypothetical Phase 1) compile clean. CHANGELOG entry under "Interface additions (non-breaking)."

### 14.5 `users.org_id` rename

Breaking for direct-DB integrators. Compat view `users_legacy_v0_7` shipped (1 minor release). CHANGELOG entry under "BREAKING for direct-DB consumers."

### 14.6 Semver

Ship as **0.8.0** (minor). Justification:
- New features behind flag
- Schema additions are additive + idempotent
- Direct-DB consumers get compat view
- IdPProvider new methods optional

Reserve 1.0.0 for: HS256→RS256 cutover + legacy JWT removal + N:M invariant relaxation + Postgres-mandatory for regulated.

---

## 15. Testing strategy

### 15.1 Test seams (mandatory)

- **Clock**: `Clock` interface (`now(): number`) injected; all time-logic SQL uses `:now` parameter (no `CURRENT_TIMESTAMP`)
- **ID generator**: `IdGen` interface (`uuid()`, `randomBytes(n)`)
- **IdP**: all GitHub calls via `IdPProvider`; tests use msw or in-memory fake
- **Token epoch cache**: testable via direct read/invalidate methods exposed for tests

### 15.2 Test pyramid

| Tier | Tools | Scope |
|---|---|---|
| Unit | Vitest | rotation algorithm, reuse detection, token_epoch check, CSRF HMAC, escapeHtml, status-code mapping, error-envelope shape |
| Integration | Vitest + real SQLite + msw GitHub mock + fake clock | full OAuth callback, device flow, refresh chain (5-deep family revoke), logout-all + epoch, idle timeout, allowlist 403, state replay 409, sweeper drain |
| E2E | Playwright | one happy path each — browser OAuth, CLI device flow, refresh-on-401 in reference SDK |
| Property / load | k6 + autocannon | oauth_state CAS @ 1000-way concurrency; refresh rotation under N concurrent retries |

### 15.3 Security-critical test matrix

| # | Decision | Unit | Integration | Security | E2E |
|---|---|---|---|---|---|
| D1 (Q1) | 1:1 org + user_orgs schema | resolveOrgFromGitHub | OAuth callback assigns to correct org | cross_tenant_oauth_user_cannot_access_other_org (4-org seed extended) | — |
| D2 (Q2) | Allowlist | allowlistChecker.isAllowed | Login rejects non-allowlist + audit row | allowlist_bypass_via_case_mutation (NFKC normalization test) | — |
| D3 (Q6) | IdP minimal | GitHubProvider.fetchUser | Full auth code via msw | idp_optional_methods_404_not_500 | — |
| D4 (Q4) | oauth_state | put/consume/expire lifecycle | State survives process restart mid-flow | state_replay_rejected_after_consume; expired_state_rejected | — |
| D5 (Q5) | HTML + cookie | renderApprovePage escapes user_code; parseCookie | Approve POST reads cookie, sets new cookie | xss_user_code_crafted; csrf_missing_token_rejected; csrf_cross_session_rejected | browser_login_cookie_roundtrip |
| D6 (Q7) | Refresh family | rotateRefresh issues new jti | Refresh chain 5-deep | refresh_reuse_revokes_entire_chain; 10s_grace_legitimate_concurrent_retry; 10s_grace_attacker_different_fingerprint_blocked | — |
| D7 (Q8) | Dual logout | logout clears cookie | Logout invalidates session | logout_all_bumps_token_epoch_invalidates_access_jwt | — |
| D8 (Q3) | TTLs | tokenTTL returns correct exp | Access token rejected at 15min+1s (fake clock); refresh rejected at 30d+1s | clock_skew_30s_grace_works; idle_timeout_forces_reauth | — |
| D9 (NR1) | Service account | issue-service-token | Service JWT excluded from rotation | service_jwt_token_epoch_applies (DB hit per request); service_revocation_immediate | — |
| D10 (NR12) | Restore | restoreDetector.shouldBump | Boot-time bump + audit | restored_db_invalidates_revoked_tokens_replay | — |

### 15.4 Chaos / fault injection (run pre-release)

- `github_500_during_callback` → 503 with audit, no partial user row
- `sqlite_write_fail_during_state_create` → transaction rolls back, no orphan
- `process_restart_between_state_create_and_consume` → state survives, callback succeeds
- `sigkill_mid_audit_batch` → Tier 1 events present, Tier 2 may drop (audit_drops_total++)
- `clock_step_backward_30s_via_ntp` → token_epoch monotonic guard prevents validation bypass
- `idp_listMemberships_5xx_after_cache_warmup` → stale served < 10min, error after

### 15.5 Performance benchmarks (acceptance)

- Sustained 500 refresh/sec for 1h: p99 `/api/auth/refresh` < 100ms (cached membership lookup)
- 100 concurrent CLI device polls: p99 < 200ms; no oauth_state row leaks
- Failed-login storm 5K/sec for 5min: audit queue does not OOM; Tier 1 events 100% durable; Tier 2 may drop (alert fires)
- Sweeper run during sustained load: no p99 spike >5%

### 15.6 Coverage floors

- `src/auth/**`: 90%
- `src/auth/refresh-rotation.ts` (security-critical): 100%
- `src/auth/token-epoch.ts`: 100%
- `src/auth/csrf.ts`: 100%

---

## 16. Migration & rollout

### 16.1 Schema migration

See §4.1 DDL. Single transaction; idempotent. `PRAGMA user_version` bump at end.

### 16.2 Phase 1 → Phase 2 upgrade procedure

```
1. npm update mcp-coordinator (0.7.0 → 0.8.0)
2. (existing AUTH_ENABLED=false deployments are unaffected — no further action needed)
3. To enable OAuth:
   a. Create GitHub OAuth App at github.com/settings/developers
      - Callback URL: <COORDINATOR_PUBLIC_URL>/api/auth/oauth/callback
      - Required scopes: read:user, user:email, read:org
   b. Set required env vars:
      COORDINATOR_OAUTH_ENABLED=true
      COORDINATOR_GITHUB_CLIENT_ID=<from GitHub App>
      COORDINATOR_GITHUB_CLIENT_SECRET=<from GitHub App>
      COORDINATOR_GITHUB_ORG=<your-github-org-login>
      COORDINATOR_PUBLIC_URL=https://your-coord-host.example.com
      COORDINATOR_BOOTSTRAP_ADMIN=<your-github-login>
   c. (Optional) Set optional vars per §12
   d. Restart coordinator
   e. Browse to https://your-coord-host.example.com/auth/login
   f. After first successful login as admin, unset COORDINATOR_BOOTSTRAP_ADMIN
4. Existing Phase 1 JWTs continue working until natural expiry (deprecation warning emitted)
5. CLI consumers: update to SDK 0.8.x for new auth flows
```

### 16.3 Restore procedure (NR12)

```
1. Stop coordinator
2. Restore SQLite DB from backup
3. export COORDINATOR_ALLOW_RESTORE=true
4. Start coordinator
5. Verify boot log shows: "config.boot.restore_detected" and "recovery.completed"
6. unset COORDINATOR_ALLOW_RESTORE
7. Broadcast to users: "All sessions invalidated; please re-authenticate"
```

### 16.4 Rollback

No down-migration (SQLite limitations). Rollback = restore from pre-migration backup (NR12 procedure).

---

## 17. Operations

### 17.1 Metrics (NR10 + ops Round 2)

Prometheus format (or equivalent):

```
# Counters
oauth_attempts_total{provider,outcome}
oauth_callback_duration_seconds (histogram)
device_flow_initiated_total
device_flow_approved_total
device_flow_denied_total
refresh_rotations_total{outcome}
refresh_chain_revokes_total
refresh_suspicious_replays_total
logouts_total{type=local|global}
audit_log_inserts_total{tier}
audit_queue_depth (gauge)
audit_drops_total
audit_events_synced_total
oauth_state_rows (gauge)
sweeper_last_run_timestamp (gauge)
sweeper_rows_deleted_total
idp_api_calls_total{endpoint,outcome}
idp_cache_hits_total
idp_cache_misses_total
idp_stale_served_total
idp_rate_limit_remaining (gauge)
rate_limit_blocked_total{endpoint,identifier_type}
legacy_token_acceptance_total
token_epoch_bumps_total
```

### 17.2 Alerts (severity)

**PAGE (CRITICAL)**:
- `refresh_chain_revokes_total > 0 over 5min` — potential token theft attack
- `audit_drops_total > 0` — SOC 2 evidence gap
- `oauth_state_rows > 100K` — sweeper stalled
- Health probe failing > 2min

**TICKET (HIGH)**:
- `oauth_callback_duration_seconds p99 > 5s` — GitHub API issues
- `idp_stale_served_total > 0` sustained for >5min — GitHub outage
- `rate_limit_blocked_total{endpoint='/oauth/token'} > 1K/hr` — credential stuffing
- `device_flow_initiated_total` × 5 > `device_flow_approved_total` sustained — phishing campaign?

**LOG (INFO)**:
- `legacy_token_acceptance_total > 0` — deprecation alert
- `audit_queue_depth > 80% capacity` — backpressure imminent

### 17.3 Health endpoints

- `GET /health`: liveness (Phase 1)
- `GET /health/ready`: readiness — DB write check + sweeper heartbeat (Phase 2 addition)

Do NOT probe GitHub from readiness (transient outages would cycle pods).

### 17.4 Logging

Pino, structured JSON. Redact paths per §11.3. Log levels:
- `error`: 5xx responses, IdP failures, audit queue overflow
- `warn`: bootstrap admin not yet claimed, idle timeout fired, deprecated Phase 1 token accepted
- `info`: auth.* successes (correlate with audit_log via request_id)
- `debug`: per-request lifecycle (dev only)

### 17.5 Backup (NR12 + B-NEW-10)

Recommended in `docs/ops/backup-restore.md`:
- **Litestream** WAL streaming to S3-compatible store (1-min RPO)
- Daily `sqlite3 .backup` snapshot, 30-day retention
- Quarterly restore drill mandatory for SOC 2 readiness
- Out-of-band audit sink (S3 immutable bucket / managed log) for v0.8.1 deferral compensation

---

## 18. Co-shipped deliverables (NR7 final list)

| # | Path | Purpose |
|---|---|---|
| 1 | `docs/ops/key-rotation.md` | JWT_SECRET rotation runbook (≥REFRESH_TTL overlap) |
| 2 | `docs/ops/incident-refresh-leak.md` | Playbook for refresh DB compromise |
| 3 | `docs/ops/incident-signing-key-leak.md` | Playbook for JWT_SECRET leak (mass force-revoke) |
| 4 | `docs/ops/access-review.md` | Quarterly export + sign-off procedure |
| 5 | `docs/ops/audit-retention.md` | Retention policy + pruning job + growth model |
| 6 | `docs/security/threat-model.md` | Pattern B, HS256 boundary, deferred encryption-at-rest |
| 7 | `SECURITY.md` + `.well-known/security.txt` | Disclosure email + SLA + scope |
| 8 | `docs/gdpr.md` | Per-field basis + retention table + Art. 13 notice template |
| 9 | `docs/onboarding-self-host.md` | GitHub OAuth App walkthrough + env vars + gotchas |
| 10 | `docs/idp-providers.md` | IdPProvider plugin contract (Phase 4 community providers) |
| 11 | `docs/ops/audit-queue-policy.md` | Tier 1 vs Tier 2 + drop policy + capacity tuning |
| 12 | `docs/ops/feature-flag-rollout.md` | COORDINATOR_OAUTH_ENABLED flip procedure |
| 13 | `docs/ops/sqlite-operations.md` | WAL, backup, restore, integrity check |
| 14 | `docs/ops/backup-restore.md` | Litestream setup + restore drill (NR12) |
| 15 | `docs/ops/single-instance-constraints.md` | Phase 2 topology limits |
| 16 | `CHANGELOG.md` | 0.8.0 entries (BREAKING for direct-DB; OAuth feature flag) |
| 17 | `docs/api/openapi.yaml` | OpenAPI 3.1 spec for all new endpoints |
| 18 | `examples/` | docker-compose, nginx reverse-proxy, GHES, stub custom IdPProvider |

---

## 19. Anti-scope-creep rules (in spec)

To preserve Phase 2 focus and prevent rot toward Phase 5:

1. **HTML routes**: only 4 (`/auth/login`, `/auth/device`, `/auth/device/confirm`, `POST /auth/device/approve`). Adding more requires ADR.
2. **No frontend framework** added to coordinator. Templates are TS template literals + `render()` seam.
3. **No new dependency** beyond `cookie` (jshttp, ~2KB) and `zod` (IdP response validation).
4. **No admin UI**: defer all admin operations to CLI verbs.
5. **No metrics dashboards** in coordinator (Grafana JSON shipped separately).
6. **No multi-instance complexity**: Phase 2 is single-process. Spec explicitly forbids Redis dep, broadcast channels, shared cache layers.

---

## 20. References

- RFC 6749 — OAuth 2.0
- RFC 6750 — Bearer Token Usage
- RFC 6819 — OAuth 2.0 Threat Model
- RFC 7009 — Token Revocation
- RFC 7636 — PKCE
- RFC 7662 — Token Introspection (referenced but not implemented Phase 2)
- RFC 8414 — OAuth 2.0 Authorization Server Metadata
- RFC 8628 — Device Authorization Grant
- RFC 8725 — JWT Best Current Practices
- RFC 9700 — OAuth 2.0 Security Best Current Practice
- OAuth 2.1 draft (consolidation)
- GDPR Articles 5, 13, 15, 17, 25, 30, 32, 33, 35
- SOC 2 Common Criteria CC6.1, CC6.6, CC7.2, CC7.3, CC9.2
- HIPAA Technical Safeguards 164.308(a)(4), 164.308(a)(5)(ii)(C), 164.312(a)(1)/(a)(2)(iii)/(c)/(d)/(e)(1), 164.314(a)

**Phase 2 design docs**:
- `2026-05-11-auth-saas-ready-design.md` — parent spec (Phase 1 + roadmap)
- `2026-05-13-v0.7.1-phase2-bootstrap.md` — brainstorm seed (118 lines)
- `2026-05-13-v0.7.1-phase2-decisions-v3.md` — final brainstorm decisions post 44-agent review

---

## 21. Next steps (post-spec)

1. **Round 3 review**: 20 reviewer agents on THIS spec (not V3). Pattern matches Phase 1 4-round process.
2. **Implementation plan**: Phase-1-style task list with 20-40 independently-reviewable tasks.
3. **subagent-driven-development execution**: same workflow that shipped v0.7.0.
4. **v0.8.0 release** with `COORDINATOR_OAUTH_ENABLED=false` default — gives self-hosters time to onboard.
5. **v0.8.1**: tamper-evident audit log chain (if SOC 2 customer demands).
6. **v0.7.5** (parallel track): SQLCipher encryption-at-rest (regulated workload prerequisite).
