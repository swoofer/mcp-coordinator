<div align="center">

# mcp-coordinator

**Embedded MQTT broker + MCP server for multi-agent coordination. Zero conflicts, everyone aligned.**

**Latest: v0.10.4.** Optional OAuth 2.1 + RFC 8628 device flow + 4 IdP providers (GitHub OAuth App, GitHub App, Google, generic OIDC) + 4 allowlist strategies + SHA-256 audit log hash chain (SOC 2 tamper-evidence) + `rotate-jwt-secret` CLI. Single-user / dev local mode requires **zero configuration** — run `mcp-coordinator server start` and you're done.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-coordinator.svg)](https://www.npmjs.com/package/mcp-coordinator)
[![Tests](https://github.com/swoofer/mcp-coordinator/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions)
[![E2E](https://github.com/swoofer/mcp-coordinator/actions/workflows/e2e.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions/workflows/e2e.yml)

[Getting started](#getting-started) · [Problem](#the-problem) · [How It Works](#how-it-works) · [MQTT Layer](#mqtt-communication-layer) · [Scoring](#impact-scoring) · [MCP Tools](#mcp-tools) · [CLI](#cli) · [Standalone use](#standalone-use--without-an-orchestrator) · [Quota](#anthropic-quota-pre-flight) · [Dashboard](#dashboard) · [Config](#configuration) · [Auth](#authentication) · [SDK](#sdk)

</div>

---

## Capabilities at a glance (v0.10.4)

| Concern | Out of the box | Opt-in |
|---------|----------------|--------|
| **Run the coordinator** | `mcp-coordinator server start` -- zero config | — |
| **Conflict detection** | 4-layer impact scoring (announce / file / module / co-change), MQTT push | — |
| **Authentication** | Open mode (synthetic legacy claims) | Phase 1 JWT (`COORDINATOR_AUTH_ENABLED`) OR Phase 2 OAuth (`COORDINATOR_OAUTH_ENABLED`) |
| **Identity providers** | — | GitHub OAuth App + GitHub App + Google + generic OIDC; up to 4 in parallel via picker UI |
| **Allowlist strategies** | — | 4 strategies (`memberships` / `idp_org_id` / `id_token_groups` / `none`); auto-selected per provider |
| **Session model** | — | Cookie sessions (`__Host-coordinator_session`) + Bearer JWT for MCP transport + service tokens for CI/CD |
| **Refresh-token rotation** | — | Reuse detection with 10s grace + family revoke; GitHub App auto-refreshes IdP access tokens on 401 |
| **Audit log** | — | Tier-1 (never-drop) + Tier-2 (batched) + SHA-256 hash chain (`prev_hash` + `row_hash`) for tamper-evidence |
| **Operational tooling** | — | `init phase2` wizard, `doctor --phase2`, `service-token {issue,list,revoke}`, `rotate-jwt-secret`, `verify-audit-chain.ts` |
| **Compliance posture** | — | SOC 2 Type II audit-chain runbook, GDPR Art. 17 procedures, threat model with 10 documented residual risks |
| **Observability** | Pino logs, MQTT broker stats | 29 Prometheus metrics on `/metrics/auth`, Grafana dashboard JSON, alert rules YAML |
| **Multi-instance** | — | (Planned v1.0) Redis-backed cache invalidation + leader election |
| **Database backend** | SQLite (better-sqlite3 / Bun:sqlite) | Postgres (planned v0.11, see [design spec](./docs/superpowers/specs/2026-05-16-postgres-adapter-design.md)) |

**1740 tests passing.** Phase 2 features ship feature-flagged so Phase 1 deployments stay byte-identical (proven by the `tests/backcompat/` suite).

---

## The Problem

When multiple developers each use an AI coding agent in parallel on the same repo, things break:

- **Regressions** — Agent A rewrites a module that Agent B was depending on
- **Duplicated work** — Two agents implement the same feature from different directions
- **Architectural drift** — Agents make local decisions that conflict with each other's designs
- **Wasted reconciliation time** — Developers spend hours untangling what the agents did

Each agent works in isolation. None of them know what the others are doing.

mcp-coordinator fixes this by giving agents a **shared nervous system over MQTT** — they announce intentions before coding, conflicts are detected before a single line is written, and agents see each other's actions in real-time to agree on an approach.

It works **with or without** an orchestrator on top. Use it standalone with any MCP client (Claude Code, Cursor, Cline, Aider) — see [Standalone use](#standalone-use--without-an-orchestrator). Or pair it with [essaim](https://github.com/swoofer/essaim) when you want pre-composed agent profiles, work-stealing templates, and a behavior catalog.

---

## Getting started

```bash
# 1. Install
npm install -g mcp-coordinator

# 2. First-time setup — creates ~/.mcp-coordinator/, writes a default config,
#    and prints a .mcp.json snippet for your MCP client.
mcp-coordinator init

# 3. Start the server (foreground or --daemon for background)
mcp-coordinator server start --daemon

# 4. Verify
mcp-coordinator server status
mcp-coordinator dashboard      # opens http://localhost:3100/dashboard
```

Step 2 is idempotent — re-running `init` won't overwrite an existing config. The snippet it prints goes into your MCP client's config (e.g., `~/.claude/.mcp.json` for Claude Code). If you'd rather not copy-paste, run `mcp-coordinator init --write-mcp-config <project-path>` and the snippet is written to `<project-path>/.mcp.json` (merging if the file already exists).

After step 4, every Claude Code (or other MCP-compatible) session connected to this coordinator can call all 26 tools (`register_agent`, `announce_work`, `post_to_thread`, `coordinator_status`, ...). For the full multi-Claude or team setup, see [Standalone use](#standalone-use--without-an-orchestrator).

---

## How It Works

```
   Agent A                          Agent B
     │                                │
     │  announce_work                 │  announce_work
     ▼                                ▼
┌──────────────┐                ┌──────────────┐
│  MCP client  │ ◄── MQTT ────► │  MCP client  │
│ (any vendor) │   push-based   │ (any vendor) │
└──────┬───────┘                └──────┬───────┘
       │         MCP HTTP / SSE        │
       └──────────────┬────────────────┘
                      │
            ┌─────────▼──────────┐
            │   mcp-coordinator  │
            │  26 MCP tools + DB │
            │  Aedes MQTT broker │
            └─────────┬──────────┘
                      │ SSE
            ┌─────────▼──────────┐
            │     Dashboard      │
            │  live events/quota │
            └────────────────────┘
```

The **consultation cycle** has four steps:

1. **Announce** — A client calls `announce_work` with target files, `depends_on_files`, and target modules before coding.
2. **Detect** — The coordinator scores impact against all online agents and opens a thread if a score ≥ 90 matches.
3. **Consult** — MQTT pushes the new thread to every affected agent. Each agent posts context, constraints, or proposes a resolution.
4. **Resolve** — Agents approve, contest, or propose again. The thread closes when consensus is reached, or auto-resolves after timeout / in gray zones.

The server is **client-agnostic**: any MCP-compatible agent (Claude Code, Cursor, Cline, Aider, custom scripts) can connect over HTTP/SSE or stdio.

---

## MQTT Communication Layer

The coordinator ships with an **embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker**. Agents subscribe once and receive every coordination event in real-time — no polling, no extra infrastructure.

### Broker

| Transport | Port | Use case |
|-----------|------|----------|
| TCP | `1883` (bind `127.0.0.1` by default) | Local / LAN agents, best latency |
| WebSocket | `/mqtt` on the coordinator HTTP port (default `3100`) | Bun binary, remote agents, firewall-friendly |

One coordinator = one broker. Nothing external to install.

### Topic map

Every coordinator event is published on a well-known topic. Clients subscribe to the full set on connect.

| Topic | Emitted when | Payload highlights |
|-------|--------------|--------------------|
| `coordinator/consultations/new` | A thread is opened | `thread_id`, `subject`, `initiator_id`, `target_modules`, `target_files` |
| `coordinator/consultations/{id}/messages` | Anyone posts to a thread | `agent_id`, `name`, `content`, `type` (warning/context/proposal) |
| `coordinator/consultations/{id}/status` | Thread transitions state | `status` ∈ `open` / `resolving` / `resolved` / `timeout` |
| `coordinator/consultations/{id}/claimed` | An agent atomically claims a task (work-stealing) | `claimed_by`, `thread_id` |
| `coordinator/consultations/{id}/completed` | Claimed task finishes | `agent_id`, `thread_id`, `resolution` |
| `coordinator/agents/{id}/status` | Agent goes online / offline | `status`, `name`, `modules` |
| `coordinator/broadcast` | System-wide announcements | arbitrary JSON |
| `coordinator/quota/update` | Anthropic quota refresh | `usage`, `limit`, `utilization_pct` |

### Push delivery flow

```
 COORDINATOR                 BROKER (Aedes)               CLIENT
 ───────────                 ──────────────               ──────

 announce_work() ──────────► publish                      subscribe
                             coordinator/                 ─► event
                             consultations/new ─────────► classify topic
                                                          self-msg filter
                                                          ─► handler
```

Key guarantees:

- **Self-filter** — clients drop messages where `payload.agent_id` equals the local agent's id, so agents never wake on their own actions.
- **Bun compatibility** — when consumed from a Bun-compiled client, a Duplex stream bridges the `mqtt` client to the native WebSocket API (the `ws` package receiver doesn't work under Bun).
- **Backpressure-free** — messages are small JSON envelopes.

---

## Impact Scoring

Every `announce_work` call scores all online agents across multiple detection layers. The highest matching layer wins.

| Layer | Signal | Score | Trigger |
|-------|--------|------:|---------|
| 0a | Same file announced in active thread | 100 | `target_files` ∩ their `target_files` |
| 0b | They modify a file you depend on | 80 | `depends_on_files` ∩ their `target_files` |
| 0c | You modify a file they depend on | 80 | `target_files` ∩ their `depends_on_files` |
| 1 | Same file recently edited | 100 | File tracker conflict (last 60s) |
| 2 | Dependency file recently edited | 80 | `depends_on_files` recently touched |
| 3 | Same module prefix | 30 | `target_modules` overlap |

Scores are categorized into three outcomes:

| Score | Category | Action |
|-------|----------|--------|
| ≥ 90 | `concerned` | Thread opened, consultation required |
| 30–89 | `gray_zone` | Thread auto-resolved, introspection recommended |
| < 30 | `pass` | No conflict, proceed immediately |

> **Layer 0 is critical.** Without announced intentions, a two-agent scenario where both work in `src/auth/` would score only 30 (gray zone, auto-resolved). With `announce_work`, the same scenario scores 100 and triggers a full consultation.

---

## What's New in v0.8.0 (Phase 2 OAuth)

Released 2026-05-14. Feature-flagged behind `COORDINATOR_OAUTH_ENABLED=true`. Phase 1 deployments are byte-identical when the flag is unset.

### A. OAuth 2.1 + device flow (RFC 6749 + RFC 8628)

- `GET /auth/login` initiates the browser flow with PKCE S256 + HMAC-bound state cookie
- `GET /api/auth/oauth/callback` performs state CAS + provider mix-up defense + IdP code exchange + user provisioning inside a transaction
- `POST /api/auth/oauth/token` unified grant endpoint (authorization_code, refresh_token, device_code per RFC 8628)
- `POST /api/auth/oauth/device_authorization` for CLI / TV / IoT device flow
- 5 HTML pages: /auth/login, /auth/device, /auth/device/confirm, /auth/device/approve POST, /auth/success
- See [`docs/openapi.yaml`](./docs/openapi.yaml) for the full API spec

### B. Refresh-token rotation with stolen-token detection (V3 §B-NEW-2)

- Each refresh issues a new family member (`family_id`) with `parent_jti` lineage
- 10-second grace window allows legitimate retries with matching fingerprint
- Mismatched fingerprint within grace → atomic `replay_count++`; family revoked at threshold 3
- Hard reuse (rotation > 10s old) → immediate family revoke + `auth.refresh.chain_revoked` Tier 1 audit

### C. Cookie sessions (Scenario 5)

- `__Host-coordinator_session` cookie + `__Host-coordinator_csrf` (double-submit pattern)
- `authenticateRequest` now handles 5 scenarios: legacy fallback, no-auth, v0.6 legacy JWT reject, Bearer JWT, cookie session
- `POST /api/auth/logout` (revoke current refresh), `/logout-all` (bump `token_epoch` → all sessions invalidated instantly), `/revoke` (RFC 7009)
- `GET /api/auth/me` userinfo helper

### D. Service tokens (V4 §5.5)

- Admin-issued long-lived JWTs for CI/CD: `mcp-coordinator service-token issue --user X --org Y --scope read --ttl 30d --reason "..."`
- 90d hardcoded TTL ceiling; reason ≥10 chars required; admin-only issuance
- `family_id` format `service:<uuid>` distinguishes from user refresh families
- DB-lookup verification on every request (admin force-revoke is immediate)
- `list` + `revoke` CLI verbs; `auth.service_token.{issued,revoked,used}` audit events

### E. Audit pipeline (two-tier durability per V3 NR13)

- 35 audit event types catalogued in `src/security/audit-events.ts`
- Tier 1 (sync direct INSERT, never drop): security-critical events (refresh.chain_revoked, login.locked, token.revoked, admin.bootstrapped, ...)
- Tier 2 (async batched queue, may drop under pressure): high-volume operational (login.success, refresh.rotated, device.code_issued, ...)
- AsyncLocalStorage-based actor + request_id propagation — no explicit threading
- Audit queue capacity 10K with backpressure → `auth.shutdown.audit_loss` row on drop

### F. Operational

- `bootPhase2` composes ServerContext at boot: env validation, HKDF key derivation, restore detection (NR12), feature-flag gate
- Sweeper prunes 6 tables on 60s cadence (oauth_state, device_auth_requests, refresh_tokens × 2 retention buckets, audit_log × 2 tiers) with adaptive chained passes + 5-failure circuit breaker
- Rate limiter + login lockout (5 failures / 15min → 15min lockout per V3 §B-NEW-8) in-memory token bucket
- IdP membership cache with 60s positive TTL + 10min stale-on-error window (V3 §B-NEW-5)

### G. Observability

- 29 new Prometheus metrics in `src/observability/metrics.ts` (auth activity, refresh chain, device flow, IdP, audit queue, sweeper, rate limit, request duration)
- `/metrics/auth` Prometheus scrape endpoint (localhost-only + optional Bearer auth)
- `/healthz` (liveness) + `/health/ready` (readiness — DB + sweeper circuit + audit queue depth + draining flag)
- Pino logger with 16 redact paths per V4 §11.3
- Grafana dashboard JSON ([`docs/ops/dashboards/coordinator.json`](./docs/ops/dashboards/coordinator.json)) + Prometheus alert rules YAML ([`docs/ops/alerts/coordinator-alerts.yaml`](./docs/ops/alerts/coordinator-alerts.yaml))

### H. CLI

- `mcp-coordinator init phase2` interactive wizard for first-time Phase 2 setup
- `mcp-coordinator doctor --phase2` runs 8 Phase 2 health probes (DB schema version, JWT_SECRET entropy, discovery doc reachability, etc.)
- `mcp-coordinator service-token {issue,list,revoke}` for admin token management

### I. Testing

- **1555 tests passing** across 116 test files (up from 392 at v0.5.0)
- 100% branch coverage enforced via vitest per-file thresholds on every security-critical module (csrf, token-epoch, oauth-state, jwt-mint, membership-cache, refresh-rotation, service-tokens, github provider, etc.)
- Playwright E2E suite (`tests/e2e/`) — 5 scenarios in ~12s, zero flakes over 5 runs
- D1-D10 cross-cutting test matrix (`tests/integration/d1-d10-matrix.test.ts`) — 20 cases proving component-interaction seams
- Phase 1 backcompat suite (`tests/backcompat/`) — 31 cases proving `COORDINATOR_OAUTH_ENABLED` unset = byte-identical Phase 1
- Cross-tenant isolation suite — 22 cases proving multi-tenant data boundary

### J. SDK (`sdk/`)

- TypeScript client `@mcp-coordinator/sdk-js` in repo workspace (not yet published)
- `McpCoordinatorClient` with verbs: `whoami`, `logout`, `logoutAll`, `revoke`, `refresh`, `deviceCodeStart`, `deviceCodePoll`
- 14 typed error subclasses mapping to the OpenAPI error envelope
- `FileTokenStore` persists tokens to `~/.mcp-coordinator/tokens.json` with `chmod 0600` (POSIX) + atomic write-rename
- `ProactiveRefresh` schedules refresh at `accessExpiresAt - 120s ± 30s jitter`
- Single-flight refresh lock via atomic O_EXCL file lock (multi-process CLI safety)
- See [`sdk/README.md`](./sdk/README.md) for usage

### Documentation

23 new doc files under `docs/` and `examples/`:

- Operator: [`docs/onboarding-self-host.md`](./docs/onboarding-self-host.md), [`docs/ops/upgrade-phase1-to-phase2.md`](./docs/ops/upgrade-phase1-to-phase2.md), 8 ops runbooks
- Security: [`docs/security/threat-model.md`](./docs/security/threat-model.md), 3 incident runbooks, [`SECURITY.md`](./SECURITY.md), `.well-known/security.txt`
- Compliance: [`docs/gdpr.md`](./docs/gdpr.md), [`docs/idp-providers.md`](./docs/idp-providers.md)
- API: [`docs/openapi.yaml`](./docs/openapi.yaml) (OpenAPI 3.1, 17 endpoints, 13 schemas)
- Examples: `examples/{docker-compose,nginx-reverse-proxy,ghes-config,custom-idp-provider}/`

### v0.8.1 follow-up (2026-05-15)

- JWT key rotation overlap (prev-secret support per [`docs/ops/key-rotation.md`](./docs/ops/key-rotation.md))
- GHES env vars wiring (`COORDINATOR_GITHUB_AUTH_BASE_URL` + `_API_BASE_URL`)

---

## What's New in v0.9.0 (Multi-IdP)

Released 2026-05-15. Single-provider GitHub-only deployments stay behaviour-compatible — every change is opt-in via new env vars or a no-op when only one IdP is registered.

### A. Provider registry

- `ProviderRegistry` class attached to `AuthHandlerContext.providers` (T45). First registration becomes the implicit default.
- Every OAuth handler resolves the IdP through `ctx.providers.get(...)` rather than the removed `ctx.githubProvider` alias (T46). Refresh-rotation reads `users.idp_provider` so multi-provider users get re-validated against the IdP they actually signed in with.

### B. Google OAuth / OIDC

- First-class `GoogleProvider` (T47) with **mandatory** id_token signature verification: jose `createRemoteJWKSet` + RS256 + `iss=https://accounts.google.com` + `aud=client_id`.
- Identity claims read straight from the verified id_token (no extra `/userinfo` round-trip).
- Workspace `hd` claim surfaces as `idp_org_id` for hd-based allowlist deployments.
- Opt-in via `COORDINATOR_GOOGLE_CLIENT_ID` + `COORDINATOR_GOOGLE_CLIENT_SECRET` (both required or neither — fail-closed at boot).

### C. Generic OpenID Connect

- `OIDCProvider` (T48) for Okta / Auth0 / Azure AD / Keycloak / Authentik / any conformant OIDC issuer.
- Auto-discovers `authorization_endpoint`, `token_endpoint`, and `jwks_uri` from `<issuer>/.well-known/openid-configuration`.
- Discovery doc's own `issuer` field is cross-checked against config — catches redirect attacks on the discovery URL.
- Email-claim fallback chain: `email` → `preferred_username` → `sub` (OIDC core makes `email` optional).
- Opt-in via `COORDINATOR_OIDC_ISSUER_URL` + `COORDINATOR_OIDC_CLIENT_ID` + `COORDINATOR_OIDC_CLIENT_SECRET` (all three required together).

### D. Login picker UI

- `GET /auth/login` renders an HTML picker when `ctx.providers.size() > 1` (T49). Each button is a top-level GET to `/auth/login?provider=<name>`; the underlying PKCE + state-cookie + 302 flow is unchanged.
- Friendly built-in labels for `github` / `google` / `oidc`; title-cased fallback for custom provider names.
- Unknown `?provider=X` → 400 `UNKNOWN_PROVIDER` (no silent fallback to the default).
- Single-provider deployments skip the picker entirely.

### Breaking changes (internal embedding APIs)

| Surface | Change | Migration |
|---------|--------|-----------|
| `AuthHandlerContext.githubProvider` | Removed | Use `ctx.providers.get("github")` or `ctx.providers.getDefault()` |
| `IdPProvider.buildAuthUrl` return type | `string` → `string \| Promise<string>` | `await` the result; built-in providers stay synchronous |
| `provisionUser(...)` | Required 6th arg `providerName: string` | Pass `"github"` for existing call sites; the resolved `provider.name` for new ones |
| `auth.state.mixup` audit metadata | `{ expected_provider: "github" }` → `{ registered_providers: string[] }` | Log-pipeline consumers parsing `expected_provider` need to update |

### Testing

- **1623 tests** passing (+61 vs v0.8.1). 100% branch coverage on `auth/providers/{registry,github,google,oidc}.ts`.
- 16 GoogleProvider tests covering happy path, id_token verification (wrong issuer / audience / expired / unknown kid), JWKS unreachable transient errors, token-endpoint 401 / 502 / 4xx mapping.
- 21 OIDCProvider tests covering discovery-URL validation, issuer cross-check, the same id_token verification matrix, and email-claim fallback chain.
- 8 login-picker rendering tests + 6 picker integration tests (1 vs N provider behaviour, unknown-name 400, rate-limit, state row provider field).

### v0.9.1 follow-up (2026-05-15)

Audit log tamper-evidence. New `prev_hash` + `row_hash` columns on `audit_log` build a SHA-256 chain over every row written via `audit()`. `scripts/verify-audit-chain.ts` walks the chain and reports tampering; `docs/ops/audit-integrity.md` is the SOC 2 Type II operator runbook covering the external tip-attestation workflow that closes the deletion-detection gap.

### v0.9.2 follow-up (2026-05-15)

`mcp-coordinator rotate-jwt-secret` CLI helper generates a fresh signing secret with entropy validation + prints the operator workflow. `docs/ops/auto-rotation.md` covers systemd-timer + Vault and Kubernetes CronJob automation patterns around the helper.

---

## What's New in v0.10.0 (GitHub App)

Released 2026-05-16. Adds a `GitHubAppProvider` sibling to the existing OAuth App `GitHubProvider`, with built-in user-to-server token refresh handling. Existing OAuth App and Google / OIDC deployments stay behaviour-compatible; the new provider is opt-in via env vars.

### Why GitHub App on top of OAuth App?

- **Fine-grained permissions** -- GitHub Apps declare per-resource permissions, OAuth App scopes are coarser
- **Installation isolation** -- the App's footprint IS the allowlist; uninstalling the App from an org is an immediate hard revoke
- **Short-lived user-to-server tokens** -- 8h TTL with auto-rotating refresh tokens vs OAuth App's effectively permanent tokens

### Configure

```bash
export COORDINATOR_GITHUB_APP_CLIENT_ID=Iv1.0123456789abcdef
export COORDINATOR_GITHUB_APP_CLIENT_SECRET=<from-app-settings>
# Optional: registry key (default "github-app")
export COORDINATOR_GITHUB_APP_NAME=acme-app
```

Both `_ID` + `_SECRET` are required together; partial config fails closed at boot. Co-exists with `COORDINATOR_GITHUB_CLIENT_ID` + `_SECRET` (OAuth App) -- the picker UI on `/auth/login` shows both entry points when both providers are registered. See [`docs/idp-providers.md`](./docs/idp-providers.md#configuring-github-app) for the full setup walkthrough.

### Refresh-token recovery

On `IdPTokenRevoked` from `/user/orgs` at refresh-rotation time, the coordinator calls `GitHubAppProvider.refreshIdpToken(refresh_token)` to mint a fresh access token + rotated refresh token, persists both, and retries the membership check. A Tier 2 `auth.idp.token_refreshed` audit row captures the recovery. If refresh fails too -- existing Tier 1 `auth.idp.token_revoked` + 401 path.

### Out of scope for v0.10.0

- App-as-itself installation token flow for membership queries (v0.10.x exploration; requires PEM private key provisioning)
- Webhook-driven membership cache invalidation (v1.0)
- IdP refresh-token replay detection (the coordinator's reuse logic covers ITS OWN refresh family only)

### Testing

- **1700 tests passing** (+45 vs v0.9.2)
- 19 `GitHubAppProvider` unit tests, 5 refresh-rotation recovery tests, 7 boot wiring tests, plus the shared HTTP transport refactor exercised by the 35 existing OAuth App tests

### v0.10.1 follow-up (2026-05-16) — OIDC nonce verification

OpenID Connect Core 1.0 §3.1.2.1 nonce verification. `OIDCProvider` generates a 256-bit nonce per authorize request, persists it in `oauth_state`, and verifies the returned `id_token`'s `nonce` claim against it. Guards against `id_token` replay across authorize requests issued for the same client. New nullable `oauth_state.nonce` column (idempotent migration). 1708 tests; +8 vs v0.10.0. Other providers unaffected; CLI auth-code grant path skips the check (PKCE + state binding still apply).

### v0.10.2 follow-up (2026-05-16) — Google Workspace `hd` allowlist

New `orgs.allowlist_idp_org_id` column + per-provider `IdPProvider.allowlistStrategy` field. `GoogleProvider` switches to the `"idp_org_id"` strategy and matches the user's Workspace `hd` (hosted domain) claim against the new column. The previous behaviour (where Google sign-in didn't work end-to-end because `listMemberships` threw) is now fixed. GitHub OAuth App + GitHub App keep the existing `"memberships"` strategy. Allowlist is now per-provider: 4 strategies total — `memberships` / `idp_org_id` / `id_token_groups` / `none`. 1714 tests; +6.

### v0.10.3 follow-up (2026-05-16) — GitHub App installation-footprint allowlist

`GitHubAppProvider` gains opt-in `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE=user_installations` mode. Calls `GET /user/installations` instead of `/user/orgs` and matches against `orgs.allowlist_github_org`. The App's installation footprint IS the allowlist — uninstalling the App from an org is an immediate hard revoke (within 8h of next refresh-rotation) with no coordinator config change required. No App RSA private key needed; the user's user-to-server token is sufficient. Default remains `user_orgs` (mirrors OAuth App behaviour). 1724 tests; +10.

### v0.10.4 follow-up (2026-05-16) — OIDC group-claim allowlist

`OIDCProvider` learns to read group / role memberships from a configurable id_token claim path. New `COORDINATOR_OIDC_GROUPS_CLAIM` env var (typical values: `groups` for Okta/Auth0/Authentik, `realm_access.roles` for Keycloak, `roles` for Azure AD App Roles). When set, `allowlistStrategy` switches from `"none"` (deny-by-default) to `"id_token_groups"`; the callback matches `IdpUserInfo.groups` (lowercased) against `orgs.allowlist_github_org`. Misconfig (wrong path, non-array value, non-string entries) fails closed. Groups captured at sign-in only — refresh-rotation does not re-fetch. 1740 tests; +16.

---

## What's New in v0.5.0

Released 2026-05-10.

### A. In-flight tracking (server-anchored)

- `WorkingFilesTracker` ([`src/working-files-tracker.ts`](src/working-files-tracker.ts)) with TTL sweeper (default 30 min claim, 60 s sweep tick).
- `POST /api/working-files/start` and `POST /api/working-files/stop` REST endpoints.
- essaim hooks: `scripts/pre_track_activity.sh` + extended `track_activity.sh` via PreToolUse / PostToolUse pipeline.

### B. Symbol-aware annotations (tree-sitter)

- 15 languages via `optionalDependencies`: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java, C#, C, C++, Ruby, PHP, Kotlin, Swift, Bash.
- Strategy registry in [`src/tree-sitter-extractor.ts`](src/tree-sitter-extractor.ts) — adding a 16th language is ~5 LOC.
- `POST /api/file-activity` now accepts an optional `content` field (capped 256 KB) for server-side symbol extraction.
- New DB columns: `file_activity.symbols_touched` (JSON) + `content_hash`.

### C. Layer 0.5 annotation — disjoint-symbol enrichment

- Same file with disjoint symbols: score stays 100, reason text enriched with `disjoint symbols: you=[X], them=[Y] — verify shared module state`.
- New optional `target_symbols?: string[]` on `announce_work` (cap 200 elements, max 256 chars each).

### D. Layer 4 — git co-change scoring

- [`src/git-cochange-builder.ts`](src/git-cochange-builder.ts): bounded `git log` (max 2000 commits, `--since=7d` default), 5 s timeout, denylist (lockfiles, dist, snapshots), dynamic 40% predictor cap.
- Score 60 if co-change ratio > 0.5, score 40 if > 0.2; canonical-pair lookup.
- Background scheduler with 5-min retry on timeout, 30-min refresh on success.
- Requires `COORDINATOR_REPO_ROOT` to enable + `git` on PATH.

### E. Dashboard "Conflict signals" panel

- New panel in `dashboard/public/index.html` backed by `GET /api/scoring-stats?since=<dur>`.
- Populated by `runCommonAnnounceFlow` writing per-firing rows to `layer_firings` table.

### Hardening & observability

- `parseBody` 1 MB cap (HTTP 413; env: `COORDINATOR_MAX_BODY_BYTES`).
- `PRAGMA user_version = 6` schema marker; daemon refuses to start on a newer DB (downgrade guard).
- [`src/path-normalize.ts`](src/path-normalize.ts) — symmetric Windows/POSIX path canonicalization.
- 5 new Prometheus metrics: `mcp_coordinator_working_files_active` (gauge), `mcp_coordinator_working_files_starts_total{result}`, `mcp_coordinator_tree_sitter_parse_failures_total`, `mcp_coordinator_git_cochange_builds_total{outcome}`, `mcp_coordinator_git_cochange_pairs_total`.
- `/readyz` extended with `tree_sitter` and `git_cochange` blocks (both `optional: true`, non-gating).

### Bundled v0.4.1 hotfix

`/livez`, `/readyz`, and `/metrics` were wired in v0.4.0 but not routed — fixed.

---

## Roadmap

### v0.8.0 (shipped 2026-05-14)

Phase 2 OAuth 2.1 + RFC 8628 device flow + cookie sessions + service tokens + audit pipeline + sweeper + 29 Prometheus metrics + reference SDK. Feature-flagged behind `COORDINATOR_OAUTH_ENABLED=true`; Phase 1 deployments byte-identical when unset. 1555 tests passing across 116 files.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

### v0.8.1 (shipped 2026-05-15)

JWT key rotation overlap (prev-secret support) + GHES env vars wiring.

### v0.9.0 (shipped 2026-05-15)

Multi-IdP: `ProviderRegistry` class + first-class `GoogleProvider` (id_token verification with JWKS) + generic `OIDCProvider` (discovery + JWKS) for Okta / Auth0 / Azure AD / Keycloak / Authentik + `/auth/login` picker UI when 2+ providers are registered. Single-provider deployments stay behaviour-compatible. 1623 tests.

### v0.9.1 (shipped 2026-05-15)

Audit log tamper-evidence (SHA-256 hash chain on every `audit_log` row + `verify-audit-chain.ts` operator script + SOC 2 Type II runbook).

### v0.9.2 (shipped 2026-05-15)

`mcp-coordinator rotate-jwt-secret` CLI helper + auto-rotation operator runbook.

### v0.10.0 (shipped 2026-05-16)

`GitHubAppProvider` sibling to the OAuth App provider, with built-in user-to-server token refresh handling. New env vars `COORDINATOR_GITHUB_APP_CLIENT_ID` / `_SECRET` / `_NAME`. Co-exists with OAuth App. 1700 tests.

### v0.10.1 (shipped 2026-05-16)

OIDC `nonce` claim verification (OpenID Connect Core 1.0 §3.1.2.1). `OIDCProvider` now generates a 256-bit nonce per authorize request, persists it in `oauth_state`, and verifies the returned `id_token`'s `nonce` claim against it. Guards against id_token replay across authorize requests. Other providers unaffected.

### v0.10.2 (shipped 2026-05-16)

Google Workspace allowlist. New `orgs.allowlist_idp_org_id` column + per-provider `IdPProvider.allowlistStrategy` field. `GoogleProvider` switches to the `"idp_org_id"` strategy and matches the user's `hd` (hosted domain) claim against the new column. GitHub OAuth App + GitHub App keep the existing memberships strategy.

### v0.10.3 (shipped 2026-05-16)

GitHub App installation-footprint allowlist. `GitHubAppProvider` gains an opt-in `allowlistSource="user_installations"` mode (via `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE`) where the org allowlist is driven by the App's installation footprint via `GET /user/installations` rather than the user's GitHub-org memberships. Uninstalling the App from an org becomes a hard revoke. No App RSA private key needed.

### v0.10.4 (shipped 2026-05-16)

OIDC group-claim allowlist. `OIDCProvider` learns to read group / role memberships from a configurable id_token claim path (`COORDINATOR_OIDC_GROUPS_CLAIM` — `groups` for Okta/Auth0/Authentik, `realm_access.roles` for Keycloak). When set, `allowlistStrategy` switches to `id_token_groups` and matches against `orgs.allowlist_github_org`. Misconfig fails closed.

### v0.5.0 (shipped 2026-05-10)

Working-files in-flight tracking, tree-sitter symbol annotations across 15 languages, git co-change Layer 4 scoring, dashboard Conflict signals panel, schema downgrade guard, 5 new Prometheus metrics.

### Planned

- **v0.10.x** — Encryption-at-rest for `users.idp_refresh_token` + `users.idp_access_token` (currently plaintext); admin web UI for org allowlist management.
- **v0.11** — Postgres adapter for regulated multi-instance workloads (Phase 4; see [`docs/superpowers/specs/2026-05-16-postgres-adapter-design.md`](./docs/superpowers/specs/2026-05-16-postgres-adapter-design.md) for the honest scope assessment).
- **v1.0** — Phase 5 multi-instance (Redis pub/sub for membership cache invalidation + token_epoch reads + rate-limit + sweeper leader election).

### Open items / known issues

- T40c SDK enhancements: keytar keychain integration, Windows DPAPI for token file, named-profile TOML config, discovery doc 24h cache
- T33 perf bench + chaos suite (next sprint)
- Encryption-at-rest (v0.7.5 deferred) — SQLCipher whole-DB encryption
- v0.5.0 dashboard Conflict signals widget shows aggregated counts only; per-layer outcome breakdown (`auto_resolved`, `consensus`, `timeout`, `cancelled`) currently returns zeros — the `layer_firings` table is not yet joined against the `events` table (decorative, not blocking).
- CHANGELOG has both an auto-generated `## [0.5.0]` block (from release-please) and a stale manual `## [0.6.0]` heading from the original plan — cosmetic, will be reconciled in a doc-only commit.

---

## MCP Tools

26 tools organized by function. All registered under one HTTP/SSE transport at `/mcp` (and stdio for stdio-mode clients).

### Agent registry

| Tool | Description |
|------|-------------|
| `register_agent` | Register as online with name and module list |
| `list_agents` | List all registered online agents |
| `heartbeat` | Update last-seen and derive activity status |
| `agent_activity` | Get activity status for all online agents |
| `wait_for_peers` | Block until N peers online, or timeout (prevents race before first announce) |

### Consultation

| Tool | Description |
|------|-------------|
| `announce_work` | Open a consultation thread — the main entry point before coding |
| `post_to_thread` | Post a message (warning, context, question) to an open thread |
| `propose_resolution` | Submit a resolution proposal for participants to approve |
| `approve_resolution` | Approve the current resolution proposal |
| `contest_resolution` | Reject the proposal with a reason — resets to `open` |
| `close_thread` | Close a thread after work is complete |
| `cancel_thread` | Cancel a thread (work abandoned or no longer relevant) |
| `get_thread` | Get a thread with all messages and current status |
| `get_thread_updates` | Poll for new messages since a timestamp |
| `list_threads` | List threads, filterable by status or agent |
| `log_action_summary` | Log a one-liner action summary for the dashboard timeline |

### File tracking

| Tool | Description |
|------|-------------|
| `hot_files` | List files being edited by multiple agents |
| `get_session_files` | Get all files edited by an agent in the current session |
| `check_file_conflict` | Check whether another agent edited a given file recently |

### Dependency map

| Tool | Description |
|------|-------------|
| `set_dependency_map` | Load a module dependency graph (JSON) |
| `get_blast_radius` | Calculate which other modules are affected by changes |
| `get_module_info` | Get dependency and dependent info for a module |

### MQTT

| Tool | Description |
|------|-------------|
| `wait_for_message` | Block until a coordination message arrives on the agent's topic |
| `get_queued_messages` | Drain all queued messages without blocking |
| `mqtt_publish` | Publish a raw message to any MQTT topic |

### Status

| Tool | Description |
|------|-------------|
| `coordinator_status` | Full system status: agents, threads, file activity, MQTT, quota |

The in-server `introspection` tool returns the full schema for every tool — point any MCP client at it for live discovery.

---

## CLI

Two distribution channels:

- **npm** — `npm install -g mcp-coordinator`. Requires Node.js 20+.
- **Single-file binary** — Bun-compiled, no Node required. Download the matching tarball from a [GitHub Release](https://github.com/swoofer/mcp-coordinator/releases).

### Commands

| Command | Description |
|---------|-------------|
| `mcp-coordinator init [--url <url>] [--write-mcp-config <path>] [--write-claude-md <path>]` | First-time setup — create config dir, default `config.json`, print/write the `.mcp.json` snippet, optionally scaffold a sample `CLAUDE.md` |
| `mcp-coordinator uninstall [--mcp-config <path>] [--claude-md <path>] [--purge] [--force]` | Remove integrations: drop `coordinator` entry from a `.mcp.json`, strip the coordination section from a `CLAUDE.md`, or `--purge` the `~/.mcp-coordinator/` directory entirely |
| `mcp-coordinator server start [--port N] [--data-dir PATH] [--daemon]` | Start the coordinator (foreground or daemon) |
| `mcp-coordinator server stop` | Stop the coordinator |
| `mcp-coordinator server status` | PID, port, online agents, open threads |
| `mcp-coordinator server logs [-n N] [-f]` | Tail the daemon log at `~/.mcp-coordinator/logs/server.log` |
| `mcp-coordinator dashboard` | Open `http://localhost:3100/dashboard` |
| `mcp-coordinator doctor [--host H] [--port P] [--mqtt-port P]` | Health check: config, server liveness, `/health`, `/mcp` initialize, dashboard, MQTT broker |
| `mcp-coordinator --version` | Print the installed version |

### Quick start

```bash
# Start the coordinator (embedded MQTT + dashboard)
mcp-coordinator server start --daemon

# Open the dashboard
mcp-coordinator dashboard

# Stop when done
mcp-coordinator server stop
```

### In-process from your own Node app

```ts
import { startServer } from "mcp-coordinator";

await startServer({
  port: 3100,
  dataDir: "./coordinator-data",
});
```

---

## Standalone use — without an orchestrator

You don't need an orchestrator. mcp-coordinator works on its own with any MCP-compatible client — Claude Code, Cursor, Cline, Aider, custom scripts. The two most common setups:

### Solo developer, multiple Claude Code sessions

You're running 2-3 Claude Code sessions in parallel on the same repo and want them to see each other's work. One coordinator instance handles all of them.

```bash
# In one terminal: start the coordinator
mcp-coordinator server start --daemon
```

Then add the coordinator to each Claude Code session's `.mcp.json` (located at `~/.claude/.mcp.json` for the global config, or `<your-project>/.mcp.json` for per-project):

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Each Claude session now has access to all 26 coordination tools (`register_agent`, `announce_work`, `post_to_thread`, etc.). Open `mcp-coordinator dashboard` in a browser to watch real-time activity across your sessions.

### Team setup — shared coordinator on LAN

One person hosts the coordinator on a shared machine; teammates point their Claude at it.

Host:

```bash
# Bind to all interfaces; default is 127.0.0.1
COORDINATOR_BIND=0.0.0.0 mcp-coordinator server start --daemon
```

Each teammate's `.mcp.json` points to the host's IP:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://192.168.1.42:3100/mcp"
    }
  }
}
```

For internet-facing or multi-tenant deployments, enable JWT auth (see [Authentication](#authentication)). Each teammate registers via `POST /api/auth/register` with the team's `COORDINATOR_REGISTRATION_SECRET`, gets a Bearer token, and adds it to their `.mcp.json`:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "https://coordinator.example.com/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

### Telling Claude to use the coordinator tools

Without a behavior catalog (which is what [essaim](https://github.com/swoofer/essaim) ships), you instruct Claude manually. Easiest path:

```bash
# In your project root — scaffolds CLAUDE.md with coordinator instructions
mcp-coordinator init --write-claude-md ~/my-repo --write-mcp-config ~/my-repo
```

This appends a clearly-marked `mcp-coordinator:coordination-section` block to `~/my-repo/CLAUDE.md` (creating it if absent, replacing the section if it already exists). Combined with `--write-mcp-config`, your project is fully wired in one command.

If you'd rather embed the instructions yourself (or you're not using Claude Code), the section reads roughly:

> Before modifying any source file, register with the coordinator MCP server:
>
> 1. Call `register_agent` with your name and the modules you'll touch
> 2. Call `announce_work` describing what you'll do, listing target files (and `depends_on_files` if applicable)
> 3. If a thread is created (consultation triggered), wait for the resolution before writing code
> 4. After a meaningful change, call `log_action_summary` to update the dashboard timeline
> 5. If another agent is already working on a file you need to touch, post a question to the thread via `post_to_thread` and wait for their response before proceeding
>
> Use the `coordinator_status` tool to see current activity at any time.

That's all you need to start coordinating. The dashboard shows live who's doing what; the SQLite database persists threads across sessions; conflicts are detected before code is written.

### Push vs polling — important architectural note

Vanilla Claude Code talks to mcp-coordinator over MCP (HTTP/stdio request-response). It **does not subscribe to MQTT**. That means events the coordinator publishes on MQTT (`coordinator/consultations/new`, etc.) are not auto-delivered to a Claude Code session — Claude has to **poll** the coordinator to discover new activity. The polling pattern is:

- `announce_work` returns the thread ID immediately if a conflict is detected — that's the most important checkpoint
- After that, periodic calls to `coordinator_status` / `list_threads` / `get_thread_updates` surface new posts on threads you're a participant in
- The CLAUDE.md scaffolded by `mcp-coordinator init --write-claude-md` instructs Claude to do exactly this polling

If you want **real-time push** (every coordination event interrupting Claude between turns instead of waiting for a poll), use [essaim](https://github.com/swoofer/essaim). essaim ships an agent-loop wrapper that subscribes to the MQTT broker and injects events into the turn flow automatically. mcp-coordinator alone supports the polling model — which is sufficient for most use cases (2-3 Claude sessions on a small team) and zero-config to set up.

### End-to-end example: two Claudes coordinating (polling model)

Two terminals, same repo, both Claude Code sessions wired to the same local coordinator. Both sessions have a `CLAUDE.md` scaffolded by `mcp-coordinator init --write-claude-md`, which instructs Claude to register, announce, and poll. The conversation below is what each Claude does — the human user just asks each Claude to make a change.

```
TERMINAL 1 (Alice)                        TERMINAL 2 (Bob)

$ claude                                  $ claude
> "Add updated_at to User type in         > "Migrate User schema"
   src/models/user.ts"                       (touches src/models/user.ts)

[Alice's Claude]                          [Bob's Claude]
register_agent(name="Alice", ...)         register_agent(name="Bob", ...)
announce_work(
  target_files: ["src/models/user.ts"]
)
→ response: { thread_id: null,
              concerned_agents: [] }      announce_work(
                                            target_files: ["src/models/user.ts",
                                                           "migrations/004.sql"]
                                          )
                                          → response: { thread_id: "T-1",
                                                        concerned_agents: ["alice"],
                                                        score: 100, layer: "0a" }
                                          [Bob sees the conflict in the response]
                                          get_thread("T-1")
                                          post_to_thread("T-1", type: "context",
                                            content: "full schema migration; can
                                            wait for your field to land first")

[Alice writes the field, then before                                            
 next major action the CLAUDE.md says
 "poll coordinator_status"]
coordinator_status()
→ response: shows T-1 with Bob's post
get_thread("T-1")
post_to_thread("T-1", type: "context",
  content: "adding 1 field at line 42,
  no rename. Done in 5 min.")
propose_resolution("T-1",
  content: "Alice's field first,
  Bob runs migration after")

                                          [Bob's CLAUDE.md polling step]
                                          coordinator_status()
                                          → shows T-1 in 'resolving' state
                                          get_thread("T-1")
                                          approve_resolution("T-1")

[Alice's next poll]
coordinator_status()
→ T-1 status = 'resolved'
[Alice writes the field]                  [Bob writes the migration]
log_action_summary(...)                   log_action_summary(...)
```

The dashboard at `http://localhost:3100/dashboard/` plays the entire timeline live. `mcp-coordinator server logs -f` (in a third terminal) tails the daemon log if you want to see the protocol-level events. If polling cadence is too coarse and you find Claude missing posts, switch to essaim's agent-loop, which delivers MQTT events automatically.

### Team setup walkthrough — shared coordinator with JWT

Full step-by-step for a team running a coordinator on a shared host with internet-facing or multi-tenant access. Adjust to your network/TLS reality.

**Step 1 (host) — generate secrets**

```bash
# 32+ char shared secret; put in your secrets manager and inject as env vars
JWT_SECRET=$(openssl rand -hex 32)
REGISTRATION_SECRET=$(openssl rand -hex 32)
ADMIN_SECRET=$(openssl rand -hex 32)
```

**Step 2 (host) — start the coordinator with auth enabled**

```bash
COORDINATOR_AUTH_ENABLED=true \
COORDINATOR_JWT_SECRET="$JWT_SECRET" \
COORDINATOR_REGISTRATION_SECRET="$REGISTRATION_SECRET" \
COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" \
COORDINATOR_BIND=0.0.0.0 \
mcp-coordinator server start --daemon --port 3100
```

(Front the server with TLS via nginx/Caddy/etc. for internet exposure. Local LAN can use plain HTTP.)

**Step 3 (each teammate) — request a token**

```bash
curl -X POST https://coordinator.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"alice","registration_secret":"<REGISTRATION_SECRET shared via team channel>"}'
# Response: { "agent_id": "alice-abc123", "token": "eyJ...", "expires_at": "...", "role": "agent" }
```

**Step 4 (each teammate) — wire `.mcp.json`**

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "https://coordinator.example.com/mcp",
      "headers": { "Authorization": "Bearer <paste-token-here>" }
    }
  }
}
```

**Step 5 (each teammate) — run `init --write-claude-md` to scaffold project instructions**, OR add the coordination section to their existing `CLAUDE.md`.

**Step 6 (each teammate) — verify**: `mcp-coordinator doctor --host coordinator.example.com --port 443` should show all checks green from any laptop.

**Token rotation**: tokens expire per `COORDINATOR_JWT_EXPIRY` (default 24h). Refresh via `POST /api/auth/refresh` with the current Bearer token. The admin can revoke a specific agent via `POST /api/auth/revoke` (admin token required).

### Logs and debugging

The daemon writes to `~/.mcp-coordinator/logs/server.log`. Tail it:

```bash
mcp-coordinator server logs           # last 50 lines
mcp-coordinator server logs -n 200    # last 200 lines
mcp-coordinator server logs -f        # follow (Ctrl+C to stop)
```

For a one-shot check that everything is wired up correctly (config valid, server up, MCP responds, dashboard reachable, MQTT accepting connections), use the doctor:

```bash
mcp-coordinator doctor
```

`doctor` exits non-zero if any check fails and prints actionable hints next to each failure. Probe a remote coordinator with `--host` and `--port`:

```bash
mcp-coordinator doctor --host coordinator.example.com --port 443 --mqtt-port 1883
```

Logging level is controlled by `LOG_LEVEL` (`debug`, `info`, `warn`, `error` — default `info`). Set `NODE_ENV=development` for human-readable pretty logs:

```bash
NODE_ENV=development LOG_LEVEL=debug mcp-coordinator server start
```

### Removing the integration (per-project or globally)

Symmetric to `init`, the `uninstall` command undoes what was added without touching anything you wrote yourself.

```bash
# Remove coordinator from a project's .mcp.json AND strip its section from CLAUDE.md
mcp-coordinator uninstall --mcp-config ~/my-repo --claude-md ~/my-repo

# Wipe the global config dir (~/.mcp-coordinator/) entirely — config + data + logs + pid file
mcp-coordinator uninstall --purge          # asks for confirmation
mcp-coordinator uninstall --purge --force  # skip the prompt, useful in scripts
```

`--mcp-config <path>` reads `<path>/.mcp.json`, removes only the `coordinator` server entry (other servers untouched), and deletes the file if it ends up empty. `--claude-md <path>` removes only the block delimited by the `mcp-coordinator:coordination-section` sentinels (rendered as HTML comments around the section) — it never touches text you authored. Combine flags as needed; if the resulting `CLAUDE.md` is empty, it's deleted.

To remove the npm package itself: `npm uninstall -g mcp-coordinator`.

### Running multiple coordinators on the same machine

Useful for per-project isolation — every project gets its own ephemeral coordinator with no cross-contamination. Pick distinct ports + data dirs:

```bash
# Project A
PORT=3110 \
COORDINATOR_MQTT_TCP_PORT=11883 \
mcp-coordinator server start --daemon --data-dir ./.mcp-coordinator-A

# Project B (different terminal)
PORT=3120 \
COORDINATOR_MQTT_TCP_PORT=12883 \
mcp-coordinator server start --daemon --data-dir ./.mcp-coordinator-B
```

The default `~/.mcp-coordinator/server.pid` only tracks ONE daemon at a time. For multi-instance runs, pass `--data-dir` explicitly to each instance — the PID file lives next to the data dir, so multiple instances don't fight over the same file. To stop a specific instance, `cd` to its data dir's parent and run `mcp-coordinator server stop` from there, OR `kill $(cat ./.mcp-coordinator-A/../server.pid)`.

In each project's `.mcp.json`, point at the project's coordinator:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://localhost:3110/mcp"
    }
  }
}
```

This pattern works well alongside `essaim`, which uses Strategy A (in-process) and starts its own ephemeral coordinator per `essaim run` — there's no port conflict because essaim picks an isolated dir by default.

---

## Anthropic Quota Pre-flight

The coordinator tracks Anthropic workspace quota live and exposes it on MQTT, the dashboard, and the `coordinator_status` MCP tool — so MCP clients can decide whether to abort, throttle, or proceed before launching expensive turns.

- Reads usage from the Anthropic API using the key in the environment.
- Threshold via `MAX_QUOTA_PCT` env var (default `95`).
- Back-off when the usage endpoint itself returns 429.
- Live widget in the dashboard with manual refresh + historical buckets.
- `coordinator/quota/update` MQTT events stream into the timeline by default.

Orchestrators that spawn N agents at once can read `coordinator_status.quota` and abort their run if utilization is over a configured threshold — the [essaim](https://github.com/swoofer/essaim) reference orchestrator does exactly this.

---

## Token Observability

Every MCP tool call and agent turn is logged with token breakdown.

- **Logs** — component logger `tokens` emits `input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `thinking`, model id, turn index.
- **Dashboard** — live per-agent token gauge, cumulative session total, quota widget.

Aggregating across runs (e.g., `reports/YYYY-MM-DD-<run-id>.md`) is an orchestrator responsibility — the coordinator emits the events, the orchestrator consumes them.

---

## Dashboard

`http://localhost:3100/dashboard` (or `/dashboard` on whichever port the coordinator is bound to).

- **Timeline** — all threads + `quota_update` events with scores and resolution types
- **Agent panel** — online/offline, working/idle/waiting, current file, thread being waited on. Resizable drag handle.
- **Scoring breakdown** — which detection layer triggered each conflict
- **Quota widget** — live utilization %, stacked buckets, manual refresh button
- **Version banner** — server version shown in the header (dynamic, not hardcoded)
- **Consensus metrics** — per session: consensus / timeout / auto-resolved split, token totals

All events arrive via SSE on `/api/events`. No polling.

---

## Agent Activity States

| Status | Indicator | Meaning |
|--------|-----------|---------|
| working | pulsing blue | Actively editing files |
| idle | solid green | Online, no recent activity |
| waiting | pulsing yellow | Blocked on a consultation thread |
| offline | solid red | Disconnected or session ended |

Activity is derived from heartbeats enriched with the current file/thread context from the file tracker.

---

## Configuration

### Local data

```
~/.mcp-coordinator/
├── config.json          # persistent configuration
├── data/
│   └── coordinator.db   # SQLite database
├── server.pid           # PID file (when daemonized)
└── logs/
    └── server.log       # daemon logs
```

### config.json

```json
{
  "server": { "port": 3100, "data_dir": "~/.mcp-coordinator/data" },
  "defaults": { "coordinator_url": "http://localhost:3100" }
}
```

Resolution priority (highest to lowest): CLI flag → env var → config.json → default.

### Server env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP port (also serves MQTT-over-WebSocket on `/mqtt`) |
| `COORDINATOR_DATA_DIR` | `~/.mcp-coordinator/data` | Directory for the SQLite database |
| `COORDINATOR_MQTT_TCP_PORT` | `1883` | TCP port for the embedded broker |
| `COORDINATOR_MQTT_WS_PATH` | `/mqtt` | WebSocket path on the same HTTP port |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | — | `development` for pretty logs |
| `COORDINATOR_AUTH_ENABLED` | `false` | Enable JWT authentication |
| `COORDINATOR_JWT_SECRET` | — | HMAC signing key (min 32 chars) |
| `COORDINATOR_JWT_EXPIRY` | `24h` | Token lifetime (e.g., `1h`, `7d`) |
| `COORDINATOR_REGISTRATION_SECRET` | — | Shared secret for agent auto-register |
| `COORDINATOR_ADMIN_SECRET` | — | Separate secret for admin token creation |
| `MAX_QUOTA_PCT` | `95` | Pre-flight abort threshold for Anthropic quota |

### Environment variables (v0.5+)

| Variable | Default | Effect |
|---|---|---|
| `COORDINATOR_REPO_ROOT` | (unset → team-mode) | Repo root for path-guard, FS fallback, Layer 4 |
| `COORDINATOR_MAX_BODY_BYTES` | `1048576` | parseBody hard cap |
| `COORDINATOR_LAYER4_DENYLIST` | (uses defaults) | Comma-separated globs appended to denylist |
| `COORDINATOR_LAYER4_SINCE_DAYS` | `7` | git log --since window |
| `COORDINATOR_LAYER4_MAX_COMMITS` | `2000` | git log --max-count |
| `COORDINATOR_LAYER4_REFRESH_INTERVAL_MS` | `1800000` | Refresh on success |
| `COORDINATOR_LAYER4_RETRY_MS` | `300000` | Retry on timeout |
| `COORDINATOR_WORKING_FILES_TTL_MIN` | `30` | working_files claim TTL |
| `COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS` | `60000` | TTL sweeper tick |

### Phase 2 OAuth env vars (v0.8.0+)

All Phase 2 vars are inert when `COORDINATOR_OAUTH_ENABLED` is unset. Setting OAuth on requires the **required** rows; everything else is opt-in. The canonical source-of-truth is [`.env.example`](./.env.example) (annotated, copy-pasteable).

**Required when `COORDINATOR_OAUTH_ENABLED=true`** (5 vars):

| Variable | Effect |
|----------|--------|
| `COORDINATOR_OAUTH_ENABLED` | Master feature flag. Set to `true` to enable Phase 2. |
| `COORDINATOR_JWT_SECRET` | HS256 signing key for issued tokens. Min 128 bits of entropy (rejected at boot otherwise). Generate via `mcp-coordinator rotate-jwt-secret --format secret-only`. |
| `COORDINATOR_PUBLIC_URL` | Externally-visible URL of the coordinator (`https://...`). Used to build OAuth `redirect_uri`. Validated http(s) and non-localhost-requires-https unless `COORDINATOR_INSECURE_COOKIES=true`. |
| `COORDINATOR_GITHUB_CLIENT_ID` | GitHub OAuth App client ID. |
| `COORDINATOR_GITHUB_CLIENT_SECRET` | GitHub OAuth App client secret. |
| `COORDINATOR_GITHUB_ORG` | Allowlisted GitHub org slug; bootstrapped into `orgs.allowlist_github_org`. |

**Optional v0.8 hardening / GHES:**

| Variable | Effect |
|----------|--------|
| `COORDINATOR_GITHUB_AUTH_BASE_URL` | GHES OAuth host override (default `https://github.com`). |
| `COORDINATOR_GITHUB_API_BASE_URL` | GHES REST API host override (default `https://api.github.com`). |
| `COORDINATOR_INSECURE_COOKIES` | `true` to drop `Secure` cookie flag for HTTP non-localhost (NOT recommended for prod). |
| `COORDINATOR_ALLOW_RESTORE` | `true` after restoring from backup (NR12) to authorize `token_epoch` global bump. Unset after first boot. |
| `COORDINATOR_JWT_SECRET_PREV` | Previous JWT signing secret for rotation overlap (v0.8.1). Verify-only under kid `hs256-v0`. |
| `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT` | ISO timestamp recorded in the `config.key_rotation` Tier 1 audit. |
| `COORDINATOR_JWT_ACCESS_TTL` | Access token TTL. Default `15m`, max `60m`. |
| `COORDINATOR_JWT_REFRESH_TTL` | Refresh token TTL. Default `30d`, max `90d`. |
| `COORDINATOR_AUTO_PROVISION` | `false` to require admin pre-creation of users before first sign-in. Default `true`. |
| `COORDINATOR_METRICS_BEARER` | Bearer token gating `/metrics/auth` for remote Prometheus. Unset = localhost-only. |

**Multi-IdP — Google (v0.9.0+, v0.10.2 hd allowlist):**

| Variable | Effect |
|----------|--------|
| `COORDINATOR_GOOGLE_CLIENT_ID` | Google OAuth client ID. Enables Google sign-in. Match against Workspace `hd` claim in `orgs.allowlist_idp_org_id`. |
| `COORDINATOR_GOOGLE_CLIENT_SECRET` | Google OAuth client secret. Both required together; fail-closed at boot. |

**Multi-IdP — generic OIDC (v0.9.0+, v0.10.1 nonce, v0.10.4 groups):**

| Variable | Effect |
|----------|--------|
| `COORDINATOR_OIDC_ISSUER_URL` | Issuer URL; drives discovery via `/.well-known/openid-configuration`. |
| `COORDINATOR_OIDC_CLIENT_ID` | OIDC client ID. |
| `COORDINATOR_OIDC_CLIENT_SECRET` | OIDC client secret. All three required together. |
| `COORDINATOR_OIDC_GROUPS_CLAIM` | (v0.10.4, optional) Dot-notation path to groups in id_token. Common: `groups`, `realm_access.roles`, `roles`. When set, switches allowlist strategy to `id_token_groups`. Without it, OIDC stays deny-by-default. |

**Multi-IdP — GitHub App (v0.10.0+, v0.10.3 installation allowlist):**

| Variable | Effect |
|----------|--------|
| `COORDINATOR_GITHUB_APP_CLIENT_ID` | GitHub App client ID (usually `Iv1.` prefix). Sibling to OAuth App; both can run simultaneously. |
| `COORDINATOR_GITHUB_APP_CLIENT_SECRET` | GitHub App client secret. |
| `COORDINATOR_GITHUB_APP_NAME` | (optional) Registry key for picker UI; default `github-app`. |
| `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE` | (v0.10.3, optional) `user_orgs` (default) or `user_installations`. The latter drives allowlist off App installation footprint instead of user's GitHub-org memberships. |

---

## Structured Logging

[Pino](https://getpino.io/) emits JSON per subsystem. Component loggers: `http`, `mcp`, `mqtt`, `consultation`, `conflict`, `auth`, `tokens`, `quota`.

Production (default):

```json
{"level":"info","time":1712345678901,"component":"http","msg":"Server started","port":3100}
```

Dev (`NODE_ENV=development`):

```
[14:21:03.456] INFO (http): Server started
    port: 3100
```

Levels controlled via `LOG_LEVEL`.

---

## Authentication

The coordinator runs in one of three modes, selected by env-var configuration. **Single-user / dev local stays zero-config**; multi-user deployments opt in to Phase 2 OAuth via a single feature flag.

### Mode 1 — Open (default, no auth)

```bash
mcp-coordinator server start
```

No env vars, no setup, no `/auth/login`. All requests get synthetic legacy claims (`sub="legacy"`, `user_id="legacy"`, `org="default"`, `role="admin"`). MCP tools work unchanged. This is byte-identical to v0.7.x; a 31-case `tests/backcompat/` suite proves the non-regression on every release.

### Mode 2 — JWT (Phase 1, v0.7.x)

Opt-in symmetric JWTs (HS256 via [jose](https://github.com/panva/jose)) without OAuth. Agents self-register against a shared secret; admins revoke via a separate secret.

```bash
export COORDINATOR_AUTH_ENABLED=true
export COORDINATOR_JWT_SECRET="$(openssl rand -base64 32)"
export COORDINATOR_REGISTRATION_SECRET="team-shared-secret"
export COORDINATOR_ADMIN_SECRET="admin-only-secret"
```

```bash
# Agent self-register
curl -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"my-agent","registration_secret":"team-shared-secret"}'
# → { agent_id, token, expires_at, role }

# Refresh
curl -X POST http://localhost:3100/api/auth/refresh \
  -H "Authorization: Bearer <current-token>"

# Admin revoke
curl -X POST http://localhost:3100/api/auth/revoke \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-to-revoke"}'
```

Exempt routes: `GET /health`, `POST /api/auth/register`, `POST /api/auth/refresh`, `GET /api/events` (SSE).

### Mode 3 — Phase 2 OAuth (v0.8.0+, the modern path)

Full OAuth 2.1 + RFC 8628 device flow + cookie sessions + service tokens + audit-chain tamper-evidence + multi-IdP picker. Activate by setting `COORDINATOR_OAUTH_ENABLED=true`; Phase 1 deployments are unaffected when the flag is unset.

#### Quick start (single IdP — GitHub OAuth App)

```bash
export COORDINATOR_OAUTH_ENABLED=true
export COORDINATOR_JWT_SECRET=$(openssl rand -base64 32)
export COORDINATOR_PUBLIC_URL=https://coordinator.example.com

# GitHub OAuth App
export COORDINATOR_GITHUB_CLIENT_ID=<from-github-oauth-app>
export COORDINATOR_GITHUB_CLIENT_SECRET=<from-github-oauth-app>
export COORDINATOR_GITHUB_ORG=<your-org-slug>

mcp-coordinator init phase2     # interactive wizard
mcp-coordinator server start
```

The first user to sign in via `${PUBLIC_URL}/auth/login` becomes the bootstrap admin atomically. Full walkthrough: [`docs/onboarding-self-host.md`](./docs/onboarding-self-host.md).

#### Multi-IdP matrix (v0.9.0 → v0.10.4)

Configure any subset of the 4 providers simultaneously — `/auth/login` automatically renders a picker page when `>=2` are registered. Each provider can be opted in / out independently; `COORDINATOR_GITHUB_CLIENT_ID` is the only one always required.

| Provider | Required env vars | Allowlist strategy | Allowlist column |
|----------|-------------------|--------------------|------------------|
| **GitHub OAuth App** | `COORDINATOR_GITHUB_CLIENT_ID` + `_SECRET` + `COORDINATOR_GITHUB_ORG` | `memberships` (default) | `orgs.allowlist_github_org` |
| **GitHub App** (v0.10.0+) | `COORDINATOR_GITHUB_APP_CLIENT_ID` + `_SECRET` | `memberships` (default) OR `memberships` via installation-footprint when `COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE=user_installations` (v0.10.3) | `orgs.allowlist_github_org` |
| **Google** (v0.9.0+) | `COORDINATOR_GOOGLE_CLIENT_ID` + `_SECRET` | `idp_org_id` (v0.10.2; Workspace `hd` claim) | `orgs.allowlist_idp_org_id` |
| **Generic OIDC** (v0.9.0+) | `COORDINATOR_OIDC_ISSUER_URL` + `_CLIENT_ID` + `_CLIENT_SECRET` | `none` by default; switches to `id_token_groups` when `COORDINATOR_OIDC_GROUPS_CLAIM` is set (v0.10.4) | `orgs.allowlist_github_org` |

Setting partial credentials for any provider fails closed at boot (BootValidationError). Detailed setup per provider: [`docs/idp-providers.md`](./docs/idp-providers.md).

#### Allowlist strategy semantics

All four strategies are case-insensitive string matches against the relevant `orgs` column. Tie-break is alphabetical (deterministic per V4 FIX 22).

- **`memberships`** — Provider's `listMemberships(accessToken)` returns an array of strings, each matched against `orgs.allowlist_github_org`. Used by GitHub OAuth App (`/user/orgs` → GitHub orgs) and GitHub App (`/user/orgs` OR `/user/installations` per `_ALLOWLIST_SOURCE`).
- **`idp_org_id`** — `IdpUserInfo.idp_org_id` matched directly against `orgs.allowlist_idp_org_id`. Used by Google (the `hd` Workspace claim).
- **`id_token_groups`** — Groups extracted from the id_token at a configurable dot-notation path (`COORDINATOR_OIDC_GROUPS_CLAIM`, typical values: `groups` / `realm_access.roles` / `roles`). Used by OIDC.
- **`none`** — Deny by default. Used by OIDC when no groups claim is configured. Operators wanting a custom OIDC allowlist vendor a subclass.

Refresh-rotation re-checks the IdP-side allowlist only for `memberships` providers. `idp_org_id` and `id_token_groups` strategies are sign-in-only — operator-side revocation requires `token_epoch` bump.

#### Sample `orgs` provisioning

```sql
-- GitHub OAuth App + GitHub App (memberships): use allowlist_github_org
INSERT INTO orgs (id, name, allowlist_github_org)
VALUES ('org-acme-gh', 'Acme GitHub', 'acme');

-- Google Workspace (idp_org_id): use allowlist_idp_org_id
INSERT INTO orgs (id, name, allowlist_idp_org_id)
VALUES ('org-acme-google', 'Acme Workspace', 'acme.com');

-- OIDC with groups claim (id_token_groups): reuses allowlist_github_org
INSERT INTO orgs (id, name, allowlist_github_org)
VALUES ('org-acme-okta', 'Acme via Okta', 'engineers');
```

A user signs in once per provider; their `users.idp_provider` stays sticky. Identities are not auto-merged across providers — a one-shot SQL reconciliation is needed if you want to consolidate users who signed in via multiple paths.

#### Refresh-token recovery (GitHub App, v0.10.0+)

GitHub App user-to-server tokens expire after 8h. On a 401 at refresh-rotation time, the coordinator automatically calls `refreshIdpToken(refresh_token)` to mint a fresh access+refresh pair, persists both to `users.idp_access_token` / `users.idp_refresh_token`, emits a Tier 2 `auth.idp.token_refreshed` audit, and retries the membership check. Only triggers for providers that implement `refreshIdpToken` (currently `GitHubAppProvider`).

#### Service tokens for CI/CD

```bash
mcp-coordinator service-token issue \
  --user u-admin-123 --org org-acme-001 \
  --scope read --ttl 30d --reason "CI deploy pipeline"
# → Returns access_token (show once)

mcp-coordinator service-token list
mcp-coordinator service-token revoke --jti <jti>
```

90-day max TTL. Admin-only issuance. Reason ≥ 10 chars required.

#### OIDC defense-in-depth

- **`nonce` verification** (v0.10.1) — Generated per authorize request, stored in `oauth_state`, verified against `id_token.nonce` at exchange time. Guards against id_token replay across authorize requests. Automatic; no configuration.
- **`id_token` signature verification** (v0.9.0) — RS256 only, JWKS-by-kid lookup from the OIDC discovery doc, `iss` + `aud` checks.
- **Discovery doc `issuer` cross-check** — The discovery doc's own `issuer` field MUST match `COORDINATOR_OIDC_ISSUER_URL`; mismatch fails at first `/auth/login`. Guards against discovery-URL redirect attacks.

#### Operational tooling

| CLI / script | Purpose | Doc |
|--------------|---------|-----|
| `mcp-coordinator init phase2` | Interactive Phase 2 wizard | [onboarding](./docs/onboarding-self-host.md) |
| `mcp-coordinator doctor --phase2` | 8 Phase 2 health probes | — |
| `mcp-coordinator service-token {issue,list,revoke}` | CI/CD tokens | — |
| `mcp-coordinator rotate-jwt-secret [--format env\|json\|secret-only]` | JWT secret rotation helper (v0.9.2) | [auto-rotation](./docs/ops/auto-rotation.md) |
| `tsx scripts/verify-audit-chain.ts [--db <path>] [--json]` | SHA-256 audit chain integrity (v0.9.1) | [audit-integrity](./docs/ops/audit-integrity.md) |

#### Audit log tamper-evidence (v0.9.1)

Every `audit_log` row carries `prev_hash` + `row_hash`. `row_hash = SHA-256(prev_hash || canonical(row_fields))`. The chain proves no in-place tampering of committed rows. Pair with the **tip-attestation workflow** (cron + external signed store, e.g. S3 Object Lock) for full SOC 2 Type II deletion-detection.

Limitations (documented in `src/security/audit-chain.ts` + `docs/ops/audit-integrity.md`):
- `created_at` is NOT in the hash — timestamp rewrites are not detected by the chain alone.
- Deletion of recent rows is indistinguishable from legitimate sweeper retention without external tip-attestation.

#### Documentation

| Doc | Topic |
|-----|-------|
| [`docs/onboarding-self-host.md`](./docs/onboarding-self-host.md) | Zero-to-first-signin walkthrough |
| [`docs/idp-providers.md`](./docs/idp-providers.md) | Per-provider setup (GitHub OAuth App, GitHub App, Google, OIDC, Azure AD) |
| [`docs/openapi.yaml`](./docs/openapi.yaml) | OpenAPI 3.1, 17 endpoints |
| [`docs/security/threat-model.md`](./docs/security/threat-model.md) | STRIDE per asset, 10 residual risks |
| [`docs/ops/upgrade-phase1-to-phase2.md`](./docs/ops/upgrade-phase1-to-phase2.md) | Phase 1 → Phase 2 migration |
| [`docs/ops/key-rotation.md`](./docs/ops/key-rotation.md) | `JWT_SECRET` rotation procedure |
| [`docs/ops/auto-rotation.md`](./docs/ops/auto-rotation.md) | Automation around `rotate-jwt-secret` (systemd / k8s CronJob) |
| [`docs/ops/audit-integrity.md`](./docs/ops/audit-integrity.md) | Audit chain runbook + tip-attestation workflow |
| [`docs/ops/backup-restore.md`](./docs/ops/backup-restore.md) | Litestream + NR12 reconciliation |
| [`docs/gdpr.md`](./docs/gdpr.md) | GDPR Art. 17 procedures |
| [`sdk/README.md`](./sdk/README.md) | TypeScript SDK reference |

### Historical: v0.6.x → v0.7.0 migration

v0.7.0 reworked auth foundation: schema gained `org_id` everywhere, JWTs gained `user_id`/`org` claims, MQTT topics gained an org prefix. Migration runs on first boot of v0.7.0 (`PRAGMA user_version` guard).

Manual JWT-secret rotation (v0.7.0 era, still works in v0.8+):

```bash
export COORDINATOR_JWT_SECRET=new-secret-here
export COORDINATOR_JWT_PREV_SECRET=old-secret-here
# Restart coordinator. Wait one JWT TTL (24h default).
# Then remove COORDINATOR_JWT_PREV_SECRET and restart again.
```

The v0.9.2 `rotate-jwt-secret` CLI automates the new-secret generation step of this procedure.

---

## SDK

A TypeScript reference client lives in [`sdk/`](./sdk/) (not yet published to npm). Install via `npm install file:./sdk` from a consumer project.

```ts
import { McpCoordinatorClient, FileTokenStore, ProactiveRefresh } from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({
  baseUrl: "https://coordinator.example.com",
  store: new FileTokenStore(),
  refreshStrategy: new ProactiveRefresh(),
  refreshLockPath: process.env.HOME + "/.mcp-coordinator/refresh.lock",
});

await client.loadFromStore();
const me = await client.whoami();
```

See [`sdk/README.md`](./sdk/README.md) for the full API.

---

## Test Results

All four coordination scenarios are validated end-to-end by the test suite:

| Scenario | Layer | Score | Category | Outcome |
|----------|-------|------:|----------|---------|
| S1 — Same file | 0a | 100 | concerned | Thread opened → consensus |
| S2 — Same module | 3 | 30 | gray_zone | Auto-resolved, introspection |
| S3 — Dependency | 0b | 80 | gray_zone | Auto-resolved, introspection |
| S4 — No overlap | — | 0 | pass | Auto-resolved immediately |

**Performance:**

| Component | Time |
|-----------|------|
| Conflict detection (no LLM) | < 5 ms |
| MQTT push delivery | < 50 ms end-to-end |
| Full consultation cycle (S1) | 30–45 s |

---

## Integration patterns

### Any MCP client

Connect to `http://localhost:3100/mcp` (HTTP/SSE) or stdio. The server speaks MCP 2024-11-05.

### Custom orchestrator

Spawn agents that connect to the MQTT broker and register via the MCP `register_agent` tool. The orchestrator decides spawn count, lifecycle, and quota gating; the coordinator handles the protocol. See [essaim](https://github.com/swoofer/essaim) for a reference implementation, or write your own.

### Reference catalog of coordinator-aware behaviors

The behaviors that make agents announce-before-write, resolve conflicts, and participate in work-stealing are YAML configs assembled by [@swoofer/promptweave](https://github.com/swoofer/promptweave). See [essaim's behaviors](https://github.com/swoofer/essaim/tree/main/behaviors) for a curated catalog.

---

## Development

```bash
# Tests (392 passing across 35+ files)
npm test
npm run test:watch

# Dev coordinator (tsx, hot reload)
npm run dev          # HTTP / SSE on port 3100
npm run dev:stdio    # stdio mode

# CLI in dev
npm run cli -- server start
npm run cli -- dashboard

# TypeScript build → dist/
npm run build

# Standalone binary (requires Bun)
bun build --compile cli/index.ts --outfile bin/mcp-coordinator
```

### Project structure

```
src/                # Coordinator (npm package surface)
  serve-http.ts     # HTTP/SSE/MCP server entry
  server-setup.ts   # 26 MCP tool registrations
  impact-scorer.ts  # multi-layer conflict detection
  consultation.ts   # Thread lifecycle
  agent-registry.ts # Online agents
  file-tracker.ts   # File edit history
  dependency-map.ts # Module graph
  agent-activity.ts # working/idle/waiting/offline
  mqtt-broker.ts    # Embedded Aedes (TCP + WS)
  mqtt-bridge.ts    # Coordinator → broker fanout
  quota/            # Anthropic quota pre-flight + refresh
  auth.ts           # Optional JWT
  path-normalize.ts         # Symmetric Windows/POSIX path canonicalization
  working-files-tracker.ts  # In-flight claim tracking + TTL sweeper
  git-cochange-builder.ts   # Layer 4 co-change scorer (bounded git log)
  tree-sitter-extractor.ts  # Symbol-aware annotations (15 languages)
  http/handle-health.ts     # /livez, /readyz, /metrics routing
  index.ts          # Stdio entry + programmatic re-exports

cli/                # CLI binary (mcp-coordinator)
  index.ts          # Entry point
  server/           # start / stop / status
  dashboard.ts      # Open dashboard URL
  config.ts         # Config loader
  version.ts        # package.json version helper

tests/unit/         # Vitest — 392 tests, 35+ files
dashboard/public/   # Single-file web dashboard
```

---

## Related projects

- **[@swoofer/promptweave](https://github.com/swoofer/promptweave)** — YAML composer for assembling agent prompts, hooks, and MCP configs. Use it with mcp-coordinator-aware behaviors from essaim.
- **[essaim](https://github.com/swoofer/essaim)** — end-to-end orchestrator that spawns N coordinated agents using `@swoofer/promptweave` + `mcp-coordinator`. Ships the reference catalog of coordinator-aware behaviors.

---

## Support

Solo maintainer. If this project saves you time, consider supporting development:

- [GitHub Sponsors](https://github.com/sponsors/swoofer)
- [Buy Me A Coffee](https://buymeacoffee.com/swoofer)

A star on the repo also helps surface the project to other developers.

---

## License

MIT
