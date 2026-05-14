# Auth Phase 2 — OAuth + Device Flow + Audit Wiring — Implementation Plan v1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is independently reviewable.

## Status

**Plan version**: v1 (initial draft, pre-review)
**Version target**: mcp-coordinator@0.8.0
**Date**: 2026-05-13
**Spec**: `docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design.md` (1708 lines)
**Spec patches**: `docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design-V4-patches.md` (787 lines)
**Decisions trail**: `decisions-v3.md` (post 44-agent review) + V4 patches (post 64-agent review total)

**Total brainstorm + design**: 64 reviewer agents across 3 rounds. **Plan review**: targets 4 rounds × 20 agents = 80 reviewers (Phase-1 process parity).

## Revisions

(Empty — initial draft. Each review round adds a section here.)

## Plan structure

5 phases / 32 tasks. Each task is a discrete PR (or subagent dispatch unit). Phase A→E ordering reflects dependencies; within a phase, many tasks can run in parallel.

```
Phase A — Foundation modules         (T01–T08)   no external API surface; pure types + helpers
Phase B — Helper modules             (T09–T14)   cross-cutting; consumed by endpoint handlers
Phase C — Endpoint implementations   (T15–T24)   HTTP routes + algorithm wiring
Phase D — Integration & operations   (T25–T30)   end-to-end glue + boot + sweepers
Phase E — Tests & documentation      (T31–T35)   coverage + co-shipped deliverables
```

### Task dependency DAG (high-level)

```
T01 (schema migration) ─────┬─→ T05 (GitHubProvider)
                            ├─→ T06 (oauth_state CRUD)
                            ├─→ T11 (audit extension)
                            ├─→ T12 (rate-limit)
                            └─→ T28 (sweeper)

T02 (IdPProvider types) ──→ T04 (membership-cache) ──→ T05 (GitHubProvider)

T03 (token-epoch helper) ──→ T19 (refresh rotation)
                          ├─→ T23 (logout endpoints)
                          ├─→ T27 (Scenario 5)
                          └─→ T29 (boot+restore)

T07 (cookies)      ────────┐
T08 (csrf)         ────────┤
T13 (html render)  ────────┼─→ T15 (login), T20 (approve), T21 (device pages), T22 (success)
T09 (allowlist)    ────────┼─→ T16 (callback), T19 (refresh rotation)
T10 (request-id)   ────────┘
T11 (audit)        ─────────→ all endpoints

T14 (discovery doc) ──────── standalone

Endpoint dependencies (Phase C):
T15 (login) → uses T13
T16 (callback) → uses T01,T02,T04,T05,T06,T07,T09,T11,T17(no),T19(no — direct INSERT)
T17 (device_auth init) → uses T01,T05
T18 (token endpoint dispatcher) → switches between T16-flow, T19-rotation, T17-poll
T19 (refresh rotation) → uses T01,T03,T04,T05,T07,T09,T11
T20 (device approve) → uses T08,T11,T13
T21 (device pages) → uses T13
T22 (success page) → uses T13
T23 (logout endpoints) → uses T03,T07,T11
T24 (/api/auth/me) → uses T27

T25 (service token issuance) → uses T01,T11
T26 (service token verification override) → uses T25,T27
T27 (Scenario 5 cookie auth) → uses T03,T07,T11
T28 (sweeper) → uses T01
T29 (boot validation + restore detect) → uses T01,T11
T30 (login lockout integration) → uses T11,T12
```

---

# Phase A — Foundation modules (T01–T08)

These tasks add no external API surface. They are pure types, schemas, and synchronous helpers. They unblock everything downstream.

## T01: Schema migration + version bump + CI lints

**Estimated size**: 600 lines (migration code + tests + CI lint scripts)
**Dependencies**: none
**Files touched**:
- `src/database.ts` (extend `initDatabase` with v8 migration block)
- `migrations/v8-phase2.sql` (NEW, optional — if Phase 1 used inline; check existing pattern)
- `tests/unit/migration-v07-to-v08.test.ts` (NEW)
- `.github/workflows/lint.yml` (CI grep checks)
- `scripts/lint-no-current-timestamp.sh` (NEW)
- `scripts/lint-no-users-org-id.sh` (NEW)
- `scripts/lint-no-audit-mutation.sh` (NEW)
- `scripts/lint-html-escape.sh` (NEW)

**Implementation summary**:

1. Add SQLite version check at boot (refuse if `<3.25`)
2. Detect current `user_version` (Phase 1 is 7); if `<8`, run migration
3. Migration block (wrap in `PRAGMA foreign_keys = OFF` ... `ON`):
   - audit_log column renames (`user_id → actor_user_id`, etc.) per V4 FIX 1
   - audit_log Phase 1 row backfill (`outcome = 'legacy_unknown'`)
   - `ALTER TABLE users RENAME COLUMN org_id TO primary_org_id`
   - `ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0`
   - `ALTER TABLE users ADD COLUMN idp_access_token TEXT` (per V4 FIX 4)
   - `CREATE TABLE user_orgs (...)` with FKs CASCADE/RESTRICT (per V4 FIX 3)
   - Backfill `user_orgs` from `users.primary_org_id` (idempotent `ON CONFLICT DO NOTHING`)
   - `ALTER TABLE orgs ADD COLUMN allowlist_github_org TEXT`
   - `CREATE INDEX idx_orgs_allowlist`
   - `CREATE TABLE oauth_state (...)` per §4.1 (NO `user_agent_hash` per V3 cut)
   - `CREATE INDEX idx_oauth_state_expires`
   - 4 `ALTER TABLE refresh_tokens ADD COLUMN` (family_id, parent_jti, revoked_reason, replay_count, consumer_fingerprint)
   - Backfill `family_id = lower(hex(randomblob(16)))` WHERE family_id IS NULL
   - 4 indexes on refresh_tokens (`family_id+revoked_at`, partial UNIQUE on `parent_jti`, `user_id+revoked_at`, `expires_at`)
   - `ALTER TABLE refresh_tokens ADD COLUMN revoked_reason_check_constraint` — NB SQLite cannot ADD CHECK constraints post-creation cleanly; document acceptance that CHECK is enforced at app layer for legacy ALTERed tables (CI lint pattern guards)
   - 3 `ALTER TABLE device_auth_requests ADD COLUMN` (requester_ip, requester_user_agent, requester_country)
   - `ALTER TABLE device_auth_requests ADD COLUMN failed_approval_attempts INTEGER NOT NULL DEFAULT 0` (per V4 FIX 21)
   - `CREATE TABLE system_state (...)`
   - Compat view: `CREATE VIEW users_legacy_v0_7 AS SELECT *, primary_org_id AS org_id FROM users`
   - Emit `migration.audit_backfill` audit row
   - `PRAGMA user_version = 8`
4. Each ALTER guarded by `hasColumn(db, table, col)` helper (introspection via `PRAGMA table_info`).
5. Each CREATE TABLE uses `IF NOT EXISTS`.

**CI lint scripts (4)**:
- `grep -rn "users\.org_id" src/ tests/` → must return 0 (except in `users_legacy_v0_7` view DDL line)
- `grep -rn "CURRENT_TIMESTAMP" src/ -- :!src/migrations/` → 0 in time-logic columns (refresh_tokens.revoked_at, oauth_state.consumed_at, etc.)
- `grep -rn "UPDATE audit_log\|DELETE FROM audit_log" src/ -- :!src/sweeper/ :!src/migrations/` → 0
- `grep -rn '\${[^}]*}' src/auth/pages/ | grep -v 'render(\|escapeHtml(' | grep -v '^[[:space:]]*//' ` → 0

**Acceptance criteria**:
- [ ] `npm test tests/unit/migration-v07-to-v08.test.ts` passes
- [ ] Migration is idempotent (run twice → 0 errors, 0 duplicate columns, no double-backfill)
- [ ] SQLite < 3.25 → boot fails with friendly error
- [ ] All Phase 1 tests still pass after migration
- [ ] CI lint scripts all return 0 matches
- [ ] `PRAGMA user_version` returns 8 post-migration
- [ ] `users_legacy_v0_7` view exists and queries return same data as `users` table

**Test cases (minimum 8)**:
1. Migration runs on fresh Phase 1 DB → user_version = 8
2. Migration runs twice → no errors, no duplicate rows
3. Phase 1 refresh_tokens rows get `family_id` backfilled (uuid format)
4. Phase 1 users rows get `user_orgs` row (1 per user, matching primary_org_id)
5. audit_log Phase 1 rows get `outcome = 'legacy_unknown'`
6. `migration.audit_backfill` row inserted with correct `rows_marked_legacy` count
7. SQLite version pre-check: mock version 3.24 → boot refuses
8. CI lint scripts: each runs against a synthetic violation file → catches it

**Scope notes**:
- Out of scope: data migration for orgs.allowlist_github_org (done at boot in T29)
- Out of scope: CHECK constraint enforcement on revoked_reason (deferred to app layer + CI lint)

---

## T02: IdPProvider interface extension + error classes

**Estimated size**: 150 lines (types + error classes + unit tests)
**Dependencies**: none
**Files touched**:
- `src/auth/providers/types.ts` (extend)
- `tests/unit/idp-provider-types.test.ts` (NEW)

**Implementation summary**:

1. Extend `IdPProvider` interface:
   ```ts
   interface ExchangeCodeResult {
     user: IdpUserInfo;
     accessToken: string;
   }
   
   interface DeviceCodeResponse {
     device_code: string;
     user_code: string;
     verification_uri: string;
     verification_uri_complete?: string;
     expires_in: number;
     interval: number;
   }
   
   type DevicePollResult =
     | { status: 'authorization_pending' }
     | { status: 'slow_down'; new_interval: number }
     | { status: 'expired_token' }
     | { status: 'access_denied' }
     | { status: 'granted'; user: IdpUserInfo; accessToken: string };
   
   interface IdPProvider {
     readonly name: string;
     buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string;
     exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<ExchangeCodeResult>;
     listMemberships?(accessToken: string): Promise<string[]>;
     requestDeviceCode?(): Promise<DeviceCodeResponse>;
     pollDeviceToken?(deviceCode: string): Promise<DevicePollResult>;
   }
   ```
   
2. Note: `exchangeCode` return type CHANGED from Phase 1 (`Promise<IdpUserInfo>` → `Promise<ExchangeCodeResult>`). This is a breaking change for any external implementer; covered by `?:` optional rule for new methods only. Document in CHANGELOG.

3. Error classes (in `src/auth/providers/errors.ts`, NEW):
   ```ts
   export class IdPTokenRevoked extends Error {
     code = 'IDP_TOKEN_REVOKED';
   }
   export class IdPTransientError extends Error {
     code = 'IDP_TRANSIENT';
   }
   export class IdPScopeInsufficient extends Error {
     code = 'IDP_SCOPE_INSUFFICIENT';
     constructor(public requiredScope: string) { super(); }
   }
   export class ProviderCapabilityError extends Error {
     code = 'PROVIDER_CAPABILITY_MISSING';
     constructor(public capability: string) { super(); }
   }
   ```

4. Branded types (per Round 3 TS agent):
   ```ts
   export type Brand<T, B> = T & { readonly __brand: B };
   export type UserId    = Brand<string, 'UserId'>;
   export type OrgId     = Brand<string, 'OrgId'>;
   export type Jti       = Brand<string, 'Jti'>;
   export type FamilyId  = Brand<string, 'FamilyId'>;
   export type DeviceCode= Brand<string, 'DeviceCode'>;
   export type UserCode  = Brand<string, 'UserCode'>;
   ```

**Acceptance criteria**:
- [ ] Types compile under strict TypeScript
- [ ] Phase 1 GitHubProvider stub (if any) is updated to new shape or marked TODO
- [ ] All 4 error classes have a `code` discriminant matching NR3 stable codes
- [ ] Branded types prevent string-typed parameter swaps at compile time
- [ ] Unit tests verify error class identity (`err instanceof IdPTokenRevoked`)

---

## T03: token-epoch module (read + bump SQL)

**Estimated size**: 100 lines (helper + 2 SQL prepared statements + tests)
**Dependencies**: T01
**Files touched**:
- `src/auth/token-epoch.ts` (NEW)
- `tests/unit/token-epoch.test.ts` (NEW)

**Implementation summary**:

Per V4 CUT 1 — no cache. Direct SQLite read on each request (~50-100µs indexed PK).

```ts
// src/auth/token-epoch.ts
import type Database from 'better-sqlite3';

export function readTokenEpoch(db: Database.Database, userId: string): number {
  const row = db.prepare("SELECT token_epoch FROM users WHERE id = ?").get(userId) as { token_epoch?: number } | undefined;
  return row?.token_epoch ?? 0;
}

export function bumpTokenEpoch(db: Database.Database, userId: string): number {
  // NTP-safe monotonic: max(now, current+1) per V4 FIX 20
  const result = db.prepare(`
    UPDATE users
    SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
    WHERE id = ?
    RETURNING token_epoch
  `).get(userId) as { token_epoch: number } | undefined;
  if (!result) throw new Error(`bumpTokenEpoch: user not found: ${userId}`);
  return result.token_epoch;
}

export function bumpTokenEpochAllUsers(db: Database.Database): number {
  // For NR12 restore detection (T29)
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE users
    SET token_epoch = MAX(?, token_epoch + 1)
  `).run(now);
  return result.changes;
}
```

**Acceptance criteria**:
- [ ] `readTokenEpoch` returns 0 for users with default value
- [ ] `bumpTokenEpoch` increments monotonically even if clock is rolled back
- [ ] `bumpTokenEpochAllUsers` returns affected row count
- [ ] 100% test coverage (per §15.6)
- [ ] Performance test: 10K reads < 200ms (acceptable for hot path)

**Test cases (minimum 6)**:
1. Fresh user → readTokenEpoch returns 0
2. Bump then read → returns now
3. Clock rolled back → bump still increases (monotonic)
4. Concurrent bumps on same user (in same process) → sequential
5. bumpTokenEpochAllUsers affects all rows
6. bumpTokenEpoch on missing user_id → throws

---

## T04: membership-cache module

**Estimated size**: 200 lines (LRU + stale-on-error + tests with fake clock)
**Dependencies**: T02
**Files touched**:
- `src/auth/membership-cache.ts` (NEW)
- `src/auth/clock.ts` (NEW — clock injection seam)
- `tests/unit/membership-cache.test.ts` (NEW)

**Implementation summary**:

Clock seam:
```ts
// src/auth/clock.ts
export interface Clock {
  now(): number;  // seconds since epoch
}
export const realClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

// Tests inject FakeClock { current: number; advance(s) { ... } }
```

Cache:
```ts
// src/auth/membership-cache.ts
import { LRUCache } from 'lru-cache';
import crypto from 'crypto';
import type { IdPProvider } from './providers/types';
import { IdPTransientError, IdPTokenRevoked } from './providers/errors';

interface CacheEntry {
  memberships: string[];  // lowercase org logins
  ts: number;
}

const POSITIVE_TTL_S = 60;
const STALE_MAX_S = 600;  // 10 min

export class MembershipCache {
  private cache = new LRUCache<string, CacheEntry>({ max: 10_000, ttl: POSITIVE_TTL_S * 1000 });
  
  constructor(private clock: Clock = realClock, private metrics: MetricsRef) {}
  
  async getMemberships(userId: string, provider: IdPProvider, accessToken: string): Promise<string[]> {
    const key = sha256(`${userId}|${provider.name}`);
    const cached = this.cache.get(key);
    if (cached && (this.clock.now() - cached.ts) < POSITIVE_TTL_S) {
      this.metrics.idpCacheHitsTotal.inc();
      return cached.memberships;
    }
    
    if (!provider.listMemberships) {
      throw new ProviderCapabilityError('listMemberships');
    }
    
    try {
      const memberships = (await provider.listMemberships(accessToken)).map(s => s.toLowerCase());
      this.cache.set(key, { memberships, ts: this.clock.now() });
      this.metrics.idpCacheMissesTotal.inc();
      return memberships;
    } catch (err) {
      if (err instanceof IdPTransientError && cached && (this.clock.now() - cached.ts) < STALE_MAX_S) {
        this.metrics.idpStaleServedTotal.inc();
        // Audit emission per V4 FIX 8C deferred to caller (caller has tier/metadata context)
        return cached.memberships;
      }
      throw err;
    }
  }
}
```

**Acceptance criteria**:
- [ ] Positive cache hit returns within 60s window
- [ ] Cache miss triggers IdP call
- [ ] IdPTransientError + cached entry < 10min → returns stale, increments `idpStaleServedTotal`
- [ ] IdPTransientError + no cached entry → throws
- [ ] IdPTokenRevoked → propagates (no stale)
- [ ] 100% test coverage (security-critical per §15.6)

**Test cases (minimum 10)**:
1. Fresh call: cache miss, hits provider, stores, returns
2. Within 60s: cache hit, no provider call
3. After 60s: cache miss, hits provider again
4. Provider 5xx within 10min of cached → returns stale + metric
5. Provider 5xx no cache → throws
6. Provider 5xx > 10min of cached → throws (stale expired)
7. Provider 401 (IdPTokenRevoked) → propagates always
8. Provider missing listMemberships → throws ProviderCapabilityError
9. Memberships normalized to lowercase
10. Cache key includes provider.name (different providers don't collide)

---

## T05: GitHubProvider concrete implementation

**Estimated size**: 400 lines (impl + msw tests)
**Dependencies**: T02
**Files touched**:
- `src/auth/providers/github.ts` (NEW)
- `tests/unit/github-provider.test.ts` (NEW with msw)

**Implementation summary**:

Concrete `class GitHubProvider implements IdPProvider`. ~280 LOC target.

Methods:
- `buildAuthUrl(state, redirectUri, codeChallenge?)`: returns `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256&scope=read:user user:email read:org`
- `exchangeCode(code, redirectUri, codeVerifier?)`: POST to `https://github.com/login/oauth/access_token` (`client_secret_post` auth — `Accept: application/json`), GET `/user`, GET `/user/emails` (use primary verified), return `{ user: IdpUserInfo, accessToken: string }`
- `listMemberships(accessToken)`: paginate GET `/user/orgs?per_page=100`, follow `Link` header. Returns `string[]` of org `login` (case-preserved by GitHub but normalized lowercase in cache). On 401 → throw `IdPTokenRevoked`. On 403 (rate limit) or 5xx → throw `IdPTransientError`. Timeout 5s + 1 retry on 5xx/timeout.
- `requestDeviceCode()`: POST `https://github.com/login/device/code` with `client_id=:cfg.clientId&scope=read:user user:email read:org`. Returns DeviceCodeResponse.
- `pollDeviceToken(deviceCode)`: POST `https://github.com/login/oauth/access_token` with `client_id&device_code&grant_type=urn:ietf:params:oauth:grant-type:device_code`. Parse `error` field for RFC 8628 codes.

Config:
```ts
interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl?: string;             // default 'https://api.github.com', override for GHES
  authBaseUrl?: string;            // default 'https://github.com'
}
```

Response parsing via zod schemas:
```ts
const GitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});
const GitHubOrgSchema = z.object({ login: z.string() });
```

AbortController for all fetches (5s timeout per request).

**Acceptance criteria**:
- [ ] All 5 methods implemented
- [ ] msw tests cover: happy path, 401, 5xx-retry-success, 5xx-retry-fail, 5xx-timeout, pagination of /user/orgs
- [ ] No persisted state (provider is stateless)
- [ ] 100% test coverage

**Test cases (minimum 12)**:
(per acceptance criteria)

---

## T06: oauth_state CRUD + atomic CAS helper

**Estimated size**: 150 lines (CRUD + CAS + tests)
**Dependencies**: T01
**Files touched**:
- `src/auth/oauth-state.ts` (NEW)
- `tests/unit/oauth-state.test.ts` (NEW)

**Implementation summary**:

```ts
// src/auth/oauth-state.ts
import type Database from 'better-sqlite3';
import crypto from 'crypto';
import type { Clock } from './clock';

export interface OAuthStateRow {
  state: string;
  code_verifier: string;
  redirect_uri: string;
  provider: string;
  org_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

const TTL_S = 600;  // 10 min absolute

export function createOAuthState(
  db: Database.Database,
  clock: Clock,
  provider: string,
  redirectUri: string
): { state: string; code_verifier: string } {
  const state = crypto.randomBytes(32).toString('base64url');
  const code_verifier = crypto.randomBytes(32).toString('base64url');
  const now = clock.now();
  db.prepare(`
    INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(state, code_verifier, redirectUri, provider, now, now + TTL_S);
  return { state, code_verifier };
}

export function consumeOAuthState(
  db: Database.Database,
  clock: Clock,
  state: string
): { code_verifier: string; redirect_uri: string; provider: string } | null {
  const now = clock.now();
  const row = db.prepare(`
    UPDATE oauth_state
    SET consumed_at = ?
    WHERE state = ? AND consumed_at IS NULL AND expires_at > ?
    RETURNING code_verifier, redirect_uri, provider
  `).get(now, state, now) as { code_verifier: string; redirect_uri: string; provider: string } | undefined;
  return row ?? null;
}

export function inspectOAuthState(
  db: Database.Database,
  state: string
): { status: 'unknown' | 'expired' | 'consumed'; row: OAuthStateRow | null } {
  // For 4xx disambiguation per V4 FIX (status code table)
  const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as OAuthStateRow | undefined;
  if (!row) return { status: 'unknown', row: null };
  if (row.consumed_at) return { status: 'consumed', row };
  return { status: 'expired', row };
}
```

**Acceptance criteria**:
- [ ] 256-bit state entropy
- [ ] Atomic CAS: concurrent consume on same row → exactly one succeeds
- [ ] One-time use enforced via `consumed_at IS NULL`
- [ ] Expired states rejected
- [ ] Property test: 1000 concurrent consumers on same state → exactly 1 success
- [ ] 100% test coverage

**Test cases (minimum 8)**:
1. Create + consume happy path
2. Consume same state twice → second returns null
3. Consume after TTL → returns null
4. inspectOAuthState disambiguates unknown/consumed/expired
5. Concurrent consume (10 threads / 1 row) → 1 success, 9 null
6. State entropy ≥ 256 bits (length check)
7. code_verifier is 43-char b64url
8. Provider column populated

---

## T07: Cookies module (parse + emit with __Host- prefix)

**Estimated size**: 200 lines (parser wrapper + emission helper + tests)
**Dependencies**: none
**Files touched**:
- `src/auth/cookies.ts` (NEW)
- `tests/unit/cookies.test.ts` (NEW)
- `package.json` (add `cookie` dep)

**Implementation summary**:

```ts
// src/auth/cookies.ts
import * as cookieLib from 'cookie';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CookieAttrs {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  domain?: string;
  maxAge?: number;
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  return header ? cookieLib.parse(header) : {};
}

export function serializeCookie(name: string, value: string, attrs: CookieAttrs): string {
  return cookieLib.serialize(name, value, {
    httpOnly: attrs.httpOnly,
    secure: attrs.secure,
    sameSite: attrs.sameSite?.toLowerCase() as 'strict' | 'lax' | 'none',
    path: attrs.path,
    domain: attrs.domain,
    maxAge: attrs.maxAge,
  });
}

// __Host- prefix helper (enforces secure + path=/ + no domain)
export function hostCookie(name: string, value: string, opts: Pick<CookieAttrs, 'httpOnly' | 'sameSite' | 'maxAge'>): string {
  if (!name.startsWith('__Host-')) throw new Error(`hostCookie requires __Host- prefix; got ${name}`);
  return serializeCookie(name, value, {
    httpOnly: opts.httpOnly,
    secure: true,
    sameSite: opts.sameSite,
    path: '/',
    // domain intentionally omitted (forbidden by __Host- prefix)
    maxAge: opts.maxAge,
  });
}

// Append multiple Set-Cookie headers (Node http requires array form)
export function setCookies(res: ServerResponse, cookies: string[]): void {
  const existing = res.getHeader('Set-Cookie');
  const merged = Array.isArray(existing) ? [...existing, ...cookies] : cookies;
  res.setHeader('Set-Cookie', merged);
}
```

Insecure cookies escape hatch (when `COORDINATOR_INSECURE_COOKIES=true`):
```ts
export function getCookieSecureFlag(): boolean {
  return process.env.COORDINATOR_INSECURE_COOKIES !== 'true';
}
```

**Acceptance criteria**:
- [ ] `__Host-` prefix validation
- [ ] Multiple Set-Cookie headers via array (not overwrite)
- [ ] Cookie parsing handles quoted values, equals-in-values, multiple cookies
- [ ] Insecure mode emits warning log at boot if active
- [ ] 100% test coverage

**Test cases (minimum 8)**:
1. Parse single cookie
2. Parse multiple cookies (semicolon-separated)
3. Parse cookie with quoted value
4. Parse cookie with equals in value
5. Set 3 cookies → all 3 in header
6. hostCookie with bad name → throws
7. hostCookie omits domain
8. Insecure mode (env=true) → secure flag false

---

## T08: CSRF module (random double-submit + timing-safe equality)

**Estimated size**: 100 lines
**Dependencies**: T07
**Files touched**:
- `src/auth/csrf.ts` (NEW)
- `tests/unit/csrf.test.ts` (NEW)

**Implementation summary**:

Per V4 CUT 2 — random double-submit only, no HMAC binding.

```ts
// src/auth/csrf.ts
import crypto from 'crypto';

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');  // 256 bits
}

export function verifyCsrfToken(cookieValue: string | undefined, formValue: string | undefined): boolean {
  if (!cookieValue || !formValue) return false;
  const cookieBuf = Buffer.from(cookieValue, 'utf8');
  const formBuf = Buffer.from(formValue, 'utf8');
  if (cookieBuf.length !== formBuf.length) return false;  // length pre-check before timingSafeEqual
  return crypto.timingSafeEqual(cookieBuf, formBuf);
}
```

**Acceptance criteria**:
- [ ] 256-bit token entropy
- [ ] Length pre-check before `timingSafeEqual` (throws on unequal length otherwise)
- [ ] Constant-time comparison
- [ ] 100% test coverage

**Test cases (minimum 5)**:
1. Match: cookie == form → true
2. Mismatch: cookie != form → false
3. Different lengths → false
4. Missing cookie → false
5. Missing form → false

---

# Phase B — Helper modules (T09–T14)

## T09: Allowlist resolver

**Estimated size**: 80 lines
**Dependencies**: T01
**Files touched**:
- `src/auth/allowlist.ts` (NEW)
- `tests/unit/allowlist.test.ts` (NEW)

**Implementation summary**:

```ts
// src/auth/allowlist.ts
import type Database from 'better-sqlite3';

export interface AllowlistMatch {
  org_id: string;
  org_name: string;
  matched_org_login: string;
}

export function resolveOrgFromMemberships(
  db: Database.Database,
  memberships: string[]  // lowercase
): AllowlistMatch | null {
  if (memberships.length === 0) return null;
  
  // Build dynamic placeholders for IN (?,?,...)
  const placeholders = memberships.map(() => '?').join(',');
  const row = db.prepare(`
    SELECT id, name, allowlist_github_org
    FROM orgs
    WHERE LOWER(allowlist_github_org) IN (${placeholders})
    ORDER BY allowlist_github_org ASC
    LIMIT 1
  `).get(...memberships) as { id: string; name: string; allowlist_github_org: string } | undefined;
  
  if (!row) return null;
  return { org_id: row.id, org_name: row.name, matched_org_login: row.allowlist_github_org };
}
```

ORDER BY for deterministic tie-break per V4 FIX 22.

**Acceptance criteria**:
- [ ] Empty memberships → null
- [ ] Single match → row
- [ ] Multiple matches → alphabetically first
- [ ] Case-insensitive match
- [ ] 100% test coverage

**Test cases (minimum 6)**:
1. User in single allowlisted org → match
2. User in no allowlisted org → null
3. User in 2 allowlisted orgs (a, b) → returns 'a'
4. User in upper-case (ACME) vs allowlist lower (acme) → match
5. Empty memberships array → null
6. Allowlist has multiple entries; user matches second → returns second

---

## T10: request-id middleware (AsyncLocalStorage)

**Estimated size**: 120 lines
**Dependencies**: none
**Files touched**:
- `src/auth/request-id.ts` (NEW)
- `src/serve-http.ts` (wire middleware into request handler chain)
- `tests/unit/request-id.test.ts` (NEW)

**Implementation summary**:

```ts
// src/auth/request-id.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';

interface RequestContext {
  requestId: string;
}

const als = new AsyncLocalStorage<RequestContext>();

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return als.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return als.getStore()?.requestId;
}
```

Wire into serve-http.ts: every inbound HTTP request wrapped in `withRequestId(req.headers['x-request-id'] ?? generateRequestId(), () => handler(req, res))`.

audit() helper (T11) reads request_id from `getRequestId()` automatically.

**Acceptance criteria**:
- [ ] Request ID propagates through async chains
- [ ] Inbound X-Request-Id header honored if present
- [ ] Otherwise UUID v4 generated
- [ ] Multiple concurrent requests don't bleed (AsyncLocalStorage isolation)
- [ ] 100% test coverage

**Test cases (minimum 4)**:
1. Inbound X-Request-Id → preserved
2. No inbound → UUID v4 generated
3. Concurrent requests → no cross-contamination
4. Deep async chain → ID accessible at leaf

---

## T11: Audit module extension (Tier 1 sync + Tier 2 async queue)

**Estimated size**: 350 lines (queue + drain + tiers + metrics + tests)
**Dependencies**: T01, T10
**Files touched**:
- `src/security/audit.ts` (extend)
- `src/security/audit-queue.ts` (NEW)
- `tests/unit/audit-tiers.test.ts` (NEW)

**Implementation summary**:

```ts
// src/security/audit.ts
import { getRequestId } from '../auth/request-id';
import { AuditQueue } from './audit-queue';

type AuditOptions = {
  tier: 1 | 2;
  metadata?: Record<string, unknown>;
  target?: string;
  outcome?: 'success' | 'failure' | 'denied';
};

let queue: AuditQueue;

export function initAuditQueue(db, clock) {
  queue = new AuditQueue(db, clock);
}

export function audit(action: string, options: AuditOptions): void {
  const row = {
    id: crypto.randomUUID(),
    actor_user_id: getCurrentActor()?.userId ?? null,
    actor_org_id: getCurrentActor()?.orgId ?? null,
    actor_ip: getCurrentRequest()?.ip ?? null,
    actor_user_agent: getCurrentRequest()?.userAgent ?? null,
    request_id: getRequestId() ?? null,
    action,
    target: options.target ?? null,
    outcome: options.outcome ?? 'success',
    metadata_json: options.metadata ? JSON.stringify(options.metadata) : null,
    created_at: clock.now(),
  };
  
  if (options.tier === 1) {
    // Synchronous direct INSERT
    insertAuditRow(row);
  } else {
    // Async batched (50 rows / 100ms)
    queue.enqueue(row);
  }
}
```

AuditQueue:
```ts
// src/security/audit-queue.ts
export class AuditQueue {
  private buffer: AuditRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private capacity = 10_000;
  
  enqueue(row: AuditRow): void {
    if (this.buffer.length >= this.capacity) {
      this.metrics.auditDropsTotal.inc();
      logger.error({ dropped_action: row.action }, 'Audit queue full; row dropped');
      return;
    }
    this.buffer.push(row);
    if (this.buffer.length >= 50 || !this.timer) {
      this.scheduleFlush();
    }
  }
  
  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 100);
  }
  
  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0, this.buffer.length);
    try {
      const insert = db.prepare("INSERT INTO audit_log (...) VALUES (...)");
      const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });
      tx(rows);
    } catch (err) {
      logger.error({ err, count: rows.length }, 'Audit batch insert failed');
      this.metrics.auditDropsTotal.inc(rows.length);
    }
  }
  
  async drain(timeoutMs = 5000): Promise<{ flushed: number; dropped: number }> {
    const start = Date.now();
    let flushed = 0;
    while (this.buffer.length > 0 && (Date.now() - start) < timeoutMs) {
      const before = this.buffer.length;
      this.flush();
      flushed += (before - this.buffer.length);
    }
    const dropped = this.buffer.length;
    if (dropped > 0) {
      // Synchronous final row to capture loss
      insertAuditRow({ action: 'system.shutdown.audit_loss', metadata_json: JSON.stringify({ dropped_count: dropped }), ... });
    }
    return { flushed, dropped };
  }
}
```

SIGTERM handler wired in T29 boot validation calls `queue.drain(5000)`.

**Acceptance criteria**:
- [ ] Tier 1 events written synchronously (visible in 2nd connection immediately)
- [ ] Tier 2 events batched (50 rows / 100ms)
- [ ] Queue overflow drops with metric
- [ ] SIGTERM drain flushes pending within 5s
- [ ] Audit-after-commit pattern: if Tier 1 audit fails after security action, increment metric, don't undo action
- [ ] 100% test coverage

**Test cases (minimum 12)**:
(events with each tier, queue overflow, drain timeout, request_id propagation, metadata serialization)

---

## T12: Rate-limit module (in-memory token bucket per §17.6)

**Estimated size**: 300 lines (bucket + lockout + tests)
**Dependencies**: T10
**Files touched**:
- `src/auth/rate-limit.ts` (NEW)
- `src/auth/login-lockout.ts` (NEW — uses same bucket map)
- `tests/unit/rate-limit.test.ts` (NEW)
- `tests/unit/login-lockout.test.ts` (NEW)

**Implementation summary**:

Per V4 FIX 14 / §17.6.

```ts
// src/auth/rate-limit.ts
interface BucketState {
  tokens: number;
  last_refill: number;
  expires_at: number;
}

export interface RateLimitConfig {
  per: number;            // max tokens
  window_seconds: number; // refill window
}

export type RateLimitResult =
  | { allowed: true; remaining: number; reset_at: number }
  | { allowed: false; retry_after_seconds: number };

export class RateLimiter {
  private buckets = new Map<string, BucketState>();
  
  constructor(private clock: Clock) {}
  
  check(key: string, cfg: RateLimitConfig): RateLimitResult {
    const now = this.clock.now();
    const refillRate = cfg.per / cfg.window_seconds;
    
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.expires_at < now) {
      bucket = { tokens: cfg.per, last_refill: now, expires_at: now + cfg.window_seconds };
      this.buckets.set(key, bucket);
    }
    
    // Refill
    const elapsed = now - bucket.last_refill;
    bucket.tokens = Math.min(cfg.per, bucket.tokens + elapsed * refillRate);
    bucket.last_refill = now;
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), reset_at: now + cfg.window_seconds };
    }
    
    const retry_after_seconds = Math.ceil((1 - bucket.tokens) / refillRate);
    return { allowed: false, retry_after_seconds };
  }
  
  sweep(): number {
    const now = this.clock.now();
    let deleted = 0;
    for (const [key, b] of this.buckets.entries()) {
      if (b.expires_at < now) { this.buckets.delete(key); deleted++; }
    }
    return deleted;
  }
}
```

Per-endpoint key derivation (T15-T24 endpoints use this):
```ts
const RATE_LIMIT_CONFIGS = {
  '/auth/login':                   { per: 30,  window_seconds: 60 },
  '/oauth/token-code':             { per: 10,  window_seconds: 60 },
  '/oauth/token-refresh-per-ip':   { per: 60,  window_seconds: 60 },
  '/oauth/token-refresh-per-family': { per: 30, window_seconds: 60 },
  '/oauth/device-auth-per-min':    { per: 5,   window_seconds: 60 },
  '/oauth/device-auth-per-hour':   { per: 20,  window_seconds: 3600 },
  '/auth/device-approve-per-min':  { per: 10,  window_seconds: 60 },
  '/auth/device-approve-per-hour': { per: 20,  window_seconds: 3600 },
  '/auth/logout-all-per-hour':     { per: 5,   window_seconds: 3600 },
  '/api/auth/me':                  { per: 600, window_seconds: 60 },
};
```

Login lockout (uses bucket map with `lockout:` prefix):
```ts
// src/auth/login-lockout.ts
export function recordFailedLogin(rateLimiter, identifierHash: string): { locked: boolean } {
  const key = `lockout:${identifierHash}`;
  const result = rateLimiter.check(key, { per: parseLockoutThreshold(), window_seconds: parseLockoutWindow() });
  if (!result.allowed) {
    audit('auth.login.locked', { tier: 1, metadata: { identifier_hash: identifierHash } });
    return { locked: true };
  }
  return { locked: false };
}

export function isLocked(rateLimiter, identifierHash: string): boolean {
  // Same bucket; check without consuming
}
```

**Acceptance criteria**:
- [ ] Per-IP rate limit per endpoint enforced
- [ ] 429 response with `Retry-After`, `X-RateLimit-*` headers
- [ ] Lockout policy: 5 failures / 15 min → 15 min lockout
- [ ] Lockout fires `auth.login.locked` audit (Tier 1)
- [ ] Sweeper cleans expired buckets every 60s
- [ ] 100% test coverage

**Test cases (minimum 10)**:
(rate limit enforcement, refill, sweep, lockout threshold, lockout duration, identifier hash, response headers)

---

## T13: HTML render module (escapeHtml + render seam)

**Estimated size**: 100 lines + 5 template files
**Dependencies**: none
**Files touched**:
- `src/auth/html.ts` (NEW)
- `tests/unit/html-escape.test.ts` (NEW)

**Implementation summary**:

Per V4 §9.4 + V3 mandate.

```ts
// src/auth/html.ts
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

export function render(template: string, ctx: Record<string, unknown>): string {
  // Auto-escapes all ${key} interpolations.
  return template.replace(/\$\{(\w+)\}/g, (_, key) => escapeHtml(ctx[key] ?? ''));
}

// Common HTML response helper (adds CSP, X-Frame-Options, Cache-Control, Content-Type)
export function sendHtml(res, status, body): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
```

**Acceptance criteria**:
- [ ] All 5 escape replacements correct
- [ ] Render with malicious payload (`<script>`, `"><script>`, etc.) → escaped
- [ ] sendHtml emits all required security headers
- [ ] 100% test coverage on `src/auth/html.ts`

**Test cases (minimum 10)**:
1. Basic interpolation
2. `<script>` payload → escaped
3. Attribute injection (`"><script>`)
4. HTML entity (`&amp;` in input → double-encoded)
5. Empty ctx value → empty string
6. Missing key → empty string
7. Non-string value (number, boolean) → coerced + escaped
8. sendHtml emits CSP
9. sendHtml emits Cache-Control: no-store
10. CSP forbids inline scripts (regex check)

---

## T14: Discovery doc endpoint (/.well-known/oauth-authorization-server)

**Estimated size**: 100 lines
**Dependencies**: T01
**Files touched**:
- `src/discovery.ts` (NEW)
- `src/serve-http.ts` (route registration)
- `tests/unit/discovery.test.ts` (NEW)

**Implementation summary**:

```ts
// src/discovery.ts
export function buildDiscoveryDoc(publicUrl: string): Record<string, unknown> {
  // Strip trailing slash defensively
  const base = publicUrl.replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/auth/login`,
    token_endpoint: `${base}/api/auth/oauth/token`,
    device_authorization_endpoint: `${base}/api/auth/oauth/device_authorization`,
    revocation_endpoint: `${base}/api/auth/revoke`,
    userinfo_endpoint: `${base}/api/auth/me`,
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:device_code',
    ],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],            // V4 FIX 12
    revocation_endpoint_auth_methods_supported: ['none'],
    service_documentation: `${base}/docs/oauth-setup`,
    id_token_signing_alg_values_supported: ['HS256'],
  };
}

// Handler
export function handleDiscovery(req, res): void {
  const doc = buildDiscoveryDoc(process.env.COORDINATOR_PUBLIC_URL!);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(doc));
}
```

**Acceptance criteria**:
- [ ] All RFC 8414 required fields present
- [ ] `token_endpoint_auth_methods_supported: ["none"]` (public clients per V4)
- [ ] `code_challenge_methods_supported: ["S256"]` (no `plain`)
- [ ] Trailing slash on PUBLIC_URL handled
- [ ] 100% test coverage

**Test cases (minimum 5)**:
1. Returns JSON with required fields
2. PUBLIC_URL trailing slash stripped
3. token_endpoint_auth_methods_supported is `["none"]`
4. issuer == PUBLIC_URL
5. Endpoint accessible without auth

---

# Phase C — Endpoint implementations (T15–T24)

## T15: GET /auth/login (HTML + OAuth init redirect)

**Estimated size**: 200 lines (handler + template + tests)
**Dependencies**: T05, T06, T07, T13
**Files touched**:
- `src/auth/oauth-handlers.ts` (NEW — login handler)
- `src/auth/pages/login.html.ts` (NEW — minimal template)
- `tests/integration/oauth-login.test.ts` (NEW)

**Implementation summary**:

`GET /auth/login` flow:
1. Rate limit check (per IP per `/auth/login` config)
2. Generate state + code_verifier via T06 `createOAuthState('github', PUBLIC_URL + '/api/auth/oauth/callback')`
3. Compute `code_challenge = base64url(sha256(code_verifier))`
4. Build GitHub auth URL via `githubProvider.buildAuthUrl(state, redirectUri, code_challenge)`
5. Set state cookie: `__Host-coordinator_oauth_state=hmac_sha256(csrf_key, "state-v1\x00" || state)` per V4 FIX 19
6. 302 redirect to GitHub
7. Set-Cookie attributes: HttpOnly, Secure, SameSite=Lax (cross-site redirect from GitHub), Path=/, Max-Age=600

Phase 2 single-provider: `/auth/login` is just a redirect. If multi-provider Phase 4, render picker first.

**Acceptance criteria**:
- [ ] Rate limit honored
- [ ] State cookie set with proper attributes (Lax, not Strict, for redirect)
- [ ] 302 to GitHub with correct URL params
- [ ] code_challenge S256
- [ ] 256-bit state entropy
- [ ] Integration test with msw GitHub

**Test cases (minimum 5)**:
1. First visit → 302 with state cookie set
2. Rate limit breach → 429
3. State entropy ≥ 256 bits
4. State cookie SameSite=Lax (required for GitHub redirect back)
5. code_challenge_method=S256

---

## T16: GET /api/auth/oauth/callback

**Estimated size**: 500 lines (handler + transaction logic + tests)
**Dependencies**: T01, T02, T04, T05, T06, T07, T09, T11, T13
**Files touched**:
- `src/auth/oauth-handlers.ts` (extend — callback handler)
- `tests/integration/oauth-callback.test.ts` (NEW)

**Implementation summary**:

This is the most complex handler. Per V4 FIX 16 + FIX 17, wraps steps 5-8 in transaction.

Algorithm (in order):
1. Validate state cookie binding (V4 FIX 19):
   - cookie_hmac = `req.cookies['__Host-coordinator_oauth_state']`
   - expected = HMAC-SHA-256(csrf_key, "state-v1\x00" || state)
   - timing-safe compare
   - if mismatch → audit `auth.state.replay` (Tier 1) + 400
2. Atomic CAS on `oauth_state` via T06 `consumeOAuthState(db, clock, state)`
   - if null: disambiguate via `inspectOAuthState` → 400/409 + audit
3. Mix-up defense (V4): `row.provider === 'github'`; else 400
4. Exchange code at GitHub via T05 `githubProvider.exchangeCode(code, row.redirect_uri, row.code_verifier)`
   - Returns `{ user, accessToken }`
5. **BEGIN IMMEDIATE TRANSACTION** (single TX for all writes):
   - Resolve org via T09 + T04 membership cache
   - If no org match: ROLLBACK, audit `auth.login.denied.not_in_org` (Tier 1), 403
   - Find user via `(idp_provider, idp_user_id)` UNIQUE index
   - If user is null:
     - If `COORDINATOR_AUTO_PROVISION='false'` (V4 §8.3): ROLLBACK, audit, 403 `USER_NOT_PROVISIONED`
     - Else: INSERT users (with `idp_access_token` populated per V4 FIX 4)
     - Bootstrap admin atomic check per V4 FIX 16:
       - `UPDATE users SET role='admin' WHERE id=:new AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND id != :new)`
       - Re-read final role; if 'admin' → audit `auth.admin.bootstrapped` (Tier 1)
     - INSERT user_orgs with final role (NOT initial)
   - If user exists: UPDATE users SET `idp_access_token = ?, last_login_at = ?` WHERE id = ?
   - family_id = `crypto.randomUUID()`
   - jti = `crypto.randomUUID()`
   - fingerprint = sha256(req.ip + '|' + req.userAgent)
   - INSERT refresh_tokens (jti, family_id, parent_jti=NULL, consumer_fingerprint, ...)
   - access_jwt = mintAccessJWT(...)
   - refresh_jwt = mintRefreshJWT(...)
6. **COMMIT** (T15 transaction ends)
7. Post-commit: enqueue `auth.login.success` (Tier 2)
8. Set 3 cookies via T07: __Host-coordinator_session (JWT), __Host-coordinator_csrf (random), clear __Host-coordinator_oauth_state
9. 302 redirect to `/auth/success`

**JWT minting helper** (in `src/auth/jwt-mint.ts`, NEW — split from this task or fold into T19):
```ts
async function mintAccessJWT(claims): Promise<string> {
  return new SignJWT({
    user_id: claims.user_id,
    active_org_id: claims.active_org_id,
    role: claims.role,
    jti: claims.jti,
    family_id: claims.family_id,
  })
    .setProtectedHeader({ alg: 'HS256', kid: 'hs256-v1' })
    .setSubject(claims.user_id)
    .setIssuedAt()
    .setExpirationTime(parseDuration(process.env.COORDINATOR_JWT_ACCESS_TTL ?? '15m'))
    .setIssuer(process.env.COORDINATOR_PUBLIC_URL!)
    .sign(signingKey);
}
```

**Acceptance criteria**:
- [ ] State binding validates (mismatch → 400 + audit)
- [ ] Atomic CAS on oauth_state (race-safe)
- [ ] Mix-up defense (different provider → 400)
- [ ] Allowlist 403 emits Tier 1 audit
- [ ] New user provisioning atomic (transaction-wrapped)
- [ ] Bootstrap admin race-safe
- [ ] user_orgs row uses FINAL role
- [ ] All 3 cookies set
- [ ] Integration test full flow with msw GitHub

**Test cases (minimum 15)**:
1. Happy path: new user, joins allowlist, gets cookie + redirect
2. State cookie mismatch → 400
3. State expired → 400
4. State replay (consumed) → 409
5. State unknown → 400
6. GitHub 5xx → 503
7. User not in allowlist → 403 + audit
8. User in allowlist, returning user → updates idp_access_token
9. Bootstrap admin login → role=admin
10. Bootstrap admin login when admin already exists → role=member
11. Multiple concurrent first-time bootstrap admin → atomic (one wins)
12. AUTO_PROVISION=false + new user → 403
13. Process crash mid-TX → no orphan rows (TX rollback)
14. Allowlist matches 2 orgs → alphabetically first (ORDER BY)
15. Memberships empty → 403

---

## T17: POST /api/auth/oauth/device_authorization

**Estimated size**: 200 lines
**Dependencies**: T01, T11
**Files touched**:
- `src/auth/device-flow.ts` (NEW — init handler)
- `tests/integration/device-auth-init.test.ts` (NEW)

**Implementation summary**:

RFC 8628 §3.1 init.

1. Rate limit (per IP per-min + per-hour)
2. Validate `client_id` per V4 FIX (require literal `"mcp-coordinator-cli"` — or revisit if we want anonymous)
3. device_code = crypto.randomBytes(32).toString('base64url')
4. user_code = generateUserCode() per §6.5.1 (20-char alphabet, 8 chars XXXX-XXXX)
5. Collision check: `SELECT 1 FROM device_auth_requests WHERE user_code = ? AND expires_at > now` — retry if collision (3 attempts max)
6. INSERT device_auth_requests (..., requester_ip, requester_user_agent, requester_country)
7. audit `auth.device.code_issued` (Tier 2)
8. Return JSON:
   ```json
   {
     "device_code": "...",
     "user_code": "WDJB-MJHT",
     "verification_uri": "PUBLIC_URL/auth/device",
     "verification_uri_complete": "PUBLIC_URL/auth/device/confirm?user_code=WDJB-MJHT",
     "expires_in": 600,
     "interval": 5
   }
   ```

`generateUserCode()`:
```ts
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
function generateUserCode(): string {
  const buf = crypto.randomBytes(8);
  const chars = Array.from(buf).map(b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}
```

`geoLookup(ip)`: best-effort GeoIP lookup via maxmind-db lite (Phase 2: ship optional dep, return null if unavailable).

**Acceptance criteria**:
- [ ] user_code matches alphabet + format
- [ ] device_code 256-bit entropy
- [ ] Collision retry (≤3 attempts)
- [ ] Audit emitted
- [ ] Rate limit enforced
- [ ] 10min TTL

**Test cases (minimum 8)**:
(per acceptance + boundary cases)

---

## T18: POST /api/auth/oauth/token (unified dispatcher)

**Estimated size**: 200 lines (dispatcher + grant handlers)
**Dependencies**: T16, T17, T19
**Files touched**:
- `src/auth/oauth-handlers.ts` (extend — token endpoint)
- `tests/integration/oauth-token.test.ts` (NEW)

**Implementation summary**:

RFC 6749 §6 unified token endpoint. Form-encoded body. Dispatch on `grant_type`:

- `authorization_code` → similar to callback but JSON response (CLI use case; mostly unused since browser redirects through callback)
- `refresh_token` → T19 refresh rotation algorithm
- `urn:ietf:params:oauth:grant-type:device_code` → T17 polling

Error responses RFC 6749 §5.2 shape.

**Acceptance criteria**:
- [ ] grant_type=refresh_token → invokes T19
- [ ] grant_type=device_code → invokes device poll handler
- [ ] Unsupported grant_type → 400 `unsupported_grant_type`
- [ ] Body not form-encoded → 400 `invalid_request`

**Test cases (minimum 6)**

---

## T19: Refresh rotation algorithm

**Estimated size**: 500 lines (algorithm + tests)
**Dependencies**: T01, T03, T04, T05, T07, T09, T11
**Files touched**:
- `src/auth/refresh-rotation.ts` (NEW — main algorithm)
- `tests/unit/refresh-rotation.test.ts` (NEW — 100% branch coverage)

**Implementation summary**:

The §10 algorithm with all V4 fixes:
- FIX 5: rotation UPDATE includes `AND revoked_at IS NULL`
- FIX 7: allowlist re-check in grace branch
- FIX 23: audit-after-commit pattern (revoke commits, then audit Tier 1, log on failure)
- FIX 24: idle-expired wrapped in TX

Reuse detection sub-algorithm:
- Within 10s grace + fingerprint matches → return cached successor (re-mint deterministic from row)
- Within 10s grace + fingerprint mismatch → increment replay_count, threshold=3 → revoke family
- Outside grace OR non-rotation revoke reason → revoke family immediately

```ts
// src/auth/refresh-rotation.ts
async function refreshGrant(req, refreshToken: string): Promise<TokenResponse> {
  // ... (per V4 FIX 5/7/23/24)
}
```

**Acceptance criteria**:
- [ ] All branches covered (100% branch coverage per §15.6 + Round 3 testing agent)
- [ ] TOCTOU race closed (FIX 5 verified)
- [ ] Concurrent legitimate refresh from same fingerprint → cached successor returned
- [ ] Different fingerprint → replay_count++, threshold revokes family
- [ ] Allowlist re-check fires on grace branch
- [ ] Idle timeout enforced
- [ ] Service account JWT path rejected (`return 400 INVALID_GRANT`)
- [ ] Audit Tier 1 events emit after commit, failure logs metric
- [ ] 100% test coverage

**Test cases (minimum 18)**:
1. Normal rotation happy path
2. Reuse: stolen token replayed > 10s after rotation → family revoked
3. Concurrent legitimate retry within 10s, same fingerprint → cached successor
4. Concurrent retry within 10s, different fingerprint → replay_count=1, 401 (no token leaked)
5. Replay count reaches 3 → family revoked
6. Idle timeout exceeded → 401 + audit
7. Allowlist removed mid-grace → 401 + family revoked
8. GitHub IdP token revoked → 401 + force re-auth
9. Service account JWT presented → 400 INVALID_GRANT
10. JWT signature invalid → 401
11. JWT expired but grace clock skew → accepted within tolerance
12. JWT kid unknown → 401
13. Transaction failure mid-rotation → no orphan state
14. Audit failure post-commit → metric increment, action stays committed
15. token_epoch bumped between auth and validate → 401
16. Rotation UPDATE rowsAffected=0 (race) → treats as reuse
17. Successor lookup returns 2 rows (impossible w/ UNIQUE constraint) → error
18. Phase 1 row with parent_jti=NULL → rotates normally

---

## T20: POST /auth/device/approve

**Estimated size**: 200 lines
**Dependencies**: T08, T11, T13, T27
**Files touched**:
- `src/auth/device-flow.ts` (extend)
- `tests/integration/device-approve.test.ts` (NEW)

**Implementation summary**:

1. Require authenticated session (Scenario 5 cookie via T27)
2. CSRF validation (T08): cookie value matches form field
3. Read `user_code` from form
4. Validate user_code format (regex `^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$`)
5. Lookup `device_auth_requests` by user_code (active, not consumed, not expired)
6. If not found / wrong format / expired:
   - `UPDATE device_auth_requests SET failed_approval_attempts = failed_approval_attempts + 1 WHERE user_code=?` (V4 FIX 21)
   - If `failed_approval_attempts >= 5` → UPDATE denied_at, audit `auth.device.denied` reason=brute_force
   - Return 400
7. Approve: `UPDATE device_auth_requests SET approved_user_id = :session.user_id, approved_at = :now`
8. audit `auth.device.approved` (Tier 2) with requester context
9. Return 204 (or HTML success page)

**Acceptance criteria**:
- [ ] Requires session
- [ ] CSRF enforced
- [ ] user_code format validated
- [ ] failed_approval_attempts counter enforced (brute-force defense per V4 FIX 21)
- [ ] Per-user pending cap (≤3 unapproved per approved_user_id) — soft enforcement
- [ ] Audit with requester IP/UA/geo

**Test cases (minimum 10)**

---

## T21: GET /auth/device + GET /auth/device/confirm

**Estimated size**: 250 lines (2 handlers + templates)
**Dependencies**: T13, T27
**Files touched**:
- `src/auth/device-flow.ts` (extend with GET handlers)
- `src/auth/pages/device.html.ts` (NEW — code entry form)
- `src/auth/pages/device-confirm.html.ts` (NEW — approve UI)
- `tests/integration/device-pages.test.ts` (NEW)

**Implementation summary**:

`GET /auth/device`:
- HTML page with code entry form
- If session present: prefill from `?user_code=` query param
- If no session: redirect to `/auth/login?return_to=/auth/device?user_code=...` per V4 implicit return-to

`GET /auth/device/confirm?user_code=WDJB-MJHT`:
- Requires session (302 to login otherwise with return_to preserved)
- Lookup device_auth_requests by user_code
- Render confirm page with: app description (defaults to "CLI device"), requester IP/UA/geo, [Approve] [Deny] buttons + CSRF token in hidden field

Per V4 FIX 22 — return_to: `/auth/login?return_to=URL` validates URL is internal (same origin, not external) before redirect.

**Acceptance criteria**:
- [ ] HTML pages render with proper escaping
- [ ] Session redirect with return_to preserved
- [ ] CSRF token rendered in confirm form
- [ ] Requester context shown
- [ ] return_to validates against internal paths only

**Test cases (minimum 8)**

---

## T22: GET /auth/success

**Estimated size**: 50 lines
**Dependencies**: T13
**Files touched**:
- `src/auth/pages/success.html.ts` (NEW — minimal "you can close this window")
- `src/serve-http.ts` (route)
- `tests/integration/auth-success.test.ts` (NEW)

**Implementation summary**:

Static page: "Login successful. You can close this window."

5th HTML route per V4 FIX 9 (updates §1 + §19 anti-scope-creep cap to 5).

**Acceptance criteria**:
- [ ] Page renders, no auth required
- [ ] CSP + headers per T13
- [ ] No external assets

---

## T23: Logout endpoints

**Estimated size**: 300 lines
**Dependencies**: T01, T03, T07, T11
**Files touched**:
- `src/auth/oauth-handlers.ts` (extend — logout + logout-all + revoke)
- `tests/integration/logout.test.ts` (NEW)

**Implementation summary**:

`POST /api/auth/logout`:
1. authenticate (Bearer or cookie)
2. UPDATE refresh_tokens SET revoked_at = now, revoked_reason = 'logout' WHERE jti = ? AND revoked_at IS NULL
3. audit `auth.logout.local` (Tier 2)
4. Clear session + csrf cookies (set Max-Age=0)
5. Return 204

`POST /api/auth/logout-all` (body: `{except_current: bool}`):
1. authenticate
2. except_jti = (except_current ? claims.jti : null)
3. BEGIN TX:
   - UPDATE refresh_tokens SET revoked_at, revoked_reason='logout_all' WHERE user_id = ? AND revoked_at IS NULL AND jti != :except_jti
   - bumpTokenEpoch(db, claims.user_id) via T03
4. COMMIT
5. audit `auth.logout.global` (Tier 1) with revoked_count
6. Return 204

`POST /api/auth/revoke` (RFC 7009):
1. Parse form: `token`, `token_type_hint`
2. Try to decode token as JWT:
   - If valid refresh → UPDATE revoked_at, audit `auth.token.revoked` (Tier 1)
   - If valid access → no-op (access not individually revocable)
   - If invalid → no-op (don't reveal)
3. Always return 200 per V4 FIX 11

**Acceptance criteria**:
- [ ] /logout idempotent
- [ ] /logout-all bumps token_epoch
- [ ] except_current preserves caller
- [ ] /revoke returns 200 even for invalid token
- [ ] All emit appropriate audit
- [ ] Cookies cleared on /logout

**Test cases (minimum 12)**

---

## T24: GET /api/auth/me

**Estimated size**: 100 lines
**Dependencies**: T27
**Files touched**:
- `src/auth/oauth-handlers.ts` (extend)
- `tests/integration/auth-me.test.ts` (NEW)

**Implementation summary**:

Returns user info + active org + session info.

```json
{
  "user": { "id": "...", "email": "...", "name": "...", "role": "member" },
  "active_org": { "id": "...", "name": "acme" },
  "session": { "exp": 1715616000, "jti": "..." }
}
```

**Acceptance criteria**:
- [ ] Requires auth (401 otherwise)
- [ ] Returns claims-derived data + DB lookups for user/org names
- [ ] No PII beyond email/name

---

# Phase D — Integration & operations (T25–T30)

## T25: Service token issuance (CLI verb + admin API)

**Estimated size**: 400 lines (CLI + endpoint + tests)
**Dependencies**: T01, T11, T27
**Files touched**:
- `src/auth/service-tokens.ts` (NEW)
- `src/cli/issue-service-token.ts` (NEW — CLI verb)
- `src/cli/list-service-tokens.ts` (NEW)
- `src/cli/revoke-service-token.ts` (NEW)
- `src/admin/handlers.ts` (NEW — admin endpoints)
- `tests/integration/service-tokens.test.ts` (NEW)

**Implementation summary**:

Per V4 FIX 10 / new §5.5.

CLI verb: `mcp-coordinator issue-service-token --user --org --scope --ttl --reason`
- Requires admin OAuth (auth via existing session or token file)
- POST `/api/admin/service-tokens` with body
- Server validates: caller is admin, target user belongs to org, ttl ≤ 90d, scope ∈ {read, write, admin}, reason ≥ 10 chars
- family_id = `service:${crypto.randomUUID()}`
- Mints JWT with `service_account: true, issued_by: caller_id, scope`
- INSERT refresh_tokens
- audit `auth.service_token.issued` (Tier 1)
- Returns JWT once (display only)

List: `mcp-coordinator list-service-tokens [--user --org --active-only]`
Revoke: `mcp-coordinator revoke-service-token --jti`

Verification path: extends `authenticateRequest` (T27 integration point):
- If JWT claims include `service_account: true`:
  - DB lookup REQUIRED (override trust-signature)
  - SELECT revoked_at FROM refresh_tokens WHERE jti = ?
  - If revoked → 401
  - token_epoch check still applies

Rotation guard: T19 refresh handler rejects service JWT (per V4 FIX 10).

**Acceptance criteria**:
- [ ] Admin-only minting
- [ ] TTL cap 90d enforced
- [ ] reason required ≥10 chars
- [ ] family_id format `service:<uuid>` validated
- [ ] Audit on issue/revoke (Tier 1)
- [ ] Verification path: revoked service JWT → 401
- [ ] Service JWT presented to /refresh → 400 INVALID_GRANT
- [ ] CLI list/revoke verbs work
- [ ] 100% test coverage

**Test cases (minimum 15)**

---

## T26: Service token verification override

**Estimated size**: 100 lines (extend authenticateRequest)
**Dependencies**: T25, T27
**Files touched**:
- `src/auth.ts` (extend `authenticateRequest`)
- `tests/unit/service-token-verification.test.ts` (NEW)

(May be folded into T25 if scope allows; separated for review clarity.)

**Implementation summary**:

In `authenticateRequest` validation (Scenario d Bearer + Scenario 5 cookie both):
```ts
if (claims.service_account === true) {
  // Override trust-signature: REQUIRES DB lookup
  const row = db.prepare("SELECT revoked_at, family_id FROM refresh_tokens WHERE jti = ?").get(claims.jti);
  if (!row) throw new TokenRevokedError();
  if (row.revoked_at) throw new TokenRevokedError();
  if (!row.family_id?.startsWith('service:')) throw new TokenRevokedError();  // sanity
}
```

**Acceptance criteria**:
- [ ] Service JWT with valid DB row → accepted
- [ ] Service JWT with revoked row → 401
- [ ] Service JWT with non-service family_id (tampered) → 401
- [ ] Non-service JWT skips DB lookup (trust-signature preserved)

---

## T27: authenticateRequest Scenario 5 (cookie auth)

**Estimated size**: 200 lines
**Dependencies**: T03, T07
**Files touched**:
- `src/auth.ts` (extend `authenticateRequest`)
- `tests/unit/auth-scenario-5.test.ts` (NEW)

**Implementation summary**:

Per V4 §9.5. Add 5th scenario:
- Read cookie `__Host-coordinator_session`
- If present AND no Bearer header: validate JWT (HS256 pinned + kid lookup + iat ≥ token_epoch direct DB read per V4 CUT 1)
- Bearer takes precedence if both present

Plus per V4 FIX (A01): mandate CSRF token check on POSTs whenever session cookie is present (regardless of Bearer):
- Implement at endpoint level (T20, T23 logout endpoints) — they call `requireCsrf(req)` helper

**Acceptance criteria**:
- [ ] Cookie scenario validates JWT and applies token_epoch check
- [ ] Bearer takes precedence over cookie
- [ ] CSRF required on POST when cookie present
- [ ] Multiple Phase 1 scenarios still work (unchanged)

**Test cases (minimum 10)**

---

## T28: Sweeper module

**Estimated size**: 350 lines (sweeper + tests)
**Dependencies**: T01
**Files touched**:
- `src/sweeper/index.ts` (NEW)
- `tests/unit/sweeper.test.ts` (NEW)

**Implementation summary**:

Per V4 §17.7.

```ts
// src/sweeper/index.ts
export class Sweeper {
  private failCount = 0;
  private circuitOpen = false;
  private timer: NodeJS.Timeout | null = null;
  
  constructor(private db, private clock, private metrics, private logger) {}
  
  start(): void {
    this.timer = setInterval(() => this.runOnce(), 60_000);
  }
  
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    // Drain current batch with 5s timeout — but sweeper is sync, so just finish current pass
    return Promise.resolve();
  }
  
  runOnce(): void {
    if (this.circuitOpen) return;
    try {
      const now = this.clock.now();
      const deleted = {
        oauth_state: this.sweepOauthState(now),
        device_auth: this.sweepDeviceAuth(now),
        refresh_revoked: this.sweepRefreshRevoked(now),
        refresh_expired: this.sweepRefreshExpired(now),
        audit_tier1: this.sweepAuditTier1(now),
        audit_tier2: this.sweepAuditTier2(now),
      };
      let totalDeleted = 0;
      for (const [table, count] of Object.entries(deleted)) {
        this.metrics.sweeperRowsDeletedTotal.labels(table).inc(count);
        totalDeleted += count;
      }
      this.failCount = 0;
      this.metrics.sweeperLastRunTimestamp.set(now);
      
      // Adaptive: re-run immediately if max batch hit
      if (totalDeleted >= 1000 * 6) {  // all tables hit max
        // Re-run; max 3 chained
      }
    } catch (err) {
      this.failCount++;
      this.metrics.sweeperConsecutiveFailures.inc();
      this.logger.error({ err }, 'Sweeper error');
      if (this.failCount >= 5) {
        this.circuitOpen = true;
        this.metrics.sweeperCircuitOpen.set(1);
        this.logger.error('Sweeper circuit open after 5 consecutive failures');
      }
    }
  }
  
  private sweepOauthState(now: number): number {
    return this.db.prepare(`
      DELETE FROM oauth_state
      WHERE expires_at < ? AND oauth_state.rowid IN (
        SELECT rowid FROM oauth_state WHERE expires_at < ? LIMIT 1000
      )
    `).run(now - 60, now - 60).changes;
  }
  
  // ... similar for other tables
  
  reset(): void {
    this.circuitOpen = false;
    this.failCount = 0;
    this.metrics.sweeperCircuitOpen.set(0);
  }
}
```

CLI verb `mcp-coordinator admin sweeper-reset` calls `sweeper.reset()`.

**Acceptance criteria**:
- [ ] All 6 tables swept
- [ ] Adaptive re-run on full batch
- [ ] Circuit-break after 5 failures
- [ ] Metrics emitted
- [ ] SIGTERM drain (finishes current pass)
- [ ] 100% test coverage

**Test cases (minimum 10)**

---

## T29: Boot validation + restore detection (NR12)

**Estimated size**: 300 lines
**Dependencies**: T01, T11
**Files touched**:
- `src/boot.ts` (NEW or extend existing entry point)
- `src/system-state.ts` (NEW — restore detection)
- `tests/integration/boot-validation.test.ts` (NEW)
- `tests/integration/restore-detection.test.ts` (NEW)

**Implementation summary**:

Boot validation (fail-closed):
1. SQLite version ≥ 3.25
2. If `COORDINATOR_OAUTH_ENABLED=true`:
   - Required env vars present (JWT_SECRET, GITHUB_CLIENT_ID/SECRET, GITHUB_ORG, PUBLIC_URL)
   - JWT_SECRET ≥ 32 bytes, entropy check (no `'change-me'`, no all-same-byte)
   - PUBLIC_URL scheme http://localhost OR https://* OR `INSECURE_COOKIES=true`
   - ACCESS_TTL ≤ 60m, REFRESH_TTL ≤ 90d
   - PREV_SECRET requires PREV_ROTATED_AT; `now - rotated_at < REFRESH_TTL`
3. If `COORDINATOR_GITHUB_ORG` set:
   - Seed orgs.allowlist_github_org if not already (per V4 FIX 4)
4. Restore detection (NR12):
   - max_ts = MAX(audit.created_at, refresh.created_at, system_state.updated_at)
   - if `(now - max_ts) > 300` AND `COORDINATOR_ALLOW_RESTORE=true`:
     - bumpTokenEpochAllUsers (T03)
     - INSERT system_state (key='last_restore_at', value=now)
     - audit `recovery.token_epoch_global_bump` + `recovery.completed` (Tier 1)
     - logger.warn "Restored from backup; all users must re-authenticate"
   - else if `(now - max_ts) > 300` AND `COORDINATOR_ALLOW_RESTORE != true`:
     - logger.warn "Boot.restore_suspected" (gap detected but no auth to bump)
5. Emit `config.boot` audit event (Tier 1) with effective config (hashed where sensitive)

**Acceptance criteria**:
- [ ] All required env vars validated
- [ ] Insecure config refused (e.g., http:// production)
- [ ] Restore detection fires only when both conditions met
- [ ] config.boot audit on every boot
- [ ] 100% test coverage

**Test cases (minimum 15)**

---

## T30: Login lockout integration

**Estimated size**: 100 lines (mostly wiring T11+T12 into endpoints)
**Dependencies**: T11, T12, T16
**Files touched**:
- `src/auth/oauth-handlers.ts` (callback handler wiring)
- `tests/integration/login-lockout.test.ts` (NEW)

**Implementation summary**:

On every `auth.login.failure` OR `auth.login.denied.not_in_org` event in callback handler (T16):
- identifier_hash = sha256(github_login if known else req.ip)
- recordFailedLogin(rateLimiter, identifier_hash) from T12
- If locked: refuse callback further attempts from this identifier (use `isLocked()` at start of callback)

**Acceptance criteria**:
- [ ] 5 failures within 15min → 15min lockout
- [ ] Lockout emits `auth.login.locked` Tier 1
- [ ] Bootstrap admin bypass
- [ ] 100% test coverage

---

# Phase E — Tests & documentation (T31–T35)

## T31: Cross-tenant isolation test suite extension

**Estimated size**: 600 lines (extend Phase 1's 4-org seed for OAuth users)
**Dependencies**: T01–T30 (most endpoints)
**Files touched**:
- `tests/integration/cross-tenant-isolation.test.ts` (extend)

**Implementation summary**:

Per spec §15.3 D1.

Seed 4 orgs (acme, beta, gamma, delta) each with:
- 1 admin user, 1 member user, 1 service token
- 2 refresh tokens
- 5 audit_log rows

Assert for every API endpoint:
- Calling as acme admin returns only acme data
- Calling as beta admin cannot read acme data
- user_orgs scoping enforced

**Acceptance criteria**:
- [ ] All endpoints traversed
- [ ] No cross-org leak in ANY response
- [ ] Audit log queries scoped by org_id

---

## T32: Security-critical test matrix D1–D10

**Estimated size**: 800 lines
**Dependencies**: T01–T30
**Files touched**:
- `tests/security/d1-d10.test.ts` (NEW or per-decision files)

**Implementation summary**:

Per §15.3 matrix. Each row gets 1 happy + 1 attack test.

| # | Decision | Test pair |
|---|---|---|
| D1 | 1:1 org | resolveOrgFromGitHub + cross_tenant_oauth_user_cannot_access_other_org |
| D2 | Allowlist | allowlistChecker happy + bypass_via_case_mutation |
| D3 | IdP minimal | fetchUser + idp_optional_methods_404 |
| D4 | oauth_state | lifecycle + state_replay_rejected |
| D5 | HTML+cookie | escapes + xss_user_code_crafted + csrf_missing_token |
| D6 | Refresh family | rotation + reuse_revokes_entire_chain + 10s_grace_fingerprint_blocked |
| D7 | Dual logout | logout clears + logout_all_bumps_token_epoch |
| D8 | TTLs | tokenTTL + clock_skew_30s_grace |
| D9 | Service account | issue + revoke + DB-hit-required |
| D10 | Restore | restoreDetector + restored_db_invalidates_revoked |

**Acceptance criteria**:
- [ ] All 10 pairs (20+ tests) pass
- [ ] Coverage 100% on security-critical files

---

## T33: Chaos / fault injection + perf benchmarks

**Estimated size**: 500 lines
**Dependencies**: T01–T30
**Files touched**:
- `tests/chaos/*.test.ts` (NEW)
- `bench/*.bench.ts` (NEW)

**Implementation summary**:

Per §15.4 + §15.5.

Chaos tests (with seam injection):
- github_500_during_callback
- sqlite_write_fail_during_state_create
- process_restart_between_state_create_and_consume
- sigkill_mid_audit_batch
- clock_step_backward_30s_via_ntp
- idp_listMemberships_5xx_after_cache_warmup

Perf benchmarks (k6 or autocannon):
- 500 refresh/sec for 1h, p99 < 100ms (cached membership)
- 100 concurrent CLI device polls, p99 < 200ms
- 5K failed-login/sec for 5min, audit queue durable Tier 1, may drop Tier 2

**Acceptance criteria**:
- [ ] All chaos scenarios pass
- [ ] SLOs met under perf load
- [ ] No oauth_state row leaks

---

## T34: OpenAPI 3.1 spec generation + CI validation

**Estimated size**: 300 lines
**Dependencies**: T15–T24
**Files touched**:
- `docs/api/openapi.yaml` (NEW)
- `scripts/generate-openapi.ts` (NEW — derives from zod schemas)
- `.github/workflows/openapi-validate.yml`

**Implementation summary**:

- OpenAPI 3.1 spec covering all Phase 2 endpoints
- Server URL templated from PUBLIC_URL
- Component schemas: User, Org, Session, ErrorEnvelope, RFC6749Error
- CI: lint + diff vs previous (block breaking changes)

**Acceptance criteria**:
- [ ] OpenAPI 3.1 valid
- [ ] All endpoints covered with examples
- [ ] CI breaks on schema regression

---

## T35: Co-shipped documentation (NR7 #1-18)

**Estimated size**: 1200 lines across 18 files (docs are stub-quality v1; real content during implementation)
**Dependencies**: spec
**Files touched**:
- `docs/ops/key-rotation.md`
- `docs/ops/incident-refresh-leak.md`
- `docs/ops/incident-signing-key-leak.md`
- `docs/ops/access-review.md`
- `docs/ops/audit-retention.md`
- `docs/security/threat-model.md`
- `SECURITY.md` + `.well-known/security.txt`
- `docs/gdpr.md`
- `docs/onboarding-self-host.md` (extended with `.env.example` per Round 3)
- `docs/idp-providers.md`
- `docs/ops/audit-queue-policy.md`
- `docs/ops/feature-flag-rollout.md`
- `docs/ops/sqlite-operations.md`
- `docs/ops/backup-restore.md`
- `docs/ops/single-instance-constraints.md`
- `CHANGELOG.md` (v0.8.0 entry)
- `examples/docker-compose/`
- `examples/nginx-reverse-proxy/`

**Implementation summary**:

Each doc follows a template:
- Purpose
- When to use
- Prerequisites
- Step-by-step procedure
- Acceptance criteria / verification

**Acceptance criteria**:
- [ ] All 18 files present
- [ ] CHANGELOG entries: BREAKING (audit_log column rename for direct-DB consumers), FEATURE (OAuth + Device Flow), DEPRECATED (org="default" legacy tokens, removed v0.9.0)
- [ ] Onboarding doc tested by following exact steps to clean install

---

# Definition of Done (DoD)

Each task is "done" when:
- [ ] All acceptance criteria checked
- [ ] All test cases pass
- [ ] Coverage targets met (file-specific or 80% global)
- [ ] No CI lint violations
- [ ] Code review approved
- [ ] Spec updated if implementation diverges (rare; spec is canonical)
- [ ] PR squashed and merged to integration branch

Phase 2 ships when:
- [ ] All 32 tasks done
- [ ] `npm version 0.8.0 --no-git-tag-version` clean
- [ ] CHANGELOG complete
- [ ] OpenAPI spec valid
- [ ] All 18 docs shipped
- [ ] Smoke test in Docker: `npm install && start && mcp-cli login` succeeds end-to-end in < 10 minutes from clean install

---

# Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration breaks Phase 1 DB | Low | High | Idempotency guards + backup pre-migration; rollback = restore |
| GitHub API breaking change | Low | High | msw mocks + integration tests pinned to API version |
| listMemberships rate limit hit at scale | Medium | Medium | 60s positive cache + 10min stale (already in design) |
| token_epoch DB read becomes bottleneck | Low | Medium | Phase 5 swap to cache if needed; bench targets ensure detection |
| 81KB spec drift from V4 patches | Medium | Low | Spec is source-of-truth; impl PRs must cite section refs |
| New eng can't onboard | High (per Round 3) | Medium | V4 glossary + module map; pair-program first 2 tasks |
| Test seam mocking complexity | Medium | Medium | T04+T13+T28 use Clock/IdGen/IdP seams from day 1 |

---

# Open questions (resolve before Phase C starts)

1. **OpenAPI generation strategy**: derive from zod schemas (T02 + handler types) OR hand-write `openapi.yaml` + validate against runtime? Tradeoff: generation = single source, hand-write = more readable.
2. **CLI bundling**: ship Phase 2 CLI verbs (`issue-service-token`, etc.) as part of `mcp-coordinator` package, OR separate `@mcp-coordinator/cli`?
3. **Geo lookup library**: maxmind-db lite (vendored) vs network IP service vs none (just null)? Affects T17.
4. **/auth/login multi-provider**: if Phase 4 plans Google, should T15 already render a picker (Phase 2 single-button) or hardcoded GitHub redirect (Phase 2)? Smaller scope: hardcoded; flag for Phase 4 refactor.

---

# Plan review process

Per Phase 1 process, this plan should go through 4 review rounds × 20 agents = 80 reviewers before code starts. Each round can lift this plan from v1 → v5.

Round focus areas:
- **Round 1**: completeness (gaps in task list)
- **Round 2**: dependency correctness (DAG fixes)
- **Round 3**: per-task implementation soundness (code-level reviews)
- **Round 4**: final compile-fail + test-fail + edge-case sweep

After round 4: implementation begins via subagent-driven-development.
