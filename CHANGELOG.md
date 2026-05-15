# Changelog

## [0.9.2](https://github.com/swoofer/mcp-coordinator/compare/v0.9.1...v0.9.2) (2026-05-15)

Operations release. New `mcp-coordinator rotate-jwt-secret` CLI
helper + auto-rotation runbook close the manual gap noted in v0.8.1's
key-rotation procedure. No code paths in the hot request path changed;
existing deployments continue running unchanged.

### Features

* **cli:** `mcp-coordinator rotate-jwt-secret` generates a fresh
  base64 secret with crypto.randomBytes (default 256 bits, 128
  minimum), validates entropy against the boot-time floor, and prints
  the operator rotation workflow. Three output formats: `env`
  (default, copy-pasteable block + workflow comments), `json`
  (machine-readable for cron pipelines), `secret-only` (raw secret
  only). Stateless -- never reads the current secret, never writes to
  any secrets manager, never restarts a coordinator instance. (T52)

### Documentation

* **docs/ops/auto-rotation.md:** new operator runbook covering
  systemd-timer + Vault automation and Kubernetes CronJob automation
  around the `rotate-jwt-secret` helper. Explicit out-of-scope notes
  for service-token rotation (admin-driven by design) and IdP client
  secrets (rotate through the IdP's own admin UI).

### Test posture

* **+14 tests** vs v0.9.1 (1669 total): plan determinism with
  injected clock + RNG, base64 length invariants, entropy floor
  rejection at boundary, broken-RNG rejection, CLI exit codes for
  invalid args, all three output formats parseable.

## [0.9.1](https://github.com/swoofer/mcp-coordinator/compare/v0.9.0...v0.9.1) (2026-05-15)

Audit log tamper-evidence release. Adds a SHA-256 hash chain over every
`audit_log` row and an operator script to verify it. SOC 2 Type II
deployments now have built-in in-place-tamper detection, with a
documented external tip-attestation workflow for full deletion +
timestamp coverage. Single-instance, single-IdP behaviour is
unchanged.

### Features

* **audit:** SHA-256 hash chain on every `audit_log` row -- new
  `prev_hash` + `row_hash` columns; `row_hash = SHA-256(prev_hash ||
  canonicalRowFields(row))`. Tier 1 sync, Tier 2 batched, and the
  shutdown `audit_loss` row all chain inside the same SQLite
  transaction as the tip lookup. Canonical serialization is JSON with
  alphabetical keys + explicit nulls -- ambiguity between "absent"
  and "explicitly null" is impossible. `GENESIS_HASH` (`"0".repeat(64)`)
  seeds the chain on an empty table. Migration backfills pre-existing
  rows in id-order; idempotent + crash-safe. (T50)
* **scripts/verify-audit-chain.ts:** operator CLI that walks the chain
  and reports `wrong_row_hash` / `wrong_prev_hash` / `missing_hash` /
  `id_gap_before` findings. Robust to front-deletion (legitimate
  sweeper retention); accepts the first observed row's `prev_hash` as
  the entry point. JSON output for monitoring; exit 0 OK, 1 findings,
  2 operational error. (T51)

### Documentation

* **docs/ops/audit-integrity.md:** new SOC 2 Type II runbook -- what
  the chain proves (in-place tamper detection + middle-row insertion
  detection), what it doesn't (timestamp integrity, deletion
  detection without external tip-attestation), how to run the
  verifier, the tip-attestation workflow, monitoring integration,
  incident recovery.
* **docs/security/threat-model.md:** new residual risk #10 records
  the tamper-evidence feature with explicit `created_at` + deletion
  gaps. Review cadence updated to v0.10.

### Limitations (intentional, documented)

* `created_at` is set by SQLite default and is NOT in the hash --
  timestamp rewrites are not detected by the chain alone.
* Deletion of recent rows is indistinguishable from legitimate
  sweeper retention without the external tip-attestation workflow.
* The backfill assumes pre-migration rows are pristine; this is
  forward evidence only.

### Test posture

* **+32 tests** vs v0.9.0 (1655 total): 12 chain-pure unit tests
  (canonical serialization determinism, hash chain construction,
  per-field tamper detection), 10 end-to-end integration tests (Tier
  1, Tier 2 batched, interleaved 1/2, backfill idempotence +
  crash-recovery, in-place tamper), 10 verifier-script tests (valid
  chain, content tamper, prev_hash forgery, missing hash, front vs
  middle deletion, bad args, missing DB, human + JSON output).

## [0.9.0](https://github.com/swoofer/mcp-coordinator/compare/v0.8.1...v0.9.0) (2026-05-15)

Multi-IdP release. The single-provider GitHub-only login surface that shipped
in Phase 2 opens up to GitHub + Google + generic OIDC, selected via a picker
UI when more than one provider is registered. Phase 2 deployments that stay
on GitHub-only see no behavioural change.

### Features

* **auth/providers/registry:** `ProviderRegistry` class -- per-server registry
  instance attached to `AuthHandlerContext.providers`. First registration
  becomes the implicit default; `setDefault()`, `has()`, `list()`, `names()`,
  `size()`, and `clear()` complete the API. Replaces the Phase 1 module-level
  `Map` skeleton. (T45)
* **auth/handlers:** every OAuth handler resolves the IdP through the registry
  (`oauth-login`: `getDefault()`; `oauth-callback`: `get(row.provider)`;
  `oauth-token`: `get(body.provider ?? default)`; `refresh-rotation`:
  `get(users.idp_provider)`). The legacy `ctx.githubProvider` alias is removed.
  Mix-up defense audit `auth.state.mixup` now records `registered_providers`
  instead of a hardcoded `expected_provider`. (T46)
* **auth/providers/google:** first-class `GoogleProvider`. id_token signature
  is mandatory: jose `createRemoteJWKSet` + RS256 + `iss=https://accounts.google.com`
  + `aud=client_id`. Identity claims read from the verified id_token (no
  extra `/userinfo` round-trip). Workspace `hd` claim surfaces as
  `idp_org_id`. Opt-in via `COORDINATOR_GOOGLE_CLIENT_ID` +
  `COORDINATOR_GOOGLE_CLIENT_SECRET` (both required or neither). (T47)
* **auth/providers/oidc:** generic `OIDCProvider` for Okta / Auth0 /
  Azure AD / Keycloak / Authentik. Auto-discovers `authorization_endpoint`,
  `token_endpoint`, and `jwks_uri` from
  `<issuer>/.well-known/openid-configuration`. id_token verified with the
  configured issuer, client_id audience, RS256. Discovery doc's own
  `issuer` field is cross-checked against config (catches redirect attacks
  on the discovery URL). Email-claim fallback chain: `email` →
  `preferred_username` → `sub`. Opt-in via `COORDINATOR_OIDC_ISSUER_URL` +
  `COORDINATOR_OIDC_CLIENT_ID` + `COORDINATOR_OIDC_CLIENT_SECRET`. (T48)
* **auth/login:** picker UI on GET `/auth/login` when `providers.size() > 1`.
  Each button is a top-level GET to `/auth/login?provider=<name>`; the
  flow itself is unchanged. Friendly built-in labels for `github` / `google`
  / `oidc`; title-cased fallback for custom provider names. Unknown
  `?provider=X` returns 400 `UNKNOWN_PROVIDER` -- no silent fallback. (T49)

### Bug Fixes

* **auth/refresh-rotation:** the IdP-membership recheck now uses the user's
  stored `idp_provider` column rather than assuming GitHub, so multi-provider
  users get their allowlist re-evaluated against the IdP they actually signed
  in with.

### Configuration

* **env:** `.env.example` updated -- the previously "Phase 4 preview" section
  for Google + OIDC is now live with usage notes.

### Test posture

* **+61 tests** vs v0.8.1 (1623 total): 10 ProviderRegistry, 16 GoogleProvider
  (id_token verification, JWKS rotation, cross-tenant rejection, transport
  failures), 21 OIDCProvider (discovery validation, issuer mismatch, expired
  tokens), 8 login-picker (rendering + escaping), 6 picker integration
  (oauth-login behavior with 1 vs N providers), boot wiring for both new
  IdPs.

### BREAKING CHANGES

* **AuthHandlerContext.githubProvider** removed -- handlers resolve the IdP
  via `ctx.providers` now. Downstream consumers that embed the coordinator
  and constructed contexts by hand must update; the test helper
  `singleProviderRegistry(provider)` in `tests/helpers/` shows the pattern.
* **IdPProvider.buildAuthUrl** return type widened from `string` to
  `string | Promise<string>`. Built-in providers stay synchronous; only
  `OIDCProvider` is async (lazy discovery on first call). Handlers
  `await` the result. Custom provider implementations stay source-compatible.
* **provisionUser** signature gained a required `providerName: string`
  parameter as the 6th argument. Internal helper; only relevant if you
  call it from custom code.
* **auth.state.mixup audit:** `{ observed_provider, expected_provider: "github" }`
  → `{ observed_provider, registered_providers: string[] }`. Log-pipeline
  consumers that parsed `expected_provider` need to update.

## [0.8.1](https://github.com/swoofer/mcp-coordinator/compare/v0.8.0...v0.8.1) (2026-05-15)

Patches + extended test coverage + SDK enhancements + documentation. No new public API beyond v0.8.0; closes gaps that were honestly flagged in v0.8.0's docs.

### Features

* **auth:** JWT key rotation overlap via `COORDINATOR_JWT_SECRET_PREV` + `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT`. New kid `"hs256-v0"` verifies old tokens during the overlap window; `"hs256-v1"` signs new tokens. Tier 1 audit `config.key_rotation` emitted at boot when prev is configured. Closes the caveat in `docs/ops/key-rotation.md`.
* **auth/providers/github:** GHES env vars `COORDINATOR_GITHUB_AUTH_BASE_URL` + `COORDINATOR_GITHUB_API_BASE_URL` now flow through `bootPhase2` to `GitHubProvider`. Both optional; unset = github.com defaults. Closes the caveat in `examples/ghes-config/README.md`.
* **sdk:** `FileTokenStore` persists tokens to `~/.mcp-coordinator/tokens.json` with `chmod 0600` (POSIX) + atomic write-rename. `MemoryTokenStore` for ephemeral use cases.
* **sdk:** `ProactiveRefresh` schedules refresh at `accessExpiresAt - 120s ± 30s jitter`, preventing thundering-herd when many CLI instances share a vendored tokens.json.
* **sdk:** Single-flight refresh lock via atomic O_EXCL file lock + stale-lock recovery (30s mtime threshold) for multi-process CLI safety.
* **sdk:** `McpCoordinatorClient` accepts optional `store` + `refreshStrategy` + `refreshLockPath`. `dispose()` cancels the timer on app shutdown.

### Tests

* **tests/e2e/:** Playwright E2E suite covering full browser OAuth + device flow + refresh-on-401 (5 scenarios, ~12s, zero flakes over 5 runs). Uses v0.8.1-P2's GHES env wiring to point GitHubProvider at a local mock-github HTTP server (no fetch monkey-patching).
* **tests/integration/d1-d10-matrix.test.ts:** 10 cross-cutting scenarios (20 cases) exercising component-interaction seams where Phase 2 bugs are most likely. Covers V3 §B-NEW-2 chain revocation, V4 FIX 7 grace-branch allowlist re-check, V4 FIX 18 device-poll CAS, V4 FIX 23 commit-then-audit, V4 FIX 24 idle-first ordering.
* **tests/perf/:** 3 benches + 2 chaos scripts (refresh rotation: p50 0.8ms / p99 15ms / 841 ops/s ; token-epoch: p50 8µs / 98k ops/s ; audit queue: 0 drops at 20K burst, exact 5000-drop accounting at 15K overflow ; IdP 50% failure: stale-on-error keeps 0 hard failures). NOT wired into CI — operator-only tooling. See `docs/ops/perf-bench.md`.

### Documentation

* **README.md:** "What's New in v0.8.0 (Phase 2 OAuth)" section + Phase 2 quick-start under Authentication + SDK subsection + Roadmap rewrite + top-nav anchors. README went from 962 → 1132 lines (+192 / -11 net).
* **docs/ops/key-rotation.md:** "planned v0.8.x patch" caveat removed; procedure documented end-to-end with the now-working `_PREV` env var.
* **docs/security/threat-model.md:** residual risk #6 marked "addressed in v0.8.1".
* **examples/ghes-config/README.md:** caveat removed; example ships as-is for GHES deployments.
* **docs/onboarding-self-host.md:** new GHES subsection pointing to `examples/ghes-config/`.
* **docs/ops/perf-bench.md:** new operator runbook for perf + chaos scripts.
* **.env.example:** 4 new optional env vars documented (2 for key rotation, 2 for GHES).

### Configuration

New optional environment variables:

* `COORDINATOR_JWT_SECRET_PREV` — previous JWT secret during rotation overlap; verify-only.
* `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT` — optional ISO timestamp for `config.key_rotation` audit correlation.
* `COORDINATOR_GITHUB_AUTH_BASE_URL` — GHES authorize/token endpoint (e.g., `https://github.example.com`). Unset = `https://github.com`.
* `COORDINATOR_GITHUB_API_BASE_URL` — GHES API endpoint (e.g., `https://github.example.com/api/v3`). Unset = `https://api.github.com`.

### Test posture

1555 individual tests passing across 116 vitest files + 5 Playwright E2E scenarios + 46 SDK tests + 5 standalone perf/chaos scripts. 100% branch coverage enforced on every security-critical module. 6 pre-existing Windows EBUSY teardown flakes ignored per project convention.

## [0.8.0](https://github.com/swoofer/mcp-coordinator/compare/v0.7.0...v0.8.0) (2026-05-14)

Phase 2 of the auth roadmap: OAuth 2.1 + RFC 8628 device flow + cookie sessions + service tokens + audit pipeline + sweeper. Feature-flagged behind `COORDINATOR_OAUTH_ENABLED=true` (default false). Phase 1 deployments are byte-identical when the flag is unset.

37 of 52 plan tasks shipped (Phase A foundation + B helpers + C endpoints + D integration). Phase E (extended test suites + SDK + docs) deferred. Spec, decisions, and plan docs live under `docs/superpowers/specs/` and `docs/superpowers/plans/` for traceability; every commit message cites the spec § or FIX number it implements.

### ⚠ BREAKING CHANGES

* **auth/providers:** `IdPProvider.exchangeCode` return type changed from `Promise<IdpUserInfo>` to `Promise<ExchangeCodeResult>` (`{ user, accessToken }`). External provider implementations need updating. Phase 1 shipped with an empty registry, so no in-tree consumers break. (V4 FIX 25)
* **db:** `audit_log` columns renamed: `user_id → actor_user_id`, `org_id → actor_org_id`, `ip → actor_ip`, `user_agent → actor_user_agent`, `metadata → metadata_json`. Phase 1 `auditLog()` helper continues to work via in-helper translation; direct SQL consumers need updating. (V4 FIX 1)
* **db:** `users.org_id` renamed to `users.primary_org_id`. The `users_legacy_v0_7` compat view exposes the old name as `org_id` for read-only consumers; `lint-no-users-org-id.sh` enforces the migration in app code.

### Features

#### OAuth 2.1 + Device Flow (RFC 6749 + RFC 8628)

* **auth/oauth:** `GET /auth/login` — initiates OAuth flow with PKCE S256 + HMAC-bound state cookie per V4 FIX 19 ([T15](https://github.com/swoofer/mcp-coordinator/commit/062e312))
* **auth/oauth:** `GET /api/auth/oauth/callback` — state CAS + mix-up defense + IdP exchange + provisioning TX + JWT mint + cookie emission + 302 to `/auth/success` ([T16a](https://github.com/swoofer/mcp-coordinator/commit/6b23c46) + [T16b](https://github.com/swoofer/mcp-coordinator/commit/7e9132b) + [T16c](https://github.com/swoofer/mcp-coordinator/commit/b1cce31))
* **auth/oauth:** `POST /api/auth/oauth/token` — unified grant dispatcher (authorization_code + refresh_token + device_code) with RFC 6749 §5.2 envelope ([T18](https://github.com/swoofer/mcp-coordinator/commit/eebfbe2))
* **auth/oauth:** `POST /api/auth/oauth/device_authorization` — RFC 8628 §3.1 device init with collision retry + per-IP rate limit ([T17](https://github.com/swoofer/mcp-coordinator/commit/6056585))
* **auth/oauth:** GET pages `/auth/device`, `/auth/device/confirm`, `/auth/success` with CSP-locked HTML + per-user_code CSRF ([T21](https://github.com/swoofer/mcp-coordinator/commit/a3f58ce))
* **auth/oauth:** `POST /auth/device/approve` with CSRF + V4 FIX 21 brute-force lockout ([T20](https://github.com/swoofer/mcp-coordinator/commit/93b3d87))
* **auth/oauth:** `/.well-known/oauth-authorization-server` RFC 8414 discovery doc ([T14](https://github.com/swoofer/mcp-coordinator/commit/ef64850))
* **auth/providers:** concrete `GitHubProvider` implementing IdPProvider — buildAuthUrl + exchangeCode + listMemberships + requestDeviceCode + pollDeviceToken; AbortController 5s timeout + 1 retry on 5xx ([T05](https://github.com/swoofer/mcp-coordinator/commit/6b1d5f7))

#### Refresh-token rotation (V3 §B-NEW-2 stolen-token detection)

* **auth/refresh:** rotation happy path with HS256-pinned kid-allowlisted JWT verify + atomic UPDATE WHERE revoked_at IS NULL (V4 FIX 5) ([T19a](https://github.com/swoofer/mcp-coordinator/commit/827556f))
* **auth/refresh:** reuse detection with 10s grace window + fingerprint binding + replay_count threshold 3 + family revoke (V3 §B-NEW-2) ([T19b](https://github.com/swoofer/mcp-coordinator/commit/620a3c6))
* **auth/refresh:** idle timeout + IdP membership refresh + allowlist re-check (V4 FIX 7) + IdPTokenRevoked → 401 + service-token rejection ([T19c](https://github.com/swoofer/mcp-coordinator/commit/ddda48f))

#### Service tokens (V4 §5.5)

* **auth/service-tokens:** issuance with 90d hardcoded TTL ceiling + ≥10-char reason + admin-only POST endpoint + CLI verb `mcp-coordinator service-token issue` ([T25](https://github.com/swoofer/mcp-coordinator/commit/c518449))
* **auth/service-tokens:** DB-lookup verification override for `service_account=true` JWTs (overrides §9.5 trust-signature; admin force-revoke wins immediately)

#### Cookie sessions (Scenario 5)

* **auth:** `authenticateRequest` extended with Scenario 5 — `__Host-coordinator_session` cookie auth via jose v6, HS256-pinned + kid-allowlisted + token_epoch check ([T27](https://github.com/swoofer/mcp-coordinator/commit/68f2d04))
* **auth:** `POST /api/auth/logout` (local), `/logout-all` (token_epoch bump invalidates all sessions instantly), `/revoke` (RFC 7009 §2.2 anti-enumeration) ([T23](https://github.com/swoofer/mcp-coordinator/commit/068ee3e))
* **auth:** `GET /api/auth/me` userinfo helper with 600/min rate limit ([T24](https://github.com/swoofer/mcp-coordinator/commit/dce5141))

#### Audit infrastructure (V3 NR13 two-tier durability)

* **security/audit:** `audit(action, options)` with optional `tier: 1 | 2` (default 2). Tier 1 = synchronous direct INSERT; Tier 2 = bounded queue (10K cap, 50-row / 100ms batch). 35 audit events catalogued per spec §11.2 ([T11a](https://github.com/swoofer/mcp-coordinator/commit/78b6798) + [T11b](https://github.com/swoofer/mcp-coordinator/commit/c9036b9))
* **auth/audit-context:** `withAuditContext(actor, request, fn)` AsyncLocalStorage propagation — audit() auto-reads actor + request without explicit threading ([T11a](https://github.com/swoofer/mcp-coordinator/commit/78b6798))
* **auth/request-id:** `withRequestId` ALS for cross-async-chain request_id propagation; inbound `X-Request-Id` honored when matching `/^[A-Za-z0-9._:-]{1,128}$/` ([T10](https://github.com/swoofer/mcp-coordinator/commit/2608a18))

#### Crypto foundation

* **auth/crypto:** HKDF-SHA256 domain-separated key derivation; mintAccessJWT + mintRefreshJWT (jose v6, HS256 pinned, kid header); PKCE S256 per RFC 7636 §4.2; entropy validation rejecting all-same-byte + dictionary words + low-Shannon secrets ([T08b](https://github.com/swoofer/mcp-coordinator/commit/c4b5609))
* **auth/csrf:** random double-submit token + length pre-check + `crypto.timingSafeEqual`; HMAC binding cut per V4 CUT 2 (SameSite=Strict + `__Host-` + CSP carry the defense) ([T08](https://github.com/swoofer/mcp-coordinator/commit/57741a1))
* **auth/cookies:** `__Host-` prefix helpers with Secure + Path=/ + no Domain enforcement; array Set-Cookie append for Node http ([T07](https://github.com/swoofer/mcp-coordinator/commit/67da436))

#### Operational

* **sweeper:** background sweeper deleting expired/revoked rows across 6 tables (oauth_state, device_auth_requests, refresh_tokens × 2 retention buckets, audit_log Tier 1/Tier 2). 60s cadence, adaptive chained passes (max 3), circuit breaker after 5 consecutive errors ([T28](https://github.com/swoofer/mcp-coordinator/commit/f1e5523))
* **boot:** `bootPhase2(opts)` validates env, derives keys via HKDF, performs NR12 restore detection (refuses to start if audit_log timestamps lag wall-clock >5min unless `COORDINATOR_ALLOW_RESTORE=true` → token_epoch global bump), composes ServerContext, starts sweeper, wires SIGTERM drain. Phase 1 deployments bypass entirely when `COORDINATOR_OAUTH_ENABLED` is unset. ([T29](https://github.com/swoofer/mcp-coordinator/commit/85f116d))
* **auth/rate-limit:** in-memory token-bucket per (endpoint, identifier) per V4 NR11 table; login-lockout with purpose-keyed SHA-256 identifier hashing ([T12](https://github.com/swoofer/mcp-coordinator/commit/4eea591))
* **auth/membership-cache:** LRU 10K with 60s positive TTL + 10min stale-on-error for IdP transient failures (V3 §B-NEW-5) ([T04](https://github.com/swoofer/mcp-coordinator/commit/8ac74f9))
* **auth/oauth-state:** PKCE state table CRUD with atomic CAS via UPDATE ... RETURNING (V3 §B-NEW-12 #15) ([T06](https://github.com/swoofer/mcp-coordinator/commit/0b14635))
* **auth/token-epoch:** direct DB read per request (no cache per V4 CUT 1); monotonic `MAX(now, current+1)` bump for NTP-rollback safety per V4 FIX 20 ([T03](https://github.com/swoofer/mcp-coordinator/commit/08b779f))
* **auth/allowlist:** `resolveOrgFromMemberships(db, lowercase_memberships)` with deterministic alphabetical tie-break per V4 FIX 22 ([T09](https://github.com/swoofer/mcp-coordinator/commit/58f7134))

#### Observability + HTTP infrastructure

* **observability/metrics:** Phase 2 prom-client registry — 29 metrics across auth activity, refresh chain, device flow, service tokens, IdP, audit queue, sweeper, rate limit, request duration histogram. `/metrics/auth` endpoint with localhost-only default + optional Bearer ([T37](https://github.com/swoofer/mcp-coordinator/commit/3e46720))
* **observability/logger:** Pino with 16 redact paths from V4 §11.3 ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))
* **http/response-contract:** `bearerAuthHeader` per RFC 6750 §3, `oauthError` per RFC 6749 §5.2, `appError` envelope with auto-injected `request_id` from T10 ALS ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))
* **http/health:** `/healthz` liveness + `/health/ready` readiness — 503 when sweeper circuit-open OR audit queue depth > 80% OR DB unreachable OR draining ([T36](https://github.com/swoofer/mcp-coordinator/commit/263354a))

#### Schema migration

* **db:** v7 → v8 migration with column renames per V4 FIX 1, `users.primary_org_id` rename, `user_orgs` join table for Phase 5 readiness, `oauth_state` table, refresh_tokens fingerprint + family_id + replay_count + parent_jti, device_auth_requests forensics columns + `denied_at`/`denied_reason`/`last_polled_at`/`interval`/`approved_at`/`failed_approval_attempts`, `system_state` table, `users_legacy_v0_7` compat view (3742a68 + 9dd6043 + 93b3d87 follow-ups)

### Bug Fixes (security)

* **auth/providers/github:** validate `Link: rel="next"` URL origin matches `apiBaseUrl` before following — prevents cross-origin SSRF leaking the GitHub OAuth Bearer token to attacker-controlled hosts ([T05 followup](https://github.com/swoofer/mcp-coordinator/commit/467db43))
* **auth/oauth-callback:** hash `idp_user_id` in audit metadata via new purpose-keyed `hashIdpUserId(s)` instead of storing PII raw (consistent with the codebase's identifier_hash discipline) ([T16b followup](https://github.com/swoofer/mcp-coordinator/commit/f3ce4bb))
* **auth/jwt-mint:** pin BOTH `iat` and `exp` numerically when `iatOverride` is set — jose's `setExpirationTime("Xs")` resolves against wall time, breaking deterministic re-mint within the 10s grace window otherwise ([T19b](https://github.com/swoofer/mcp-coordinator/commit/620a3c6))

### Tests

* 1444 individual tests pass (1300 new in this release + 144 from Phase 1). 6 pre-existing Windows EBUSY file-handle teardown flakes ignored per project convention.
* **Per-file 100% branch coverage enforced** via vitest thresholds on every security-critical module (csrf, token-epoch, oauth-state, jwt-mint, membership-cache, refresh-rotation, service-tokens, plus most Phase 2 helpers).
* **Phase 1 backcompat suite** under `tests/backcompat/` — 31 cases proving the upgrade path is non-destructive and Phase 2 wiring is opt-in only ([T43](https://github.com/swoofer/mcp-coordinator/commit/1b5f92b))
* **Cross-tenant isolation suite** under `tests/integration/` — 22 cases proving org-scoped data cannot leak across tenant boundaries via any Phase 2 endpoint ([T31](https://github.com/swoofer/mcp-coordinator/commit/7ac9ba6))
* **CI lint scripts** under `scripts/` — 5 grep-based bash lints catching: `users.org_id` references, `CURRENT_TIMESTAMP` in Phase 2 columns, `UPDATE/DELETE audit_log` outside sweeper, unescaped `${...}` in HTML pages, direct `process.env.COORDINATOR_*` reads in auth/cli/admin (everything must go through T44 `getOrgSetting`) ([T01b](https://github.com/swoofer/mcp-coordinator/commit/d1c9a79) + [T44](https://github.com/swoofer/mcp-coordinator/commit/e05cade))

### Deprecated

* `auditLog(ev)` (Phase 1 helper) — superseded by `audit(action, options)` with explicit tier routing. The Phase 1 helper continues to work for backward compat; new callers use `audit()`.

### Configuration

New environment variables (required when `COORDINATOR_OAUTH_ENABLED=true`):

* `COORDINATOR_OAUTH_ENABLED` — `true` to activate Phase 2 (default `false`)
* `COORDINATOR_JWT_SECRET` — ≥32 bytes; entropy-validated at boot
* `COORDINATOR_GITHUB_CLIENT_ID` / `COORDINATOR_GITHUB_CLIENT_SECRET`
* `COORDINATOR_GITHUB_ORG` — seeds the bootstrap `orgs.allowlist_github_org` row
* `COORDINATOR_PUBLIC_URL` — must be `http://` or `https://`; `http://` non-localhost requires `COORDINATOR_INSECURE_COOKIES=true` override

Optional environment variables (all routed through T44 `getOrgSetting` so Phase 5 can override per-org via the `orgs` table):

* `COORDINATOR_JWT_ACCESS_TTL` (default `15m`, max `60m`)
* `COORDINATOR_JWT_REFRESH_TTL` (default `30d`, max `90d`)
* `COORDINATOR_SESSION_IDLE_TIMEOUT` (unset = no idle check; `15m` recommended for regulated)
* `COORDINATOR_AUTO_PROVISION` (`true`|`false`, default `true`)
* `COORDINATOR_LOGIN_LOCKOUT_THRESHOLD` (default 5), `_WINDOW` (default 15m), `_DURATION` (default 15m)
* `COORDINATOR_REFRESH_RETENTION_DAYS` (default 180)
* `COORDINATOR_AUDIT_RETENTION_DAYS` (default 365) — Tier 1
* `COORDINATOR_AUDIT_TIER2_RETENTION_DAYS` (default 90)
* `COORDINATOR_ALLOW_RESTORE` (boot-only override after a DB restore; unset after boot per NR12)
* `COORDINATOR_INSECURE_COOKIES` (`true` required for `http://` non-localhost; not for production)
* `COORDINATOR_METRICS_BEARER` (optional Bearer token for `/metrics/auth` from non-loopback IPs)

### Migration notes (v0.7.0 → v0.8.0)

1. **Phase 1 deployments** (most existing installs): no action required. Leave `COORDINATOR_OAUTH_ENABLED` unset. The schema migration runs automatically on first start; existing data is preserved with column renames + backfills (token_epoch=0, family_id=random, outcome='legacy_unknown'). Phase 1 behavior is byte-identical.
2. **Enabling Phase 2**: set the 5 required env vars above, set `COORDINATOR_OAUTH_ENABLED=true`, restart. The bootstrap flow assigns admin role to the first user who signs in via OAuth (atomic — concurrent first-time logins resolve to exactly one admin).
3. **Custom IdPProvider implementations**: update `exchangeCode` return type from `Promise<IdpUserInfo>` to `Promise<ExchangeCodeResult>` (`{ user, accessToken }`).
4. **Direct audit_log SQL consumers**: update column names per V4 FIX 1.
5. **Direct users.org_id SQL consumers**: read from `users_legacy_v0_7` view, OR update to `users.primary_org_id`.

### Deferred (planned for v0.8.x or v0.9.0)

* Reference SDK (`@mcp-coordinator/sdk-js`) — T40
* `mcp-coordinator init` interactive wizard — T41
* `mcp-coordinator doctor` Phase 2 probes — T42
* Playwright E2E suite — T39
* OpenAPI spec generated from zod schemas — T34
* Grafana dashboard JSON + Prometheus alert YAML — T37b
* Security/compliance/operations runbook docs — T35a/b/c
* `service-token list` and `revoke` CLI subcommands (currently stubbed with SQL workarounds)
* Perf bench + chaos suite — T33

## [0.7.0](https://github.com/swoofer/mcp-coordinator/compare/v0.6.1...v0.7.0) (2026-05-13)


### Features

* **auth:** add IdPProvider interface + empty registry (Phase 2 hangs OAuth) ([f8b6548](https://github.com/swoofer/mcp-coordinator/commit/f8b65487a86208a62388645b51b41f7561488c68))
* **auth:** emit WWW-Authenticate header on 401 per RFC 6750 ([46c45ab](https://github.com/swoofer/mcp-coordinator/commit/46c45ab53e27beb7293c23482ad61fc58e085fd5))
* **auth:** extend AuthClaims with user_id, org, jti and add member role ([6a2bd70](https://github.com/swoofer/mcp-coordinator/commit/6a2bd70ba07cd088fd63e4b1681d23051ba9d525))
* **auth:** four-scenario backward-compat for AUTH_ENABLED toggle ([577cae0](https://github.com/swoofer/mcp-coordinator/commit/577cae0bebb51b1798b12014c469f7397ddfdd10))
* **auth:** support COORDINATOR_JWT_PREV_SECRET for zero-downtime rotation ([4c3387f](https://github.com/swoofer/mcp-coordinator/commit/4c3387fc8b1e51128b2cfc13ee40c55f6d854177))
* **db:** add orgs table + seed default org ([9b634b7](https://github.com/swoofer/mcp-coordinator/commit/9b634b7451161d02470aadf8ccaa31428ad297a8))
* **db:** add refresh_tokens, device_auth_requests, audit_log tables ([1d21384](https://github.com/swoofer/mcp-coordinator/commit/1d2138420666e9b4a493793aceaac0f2f8f7b891))
* **db:** add users table + UNIQUE(idp_provider,idp_user_id) + org index ([93d34e7](https://github.com/swoofer/mcp-coordinator/commit/93d34e7c802a1332d923d64ffb6a5021d55c0c14))
* **db:** ALTER 14 tables for org_id + events(org_id,id) index + PRAGMA bump ([a992411](https://github.com/swoofer/mcp-coordinator/commit/a992411f19f6dfdc86fb0bb3a4d296c3de5e6062))
* **db:** chmod coordinator.db to 0600 on init (POSIX) ([949575a](https://github.com/swoofer/mcp-coordinator/commit/949575a5b2afefc1898e483ca2e54b76834a4250))
* **db:** migrate cross-org-collision tables to composite PK (org_id, ...) ([e709296](https://github.com/swoofer/mcp-coordinator/commit/e709296ffacdb9454551821b0a0117d88d786c29))
* **health:** /healthz reports auth_enabled and jwt_secret_set with warnings ([fc2e1da](https://github.com/swoofer/mcp-coordinator/commit/fc2e1da29c95044208c341d54aaa5054f432ee5c))
* **http:** thread AuthClaims through RestContext into REST handlers ([bf38050](https://github.com/swoofer/mcp-coordinator/commit/bf38050eae2cc580aabf5c68c743495822ce563e))
* **mcp:** per-session claims map; tool handlers scope by claims.org via getter ([6141b78](https://github.com/swoofer/mcp-coordinator/commit/6141b78758fb1086cb96ddeb57196a920e594a00))
* **mcp:** verify JWT on every MCP request (new + existing sessions) ([2b94bc8](https://github.com/swoofer/mcp-coordinator/commit/2b94bc8f8629918da1e42344d7bbe3ad0b8cbd45))
* **mqtt:** scope subscribe/publish/LWT to coordinator/&lt;org_id&gt;/ prefix ([d48752c](https://github.com/swoofer/mcp-coordinator/commit/d48752c808b1f0eb9d3bdff3306d9c0c212a9ea8))
* **security:** add auditLog helper for audit_log table ([0947397](https://github.com/swoofer/mcp-coordinator/commit/09473974e2c656cce915f1bc1101db52a7042585))
* **security:** add EncryptionProvider interface + Passthrough default ([56ad863](https://github.com/swoofer/mcp-coordinator/commit/56ad863194a31b0fda0e0be693f850bdcb83c492))
* **sse:** authenticate /api/events handler and scope listener by claims.org ([5a47d5b](https://github.com/swoofer/mcp-coordinator/commit/5a47d5b74c62fbe6841c8b561994d5e16a21d04b))
* **sse:** scope listeners + events by org_id ([7555cf7](https://github.com/swoofer/mcp-coordinator/commit/7555cf7d9eb8972cc92069f36bb9049dd038dd3f))
* v0.7.0 Phase 1 auth foundation (multi-tenant, JWT hardening, org scoping) ([e36c3bb](https://github.com/swoofer/mcp-coordinator/commit/e36c3bb19f098b1706c3f73dc6ff866607f25d21))


### Bug Fixes

* **agent-activity:** scope getActivity/listAll by org_id (plan line 3378) ([49d239c](https://github.com/swoofer/mcp-coordinator/commit/49d239c27b5a7130d25352153d740f43d7675c21))
* **auth:** add WWW-Authenticate to /api/auth/refresh 401 responses ([d642410](https://github.com/swoofer/mcp-coordinator/commit/d642410cfe258d65bed20b683142b9c06e269d4d))
* **auth:** make refreshToken options required (no silent bypass) ([29a51da](https://github.com/swoofer/mcp-coordinator/commit/29a51daf837a3fac7144117c730ff858fd6d5829))
* **auth:** pin HS256 in refreshToken grace-period jwtVerify (defense-in-depth) ([6e609fe](https://github.com/swoofer/mcp-coordinator/commit/6e609fe6fa0f7139cdb00999b5fadecaec2ecff4))
* **db:** restore agent_activity_status FK to agents(id) lost in 5.5 migration ([adbad6d](https://github.com/swoofer/mcp-coordinator/commit/adbad6d31bbd094042aa64bd552323cbc82fa8a1))
* **dependency-map:** scope getMap/setMap/getModuleInfo/getBlastRadius by org_id ([bc32a5a](https://github.com/swoofer/mcp-coordinator/commit/bc32a5ac5885bd70a7a7ecd83b67df077a8dac20))
* **health:** restore /health status alive + uptime_seconds (regression) ([299c10f](https://github.com/swoofer/mcp-coordinator/commit/299c10f330c08050c712b321221a6a8c60f184f7))
* **mqtt:** move consultations + broadcast subscribes inside on(connect) ([648bc22](https://github.com/swoofer/mcp-coordinator/commit/648bc224899faae14dc3f2f922471001d723d6bd))
* **security:** close 3 cross-org leaks discovered by 32-agent audit ([af48d7c](https://github.com/swoofer/mcp-coordinator/commit/af48d7c26e6f522e15404c0b746e5a0b0e4dd091))
* **security:** make ConflictDetector.detect.org_id required + retag MCP TODOs to Task 23.5 ([a2f8211](https://github.com/swoofer/mcp-coordinator/commit/a2f821146752c8d2d7ffa6ea5f2cf81de917514e))
* **security:** scope raw UPDATE threads by org_id (cross-tenant leak) ([2a7cefa](https://github.com/swoofer/mcp-coordinator/commit/2a7cefa5fa51f5d2e4542097d135bba2d8590304))
* **test:** use ThreadMessage.content (not .subject) in cross-org leak test ([7a3397a](https://github.com/swoofer/mcp-coordinator/commit/7a3397a97d444a69ca8f4c93193458a37ed9beaa))


### Documentation

* **plan:** v0.7.0 Phase 1 auth foundation implementation plan (4-round review) ([#21](https://github.com/swoofer/mcp-coordinator/issues/21)) ([a8e6fa1](https://github.com/swoofer/mcp-coordinator/commit/a8e6fa1289c2ee8c241278899d4e55a0758d537b))
* **v0.7:** amend specs with 55 findings from 40-agent review ([#18](https://github.com/swoofer/mcp-coordinator/issues/18)) ([24e441a](https://github.com/swoofer/mcp-coordinator/commit/24e441a84cb33989dd0a6d1f01edf151a6a093e9))
* **v0.7:** document Phase 1 breaking changes + migration guide ([d8e0e7f](https://github.com/swoofer/mcp-coordinator/commit/d8e0e7f6e1e93d26057fe84a296290e2e9857c62))


### Code Refactoring

* **agent-activity:** scope status writes/reads by org_id ([66349ae](https://github.com/swoofer/mcp-coordinator/commit/66349aef75d7d59729eb77f003cc09c72c26856b))
* **agent-registry:** scope all queries by org_id ([701167e](https://github.com/swoofer/mcp-coordinator/commit/701167ee3b043f977b4465c0338bc790c0a533f1))
* **consultation:** scope thread/message/introspection queries by org_id ([44dccc5](https://github.com/swoofer/mcp-coordinator/commit/44dccc5ce4d6e482e1c0a6ab6ac080df391adcc2))
* **dependency-map:** scope set/get/listOwners by org_id ([0c95104](https://github.com/swoofer/mcp-coordinator/commit/0c95104a72643a2540e4896de021f547989a4217))
* **file-tracker:** scope all queries by org_id ([6c5e2f5](https://github.com/swoofer/mcp-coordinator/commit/6c5e2f54138923b1e7db62ee52dbfb4df97e893c))
* **git-cochange:** scope build/query by org_id ([2db5172](https://github.com/swoofer/mcp-coordinator/commit/2db51721f8204867b3ba399a02369061fa1a907a))
* **impact-scorer:** scope direct SQL blocks by org_id (3 sites) ([c4de948](https://github.com/swoofer/mcp-coordinator/commit/c4de948fb954c9a0c72cb0a66f54ea481f934169))
* **introspection:** scope create/respond/list/getPending by org_id ([94dae4d](https://github.com/swoofer/mcp-coordinator/commit/94dae4df62b3ac31cfe66d12003874c397491de5))
* **working-files:** scope claim/list/release by org_id ([d76e45d](https://github.com/swoofer/mcp-coordinator/commit/d76e45d095f89aec29be882c6fdfcf19dcedd128))

## [0.7.0] - 2026-05-13

### Breaking changes

- **JWT shape extended**: tokens now require `user_id` and `org` claims. v0.6 tokens (without these) are rejected when `AUTH_ENABLED=true`. Set `AUTH_ENABLED=false` for backward-compat mode.
- **`COORDINATOR_JWT_SECRET` is now strongly recommended in production**: when unset, the coordinator generates a random secret per boot — this invalidates ALL existing sessions on every restart. The behavior is unchanged from prior releases but documented explicitly for the first time. Set `COORDINATOR_JWT_SECRET` to a stable value (32+ chars) in any deployment where session persistence across restarts matters.
- **Database schema bumped to user_version=7**: new tables (`orgs`, `users`, `refresh_tokens`, `device_auth_requests`, `audit_log`) and `org_id` column added to 14 existing tables. Migration is automatic and idempotent on boot. **Downgrade to v0.6 binary is refused** by `PRAGMA user_version` check.
- **Composite primary keys migrated** for 7 tables: `agents`, `agent_activity_status`, `dependency_map`, `git_cochange`, `git_cochange_meta`, `revoked_agents`, `working_files`. Each now has `(org_id, ...)` as its PK instead of the v0.6 single-column key. Migration is performed via SQLite's create-new + copy + drop + rename pattern (no `ALTER PRIMARY KEY`) with `PRAGMA foreign_keys = OFF` around the transaction. **Rollback to v0.6 requires restoring from backup** — the schema change is one-way.
- **DB file mode tightened to 0600** on POSIX. Co-users can no longer read `coordinator.db` directly.
- **MQTT topic namespace changed** from `coordinator/agents/...` (and similar) to `coordinator/<org_id>/agents/...`. External MQTT consumers (dashboards, monitoring) must update subscription patterns. For Phase 1 single-org deployments, replace `coordinator/` with `coordinator/default/` everywhere. Wildcard subscribers: `coordinator/+/status` becomes `coordinator/+/+/status`. The internal bridge is updated automatically.
- **MCP transport: per-request JWT verification on every MCP request** (was: session-open only). Pre-v0.7 agents whose JWT expired mid-session could continue issuing tool calls indefinitely under the session-open bypass. v0.7 closes that hole. Agents must rotate their JWT within the TTL window or tool calls will fail mid-session with 401.
- **SSE endpoint `/api/events` now requires authentication** when `AUTH_ENABLED=true`. Browser clients using `EventSource` must send the token via query string: `new EventSource('/api/events?token=' + token)`. Server-side clients can use the standard `Authorization: Bearer` header.
- **`/api/auth/refresh` rejects v0.6 tokens when `AUTH_ENABLED=true`**: closes a bypass where a v0.6 token could be silently rotated to a v0.7-shape token via the refresh endpoint, sidestepping the AUTH_ENABLED=true reject-v0.6 invariant. Operators upgrading must either re-authenticate or use `/api/auth/refresh` while AUTH_ENABLED is still false (see Migration step 4 below).

### Added

- New env: `COORDINATOR_JWT_PREV_SECRET` for zero-downtime JWT secret rotation (set both `COORDINATOR_JWT_SECRET` and `COORDINATOR_JWT_PREV_SECRET`, restart, wait one JWT TTL, then remove `_PREV_`).
- `IdPProvider` interface + empty registry (Phase 2 will populate with GitHub OAuth).
- `EncryptionProvider` interface + `PassthroughEncryption` default (Phase v0.7.5 will replace with SQLCipher).
- `auditLog()` helper + `audit_log` table (Phase 2+ will emit events).
- All REST + SSE + MQTT operations scoped by `org_id` end-to-end. Default org is `'default'` until Phase 2 introduces real multi-tenancy via OAuth login.
- RFC 6750 `WWW-Authenticate` header on 401 responses.
- JWT algorithm pinning: `alg=none` and non-HS256 tokens rejected.
- `/healthz` now reports `auth_enabled` and `jwt_secret_set` flags for operability.

### Migration

1. Stop coordinator.
2. **Backup `coordinator.db`** (the migration is one-way per session — restore is needed if rolling back to v0.6).
3. **Set `COORDINATOR_JWT_SECRET`** to a stable 32+ char value if not already set (otherwise every restart invalidates all sessions).
4. Deploy v0.7.0 binary.
5. Start coordinator. Migration runs on first boot (idempotent). The PRAGMA user_version bump happens AFTER all ALTERs succeed — a mid-migration crash leaves the DB at user_version=6 and the next boot retries cleanly.
6. Existing clients keep working under `AUTH_ENABLED=false` (synthetic legacy claims).
7. **Rotate v0.6 tokens BEFORE flipping `AUTH_ENABLED=true`**: each agent must either (a) call `/api/auth/refresh` while `AUTH_ENABLED=false` is still set (v0.7.0 lifts the 501 gate for this endpoint specifically so v0.6 clients can rotate to v0.7-shape tokens), OR (b) call `/api/auth/register` to obtain a fresh v0.7 token. Once `AUTH_ENABLED=true`, `/api/auth/refresh` rejects v0.6 tokens with an explicit error.
8. Flip `AUTH_ENABLED=true` and restart. Agents that completed step 7 continue working; agents that didn't will get 401s and must re-register.

## [0.6.1](https://github.com/swoofer/mcp-coordinator/compare/v0.6.0...v0.6.1) (2026-05-12)


### Bug Fixes

* **deps:** override ip-address to ^10.2.0 (resolves dependabot [#1](https://github.com/swoofer/mcp-coordinator/issues/1)) ([f65f441](https://github.com/swoofer/mcp-coordinator/commit/f65f441954f6860a70c23ef64bd332ef6d7a0c2b))
* **deps:** override ip-address to ^10.2.0 (resolves GHSA-v2v4-37r5-5v8g) ([38bd705](https://github.com/swoofer/mcp-coordinator/commit/38bd705ad79473bc95dc2b8290ab868392d73aae))
* **http:** enforce repo-relative path contract in v0.6 endpoints ([0aaaaf8](https://github.com/swoofer/mcp-coordinator/commit/0aaaaf88465633dc51739ac80fe5d8a1476f8974))
* **http:** enforce repo-relative path contract in v0.6 endpoints ([eb9dbea](https://github.com/swoofer/mcp-coordinator/commit/eb9dbea05174c11a8381508ae1d6d74f17bce06c))


### Documentation

* add Contributor License Grant (relicense optionality) ([779c7d9](https://github.com/swoofer/mcp-coordinator/commit/779c7d9f62afad762ed870d5c3ddf96e47075e89))
* **contributing:** add Contributor License Grant for relicense optionality ([60acb03](https://github.com/swoofer/mcp-coordinator/commit/60acb03f667168d5943cede152ac91999644459b))

## [0.6.0](https://github.com/swoofer/mcp-coordinator/compare/v0.5.0...v0.6.0) (2026-05-10)


### Features

* **dashboard:** aggregate real outcomes in /api/scoring-stats ([eeb6f10](https://github.com/swoofer/mcp-coordinator/commit/eeb6f1008423b9bf79da8580ad5d73a3b5fc2803))


### Documentation

* **changelog:** remove orphan v0.6.0 entry pre-dating release-please ([4da39af](https://github.com/swoofer/mcp-coordinator/commit/4da39afe6652cca9a4e615dd2aadf6c78bae08ec))
* **i18n:** add fr/es/de/ja/zh translations for v0.5.0 landing additions ([858cf63](https://github.com/swoofer/mcp-coordinator/commit/858cf63e0c618dba89c8fbd978512637dd9848d2))
* **landing:** update for v0.5.0 — 15 languages, 6 scoring layers, dashboard signals ([4d122a8](https://github.com/swoofer/mcp-coordinator/commit/4d122a869849f47a80bd5137cdb008335281ccf9))
* **readme:** update for v0.5.0 — features shipped + LLM Reasoner roadmap ([5635497](https://github.com/swoofer/mcp-coordinator/commit/56354976f7a5a355d4857ef4545319e6d3a5a0cf))
* **v0.5.0:** follow-up polish — CHANGELOG, dashboard outcomes, i18n ([450ed07](https://github.com/swoofer/mcp-coordinator/commit/450ed0740e524b5c31ae5f94dfc82cbdcf24aa31))

## [0.5.0](https://github.com/swoofer/mcp-coordinator/compare/v0.4.0...v0.5.0) (2026-05-10)


### Features

* v0.6.0 Semantic Conflict Detection (server-anchored) ([aaf47fc](https://github.com/swoofer/mcp-coordinator/commit/aaf47fc8ec6f5a271c2d60331e2dd2e6e9e4b302))
* **v0.6:** /api/file-activity accepts content; parses symbols_touched via tree-sitter ([b6794f9](https://github.com/swoofer/mcp-coordinator/commit/b6794f95e6fbd04575d24abe49b4851028322d2d))
* **v0.6:** /api/scoring-stats + dashboard 'Conflict signals' panel ([defd5e0](https://github.com/swoofer/mcp-coordinator/commit/defd5e011b419ab5d265a6c0dac3f63736eb83d2))
* **v0.6:** /api/working-files/{start,stop} endpoints ([cbf8f93](https://github.com/swoofer/mcp-coordinator/commit/cbf8f9365f761a73a80b0c5f2221288504ed7329))
* **v0.6:** /readyz reports tree_sitter + git_cochange (optional, non-gating) ([6896635](https://github.com/swoofer/mcp-coordinator/commit/68966356a6e97df686ffa562a933e51d659e7786))
* **v0.6:** add normalizePath utility for symmetric path matching ([b6bfa6f](https://github.com/swoofer/mcp-coordinator/commit/b6bfa6f27bc328ec90e65e9c8ea55623ae90c013))
* **v0.6:** add working_files, git_cochange, layer_firings tables + user_version=6 ([4450458](https://github.com/swoofer/mcp-coordinator/commit/4450458293f07e60e0043c05dfd9271565ac450d))
* **v0.6:** env-var CLI flags, README docs, Prometheus counters ([0c932bb](https://github.com/swoofer/mcp-coordinator/commit/0c932bbbe778b9afc11441721611cca01ffd7c4f))
* **v0.6:** GitCochangeBuilder — bounded git log, denylist, retry-on-timeout ([8eadb1d](https://github.com/swoofer/mcp-coordinator/commit/8eadb1d151b8c6fd354acfd6ef5969b20e1e4e62))
* **v0.6:** Layer 0.5 annotation — same file, disjoint symbols flagged in reason ([ef64a50](https://github.com/swoofer/mcp-coordinator/commit/ef64a50f33ee38ab4733b7362c4caf9ea12a8dff))
* **v0.6:** Layer 4 git co-change scoring with canonical pair lookup ([994c9c8](https://github.com/swoofer/mcp-coordinator/commit/994c9c87410b7f3ed8d6f68efdaeeaafbb583c8a))
* **v0.6:** refactor TreeSitterExtractor to language-handler registry; add C#/C/C++/Ruby/PHP/Kotlin/Swift/Bash ([e1b9874](https://github.com/swoofer/mcp-coordinator/commit/e1b987474f3b38a7b3763389225e8ea28c044052))
* **v0.6:** refuse downgrade — PRAGMA user_version guard ([fe9893c](https://github.com/swoofer/mcp-coordinator/commit/fe9893cb1ff7457ebb1e9640ba398358d239cd77))
* **v0.6:** scorer Layer 1 unions working_files; offline hook clears working_files ([c736812](https://github.com/swoofer/mcp-coordinator/commit/c7368122f0a514ff42e408d22171bed0a638972e))
* **v0.6:** TreeSitterExtractor with per-language symbol qualification ([e54e5df](https://github.com/swoofer/mcp-coordinator/commit/e54e5dfc1dfe949c64a830149a8e7a3f9cb02ee6))
* **v0.6:** WorkingFilesTracker — UPSERT/DELETE/sweeper/index ([41d00ba](https://github.com/swoofer/mcp-coordinator/commit/41d00ba6f610a38a2a6ce81c7bba253225be7c5a))


### Bug Fixes

* **http:** cap parseBody at 1 MB with 413 response ([c820115](https://github.com/swoofer/mcp-coordinator/commit/c820115157eec6468d43be0817745191f88d689c))
* **http:** wire /livez /readyz /metrics + recordHttpRequest counters ([55f5ff4](https://github.com/swoofer/mcp-coordinator/commit/55f5ff45be770d5d0ab31c4b199ea78a9dd3d594))
* **path-normalize:** detect Windows-style paths from input shape, not process.platform ([f4cf7f0](https://github.com/swoofer/mcp-coordinator/commit/f4cf7f0c396f36ae779ec73b89e793a51c535b48))


### Documentation

* **v0.6:** add design spec + implementation plan + handoff ([ec35949](https://github.com/swoofer/mcp-coordinator/commit/ec359495b8edb4b10344f1bc7e34a4a158f10c3f))
* **v0.6:** add tree-sitter handler registry refactor plan ([4e3bba6](https://github.com/swoofer/mcp-coordinator/commit/4e3bba64ef7d0b7697085e1d7331459d6b92a556))

## [0.4.0](https://github.com/swoofer/mcp-coordinator/compare/v0.3.0...v0.4.0) (2026-05-10)


### Features

* v0.4 Operability + v0.5 Performance (autonomous 9-agent sprint) ([#8](https://github.com/swoofer/mcp-coordinator/issues/8)) ([76b4f38](https://github.com/swoofer/mcp-coordinator/commit/76b4f3875bc06b945c3dc9fba64cb354bd1da129))

## [0.3.0](https://github.com/swoofer/mcp-coordinator/compare/v0.2.1...v0.3.0) (2026-05-10)


### Features

* **server:** B6 - graceful shutdown + ServerHandle return ([95da83d](https://github.com/swoofer/mcp-coordinator/commit/95da83da1e9660cb146196b3610f6498e53b6d2b))


### Bug Fixes

* **consistency:** B1 - transactions in announceWork + CAS in approveResolution ([e4348e2](https://github.com/swoofer/mcp-coordinator/commit/e4348e23a0085985e0ac83f56429d35c5609e93e))
* **consistency:** B2 - move checkTimeouts to background sweeper ([231675c](https://github.com/swoofer/mcp-coordinator/commit/231675c729c25f90e9e71b4821bb5aad6d96b9fe))
* **landing:** hamburger visible on desktop ([4b7c79a](https://github.com/swoofer/mcp-coordinator/commit/4b7c79a24f98090c6c19af078c63a7194ebe5bd0))
* **landing:** remove orphan i18n block leaking past translations close ([79d2aa9](https://github.com/swoofer/mcp-coordinator/commit/79d2aa9fa61c8a5e7d3ee42749a914bc777c1623))
* **security:** B3 - opt-in MQTT JWT auth (preserves anonymous default) ([45dc203](https://github.com/swoofer/mcp-coordinator/commit/45dc203011cde6425920051533b5bb06f7c95ea1))
* **security:** B4 - gate /api/reset when AUTH is disabled ([969370f](https://github.com/swoofer/mcp-coordinator/commit/969370f3e45f38177dbc260f1152b0fca8da92d6))
* **security:** B5 - dashboard path traversal guard ([43e880d](https://github.com/swoofer/mcp-coordinator/commit/43e880df2c00dd4ae2bd88459b3ec36d133cc4f7))


### Documentation

* **audit:** code audit by 20 critical experts (avg 4.85/10) ([e59838f](https://github.com/swoofer/mcp-coordinator/commit/e59838fe578b37a8dae429717dc1ca657165eb69))
* **landing:** redesign — 11 sections, narrative arc, +templates +FAQ ([7f4e6dd](https://github.com/swoofer/mcp-coordinator/commit/7f4e6dd54ec9900191bedf593ae33ec3db0bbf23))
* **landing:** redesign for clarity, fix DOM/version/BCE bugs, expand a11y/SEO/i18n ([0f35f49](https://github.com/swoofer/mcp-coordinator/commit/0f35f492a21258d3053ea405c38a6ffc53523e02))
* **landing:** reframe templates section to lead with mcp-coordinator ([21af5c0](https://github.com/swoofer/mcp-coordinator/commit/21af5c04923c5b7bd19ee138b4075155da6f7247))
* **landing:** translate 1010 placeholders across 5 locales ([318bef2](https://github.com/swoofer/mcp-coordinator/commit/318bef24ff482bbc1e1171df9fa24dbb0d2b0e8b))
* **redesign:** integration draft v1 (11 sections merged) ([ee5de20](https://github.com/swoofer/mcp-coordinator/commit/ee5de20949f5ddafadfc67f1448caf314ac862bf))
* **redesign:** integration draft v2 (Layer 3 audits applied) ([29121fc](https://github.com/swoofer/mcp-coordinator/commit/29121fc0efb3b12ab635095a2e36923f20539be6))
* **redesign:** Layer 1 strategy briefs (5 agents) ([657f4d4](https://github.com/swoofer/mcp-coordinator/commit/657f4d476d1826158b768e203c70412e018f4266))
* **redesign:** Layer 2 section fragments (22 agents, 11 pairs) ([5574100](https://github.com/swoofer/mcp-coordinator/commit/55741007fb6c62a52fdf8582aa30dc3bf369d2e6))
* **redesign:** Layer 3 discipline audits (6 agents) ([c3693cf](https://github.com/swoofer/mcp-coordinator/commit/c3693cf01e4953cad069cee966969755500e6c26))
* **redesign:** Layer 4 QA finale (3 agents sequential) ([755a197](https://github.com/swoofer/mcp-coordinator/commit/755a197e5b1e502f46832821a9b934e3b3d1b351))
* **seo:** add Open Graph + Twitter Cards + sitemap + robots.txt ([55b6ec6](https://github.com/swoofer/mcp-coordinator/commit/55b6ec65e31d0f85d30cfac5fa4c09175309350e))


### Code Refactoring

* structural fixes S1/S2/S3 (god files split, duplication, network tests) ([#7](https://github.com/swoofer/mcp-coordinator/issues/7)) ([900ab9a](https://github.com/swoofer/mcp-coordinator/commit/900ab9a2ce5ee917a24d764507dba7f9b9909998))

## [0.2.1](https://github.com/swoofer/mcp-coordinator/compare/v0.2.0...v0.2.1) (2026-05-06)


### Bug Fixes

* **landing:** missing commas in i18n dict broke JS parsing ([0d62c44](https://github.com/swoofer/mcp-coordinator/commit/0d62c44f13fcdf5f37df6142f4b23ab5e7242ece))


### Documentation

* add Buy Me A Coffee + GitHub Sponsors links across surfaces ([5e5d2d1](https://github.com/swoofer/mcp-coordinator/commit/5e5d2d10e47bbaa15d2e808041f264b0de10c36c))
* **landing:** remove essaim/v3 spillover from why blocks ([2e1c399](https://github.com/swoofer/mcp-coordinator/commit/2e1c3991fc436127fc30502adf8389e54ace827f))
* **landing:** roadmap reflects what was actually shipped in 0.2.0 ([84d8510](https://github.com/swoofer/mcp-coordinator/commit/84d85101ff25f9eb33701cc61f377f32f8847204))

## [0.2.0](https://github.com/swoofer/mcp-coordinator/compare/v0.1.0...v0.2.0) (2026-05-05)


### Features

* **cli:** add doctor, server logs, and init --write-claude-md ([95b1505](https://github.com/swoofer/mcp-coordinator/commit/95b15051c06f308161defc33b1a7d91dab1f3c77))
* **cli:** add init command + document standalone use ([5bb2da8](https://github.com/swoofer/mcp-coordinator/commit/5bb2da88c9830ab27f752b191d137ff66c0fe58d))
* **cli:** add uninstall command + expand release-please CHANGELOG sections ([d4330ed](https://github.com/swoofer/mcp-coordinator/commit/d4330ed381cd43b31c7103779d6847280dcc7183))


### Bug Fixes

* **ci:** disable component prefix in release-please tags ([85fadf1](https://github.com/swoofer/mcp-coordinator/commit/85fadf1efb67dc4f48fef5d638799980ebdfacd6))


### Documentation

* clarify push vs polling — vanilla Claude Code is polling-based, not push ([5a097da](https://github.com/swoofer/mcp-coordinator/commit/5a097daedb09eb7ebb015aaaa0b06eae977fa2d2))
* expand standalone use with team walkthrough, e2e example, logs/debug, multi-instance ([98fa71a](https://github.com/swoofer/mcp-coordinator/commit/98fa71a401ecb587dc281f71b849e55392591981))
* **landing:** hero subtitle now signals standalone use + essaim pairing ([049d6f5](https://github.com/swoofer/mcp-coordinator/commit/049d6f5a05f1a6d57daac7d207b87e65c71b0a95))
* **landing:** reflect 0.2.0 surface — init flow, polling vs push, fix dashboard port ([00b3404](https://github.com/swoofer/mcp-coordinator/commit/00b34040fd2cabea543710f7d4c0b6f52085536e))
* **landing:** replace minimal placeholder with epurated source landing page ([812fee7](https://github.com/swoofer/mcp-coordinator/commit/812fee770085686b66ef794d0be7891415d752f6))
* replace README with epurated source (preserve all server-pure sections) ([4cb9930](https://github.com/swoofer/mcp-coordinator/commit/4cb9930cf4a1ab5730c010022a5810734c77e479))
