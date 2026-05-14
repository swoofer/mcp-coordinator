# Phase 2 Plan V2 — Patches & Additions

**Date**: 2026-05-13
**Status**: Patches post Plan Round 1 review (22 reviewer agents)
**Supersedes specific sections of**: `2026-05-13-auth-phase2-oauth-device-plan.md` (main plan v1)
**Read order**: main plan v1 first, then this patches doc

## Purpose

Plan R1 (22 agents covering: spec→plan completeness, DAG correctness, atomicity, acceptance criteria, test plan, SOC 2, OWASP, OAuth RFC, crypto, distributed systems, DB design, REST API, backward compat, DX, self-host, TypeScript, performance, operations, contrarian, subagent fit, multi-tenant SaaS, implementation order) confirmed:

- **No structural design issues** in plan v1 (every reviewer accepted V3 decisions + V4 patches)
- **20+ mechanical issues** in plan text — same pattern as spec → V4
- **3 implementation-planner blockers** previously surfaced in spec Round 3
- **8 new tasks needed** for completeness
- **5 large tasks need splitting** (T01, T11, T16, T19, T35)
- **3 small tasks need merging** (T22→T21, T26→T25, T30→T16)

V2 = patches addressing convergent R1 findings. No further plan review rounds (we've reached 86 reviewers total: 64 design + 22 plan; diminishing returns vs implementation feedback).

---

## Section A — Task splits and merges

### A.1 SPLIT T01 → T01a + T01b

**Reason**: 600 LOC mixing migration + CI lints exceeds atomic-PR target.

**T01a — Schema migration + version bump** (~400 LOC, 8 test cases)
- Files: `src/database.ts` (extend), `tests/unit/migration-v07-to-v08.test.ts`
- Scope: All DDL from main plan §T01 implementation summary
- Dependencies: none
- Acceptance: items 1-7 from main plan T01 acceptance criteria

**T01b — CI lint scripts** (~200 LOC, 4 lint scripts)
- Files: `scripts/lint-*.sh`, `.github/workflows/lint.yml`
- Scope: 4 grep-based lints (no users.org_id, no CURRENT_TIMESTAMP, no audit mutation, html escape) — see §C.1 below for expanded set
- Dependencies: T01a (lints validate post-migration state)
- Acceptance: each script catches synthetic violation + clean on real code

### A.2 SPLIT T11 → T11a + T11b

**Reason**: Audit + queue + drain + tier dispatch = 350 LOC; queue is separable.

**T11a — audit() helper + Tier 1 sync path** (~150 LOC, 6 tests)
- Files: `src/security/audit.ts` (extend), `tests/unit/audit-tier1.test.ts`
- Scope: `audit()` API, `tier` param (DEFAULT TO 2 for backward compat with Phase 1 callers — see §B.1 fix), `getCurrentActor()`/`getCurrentRequest()` helpers (defined here, owned by T10 request-id), Tier 1 sync direct INSERT
- Dependencies: T01a, T10

**T11b — AuditQueue + Tier 2 async batched** (~200 LOC, 6 tests)
- Files: `src/security/audit-queue.ts`, `tests/unit/audit-queue.test.ts`
- Scope: Bounded queue (10K cap), batching (50/100ms), `drain(timeoutMs)` with SIGTERM 5s timeout, overflow drop with metric, `system.shutdown.audit_loss` final row
- Dependencies: T11a

### A.3 SPLIT T16 → T16a + T16b + T16c

**Reason**: 500 LOC for callback handler is too big for one reviewable PR; 100% branch coverage of 15 test cases needs sub-task isolation.

**T16a — Callback skeleton: state validation + CAS + IdP exchange** (~150 LOC, 5 tests)
- Files: `src/auth/oauth-handlers.ts` (callback handler — first half)
- Scope: HMAC state cookie compare (via T08), `consumeOAuthState` CAS, mix-up defense (`row.provider`), `exchangeCode` call + error handling (503 on transient, 401 on revoked)
- Dependencies: T01a, T06, T08, T16helpers (see A.10), T08b (crypto foundation), T08c (HTTP contract)
- Tests: state mismatch, expired, replay, mix-up, IdP 5xx

**T16b — Provisioning transaction body** (~200 LOC, 6 tests)
- Files: `src/auth/oauth-handlers.ts` (callback handler — TX body)
- Scope: `BEGIN IMMEDIATE TRANSACTION`, allowlist resolve via T09, find-or-create user, bootstrap admin atomic SQL with role recompute + propagate to `user_orgs` row (V4 FIX 16 explicit), idp_access_token UPDATE, `AUTO_PROVISION` mode handling
- Dependencies: T16a, T01a, T09, T11a (audit tier 1 calls)
- Tests: new user happy path, returning user, bootstrap admin first time, bootstrap admin race (concurrent), AUTO_PROVISION=false, allowlist 403

**T16c — JWT mint + cookie emission + redirect** (~150 LOC, 4 tests)
- Files: `src/auth/oauth-handlers.ts` (callback — finalization)
- Scope: `mintAccessJWT`/`mintRefreshJWT` calls (helpers in T08b), fingerprint = SHA256(ip+'|'+ua), INSERT refresh_tokens, post-commit audit `auth.login.success` (Tier 2), set 3 cookies via T07 `setCookies()` array form, clear oauth_state cookie, 302 redirect
- Dependencies: T16b, T07, T08b
- Tests: 3 cookies set in single Set-Cookie array, fingerprint computation, JWT claims shape, redirect destination = /auth/success

### A.4 SPLIT T19 → T19a + T19b + T19c

**Reason**: 500 LOC + 100% branch coverage on most security-critical algorithm = needs sub-task review granularity. Pentester R3 found 4 chains in this algorithm alone.

**T19a — Rotation happy path + JWT validation** (~150 LOC, 6 tests)
- Files: `src/auth/refresh-rotation.ts` (rotation happy path)
- Scope: JWT verify (HS256 + kid + clock_tolerance 30), `verifyTokenStrict` integration, row SELECT, normal rotation transaction (V4 FIX 5: `UPDATE WHERE jti=? AND revoked_at IS NULL`), JWT mint via T08b, post-commit audit `auth.refresh.rotated` (Tier 2)
- Dependencies: T01a, T03, T05, T07, T08b, T11a
- Tests: happy path, JWT expired (within 30s skew), JWT invalid kid, rotation race (revoke between check and update — caught by atomic WHERE), audit row visible from 2nd connection, fingerprint stored on successor

**T19b — Reuse detection + 10s grace + family revoke** (~200 LOC, 7 tests)
- Files: `src/auth/refresh-rotation.ts` (reuse branch)
- Scope: Reuse detection branch (`row.revoked_at IS NOT NULL`), grace window (10s), `consumer_fingerprint` compare, `replay_count` increment (atomic UPDATE...RETURNING), threshold 3 → `revokeFamilyForReuse` (Tier 1 sync audit BEFORE transaction commits OR per V4 FIX 23 pattern: commit security, then audit, log on audit failure with metric `audit_after_critical_op_failures_total`)
- Dependencies: T19a, T11a
- Tests: stolen token replay > 10s → family revoked; concurrent retry within 10s same fingerprint → cached successor; different fingerprint → replay_count++ no token leak; replay_count reaches 3 → family revoked; cached successor re-mint with deterministic claims; suspicious_replay audit emitted Tier 1; allowlist re-check on grace branch (per V4 FIX 7)

**T19c — Idle timeout + IdP errors + service rejection** (~150 LOC, 5 tests)
- Files: `src/auth/refresh-rotation.ts` (auxiliary branches)
- Scope: Idle timeout conditional UPDATE...RETURNING (V4 FIX 24, wrapped in db.transaction), IdP membership refresh via T04 cache, allowlist re-check, IdPTokenRevoked → 401 + Tier 1 audit `auth.idp.token_revoked`, IdPTransientError → 503, service account JWT short-circuit (`claims.service_account === true → 400 INVALID_GRANT`)
- Dependencies: T19a, T04, T09, T11a
- Tests: idle timeout fired, idle race (TOCTOU caught), GitHub revoked → IdPTokenRevoked, GitHub 5xx → 503, service JWT presented → 400 INVALID_GRANT, allowlist removed mid-session → 401 + family revoke

### A.5 SPLIT T35 → T35a/b/c/d

**Reason**: 18 files in one task hides progress; mixed audiences (ops, security, GDPR, onboarding).

**T35a — Security & policy artifacts** (6 files, ~600 LOC realistic)
- `docs/ops/key-rotation.md`
- `docs/ops/incident-refresh-leak.md`
- `docs/ops/incident-signing-key-leak.md`
- `docs/security/threat-model.md`
- `SECURITY.md`
- `.well-known/security.txt`

**T35b — Compliance & onboarding** (4 files + `.env.example`, ~500 LOC)
- `docs/gdpr.md`
- `docs/onboarding-self-host.md` (extended with Round 3 required sections — see §B.5 onboarding doc contents)
- `docs/idp-providers.md`
- `.env.example` (standalone file in repo root, NOT buried)
- `docs/ops/upgrade-phase1-to-phase2.md` (NEW — was missing in v1)

**T35c — Operations runbooks** (7 files, ~800 LOC)
- `docs/ops/access-review.md`
- `docs/ops/audit-retention.md`
- `docs/ops/audit-queue-policy.md`
- `docs/ops/feature-flag-rollout.md`
- `docs/ops/sqlite-operations.md`
- `docs/ops/backup-restore.md`
- `docs/ops/single-instance-constraints.md`
- `docs/ops/sweeper-circuit-recovery.md` (NEW — was missing)

**T35d — CHANGELOG + examples** (~300 LOC)
- `CHANGELOG.md` (v0.8.0 entries; explicit BREAKING list — see §B.2)
- `examples/docker-compose/` (working stack tested by T39 E2E)
- `examples/nginx-reverse-proxy/`
- `examples/ghes-config/`
- `examples/custom-idp-provider/` (stub)

**Total realistic LOC: ~2200 (vs v1 "1200" estimate which was wildly optimistic per contrarian R1).**

### A.6 MERGE T22 → into T21

**Reason**: `/auth/success` is a 10-line static HTML page using same `render()` seam as `/auth/device`. Atomic with device pages.

**T21 (revised) — Device + success HTML pages** (~300 LOC, 9 tests)
- Files: `src/auth/pages/{device,device-confirm,success}.html.ts`, route registration
- Adds /auth/success route to T21's existing scope.

**Anti-scope-creep rule (§19) update**: 5 HTML routes (login, device, device/confirm, device/approve POST, success). 6th requires ADR.

### A.7 MERGE T26 → into T25

**Reason**: Plan v1 explicitly noted T26 "may be folded into T25 if scope allows." Service token verification override is 50 LOC of `authenticateRequest` extension; bundle with T25.

**T25 (revised) — Service tokens: issuance + CLI + verification override** (~500 LOC, 18 tests)
- Files: `src/auth/service-tokens.ts`, `src/admin/handlers.ts`, 3 CLI verb files, `src/auth.ts` extension
- Now owns: issuance flow + verification path (DB lookup override for `service_account=true` JWTs) + rotation rejection
- 18 test cases enumerated below (was "minimum 15" in v1)

### A.8 MERGE T30 → into T16b

**Reason**: Login lockout is 50 LOC of integration into the callback handler. T12 owns the rate-limit module; T30 was just wiring. Fold into T16b (provisioning) since lockout sits between allowlist check and user provisioning.

**T16b expanded acceptance**:
- On `auth.login.failure` OR `auth.login.denied.not_in_org`: `recordFailedLogin(identifier_hash)` from T12
- `identifier_hash = sha256(idp_user_login if known else req.ip)`
- If `isLocked(identifier_hash)` at callback entry → 429 with Retry-After
- Bootstrap admin exempt (when 0 admins exist in users table)

### A.9 NEW SECTION: shared OAuth-finalize helper (T16helpers)

Per DAG R1 finding: T16 callback and T18's `authorization_code` grant branch share logic. Extract:

**T16helpers — `src/auth/oauth-finalize.ts`** (~150 LOC, 5 tests)
- Files: `src/auth/oauth-finalize.ts`
- Scope: `provisionUser(idpUserInfo, accessToken, allowlistOrg) → { user, isNew }`, `mintTokenPair(user, family_id, fingerprint)`, `setSessionCookies(res, accessJwt, csrfToken)` — pure functions consumed by T16c (browser path) and T18 (CLI/code-grant path)
- Dependencies: T01a, T02, T07, T08b, T09, T11a

This eliminates the phantom `T18 → T16` dependency flagged in R1 DAG review.

### A.10 Updated DAG (after splits/merges)

```
T01a (migration) ──→ T05, T06, T11a/b, T12, T28, T29
T01b (CI lints)  ──→ runs against T01a state
T02 (IdPProvider types) ──→ T04, T05
T03 (token-epoch) ──→ T19a, T23, T27, T29
T04 (membership-cache) ──→ T19a (via T19c specifically), T16b (via T16helpers)
T05 (GitHubProvider) ──→ T16a, T17, T19c
T06 (oauth_state) ──→ T16a
T07 (cookies) ──→ T15, T16c, T21, T23
T08 (csrf) ──→ T16a (state cookie HMAC), T20
T08b (crypto foundation) ──→ T16a, T16c, T19a, T25, T27, T29
T08c (HTTP contract module) ──→ T15-T24 (response shapes, WWW-Authenticate)
T09 (allowlist) ──→ T16b, T19c
T10 (request-id) ──→ T11a
T11a (audit Tier 1) ──→ all endpoints emitting Tier 1
T11b (audit queue) ──→ all endpoints emitting Tier 2; SIGTERM in T29
T12 (rate-limit) ──→ all endpoints, T16b lockout
T13 (html) ──→ T15, T21
T14 (discovery doc) ──→ standalone
T16helpers ──→ T16c, T18 (eliminates phantom dep)
T16a → T16b → T16c
T17 → T18 device-grant branch
T18 dispatcher → T16helpers, T17 (device handler), T19a (refresh grant)
T19a → T19b → T19c
T20 → T08, T11a, T13, T27
T21 (incl /auth/success) → T13
T23 → T03, T07, T11a, T27
T24 → T27
T25 (incl T26) → T01a, T11a, T27
T27 → T03, T07, T08b
T28 (sweeper) → T01a, T11b (drain), T29 (advisory file lock + circuit reset)
T29 (boot+restore) → T01a, T03, T11a
T31 → T01a..T30
T32 → T01a..T30
T33 → T01a..T30
T34 → T15-T24 zod schemas
T35a/b/c/d → spec + impl-complete
```

---

## Section B — New tasks (T36–T44)

### T36 — Response contract module + WWW-Authenticate + Pino redaction + /health/ready

**Estimated size**: 300 LOC + tests
**Dependencies**: T10, T11a
**Files**:
- `src/http/response-contract.ts` (NEW)
- `src/http/error-envelope.ts` (NEW)
- `src/observability/logger.ts` (NEW — Pino init with redact paths)
- `src/http/health.ts` (NEW — /healthz + /health/ready)
- `tests/unit/response-contract.test.ts`

**Scope**:
- **WWW-Authenticate helper** per V4 §6.0.1:
  ```ts
  export function bearerAuthHeader(err?: 'invalid_token' | 'insufficient_scope', desc?: string, scope?: string): string {
    let h = 'Bearer realm="coordinator"';
    if (err) h += `, error="${err}"`;
    if (desc) h += `, error_description="${escapeQuoted(desc)}"`;
    if (scope) h += `, scope="${scope}"`;
    return h;
  }
  ```
- **Error envelope helpers** (2 schemas):
  - `oauthError(error, description, uri?)` → RFC 6749 §5.2 shape for OAuth endpoints
  - `appError(code, message, details?)` → coordinator envelope for non-OAuth endpoints (request_id auto-injected from T10)
- **Pino logger init** with `redact` paths from V4 §11.3 (16 paths)
- **`/healthz`** liveness: 200 if process alive (cheap)
- **`/health/ready`** readiness: 503 if any of: sweeper circuit open, audit queue depth > 80%, DB unreachable (SELECT 1)

Acceptance:
- [ ] `WWW-Authenticate` emitted on every 401 from T19/T23/T24/T26/T27 paths
- [ ] OAuth endpoints return RFC 6749 envelope; non-OAuth return coordinator envelope
- [ ] Pino redact catches all 16 paths in V4 §11.3 — unit test injects `Authorization: Bearer SECRET` log line, asserts SECRET not in output
- [ ] `/health/ready` flips to 503 on sweeper circuit-open within 1s
- [ ] During SIGTERM drain, `/health/ready` returns 503 to drain load-balancer traffic

Test cases (minimum 12)

### T37 — Metrics registry + /metrics endpoint + alert rules YAML

**Estimated size**: 400 LOC (registry + handler + Grafana JSON + Prometheus rules)
**Dependencies**: T01a, T11a, T12, T28, T36
**Files**:
- `src/observability/metrics.ts` (NEW — prom-client registry)
- `src/http/metrics.ts` (NEW — /metrics handler, optionally localhost-only or Bearer-protected)
- `docs/ops/dashboards/coordinator.json` (NEW — Grafana JSON)
- `docs/ops/alerts/coordinator-alerts.yaml` (NEW — Prometheus alert rules)
- `tests/unit/metrics.test.ts`

**Scope**:
- 24 metrics from main plan §17.1 + additions: `audit_after_critical_op_failures_total`, `sweeper_circuit_open`, `sweeper_consecutive_failures`, `litestream_replication_lag_seconds`, `audit_pruned_rows_total`, `rate_limit_rejections_total{endpoint}`
- Default Node metrics: process_*, nodejs_eventloop_lag, gc duration
- All metrics labeled with `org_id` where tenant-scoped (Phase 5 readiness, V3 SaaS evolution requirement)
- `/metrics` endpoint: localhost-only by default, optional Bearer-protected via `COORDINATOR_METRICS_BEARER` env var
- Grafana dashboard JSON with 4 rows: Auth Activity, Refresh Health, IdP Connectivity, Audit & Sweep
- Prometheus alert rules: 4 PAGE (refresh_chain_revokes>0/5min, audit_drops>0, sweeper_circuit_open, ready_failing>2min), 4 TICKET (idp p99>5s, idp_stale_served>0/5min, device_flow_init_v_approve_ratio>5x, audit_queue_depth>80%), 3 LOG (legacy_token_acceptance>0, audit_queue_depth>50%, sweeper_last_run>180s)

Acceptance:
- [ ] All 30 metrics registered
- [ ] Tenant-scoped metrics carry `org_id` label
- [ ] `/metrics` localhost-only default
- [ ] Grafana JSON imports cleanly into v10+
- [ ] Prometheus alert rules YAML passes `promtool check rules`

### T38 — Test harness module

**Estimated size**: 300 LOC
**Dependencies**: T01a, T02
**Files**:
- `tests/helpers/clock.ts` (`FakeClock` with `advance(ms)`, `set(iso)`)
- `tests/helpers/idgen.ts` (deterministic `IdGen` for tests)
- `tests/helpers/idp.ts` (msw factory: `mockIdp.respondWith(status, body).failNext(n).delay(ms)`)
- `tests/helpers/audit.ts` (`auditQueue.drain()` exposed; assertion helpers)
- `tests/helpers/db.ts` (`db.readCommitted(sql)` opens 2nd connection for post-commit assertion)
- `tests/helpers/fetch.ts` (`rawFetch(method, path, opts)` bypasses cookie jar / CSRF auto-injection)
- `tests/helpers/seed.ts` (`seedFourOrgs()` — shared by T31 + T32)
- `tests/helpers/index.ts` (barrel export)

Scope per V4 §15.7 (test harness contracts) and Round 1 R1 finding.

Acceptance:
- [ ] All 6 helpers callable from any integration test
- [ ] `clock.advance(ms)` propagates via T04 Clock seam
- [ ] `mockIdp.failNext(2)` causes next 2 calls to error (used in chaos tests)
- [ ] `auditQueue.drain()` returns `{flushed, dropped}` deterministically
- [ ] `db.readCommitted` opens separate `better-sqlite3` connection to same DB file
- [ ] `seedFourOrgs` creates 4 orgs × (1 admin + 1 member + 1 service token) deterministically

### T39 — Playwright E2E suite

**Estimated size**: 500 LOC
**Dependencies**: T01a..T30
**Files**:
- `tests/e2e/browser-oauth.spec.ts`
- `tests/e2e/cli-device-flow.spec.ts`
- `tests/e2e/refresh-on-401.spec.ts`
- `playwright.config.ts`
- `.github/workflows/e2e.yml`

Scope per V4 §15.2 (E2E tier).
- Browser OAuth happy path: navigate → login → approve at GitHub mock → callback → /auth/success
- CLI device flow: spawn mock CLI process → init device → browser approval (Playwright) → CLI polls → receives tokens
- Refresh-on-401: client SDK fetch → 401 → auto-refresh → retry → success

Acceptance:
- [ ] 3 E2E scenarios run green on Linux CI (headless Chromium)
- [ ] Total runtime < 60s
- [ ] No flakes over 50-run repeat (CI nightly)

### T40 — Reference SDK `@mcp-coordinator/sdk-js`

**Estimated size**: 800 LOC (SDK + tests)
**Dependencies**: T14 (discovery), T36 (response contract)
**Files**: separate package `packages/sdk-js/` (monorepo addition; or sibling repo)

Scope per V3 NR9 + Round 3 DX:
- TypeScript classes: `McpCoordinatorClient`, `AuthClient`
- Verbs: `login()`, `logout()`, `logoutAll()`, `whoami()`, `refresh()`, `deviceLogin()`
- OS keychain integration: keytar (cross-platform) with chmod-600 plaintext fallback + warning
- Named profiles via `~/.mcp-coordinator/config.toml` ([profile.default] base_url, token_path)
- Stable error subclasses: `OrgAllowlistUnsetError`, `NotInAllowlistError`, `SessionRevokedError`, `TokenExpiredError`, `RefreshChainRevokedError`, `RateLimitedError`, `IdPTransientError`, `DeviceFlowExpiredError`, etc. (12+ classes)
- Discovery doc consumption: SDK fetches `.well-known/oauth-authorization-server` on cold start, caches 24h
- Proactive refresh at `T-2min` for long-running streams + jitter ±30s
- Single-flight refresh lock via OS file (multi-process CLI safety)

Acceptance:
- [ ] All verbs implemented + integration-tested against coordinator
- [ ] OS keychain on Win/Mac/Linux (CI matrix)
- [ ] Plaintext fallback emits warning + sets 0600 perms
- [ ] 100% test coverage on error mapping

### T41 — `mcp-coordinator init` interactive wizard

**Estimated size**: 400 LOC
**Dependencies**: T29 (uses same validation)
**Files**:
- `src/cli/init.ts`
- `tests/integration/init-wizard.test.ts`

Scope per Round 3 onboarding + R1 self-host:
- Interactive prompts (using `enquirer` or similar):
  1. GitHub OAuth App: prints exact callback URL to register, opens `github.com/settings/developers/new` in browser
  2. Paste Client ID, Client Secret
  3. GitHub organization (validates user is member)
  4. Bootstrap admin (default = current GitHub user)
  5. PUBLIC_URL (validates reachable)
- Generates JWT_SECRET via `crypto.randomBytes(32).toString('base64url')`
- Writes `.env` file
- Validates by running T29 boot validation in advisory mode
- Prints next steps including "to log in: visit {PUBLIC_URL}/auth/login"

Acceptance:
- [ ] Wizard runs to completion < 5 min for new self-hoster
- [ ] Generated `.env` passes T29 fail-closed validation
- [ ] Wizard refuses to overwrite existing `.env` (asks for confirm)
- [ ] Detects GitHub OAuth App callback URL mismatch + offers to update

### T42 — `mcp-coordinator doctor` verb

**Estimated size**: 200 LOC
**Dependencies**: T29
**Files**: `src/cli/doctor.ts`, `tests/integration/doctor.test.ts`

Scope per Round 3 DX:
- Probes: PUBLIC_URL reachable, discovery doc parses, GitHub Client ID/Secret round-trips, SQLite ≥3.25, clock skew vs system NTP, audit queue health, sweeper status, keychain accessible
- Outputs: pass/warn/fail per check + remediation hints
- Exit code: 0 if all pass, 1 if warns, 2 if any fail

Acceptance:
- [ ] All probes pass on healthy install
- [ ] Each failure mode produces actionable message

### T43 — Phase 1 backcompat verification suite

**Estimated size**: 400 LOC (suite + fixtures)
**Dependencies**: T01a..T27
**Files**:
- `tests/backcompat/phase1-jwt-acceptance.test.ts`
- `tests/backcompat/phase1-endpoint-survival.test.ts`
- `tests/fixtures/phase1-db-snapshot.db` (binary: Phase 1 v0.7.0 SQLite snapshot captured for regression)
- `tests/fixtures/phase1-token-set.json` (sample valid Phase 1 JWTs)

Scope per R1 backward-compat:
- Load Phase 1 DB snapshot → run T01a migration → verify all Phase 1 endpoint tests pass
- Phase 1 JWT (org="default", no family_id, no active_org_id) → accepted by T27 with deprecation telemetry (`auth.legacy_token.accepted` Tier 2 emitted, `legacy_token_acceptance_total` counter incremented)
- Phase 1 route inventory (enumerated): assert non-collision with Phase 2 routes
- `users_legacy_v0_7` view query returns same rows as `users` (with column alias)

Acceptance:
- [ ] Phase 1 token from fixture file accepted post-upgrade
- [ ] Phase 1 endpoint tests pass against v0.8.0 server with `COORDINATOR_OAUTH_ENABLED=false`
- [ ] Deprecation telemetry fires on each Phase 1 token use
- [ ] Direct-DB query `SELECT org_id FROM users_legacy_v0_7` works (compat view)
- [ ] Phase 1 fixture migration runs without error

### T44 — getOrgSetting shim + CI lint

**Estimated size**: 150 LOC
**Dependencies**: T01a
**Files**:
- `src/auth/org-settings.ts` (NEW)
- `scripts/lint-no-direct-env-in-auth.sh` (NEW — to T01b's lint suite)
- `tests/unit/org-settings.test.ts`

Scope per V3 §4.4 SaaS evolution requirement:
- `getOrgSetting(db, orgId, key, envDefault)` → reads from `orgs.<key>` column first; falls back to `process.env.COORDINATOR_<UPPER_KEY>`; falls back to envDefault
- CI lint: `grep -rn "process\.env\.COORDINATOR_" src/auth/ src/cli/ src/admin/` returns 0 hits except in `src/auth/org-settings.ts` itself and boot validation files

Phase 2 use sites (must use shim, not direct env):
- T19a JWT_ACCESS_TTL / REFRESH_TTL reads
- T16b AUTO_PROVISION mode
- T17 client_id allowlist
- T12 rate limit configs
- T16b lockout thresholds

Acceptance:
- [ ] Shim reads org column when set, env fallback when not
- [ ] CI lint catches direct `process.env.COORDINATOR_` reads in auth code
- [ ] All Phase 2 config reads in main plan tasks updated to use shim

### T08b — Crypto foundation modules

**Estimated size**: 350 LOC (5 modules + tests)
**Dependencies**: T01a (env loading)
**Files**:
- `src/auth/crypto-keys.ts` (HKDF-derived purpose keys: `getCsrfHmacKey()`, `getStateBindingKey()` — V4 §9.3)
- `src/auth/jwt-keys.ts` (kid → key registry, accepted-kid allowlist `['hs256-v1']`)
- `src/auth/jwt-mint.ts` (`mintAccessJWT`, `mintRefreshJWT` — shared between T16c, T19a, T25)
- `src/auth/pkce.ts` (`generateVerifier()`, `computeChallenge(verifier)` — prevents RFC 7636 §4.2 footgun)
- `src/auth/entropy.ts` (`assertSecretEntropy(buf, minBits)` — used by T29 boot)
- `tests/unit/crypto-foundation.test.ts`

Scope per R1 crypto agent:
- HKDF-SHA256 from `JWT_SECRET` with info labels: `"csrf-v1"`, `"state-binding-v1"`. Override via `COORDINATOR_CSRF_HMAC_KEY` (V4 §9.3).
- Domain separation: `csrf_key ≠ state_binding_key ≠ JWT signing key`
- `kid` registry: `{ 'hs256-v1': signingKey }`; unknown kid → reject. Prev secret rotation: `{ 'hs256-v1': current, 'hs256-v0': prev }` during overlap window.
- `mintAccessJWT(claims)`: jose v5 SignJWT, HS256 pinned, `kid: 'hs256-v1'` header, `setIssuer(PUBLIC_URL)`, `setExpirationTime(getOrgSetting(...))`. Claims minimization per V4 (no email/login in JWT).
- `pkce.computeChallenge(verifier)`: `base64url(sha256(verifier))` — verifier is the b64url string itself per RFC 7636 §4.2
- `entropy.assertSecretEntropy(buf, 128)`: rejects all-zero, all-same-byte, dictionary words (`change-me`, `secret`, `password`), low Shannon entropy

Acceptance:
- [ ] HKDF keys deterministically derived from JWT_SECRET
- [ ] csrf_key, state_binding_key, jwt_signing_key all distinct
- [ ] Unknown kid → 401 with `auth.jwt.unknown_kid` audit event (Tier 1)
- [ ] `mintAccessJWT` produces JWTs with exact claim set: `{sub, jti, iat, exp, iss, family_id, active_org_id, role}` — no PII
- [ ] PKCE challenge matches RFC 7636 §4.2 test vectors
- [ ] Entropy check rejects weak secrets (10+ unit tests)

---

## Section C — Fixes to plan v1

### C.1 Expanded CI lint suite (T01b)

V1 listed 4 lints; R1 reviewers requested more. Final set (in T01b):

| Script | Forbids | Allowed in |
|---|---|---|
| `lint-no-users-org-id.sh` | `users\.org_id` in src/ tests/ | `src/auth/users_org_id_legacy.sql` (compat view DDL only) |
| `lint-no-current-timestamp.sh` | `CURRENT_TIMESTAMP` on time-logic columns | migrations only |
| `lint-no-audit-mutation.sh` | `UPDATE audit_log\|DELETE FROM audit_log` | `src/sweeper/audit-retention.ts`, migrations |
| `lint-html-escape.sh` | `\${...}` interpolation outside `render()` | applied to `src/auth/pages/`, `src/admin/pages/` |
| `lint-no-direct-env-in-auth.sh` (T44) | `process\.env\.COORDINATOR_` in auth code | `src/auth/org-settings.ts`, `src/boot.ts`, `src/cli/` |
| `lint-no-floating-promises.sh` (NEW R1 TS) | `@typescript-eslint/no-floating-promises` rule | configured in eslint |
| `lint-tier-assignment.sh` (NEW R1 SOC2) | Tier 1 required events must have `tier: 1` | maps required events list to grep |

### C.2 Audit event master table (T11a addition)

Per R1 SOC 2 + OWASP convergent finding. Add to T11a deliverables:

| Event | Tier | Owning Task | Test ID |
|---|---|---|---|
| auth.login.success | 2 | T16c | I16c-1 |
| auth.login.failure | 2 | T16b | I16b-1 |
| auth.login.denied.not_in_org | 1 | T16b | I16b-2 |
| auth.login.locked | 1 | T16b (incl T30) | I16b-3 |
| auth.legacy_token.accepted | 2 | T27 | I27-1 |
| auth.refresh.rotated | 2 | T19a | I19a-1 |
| auth.refresh.chain_revoked | 1 | T19b | I19b-1 |
| auth.refresh.suspicious_replay | 1 | T19b | I19b-2 |
| auth.refresh.idle_expired | 2 | T19c | I19c-1 |
| auth.token.revoked | 1 | T23 | I23-1 |
| auth.logout.local | 2 | T23 | I23-2 |
| auth.logout.global | 1 | T23 | I23-3 |
| auth.device.code_issued | 2 | T17 | I17-1 |
| auth.device.approved | 2 | T20 | I20-1 |
| auth.device.denied | 2 | T20 | I20-2 |
| auth.user.created | 2 | T16b | I16b-4 |
| auth.user.provisioned | 2 | T16b | I16b-5 |
| auth.admin.bootstrapped | 1 | T16b | I16b-6 |
| auth.invalid_token | 2 | T19a | I19a-2 |
| auth.state.replay | 1 | T16a | I16a-1 |
| auth.state.mixup | 1 | T16a | I16a-2 |
| auth.csrf.failed | 2 | T20 | I20-3 |
| auth.idp.token_revoked | 1 | T19c | I19c-2 |
| auth.idp.stale_served | 2 | T04 | I04-1 |
| auth.idp.unknown_kid | 1 | T08b | I08b-1 |
| auth.service_token.issued | 1 | T25 | I25-1 |
| auth.service_token.used | 2 (sampled 1/hr) | T25 | I25-2 |
| auth.service_token.revoked | 1 | T25 | I25-3 |
| auth.bootstrap.admin_assigned | 1 | T16b | I16b-7 |
| recovery.token_epoch_global_bump | 1 | T29 | I29-1 |
| recovery.completed | 1 | T29 | I29-2 |
| config.boot | 1 | T29 | I29-3 |
| config.key_rotation | 1 | T29 | I29-4 |
| system.shutdown.audit_loss | 1 (best-effort) | T11b | I11b-1 |
| migration.audit_backfill | 1 | T01a | I01a-1 |

**35 events total** (was 30 in v1; added 5: legacy_token.accepted, idp.unknown_kid, bootstrap.admin_assigned, config.key_rotation, migration.audit_backfill).

CI lint `lint-tier-assignment.sh` validates this table against actual emit sites.

### C.3 Branched coverage explicit

All security-critical files require **100% branch coverage** (not just line):
- `src/auth/refresh-rotation.ts` (T19a/b/c combined)
- `src/auth/csrf.ts` (T08)
- `src/auth/token-epoch.ts` (T03)
- `src/auth/oauth-state.ts` (T06)
- `src/auth/jwt-mint.ts` (T08b)
- `src/auth/membership-cache.ts` (T04)
- `src/auth/service-tokens.ts` (T25)
- `src/auth/refresh-rotation.ts` (T19)

vitest.config.ts:
```ts
coverage: {
  thresholds: {
    'src/auth/refresh-rotation.ts': { branches: 100, lines: 100 },
    'src/auth/csrf.ts': { branches: 100 },
    'src/auth/token-epoch.ts': { branches: 100 },
    'src/auth/oauth-state.ts': { branches: 100 },
    'src/auth/jwt-mint.ts': { branches: 100 },
    'src/auth/membership-cache.ts': { branches: 100 },
    'src/auth/service-tokens.ts': { branches: 100 },
    global: { branches: 80, lines: 90 },
  }
}
```

### C.4 Boundary thresholds enumerated

Per R1 acceptance criteria reviewer. Each task gets "Boundary cases" subsection:

- T03: bump preserves monotonicity across NTP rollback (32+1 vs current)
- T06: state created at exact expiry second (300s); state with `consumed_at` set in same TX
- T08: CSRF tokens length-pre-check then constant-time
- T12: bucket at exactly capacity (5); 6th attempt within 15min window
- T17: collision retry exhausts 3 attempts → fallback behavior pinned
- T19: 10.0s grace, 10.001s grace+1ms (just outside), 9.999s grace-1ms; replay_count exactly 3 (revoke), exactly 2 (don't yet)
- T25: TTL = 90d exact (accept), 90d+1s (reject), reason 10 chars exact (accept), 9 chars (reject)
- T29: JWT_SECRET = 32 bytes exact (accept), 31 (reject); REFRESH_TTL = 90d exact (accept), 90d+1s (reject); restore detection 300s exact, 301s, 299s
- T20: failed_approval_attempts = 5 exact → deny; 4 → allow

### C.5 SQLite operational assumptions (boilerplate)

Add to plan top section (before Phase A):

> **SQLite operational baseline**:
> - Mode: WAL (`PRAGMA journal_mode = WAL`)
> - Synchronous: NORMAL (`PRAGMA synchronous = NORMAL`)
> - Busy timeout: 5000ms (`PRAGMA busy_timeout = 5000`)
> - Foreign keys: ON (`PRAGMA foreign_keys = ON`)
> - User version: tracked via `PRAGMA user_version`
> - WAL checkpoint: default 1000 pages (`PRAGMA wal_autocheckpoint = 1000`)
>
> All writes serialize on a single writer. Budget assumes WAL allows concurrent reads.

### C.6 T11 audit() backward compat fix (CRITICAL)

R1 backcompat reviewer found: making `tier` REQUIRED breaks Phase 1 callers compile-time.

**Fix in T11a**:
```ts
type AuditOptions = {
  tier?: 1 | 2;  // OPTIONAL: defaults to 2 (Tier 2 async)
  metadata?: Record<string, unknown>;
  target?: string;
  outcome?: 'success' | 'failure' | 'denied';
};

export function audit(action: string, options: AuditOptions = {}): void {
  const tier = options.tier ?? 2;  // default
  // ...
}
```

CI verifies: any new Tier 1 audit call in this codebase explicitly sets `tier: 1`. Linter (T01b) script `lint-tier-assignment.sh` enforces.

### C.7 T02 exchangeCode breaking change documentation

R1 backcompat: return type change `Promise<IdpUserInfo>` → `Promise<{user, accessToken}>` IS breaking for external implementers.

**Fix**:
- T02 acceptance + CHANGELOG: explicitly listed as BREAKING for external IdPProvider implementers (was masked as "covered by `?:` optional rule" which only applies to NEW methods, not changed signatures)
- Plan accepts this as breaking since Phase 1 shipped empty IdPProvider registry — no real consumers to break
- 0.8.0 minor justification: pre-1.0 semver allows breaking changes in minors; documented in CHANGELOG under BREAKING section

### C.8 T17 user_code collision fix (TOCTOU)

R1 distributed systems + pentester: SELECT-then-INSERT is racy.

**Fix in T17 algorithm**:
```sql
-- Use UNIQUE constraint + INSERT OR FAIL with retry
INSERT INTO device_auth_requests (device_code, user_code, ...) VALUES (?, ?, ...);
-- On SQLITE_CONSTRAINT (UNIQUE failure): regenerate user_code, retry (max 3 attempts)
-- After 3 failures: 500 internal error
```

Requires `UNIQUE(user_code)` on `device_auth_requests` (already in Phase 1 schema per bootstrap doc).

### C.9 T20 atomic CAS for device approve

R1 distributed systems + pentester (V4 FIX 18 named but not transcribed):

**Fix in T20 algorithm**:
```sql
-- Approve path (atomic CAS)
UPDATE device_auth_requests
SET approved_user_id = :user_id, approved_at = :now
WHERE user_code = :user_code 
  AND approved_user_id IS NULL 
  AND denied_at IS NULL 
  AND expires_at > :now
  AND failed_approval_attempts < 5
RETURNING device_code;
-- Check rowsAffected = 1; else 400 + audit auth.device.denied with reason

-- Failed approval path (atomic increment-with-RETURNING)
UPDATE device_auth_requests
SET failed_approval_attempts = failed_approval_attempts + 1
WHERE user_code = :user_code
RETURNING failed_approval_attempts;
-- If returned >= 5: UPDATE SET denied_at, denied_reason='brute_force_lockout'
```

### C.10 T16a state cookie HMAC canonical construction

R1 crypto: 3-arg HMAC is non-standard.

**Fix in T16a**:
```ts
function bindState(state: string): string {
  const message = Buffer.concat([
    Buffer.from('state-v1', 'utf8'),
    Buffer.from([0]),  // explicit null byte separator
    Buffer.from(state, 'utf8'),
  ]);
  const hmac = crypto.createHmac('sha256', getStateBindingKey());  // T08b
  hmac.update(message);
  return hmac.digest('base64url');
}

// Verify side: recompute, timingSafeEqual with length pre-check
```

### C.11 T19a allowlist re-check explicit

R1 OWASP: V4 FIX 7 named but not in test cases.

**Fix in T19b/c acceptance**:
- [ ] Allowlist re-checked on grace branch (V4 FIX 7) AND outside-grace branches
- Test case: user removed from GitHub org → next refresh (whether in 10s grace or after) → 401 + family revoked + audit `auth.login.denied.not_in_org` Tier 1

### C.12 T28 sweeper concrete DELETE SQL

R1 DB design: only `sweepOauthState` exemplified; others elided.

**Fix in T28 acceptance**:
- Concrete DELETE SQL for each of 6 tables shown:
  - `oauth_state`: `DELETE FROM oauth_state WHERE expires_at < (? - 60) LIMIT 1000`
  - `device_auth_requests`: `DELETE FROM device_auth_requests WHERE expires_at < (? - 60) LIMIT 1000`
  - `refresh_tokens` (revoked retention): `DELETE FROM refresh_tokens WHERE revoked_at IS NOT NULL AND revoked_at < (? - :retention_seconds) LIMIT 1000`
  - `refresh_tokens` (expired no-revoke): `DELETE FROM refresh_tokens WHERE revoked_at IS NULL AND expires_at < (? - 30*86400) LIMIT 1000`
  - `audit_log` Tier 1: `DELETE FROM audit_log WHERE created_at < (? - :tier1_retention_days * 86400) AND action IN (:tier1_events) LIMIT 1000`
  - `audit_log` Tier 2: `DELETE FROM audit_log WHERE created_at < (? - :tier2_retention_days * 86400) AND action IN (:tier2_events) LIMIT 1000`
- Indexes required: `(outcome, created_at)` on audit_log, `expires_at` on device_auth_requests — added to T01a DDL

### C.13 Open questions resolved

Round 1 plan agent noted 4 open questions in plan v1; resolve:

1. **OpenAPI generation strategy**: Hand-write from per-endpoint zod schemas (T15-T24 each export `request: z.object(...)`, `response: z.object(...)`). T34 collects them. **DECISION: zod-derived**.

2. **CLI bundling**: Ship as part of `mcp-coordinator` package for Phase 2 (single CLI binary). **DECISION: monolithic** for now; split into `@mcp-coordinator/cli` if separable later.

3. **Geo lookup library**: maxmind-db-lite (vendored, optional). Falls back to null if missing/unavailable. **DECISION: optional dep**.

4. **/auth/login multi-provider**: Phase 2 = hardcoded GitHub redirect (single button). Phase 4 = picker. **DECISION: hardcoded GitHub Phase 2**.

---

## Section D — Risk register update

Add to plan §risk register:

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SQLite single-writer contention under combined refresh + audit + sweep load | Medium | Medium | WAL + busy_timeout=5000; perf bench T33 catches |
| Phase 5 subdomain tenancy blocked by `__Host-` cookie prefix | Medium | Medium | Documented Phase 5 trade-off; cookie module has seam for future split |
| Service token re-scoping requires re-issue (no rotation) | Low | Low | Documented operational property |
| Per-org config bypass via direct env read | Medium | Medium | T44 CI lint enforces shim usage |
| Membership cache cardinality cliff at 10K users | Low | Medium | Document; Phase 5 enlarges or moves to Redis |
| Rate-limiter bucket-map unbounded growth under DDoS | Medium | Medium | LRU eviction + sweeper prune; document |
| Audit-after-commit failure loses Tier 1 event | Low | High | Metric + logger.error with full context; runbook for forensic reconstruction |

---

## Section E — Final task count

| Phase | v1 tasks | v2 tasks |
|---|---:|---:|
| A Foundation | T01–T08 (8) | T01a, T01b, T02, T03, T04, T05, T06, T07, T08, **T08b** (10) |
| B Helpers | T09–T14 (6) | T09, T10, T11a, T11b, T12, T13, T14, **T36, T37, T38, T44** (11) |
| C Endpoints | T15–T24 (10) | T15, T16a, T16b, T16c, T16helpers, T17, T18, T19a, T19b, T19c, T20, T21 (incl T22), T23, T24 (14) |
| D Integration | T25–T30 (6) | T25 (incl T26 + T30), T27, T28, T29 (4) |
| E Tests/Docs | T31–T35 (5) | T31, T32, T33, T34, T35a, T35b, T35c, T35d, **T39, T40, T41, T42, T43** (13) |
| **Total** | **35** | **52** |

(Plus T16helpers and T08b counted in their respective phases.)

Estimated total LOC: ~6500 (plan text — Phase 1 v5 was 5814; on parity for completeness).

---

## Section G — Implementation Conventions (NEW §0 to pre-pend to plan)

Per R1 subagent-fit agent. Mandatory pre-read for any subagent dispatched on a Phase 2 task:

### G.1 Primary source citation per task

Every task header MUST cite:
- `**Primary source**: Spec §X.Y` (canonical authority)
- `**V4 patches**: FIX_N` (overrides primary; spec V4 takes precedence over spec body)
- `**V2 plan patches**: §A.x / B.y` (overrides plan v1)

Subagent reads: V2-patches > V4-patches > spec > V3-decisions > plan v1.

### G.2 File ownership per task

Every task lists:
- `**Exports**: <symbol1>, <symbol2>, ...` (symbols introduced or extended)
- `**Imports from**: <task1>, <task2>, ...` (modules consumed)

When 2+ tasks edit the same file, task header includes `**MERGE ORDER**: after T<x>`.

### G.3 Shared `src/auth/oauth-handlers.ts` refactor (pre-Phase C)

**NEW T14.5 — Split oauth-handlers.ts skeleton** (~50 LOC scaffolding, before Phase C)

Creates skeleton files:
- `src/auth/oauth-login.ts` — owns `/auth/login` handler (T15)
- `src/auth/oauth-callback.ts` — owns `/api/auth/oauth/callback` (T16a/b/c)
- `src/auth/oauth-token.ts` — owns `/api/auth/oauth/token` dispatcher (T18 + grants)
- `src/auth/logout.ts` — owns logout/logout-all/revoke (T23)
- `src/auth/userinfo.ts` — owns /api/auth/me (T24)

Each file exports its handler(s); `src/http/auth-routes.ts` (NEW, T14.5) registers them. Phase 1's `src/http/handle-rest.ts:handleRest()` calls `registerAuthRoutes(router)` before its existing cascade.

This eliminates the 6-task merge-conflict bomb on a single file.

### G.4 DI seam: ServerContext

```ts
// src/types.ts
export interface ServerContext {
  db: Database.Database;
  clock: Clock;
  metrics: MetricsRegistry;
  logger: PinoLogger;
  rateLimiter: RateLimiter;
  audit: AuditFunctions;
  membershipCache: MembershipCache;
  githubProvider: IdPProvider;
  signingKeys: JwtKeyRegistry;
}
```

Every handler signature: `async function handle<X>(ctx: ServerContext, req, res): Promise<void>`. No globals.

### G.5 Import path map (one-time table)

| Module | Import from |
|---|---|
| `bumpTokenEpoch` | `src/auth/token-epoch` |
| `audit` | `src/security/audit` |
| `MembershipCache` | `src/auth/membership-cache` |
| `escapeHtml`, `render`, `sendHtml` | `src/auth/html` |
| `setCookies`, `hostCookie`, `parseCookies` | `src/auth/cookies` |
| `generateCsrfToken`, `verifyCsrfToken` | `src/auth/csrf` |
| `requireCsrf` (middleware) | `src/http/middleware/csrf-require` (NEW — small) |
| `resolveOrgFromMemberships` | `src/auth/allowlist` |
| `createOAuthState`, `consumeOAuthState` | `src/auth/oauth-state` |
| `mintAccessJWT`, `mintRefreshJWT` | `src/auth/jwt-mint` (T08b) |
| `getCsrfHmacKey`, `getStateBindingKey` | `src/auth/crypto-keys` (T08b) |
| `getOrgSetting` | `src/auth/org-settings` (T44) |

### G.6 Pre-T01a prep task

**NEW T00 — package.json + dependencies prep** (~50 LOC)

- `"type": "module"` (ESM)
- `"engines": { "node": ">=20.0.0", "better-sqlite3": ">=11" }`
- Add deps (with versions): `cookie@^0.6`, `lru-cache@^10`, `jose@^5`, `zod@^3`, `pino@^9`, `prom-client@^15`, `enquirer@^2` (for T41 wizard), `keytar@^7` (T40 SDK package)
- DevDeps: `msw@^2`, `playwright@^1.40`, `fast-check@^3`, `c8` or `@vitest/coverage-v8`
- `tsconfig.json` strict additions: `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`
- ESLint rule: `@typescript-eslint/no-floating-promises: error`
- `vitest.config.ts` coverage thresholds per §C.3

### G.7 Test fixtures registry

| Fixture | Created by | Used by |
|---|---|---|
| `tests/helpers/idp.ts` (`mockIdp` msw factory) | T38 | T05, T15, T16a, T17, T18, T19, T39 |
| `tests/helpers/clock.ts` (`FakeClock`) | T38 | every time-sensitive test |
| `tests/helpers/db.ts` (`db.readCommitted`) | T38 | T11, T16, T19, T29 |
| `tests/helpers/seed.ts` (`seedFourOrgs`) | T38 | T31, T32 |

### G.8 SIGTERM shutdown sequence (NEW, T29 ownership)

Composition order (T29 registers SIGTERM handler):
1. Set `/health/ready` to 503 (drain LB traffic; ~2s grace)
2. Stop accepting new HTTP requests
3. Wait for in-flight requests (≤10s timeout)
4. `Sweeper.stop()` (finish current pass)
5. `AuditQueue.drain(5000)` — Tier 2 buffer flush
6. Close DB
7. Exit 0

### G.9 Conflict-prone shared symbols (mandatory ownership table)

| File | Symbol | Owning Task |
|---|---|---|
| `src/auth.ts` | `authenticateRequest` scenario 5 | T27 |
| `src/auth.ts` | service_account branch | T25 (after T27) |
| `src/auth.ts` | legacy_token.accepted telemetry | T43 (after T27) |
| `src/auth/oauth-callback.ts` | `handleOAuthCallback` | T16c (composes T16a + T16b) |
| `src/auth/refresh-rotation.ts` | `refreshGrant` | T19a + T19b + T19c land sequentially |
| `src/auth/oauth-token.ts` | grant dispatcher | T18 (after T16c, T17, T19c) |
| `src/security/audit.ts` | `audit()` API | T11a (frozen after) |
| `src/security/audit.ts` | `AuditQueue` | T11b |

### G.10 Open Questions closure status

| OQ | Resolved | Resolution |
|---|---|---|
| 1. OpenAPI generation | YES (§C.13) | Hand-write from per-endpoint zod schemas |
| 2. CLI framework | YES (§C.13) | Monolithic; argv switch (no yargs/commander Phase 2) |
| 3. Geo lookup | YES (§C.13) | Optional `maxmind-db-lite` dep; null fallback |
| 4. /auth/login multi-provider | YES (§C.13) | Hardcoded GitHub Phase 2 |

---

## Section H — Updated implementation timeline

Per R1 implementation-order agent. Realistic: 6.5-7 weeks parallel, 7.5-8 solo.

```
Week 1 (foundation 1):
  T00, T01a, T02, T07, T08, T10, T13, T14.5 (oauth-handlers split)
  [8 tasks; mostly parallel-safe]

Week 2 (foundation 2):
  T01b, T03, T04, T05, T06, T08b, T08c, T09, T11a, T11b, T12, T14, T44
  [13 tasks; many parallel-safe after T01a/T02/T10 land]

Week 3 (simple endpoints + cross-cutting):
  T15, T17, T22 (folded), T27, T36, T37, T38
  [7 tasks; T27 pulled forward per R1 sequencing finding]

Week 4 (complex endpoints):
  T16a → T16b → T16c (sequential same file), T18, T19a → T19b → T19c (sequential), T20, T21, T23, T24, T16helpers
  [11 tasks; merge serialization on oauth-callback.ts mitigated by T14.5 file split]

Week 5 (integration + ops):
  T25, T28, T29, T30 (folded), T40 (SDK), T41 (init wizard), T42 (doctor)
  [4 core + 3 DX/CLI; T40/T41/T42 parallel-safe]

Week 6 (test foundations):
  T31, T32, T43 (Phase 1 backcompat suite)
  [3 large test tasks]

Week 7 (chaos + docs):
  T33, T34, T35a, T35b, T35c, T35d, T39 (Playwright)
  [7 tasks; mostly parallel]
```

Total: **~52 atomic units** across 7 weeks. Solo dev pace: 8 weeks. Compressed timeline assumes 4-subagent parallelism + serialized human review.

---

## Section F — Status

V2 patches finalize plan. Total brainstorm + design + plan reviewers: **86** (24 R1 spec + 20 R2 spec + 20 R3 spec + 22 R1 plan = 86).

**No further planned review rounds.** Each implementation PR will get individual code-review attention which substitutes for additional plan rounds.

Next action: **start T01a (schema migration + version bump)**.

Rationale (per contrarian R1 + implementation order R1):
- T01a is the most stable + best-specified task
- Blocks 8+ downstream tasks; landing it unblocks parallel work
- Migration code is testable in isolation (no IdP, no HTTP, no auth)
- A working migration validates the cross-cutting schema decisions across V2/V3/V4/V2-patches

Per Phase 1 process: subagent-driven-development executes task-by-task with checkpoint reviews. Each task's checkbox is the gate.
