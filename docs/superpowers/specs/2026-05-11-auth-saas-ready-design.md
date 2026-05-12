# Team-mode Auth with SaaS-ready foundation (design)

**Status**: design (approved for implementation 2026-05-11)
**Owner**: swoofer
**Targets**: mcp-coordinator v0.7.0 → v0.7.3 (4 phases)
**Process**: brainstorming session 2026-05-11; user-chosen Team-PME-with-SaaS-future scope, multi-IdP, both device flow and CLI login.

## Summary

Replace the v0.3-era pre-shared-secret JWT auth with **OAuth 2.0 / OIDC-based authentication** that's friendly for small teams today (GitHub OAuth in 1 command) and SaaS-ready for tomorrow (multi-tenant `org_id` baked into the schema and JWT from day 1).

Ships in 4 phases over ~3-4 weeks:

- **v0.7.0** — Foundation. Schema with `org_id` everywhere, JWT gains `org` claim, query scoping, `IdPProvider` interface. No user-facing changes.
- **v0.7.1** — GitHub OAuth + Device Flow (RFC 8628). First working SSO.
- **v0.7.2** — CLI login (`gcloud auth login`-style local browser callback).
- **v0.7.3** — Google OAuth + generic OIDC. Multi-provider selection UI.

Phase 5 (full SaaS — signup, billing, per-org admin UI) is **out of scope**; this design only makes that future migration cheap.

## Goals

1. **Replace shared-secret registration** with SSO via the user's existing identity provider. No more `COORDINATOR_REGISTRATION_SECRET` to distribute.
2. **Frictionless first-time auth** — user runs essaim, sees a "visit URL + enter code" prompt OR runs `mcp-coordinator-cli login` once.
3. **Audit trail** — every coordinator action attributable to a specific human user via JWT claims, plus the specific agent process via `sub`.
4. **Multi-IdP from day 1** — GitHub for tech teams, Google for Workspace shops, OIDC generic for enterprise (Okta, Auth0, Azure AD, Keycloak).
5. **SaaS-migration cost ~2-4 weeks** (not 3-6 months). Achieved by baking `org_id`, query scoping, and provider abstraction now.

## Non-goals

- **Full SaaS infrastructure** (signup flows, billing, per-org admin UI) — Phase 5, deferred.
- **Per-org quotas / rate-limits**.
- **Email/password local auth** — IdP only. Bare-bones MIT users without an IdP keep the existing `AUTH_ENABLED=false` open-coordinator mode.
- **MFA enforcement at coordinator level** — IdPs handle this.
- **Audit log surface UI** — log lines and Prometheus metrics are enough for v0.7.
- **Role-based fine-grained permissions** — only `admin` and `member` (and `agent` for machine-to-machine).
- **Encryption at rest** — deferred to **v0.7.5** (separate spec `2026-05-11-encryption-at-rest-design.md`). v0.7 bakes the structural hooks (audit_log table, EncryptionProvider interface, file mode 0600) but does not implement encryption yet.
- **Column-level encryption / GDPR endpoints / BYOK** — deferred to **v0.8** (compliance-enterprise tier, separate spec to be written when a first enterprise client demands it).

## Background

mcp-coordinator's current auth (`src/auth.ts`, ~114 LOC, added in v0.3.0 B3 fix) is:

- Pre-shared secret model: env vars `COORDINATOR_REGISTRATION_SECRET` and `COORDINATOR_ADMIN_SECRET`
- Agent registers via `POST /api/auth/register` with `{ agent_name, registration_secret }` → receives JWT
- JWT validated on each request (HS256 via `jose`)
- Refresh + revoke endpoints exist
- MQTT broker uses same JWT (Aedes auth hook)

It works but has friction:

- Each user needs to receive the shared secret out-of-band (Slack/email — both leak)
- No identity behind the agent: the JWT subject is `<agent_name>` chosen client-side, with no link to a real person
- No way to revoke "all of Alice's tokens" without rotating the shared secret globally
- No path to multi-tenant — shared secrets don't scale past one team

OAuth/OIDC fixes all four. The cost is implementation complexity (~3-4 weeks).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Human user                                                          │
│   ├─ mcp-coordinator-cli login     ─── once per machine ───┐        │
│   └─ essaim run swarm              ─── uses cached token ──┤        │
└────────────────────────────────────────────────────────────┼────────┘
                                                              │
                                                       refresh│token
┌─────────────────────────────────────────────────────────────┼────────┐
│  Agent process (Claude Code / essaim subprocess)             │       │
│   ├─ Read ~/.mcp-coordinator/auth.json                       │       │
│   ├─ POST /api/auth/agent-token (refresh_token, label)       │       │
│   ├─ Receive short-lived agent JWT (15 min)                  │       │
│   └─ Use agent JWT in Authorization: Bearer header          ◄┤       │
└──────────────────────────────────────────────────────────────┼───────┘
                                                                │
                                                                │
┌───────────────────────────────────────────────────────────────▼──────┐
│  mcp-coordinator                                                      │
│   ├─ HTTP Auth Endpoints:                                             │
│   │   GET  /auth/login              ──→ provider selection UI         │
│   │   GET  /auth/login?provider=X   ──→ redirect to IdP authorize     │
│   │   GET  /auth/callback/<X>       ──→ IdP redirects back            │
│   │   GET  /auth/device             ──→ device-flow code entry UI     │
│   │   POST /api/auth/device         ──→ start device flow             │
│   │   POST /api/auth/device/token   ──→ poll for device-flow approval │
│   │   POST /api/auth/agent-token    ──→ derive agent JWT from refresh │
│   │   POST /api/auth/refresh        ──→ rotate refresh token          │
│   │   POST /api/auth/revoke         ──→ revoke a specific token       │
│   │                                                                    │
│   ├─ IdPProvider registry (pluggable):                                │
│   │   - GitHub   (Phase 2)                                            │
│   │   - Google   (Phase 4)                                            │
│   │   - OIDC     (Phase 4 — generic)                                  │
│   │                                                                    │
│   ├─ Database (new):                                                  │
│   │   - orgs                                                          │
│   │   - users                                                         │
│   │   - refresh_tokens                                                │
│   │   - device_auth_requests                                          │
│   │   - existing tables get org_id column                             │
│   │                                                                    │
│   └─ Middleware:                                                      │
│       authenticateRequest → extracts JWT → attaches { user_id, org,  │
│       role } to req context. All handlers scope queries by org.       │
└──────────────────────────────────────────────────────────────────────┘
```

## Components

### A. Database schema (Phase 1)

**New tables** (appended to `SCHEMA` const in `src/database.ts`):

```sql
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  idp_provider  TEXT,              -- 'github' | 'google' | 'oidc' | NULL
  idp_org_id    TEXT,              -- GitHub org slug, Google domain, OIDC group claim
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  email           TEXT NOT NULL,
  name            TEXT,
  idp_provider    TEXT NOT NULL,    -- 'github' | 'google' | 'oidc'
  idp_user_id     TEXT NOT NULL,    -- provider-specific user identifier
  role            TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at   TEXT,
  UNIQUE(idp_provider, idp_user_id)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id              TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL REFERENCES orgs(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  jti             TEXT NOT NULL UNIQUE,
  device_label    TEXT,              -- 'maxime-laptop', 'ci-runner-3', set by client
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_refresh_org_user ON refresh_tokens(org_id, user_id, revoked_at);

CREATE TABLE IF NOT EXISTS device_auth_requests (
  device_code      TEXT PRIMARY KEY,
  user_code        TEXT NOT NULL UNIQUE,
  nonce            TEXT NOT NULL UNIQUE,  -- single-use, tracked for replay prevention
  approved_user_id TEXT REFERENCES users(id),
  org_id           TEXT,                  -- populated on approval; defense against cross-org token reuse
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_user_code ON device_auth_requests(user_code);
CREATE INDEX IF NOT EXISTS idx_device_nonce ON device_auth_requests(nonce);

-- Audit log (structural hook for SOC 2 / GDPR baseline; populated from Phase 2)
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT,                 -- may be NULL for unauthenticated actions
  org_id          TEXT,                 -- NULL for unauthenticated actions (e.g., failed login before identity established)
  action          TEXT NOT NULL,        -- 'auth.login.success', 'auth.refresh', 'auth.token_revoke', ...
  target          TEXT,                 -- entity acted on (thread_id, agent_id, user_id...)
  ip              TEXT,
  user_agent      TEXT,
  metadata        TEXT,                 -- JSON, freeform per-action context
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

-- Seed default org for migration from v0.6.x:
INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Default Organization');
```

**ALTER TABLE migrations** (existing pattern in `src/database.ts:initDatabase`):

```typescript
const TABLES_NEEDING_ORG = [
  "agents", "threads", "thread_messages", "action_summaries",
  "file_activity", "events", "dependency_map", "introspections",
  "agent_activity_status", "revoked_agents", "working_files",
  "git_cochange", "git_cochange_meta", "layer_firings",
];
for (const t of TABLES_NEEDING_ORG) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'`); }
  catch { /* already exists */ }
}
```

PRAGMA bump: `user_version = 7`.

### B. IdPProvider interface (Phase 1)

```typescript
// src/auth/providers/types.ts
export interface IdpUserInfo {
  idp_user_id: string;      // provider's stable user id
  email: string;
  name?: string;
  idp_org_id?: string;      // for GitHub org / Google domain / OIDC group claim
}

export interface IdPProvider {
  name: string;                                              // 'github' | 'google' | 'oidc'
  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<IdpUserInfo>;
}

// src/auth/providers/registry.ts
export const providers = new Map<string, IdPProvider>();
export function registerProvider(p: IdPProvider) { providers.set(p.name, p); }
export function getProvider(name: string): IdPProvider | null {
  return providers.get(name) ?? null;
}
```

Phase 1 ships the interface + an empty registry. Phase 2 adds `GitHubProvider`. Phase 4 adds `GoogleProvider` + `OIDCProvider`.

### B.5. EncryptionProvider interface + audit log helper (Phase 1, structural hooks)

These interfaces ship in Phase 1 with NO implementations — they pave the way for v0.7.5 (encryption at rest) and v0.8 (column-level + compliance). Adding them now means later phases don't need to thread a new abstraction through 50 call sites.

```typescript
// src/security/encryption.ts (Phase 1: interface only; impls in v0.7.5+)
export interface EncryptionProvider {
  /** Encrypt a value for storage. Returns base64 ciphertext. */
  encrypt(plaintext: string, context: { org_id: string; column: string }): string;
  /** Decrypt a base64 ciphertext. Throws on wrong key / corruption. */
  decrypt(ciphertext: string, context: { org_id: string; column: string }): string;
  /** Stable HMAC for indexing on encrypted columns without leaking plaintext. */
  hmac(value: string, context: { org_id: string; column: string }): string;
}

/** v0.7 default: pass-through (no encryption). v0.7.5 replaces with SQLCipher-backed. */
export class PassthroughEncryption implements EncryptionProvider {
  encrypt(p: string) { return p; }
  decrypt(c: string) { return c; }
  hmac(v: string) { return v; }
}
```

```typescript
// src/security/audit.ts
export interface AuditEvent {
  user_id?: string | null;
  org_id: string;
  action: string;       // dotted namespace: 'auth.login.success', 'thread.create', ...
  target?: string;
  ip?: string;
  user_agent?: string;
  metadata?: Record<string, unknown>;
}

export function auditLog(ev: AuditEvent): void {
  getDb().prepare(`INSERT INTO audit_log (user_id, org_id, action, target, ip, user_agent, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ev.user_id ?? null, ev.org_id, ev.action, ev.target ?? null,
         ev.ip ?? null, ev.user_agent ?? null,
         ev.metadata ? JSON.stringify(ev.metadata) : null);
}
```

**Where to call `auditLog`** in Phase 2+:

| Endpoint / event | action string |
|---|---|
| Successful OAuth callback | `auth.login.success` |
| Failed login (CSRF / invalid state) | `auth.login.failure` |
| `/api/auth/device` initiated | `auth.device.initiated` |
| `/api/auth/device/token` approved | `auth.device.approved` |
| `/api/auth/agent-token` issued | `auth.agent_token.issued` |
| `/api/auth/refresh` rotated | `auth.refresh.rotated` |
| `/api/auth/revoke` | `auth.token.revoked` |
| `/api/reset` (admin destructive op) | `admin.reset` |
| Sensitive column/table accessed | `data.read.<table>` |
| Role granted to user | `role.grant` |
| Role revoked from user | `role.revoke` |
| IdP config created/updated | `idp.config.update` |
| JWT secret rotated | `auth.jwt_secret.rotated` |
| User added to org | `org.user.added` |
| User removed from org | `org.user.removed` |
| Admin deletes a user | `admin.user_delete` |
| Audit log exported | `admin.audit_log_export` |
| Refresh token reuse detected (both revoked) | `auth.refresh.reuse_detected` |
| Device code expired before approval | `auth.device.expired` |
| Device code brute-force limit hit | `auth.device.rate_limit` |

Total ~20 events defined. Phase 5 (v0.8) extends with `data.export.*`, `data.delete.*` for GDPR right-to-access/forgotten endpoints.

### C. JWT shape (Phase 1)

```typescript
interface AuthClaims {
  sub: string;        // 'agent_<uuid>' (per-process agent identity)
  user_id: string;    // 'user_<uuid>' (the human owner)
  org: string;        // 'default' until Phase 5 SaaS
  role: 'admin' | 'member' | 'agent';
  jti: string;        // for revocation tracking
  iat: number;
  exp: number;
}
```

Backward compat: existing v0.6.x JWTs without `user_id` / `org` are treated as `user_id='legacy', org='default', role='admin'` and accepted only when `AUTH_ENABLED=false` (open-coordinator mode). When `AUTH_ENABLED=true`, v0.6 JWTs are rejected — agents must re-authenticate via the device flow or CLI login to obtain a v0.7 JWT.

### D. Query scoping (Phase 1)

Every existing SELECT/INSERT/UPDATE that hits a table with `org_id` must scope by org. Convention: pass `org_id` as the first parameter through the call chain.

Example before/after in `src/file-tracker.ts`:

```typescript
// Before:
getBySession(sessionId: string): FileActivity[] {
  return db.prepare("SELECT * FROM file_activity WHERE session_id = ?")
    .all(sessionId) as FileActivity[];
}

// After:
getBySession(orgId: string, sessionId: string): FileActivity[] {
  return db.prepare("SELECT * FROM file_activity WHERE org_id = ? AND session_id = ?")
    .all(orgId, sessionId) as FileActivity[];
}
```

Same pattern for all consultation, registry, working-files, git-cochange queries. The middleware extracts `claims.org` and passes it to every handler; handlers pass it into every service method.

A test verifies cross-tenant isolation: seed two orgs with overlapping data, query as org A, confirm no rows from org B leak.

### E. GitHub provider (Phase 2)

```typescript
// src/auth/providers/github.ts
import type { IdPProvider, IdpUserInfo } from "./types.js";

export class GitHubProvider implements IdPProvider {
  name = "github";
  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  buildAuthUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      state,
      scope: "read:user user:email",
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<IdpUserInfo> {
    // POST https://github.com/login/oauth/access_token
    // GET https://api.github.com/user
    // GET https://api.github.com/user/emails (for primary verified email)
    // Return { idp_user_id: String(github.id), email, name, idp_org_id? }
  }
}
```

Wired via env vars: `COORDINATOR_GITHUB_CLIENT_ID`, `COORDINATOR_GITHUB_CLIENT_SECRET`.

### F. Device Flow (Phase 2 — RFC 8628)

**Initiation** (agent calls):

```
POST /api/auth/device
Request: { provider: "github", device_label?: "essaim-agent-1" }
Response: {
  device_code: "8a4f9e2c-...",       // opaque, agent-only
  user_code: "AB12-CD34",            // human-typeable, shown to user
  verification_url: "https://coord.example.com/auth/device",
  verification_url_complete: "https://coord.example.com/auth/device?code=AB12-CD34",
  expires_in: 600,                   // seconds
  interval: 5                        // poll interval
}
```

Coordinator inserts a `device_auth_requests` row with the codes and expiration.

**User-facing UI** (Phase 2 HTML page at `GET /auth/device`):

```
┌────────────────────────────────────────┐
│  Enter your device code                │
│  ┌────────────────────────────────────┐│
│  │  AB12-CD34                         ││
│  └────────────────────────────────────┘│
│           [Sign in to authorize]       │
└────────────────────────────────────────┘
```

User clicks "Sign in", page redirects to `GET /auth/login?device_code=...`, which redirects to the provider's OAuth.

**Callback handling** (`GET /auth/callback/github?code=...&state=...`):

1. Decode `state` (signed JWT containing `device_code`)
2. Exchange `code` for GitHub user info via `GitHubProvider.exchangeCode`
3. Find-or-create row in `users` (org = `'default'` for Phase 2-4)
4. Update `device_auth_requests.approved_user_id`
5. Render success page: "You can close this browser. Your CLI/agent will continue."

**User code format**: `BCDFGHJK-LMNPQRSTV` charset (RFC 8628 recommended, no vowels or visually confusable characters). Format: 8 characters with a central hyphen (e.g., `BCDF-GHJK`). The `user_code` field is generated with a `UNIQUE` constraint in the DB. On collision, generation retries up to 3 times before failing the device flow request.

**Agent polling**:

```
POST /api/auth/device/token
Request: { device_code: "8a4f9e2c-..." }
Response (still pending):
  202 { status: "authorization_pending" }
Response (polling too fast):
  400 { error: "slow_down", interval: <updated-interval> }   // RFC 8628
Response (user rejected):
  400 { error: "access_denied" }
Response (code expired):
  400 { error: "expired_token" }                             // not HTTP 410 — RFC 8628 §3.5
Response (approved):
  200 {
    refresh_token: "rt_...",         // long-lived (30 days), stored locally
    agent_jwt: "eyJ...",             // short-lived (15 min), used for API calls
    expires_in: 900
  }
```

Agent polls every `interval` seconds. Pending → 202. Approved → 200 + tokens. Expired → 400 `expired_token`. Coordinator deletes `device_auth_requests` row after issuing tokens.

**Abandoned device code cleanup**: a background sweeper (reusing the v0.6 sweeper pattern) deletes `device_auth_requests` rows where `expires_at < now AND approved_user_id IS NULL`. Runs every 5 minutes.

### G. CLI login (Phase 3)

`mcp-coordinator-cli login [--provider github|google|oidc] [--coordinator-url URL]`:

1. CLI starts an HTTP server on `127.0.0.1:<random-port>` with a single handler for `/cb`. If the port is in use (`EADDRINUSE`), retry up to 5 times with a new random port before failing. Always print the auth URL to stdout regardless so the user can copy-paste it manually.
2. CLI generates a PKCE pair:
   - `code_verifier`: 43-character crypto-random string (A-Z a-z 0-9 - . _ ~), stored in a signed state JWT.
   - `code_challenge`: `BASE64URL(SHA-256(ASCII(code_verifier)))` — S256 method, mandatory.
3. If running under WSL (`WSL_DISTRO_NAME` env set) or SSH (`SSH_CONNECTION` env set), skip `open()` and print:
   ```
   Open this URL in your browser to authenticate:
   https://coord.example.com/auth/login?...
   ```
   Otherwise call `open(url)` and also print the URL as fallback.
4. CLI sends the URL:
   ```
   https://coord.example.com/auth/login
     ?provider=github
     &cb=http://127.0.0.1:<random-port>/cb
     &state=<signed-state-JWT containing: cb, code_verifier, nonce>
     &code_challenge=<base64url-sha256-verifier>
     &code_challenge_method=S256
   ```
5. Coordinator handles `/auth/login`, stores `code_verifier` from state JWT, redirects to the IdP's authorize URL with `code_challenge` and `code_challenge_method=S256`.
6. User authenticates at the IdP, redirects back to coordinator's `/auth/callback/github?code=...&state=...`.
7. Coordinator verifies `state` JWT (including `provider` claim matches URL path — mix-up defense), extracts `code_verifier`, calls `exchangeCode(code, redirectUri, codeVerifier)`.
8. Coordinator exchanges code, find-or-creates user, issues `refresh_token`.
9. Coordinator POSTs to `http://127.0.0.1:<random-port>/cb` with form-encoded body `refresh_token=...&device_label=cli-login`. (POST body, not query string — query strings are logged in browser history and intermediate proxies.)
10. CLI's local server receives the POST, extracts `refresh_token`, stores it in `~/.mcp-coordinator/auth.json` (mode 0600).
11. CLI prints `Logged in as alice@example.com. You can close the browser.` and exits.

When `refresh_token` has fewer than 3 days remaining before expiry, the CLI logs a warning at startup. The `mcp-coordinator-cli auth status` subcommand shows the current expiration date.

Storage format:

```json
{
  "coordinator_url": "https://coord.example.com",
  "refresh_token": "rt_...",
  "user_email": "alice@example.com",
  "device_label": "cli-login-2026-05-11",
  "expires_at": "2026-06-10T15:30:00Z"
}
```

OS keychain integration (optional, Phase 3 enhancement): if `keytar` is available, store `refresh_token` in the OS keychain instead of plaintext. Fallback to file mode 0600.

**CLI binary structure**: All CLI commands ship as subcommands of the single `mcp-coordinator` binary. The pattern is `mcp-coordinator auth login`, `mcp-coordinator auth status`, `mcp-coordinator server backup`, etc. This avoids binary sprawl (`mcp-coordinator-cli` as a separate binary is deprecated in favor of the subcommand approach). The `bin` entry in `package.json` registers only `mcp-coordinator` (the daemon + CLI in one binary, with the first positional arg routing between daemon and CLI modes).

### H. Agent token derivation (Phase 2)

```
POST /api/auth/agent-token
Request:
  Authorization: Bearer <refresh_token>
  Body: { agent_label?: "essaim-agent-1" }
Response:
  200 {
    agent_jwt: "eyJ...",
    expires_in: 900,
    agent_id: "agent_<uuid>"
  }
```

Coordinator:
1. Verify `refresh_token` (lookup in `refresh_tokens` table, not revoked, not expired).
2. Update `last_used_at` on the refresh token.
3. Mint a new short-lived JWT with claims `{ sub: agent_id, user_id, org, role: 'agent', exp: now+15min, jti }`.
4. Return JWT to agent.

When the agent JWT expires (15 min), the agent calls `/api/auth/agent-token` again with the same `refresh_token`. No need to re-authenticate the human.

### I. Google + OIDC providers (Phase 4)

`GoogleProvider` follows the same pattern as `GitHubProvider`, with different endpoints (`accounts.google.com/o/oauth2/v2/auth` and `oauth2.googleapis.com/token`). Requested scope: `openid email profile`.

The Google authorization request includes a `nonce=<random>` parameter. The coordinator verifies that the returned `id_token`'s `nonce` claim matches the value sent in the request.

**id_token signature verification** (mandatory for both Google and generic OIDC):

```typescript
// Auto-discover JWKS endpoint via /.well-known/openid-configuration
const jwks = jose.createRemoteJWKSet(new URL(issuer + '/.well-known/openid-configuration'));

// Verify RS256 signature, issuer, audience, and nonce
const { payload } = await jose.jwtVerify(idToken, jwks, {
  issuer: OIDC_ISSUER,          // must match 'iss' claim
  audience: OIDC_CLIENT_ID,     // must match 'aud' claim (prevents id_token misuse across apps)
  algorithms: ['RS256'],         // RS256 only for OIDC id_tokens
});
// Then verify payload.nonce === nonce sent in authorization request
```

Skipping or relaxing any of `issuer`, `audience`, `algorithms`, or `nonce` validation is disallowed.

`OIDCProvider` is generic — takes an `issuer_url` and auto-discovers via `<issuer>/.well-known/openid-configuration`. Configurable for Okta, Auth0, Azure AD, Keycloak, Authentik, etc.

Provider selection UI (`GET /auth/login` with no `?provider=`):

```
┌──────────────────────────────────────────┐
│  Sign in to mcp-coordinator              │
│                                          │
│  [  Continue with GitHub  ]              │
│  [  Continue with Google  ]              │
│  [  Continue with SSO     ]   (OIDC)     │
└──────────────────────────────────────────┘
```

### J. Middleware integration (Phase 1)

`src/auth.ts` `authenticateRequest` is extended:

```typescript
export async function authenticateRequest(req: IncomingMessage): Promise<AuthResult> {
  const auth = req.headers.authorization;

  if (!AUTH_ENABLED) {
    // Open-coordinator mode: four sub-scenarios:
    // (a) No Authorization header + AUTH_ENABLED=false → synthetic legacy claims (backward compat)
    // (b) No Authorization header + AUTH_ENABLED=true  → 401 (handled in else branch)
    // (c) Old v0.6 JWT (no user_id/org claims) + AUTH_ENABLED=false → accept, inject synthetic legacy claims
    // (d) New v0.7 JWT + AUTH_ENABLED=false → standard verify (optional in open mode)
    if (!auth || !auth.startsWith('Bearer ')) {
      return { ok: true, claims: { sub: 'legacy', user_id: 'legacy', org: 'default', role: 'admin' } };
    }
    // Bearer present even in open mode — verify but tolerate missing v0.7 claims
    try {
      const claims = await verifyToken(auth.slice(7), { algorithms: ['HS256'] });
      return { ok: true, claims: { user_id: 'legacy', org: 'default', role: 'admin', ...claims } };
    } catch {
      return { ok: true, claims: { sub: 'legacy', user_id: 'legacy', org: 'default', role: 'admin' } };
    }
  }

  // AUTH_ENABLED=true
  if (!auth || !auth.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing Bearer token', status: 401,
             wwwAuthenticate: 'Bearer realm="mcp-coordinator", error="invalid_token"' };
  }
  try {
    const claims = await verifyToken(auth.slice(7), { algorithms: ['HS256'] });
    return { ok: true, claims };
  } catch (err) {
    const isExpired = err instanceof errors.JWTExpired;
    return { ok: false, error: isExpired ? 'Token expired' : 'Invalid token', status: 401,
             wwwAuthenticate: `Bearer realm="mcp-coordinator", error="${isExpired ? 'expired_token' : 'invalid_token'}"` };
  }
}
```

**MCP transport JWT verification**: every MCP tool call (not just session-open) must carry a valid `Authorization: Bearer <agent_jwt>` header and pass through `authenticateRequest`. If the MCP session lives longer than the agent JWT TTL (15 min), the agent must call `/api/auth/agent-token` with its refresh token to obtain a new agent JWT and update the Authorization header on subsequent MCP requests. This is documented in the MCP client adapter.

**Multi-tenant isolation**: `sseEmitter.emit()` and `addListener()` in `src/sse.ts` are extended with an `org_id` filter parameter. SSE clients are registered with their `org` claim and only receive events where `event.org_id === client.org_id`. The `handle-rest.ts` API change: SSE subscription endpoints extract `claims.org` and pass it to the emitter registry. MQTT topic structure: `coordinator/<org_id>/agents/...`. The Aedes ACL hook filters subscriptions by the `org` claim in the JWT, rejecting subscriptions to topics outside the subscriber's org.

Every handler that uses `services.workingFiles.start(agent_id, ...)` etc. now passes `claims.org` so the service can scope DB queries.

## Auth flows (sequence diagrams)

### Flow 1 — Device Flow (headless / SSH / Docker)

```
agent              coordinator           IdP            user-browser
  │                     │                  │                  │
  │── POST /device ────>│                  │                  │
  │<── code+url ────────│                  │                  │
  │ (prints code to UI)                    │                  │
  │                     │                  │   user visits URL│
  │                     │<───── GET /auth/device + code ──────│
  │                     │                  │  shows sign-in   │
  │                     │── redirect ──>   │                  │
  │                     │                  │<── OAuth flow ──>│
  │                     │<── callback+code ────────────────── │
  │                     │── token request ─>                  │
  │                     │<── user info ────                   │
  │                     │ (creates user, marks device approved)│
  │                     │── success page ───────────────────> │
  │                                                            │
  │── POST /device/token (poll) ─>                             │
  │<── 200 {refresh, jwt} ────────                             │
  │ (stores refresh, uses jwt)                                 │
```

### Flow 2 — CLI login (local browser callback)

```
CLI         local-http (127.0.0.1)   coordinator        IdP        browser
 │                  │                       │              │           │
 │── starts ───────>│ (listens on :random)  │              │           │
 │── open(url) ─────────────────────────────────────────> │           │
 │                  │                       │<── GET /login│           │
 │                  │                       │── 302 ──────>│           │
 │                  │                       │              │<──auth ──>│
 │                  │                       │<──callback ──│           │
 │                  │ (user, refresh_token created)        │           │
 │                  │                       │── 302 ──────────────────>│
 │                  │<── GET /cb?rt=... ────────────────── │           │
 │ (receives rt)    │                       │              │           │
 │── stores rt ─────│                                                  │
 │ (exits 0)        │                                                  │
```

### Flow 3 — Agent token issuance (each agent boot)

```
agent          coordinator
  │── read ~/.mcp-coordinator/auth.json
  │── POST /api/auth/agent-token (Bearer rt) ─>
  │                              (verify rt, mint JWT)
  │<── 200 { agent_jwt, expires_in: 900 } ────
  │
  │── (use Bearer agent_jwt for all API calls)
  │
  │ (15 min later)
  │── POST /api/auth/agent-token (Bearer rt) ─>
  │<── 200 { new jwt, expires_in: 900 } ──────
```

## Operational config

### Environment variables

| Variable | Default | Effect | Phase |
|---|---|---|---|
| `COORDINATOR_AUTH_ENABLED` | `false` | Master switch. When `true`, all `/api/*` require JWT. | (existing) |
| `COORDINATOR_PUBLIC_URL` | (host header) | Used as the base URL for OAuth callbacks. **Required** when `AUTH_ENABLED=true`. | 2 |
| `COORDINATOR_JWT_SECRET` | (random per boot, transient) | HS256 signing key. **MUST be set explicitly in prod** — default random-per-boot invalidates all sessions on restart. | (existing) |
| `COORDINATOR_JWT_PREV_SECRET` | (unset) | Optional previous signing key for zero-downtime rotation. Middleware verifies with current secret first; falls back to prev. Operator workflow: set both, restart, wait one JWT TTL, remove prev. | (existing) |
| `COORDINATOR_GITHUB_CLIENT_ID` | (unset) | Enables GitHub provider when set. | 2 |
| `COORDINATOR_GITHUB_CLIENT_SECRET` | (unset) | Required with above. | 2 |
| `COORDINATOR_GOOGLE_CLIENT_ID` | (unset) | Enables Google provider. | 4 |
| `COORDINATOR_GOOGLE_CLIENT_SECRET` | (unset) | Required with above. | 4 |
| `COORDINATOR_OIDC_ISSUER_URL` | (unset) | Enables generic OIDC. Auto-discovers `/well-known/openid-configuration`. | 4 |
| `COORDINATOR_OIDC_CLIENT_ID` | (unset) | Required with above. | 4 |
| `COORDINATOR_OIDC_CLIENT_SECRET` | (unset) | Required with above. | 4 |
| `COORDINATOR_REFRESH_TOKEN_TTL_DAYS` | `30` | Lifetime of refresh tokens. | 2 |
| `COORDINATOR_AGENT_JWT_TTL_SECONDS` | `900` (15 min) | Lifetime of agent JWTs. | 2 |
| `COORDINATOR_DEVICE_FLOW_TTL_SECONDS` | `600` (10 min) | Lifetime of device codes. | 2 |
| `COORDINATOR_REGISTRATION_SECRET` | (unset) | **Deprecated.** Still accepted in `AUTH_ENABLED=false` mode for backward compat. Removed in v0.8. | (existing) |
| `COORDINATOR_ADMIN_SECRET` | (unset) | **Deprecated.** Same as above. | (existing) |

### DB file permissions

Phase 1 adds: on first DB creation in `initDatabase()`, set `coordinator.db` to mode 0600 (owner read/write only). Existing v0.6.x DBs are also re-chmod'd to 0600 on every boot (idempotent). Defense baseline against an unprivileged co-user reading the DB file directly.

### TLS

OAuth providers refuse non-HTTPS callbacks for security. Therefore, when `AUTH_ENABLED=true` with any IdP configured, the coordinator **must** be reachable via HTTPS at `COORDINATOR_PUBLIC_URL`. Recommended approaches:

- **Reverse proxy** (nginx, Caddy, Traefik) terminating TLS. Coordinator listens on HTTP behind it.
- **Cloudflare Tunnel / ngrok** for dev.
- **`127.0.0.1`** is OAuth-callback-acceptable for local CLI login (Phase 3) without HTTPS — exception in the OAuth spec.

Documenting in README. Not implementing in-coordinator TLS termination (use a proxy).

## Error handling

| Failure | Behavior |
|---|---|
| User cancels OAuth | Provider redirects with `error=access_denied`; coordinator shows friendly "Login cancelled" page |
| Provider returns 5xx during code exchange | 502 with retry hint; log error |
| Refresh token revoked | `/api/auth/agent-token` returns 401; agent must re-authenticate (delete `auth.json`, re-run login) |
| Device code expired before approval | `/api/auth/device/token` returns 400 `{ error: "expired_token" }` (RFC 8628 §3.5; not HTTP 410); agent prints "Code expired, please retry" |
| User_code collision (1 in 16M) | Retry generation up to 3 times |
| `org` claim in JWT mismatches stored user row (token was minted for different org) | 401 with log warn; could indicate token theft |
| Cross-tenant query (handler forgets to scope) | Defense-in-depth: a unit test seeds 2 orgs, runs every public API method, asserts isolation |

## Security considerations

- **State parameter**: every OAuth flow uses a signed-JWT state token containing the `device_code` (Flow 1) or `cb` URL (Flow 2) to prevent CSRF. From the IdP's perspective the state value is opaque — the fact that it's a JWT is an internal implementation detail. The state JWT includes a `provider` claim; the coordinator verifies this claim matches the URL path (`/auth/callback/<provider>`) on callback, defending against mix-up attacks where a user completes an OAuth flow with the wrong provider.
- **State single-use (nonce)**: the state JWT includes a `nonce` claim (random per flow). Used nonces are tracked in the `device_auth_requests` table (or a dedicated `state_nonces` table). Post-exchange, the nonce is invalidated to prevent replay.
- **PKCE (S256 mandatory)**: CLI login flow (Phase 3) generates a 43-character crypto-random `code_verifier`, derives `code_challenge = BASE64URL(SHA-256(code_verifier))`. The verifier is stored in the signed state JWT and passed to `exchangeCode`. S256 is the only accepted method — plain is rejected.
- **JWS algorithm pinning**: `jwtVerify` must be called with `{ algorithms: ['HS256'] }` at every call site. This prevents algorithm confusion attacks (including `alg=none`). The `algorithms` parameter is mandatory per call — it is never omitted. Example: `jose.jwtVerify(token, secret, { algorithms: ['HS256'] })`. RS256 is only used for OIDC id_token verification (see OIDC section).
- **Refresh token rotation**: each `/api/auth/refresh` issues a new refresh token and revokes the old one. Detects compromise via reuse detection: if two concurrent requests arrive with the same refresh token, only the first DB write succeeds (UNIQUE constraint on `last_used_at` update, or a compare-and-swap). The second attempt gets 401, **both** tokens are immediately revoked, and the user must re-login. This is the refresh-rotation reuse-detection pattern.
- **JWT lifetime**: short (15 min) so revocation is fast (no full revocation list lookup needed for most requests).
- **Refresh storage**: file mode 0600; OS keychain when available.
- **401 WWW-Authenticate header**: on any 401 response, middleware includes `WWW-Authenticate: Bearer realm="mcp-coordinator", error="<reason>"` where reason is `invalid_token`, `expired_token`, or `insufficient_scope` per RFC 6750.
- **Audit log**: every successful login, refresh, agent-token issue, revoke logged with `user_id`, IP, user-agent.
- **Rate limiting**: `/api/auth/device/token` polling is rate-limited per device_code (the `interval` in the response). User code entry (`POST /auth/device`) is rate-limited to 5 attempts per IP per minute and 20 attempts per device_code lifetime; after 20 attempts, the device code is expired.

## Testing

- `tests/unit/auth-jwt.test.ts` (extends existing) — adds `org` claim, `user_id` claim
- `tests/unit/auth-providers/github.test.ts` — mock HTTPS, verify URL building + code exchange
- `tests/unit/auth-providers/google.test.ts` — same
- `tests/unit/auth-providers/oidc.test.ts` — mock issuer discovery + token endpoint
- `tests/unit/auth-device-flow.test.ts` — full flow: device init, approve, poll, exchange
- `tests/unit/auth-cli-login.test.ts` — integration with a mock local HTTP server
- `tests/unit/auth-cross-tenant-isolation.test.ts` — defense-in-depth: 2 orgs, every public API method, no row leak
- `tests/unit/auth-pkce.test.ts` — verifier→challenge round-trip (43-char verifier → SHA-256 → base64url matches challenge); exchange with wrong verifier → rejected
- `tests/unit/auth-state-nonce.test.ts` — state JWT nonce is single-use; replaying same nonce → rejected
- `tests/unit/auth-mix-up.test.ts` — state JWT `provider` claim mismatch on callback URL → rejected
- `tests/unit/auth-device-flow-rfc8628.test.ts` — `slow_down`, `access_denied`, `expired_token` error codes; user_code RFC 8628 charset; 20-attempt rate-limit expires the device code
- `tests/unit/auth-refresh-reuse-race.test.ts` — concurrent refresh reuse → first succeeds, second gets 401, both revoked
- `tests/unit/auth-alg-pinning.test.ts` — `alg=none` token rejected; RS256-signed token rejected for HS256 endpoint
- `tests/unit/orgs-migration.test.ts` — v0.6.x DB with no `org_id` columns → boot v0.7 → all rows get `org_id='default'`
- `tests/unit/auth-backward-compat.test.ts` — four AUTH_ENABLED scenarios (a/b/c/d) per migration table

Integration: extend `tests/unit/s3-network-integration.test.ts` to set up a mock IdP server and run a complete device-flow happy path against a real coordinator instance.

## Migration & rollback

### Boot v0.7 against v0.6.x database

- Schema migrations idempotent (`IF NOT EXISTS`, try/catch `ALTER TABLE`).
- All existing rows get `org_id='default'` via the `DEFAULT 'default'` in the ALTER.
- The `'default'` org is seeded.
- `user_version` bumps from 6 → 7.
- **ALTER TABLE note**: SQLite lacks online DDL. Each `ALTER TABLE ... ADD COLUMN` briefly blocks writes (~30-60s on large tables). Recommend stopping the coordinator before v0.7 boot, or accept this brief unavailability window. Migration is idempotent (try/catch on already-exists error).

### Phase 1 data migration — v0.6 agents to v0.7 users

When first booting v0.7 with `AUTH_ENABLED=true`:
- Existing `agents` rows receive `org_id='default'` (via the ALTER migration above).
- No `users` rows are auto-created for v0.6 agents. Each agent's human owner must authenticate via the device flow or CLI login to create a `users` row. There is no automatic mapping from `agent_name` to a user identity.
- **All v0.6 JWTs are invalidated** when `AUTH_ENABLED=true` (the new middleware rejects tokens without `user_id` / `org` claims). Agents must re-authenticate. Communicate this breaking change in the v0.7 release notes.
- Recommended migration sequence: (1) notify team, (2) boot v0.7 with `AUTH_ENABLED=false` first (zero disruption), (3) have everyone run `mcp-coordinator auth login`, (4) flip `AUTH_ENABLED=true`, (5) restart.

### Boot v0.7 with `AUTH_ENABLED=false`

The middleware handles four scenarios for backward compatibility:

| Scenario | Behavior |
|---|---|
| (a) No `Authorization` header + `AUTH_ENABLED=false` | Inject synthetic claims `{user_id:'legacy', org:'default', role:'admin'}`. Backward compat for all v0.6 clients. |
| (b) No `Authorization` header + `AUTH_ENABLED=true` | Return 401 with `WWW-Authenticate` header. |
| (c) Old v0.6 JWT (no `user_id`/`org` claims) + `AUTH_ENABLED=false` | Accept; inject missing claims as `{user_id:'legacy', org:'default', role:'admin'}`. |
| (d) New v0.7 JWT (has `user_id`/`org`) | Standard verify at both `AUTH_ENABLED` values. |

All existing v0.6 clients (essaim hooks, MCP tools) keep working unchanged under scenario (a).

### Enable auth on an existing deployment

- Set `AUTH_ENABLED=true` + IdP env vars + `COORDINATOR_PUBLIC_URL`.
- Restart coordinator.
- Users run `mcp-coordinator auth login` once on their machines.
- essaim hooks already read `~/.mcp-coordinator/auth.json` and call `/api/auth/agent-token` (after Phase 2 changes to the hook scripts).

### Rollback v0.7 → v0.6

- Disable auth: set `AUTH_ENABLED=false`, restart.
- v0.6 binary doesn't know about `org_id` columns but SQLite ignores unknown columns at read time. No data loss.
- `PRAGMA user_version` check refuses v0.7 DB on v0.6 binary — known limitation, restore v0.6 backup if downgrading.

## Phasing

| Phase | Version | Scope | Estimate |
|---|---|---|---|
| 1 | v0.7.0 | Foundation: schema, JWT shape, IdPProvider interface, query scoping, middleware | 1-2 weeks |
| 2 | v0.7.1 | GitHub OAuth + Device Flow + agent-token endpoint + essaim hook updates (read `~/.mcp-coordinator/auth.json` + call `/api/auth/agent-token`) + first end-to-end auth | 1 week |
| 3 | v0.7.2 | CLI login command + local browser callback + auth.json storage + OS keychain integration | 3-4 days |
| 4 | v0.7.3 | Google OAuth + generic OIDC + provider selection UI | 1 week |
| **Total** | | | **~3-4 weeks** |

Ship each phase as its own release. Validate Phase 1 with all-existing-features-still-work (zero user-visible change) before Phase 2.

## What was cut and why

| Cut | Reason |
|---|---|
| Email/password local auth | IdP-only keeps the attack surface narrow. Solo users can use `AUTH_ENABLED=false`. |
| MFA enforcement | IdPs handle this. Coordinator doesn't try to second-guess. |
| Per-org admin UI | Phase 5 SaaS, deferred. |
| Billing / Stripe | Phase 5 SaaS, deferred. |
| Audit log surface UI | Pino log lines + Prometheus metrics suffice. Visual surface is Phase 5. |
| Fine-grained roles | Only `admin`, `member`, `agent`. Per-action permissions are Phase 5. |
| In-coordinator TLS termination | Use a reverse proxy. Less code, well-trodden ops pattern. |
| GraphQL/REST API for orgs/users CRUD | Coordinator is the auth backplane only. Org management is via direct DB or future admin UI. |

## Risks accepted

- **Cross-tenant data leak via missed query scoping**: mitigated by the defense-in-depth isolation test that exercises every public API method, plus code review. Cannot be eliminated 100% in TypeScript without a stronger query DSL.
- **OAuth provider downtime**: agents with valid refresh tokens keep working (token exchange is local). New logins blocked while provider is down. Acceptable.
- **`COORDINATOR_PUBLIC_URL` misconfiguration**: callbacks fail. Diagnostic: clear error message in coordinator log + `/healthz` reports auth config status.
- **TTL tuning**: refresh-token TTL of 30 days means revoked tokens stay valid up to 30 days at edge sites with stale state. Mitigated by refresh rotation + `revoked_at` lookup on every issuance.
- **Phase 1 has no user-visible value on its own**: pure technical debt payoff. Risk that this phase ships and v0.7.1 doesn't materialize for a while. Mitigated by sequencing Phase 1+2 as a single release if possible.

## Open questions

None. All resolved through the brainstorming session.

## References

- `src/auth.ts` (current ~114 LOC) — base to extend
- `src/database.ts:10-180` — inline `SCHEMA` const, follow the existing pattern
- `src/serve-http.ts` — `handleAuth` function (lines 97-171 after the v0.5.0 parseBody fix), where new auth routes plug in
- `src/path-normalize.ts` — module-style precedent for new utility files (e.g. `src/auth/providers/*`)
- RFC 8628 — OAuth 2.0 Device Authorization Grant
- RFC 7636 — PKCE (for CLI login Phase 3)
- OpenID Connect Core 1.0 — for Phase 4 generic OIDC provider
- Anthropic Claude Code's MCP auth model — for any future native integration
