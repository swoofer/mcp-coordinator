# Threat model — Phase 2 authentication

This document is a STRIDE-by-asset threat model for the authentication
and session subsystem shipped in Phase 2 (v0.8.0). It enumerates each
asset the coordinator persists, walks the STRIDE categories (Spoofing,
Tampering, Repudiation, Information disclosure, Denial of service,
Elevation of privilege) for every asset, and cites the implementing
mitigation in the codebase or the deferring task.

References:

- V3 design — `docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design.md`
- V4 patches — `docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design-V4-patches.md`
  (especially V4 §FIX 4 residual risks)
- V2/V3 plan — `docs/superpowers/plans/2026-05-13-auth-phase2-oauth-device-plan-v2-patches.md`

Out of scope (deferred to later phases): MQTT broker authentication
(Phase 1 still trust-on-first-connect), full database-file encryption at
rest (v0.10.5 ships column-level encryption for IdP tokens only; other
columns rely on OS-level encryption), Postgres back-end for regulated
workloads (Phase 4), multi-instance HA (Phase 5).

## Trust boundaries

```
+--------------------+         TLS         +-------------------------+
| Browser / CLI      | <-----------------> | Reverse proxy (nginx,   |
| (untrusted client) |                     | Caddy, Cloudflare)      |
+--------------------+                     +-----------+-------------+
                                                       |
                                          HTTP (loopback or private VLAN)
                                                       |
                                       +---------------v----------------+
                                       | mcp-coordinator process        |
                                       |  - dispatchAuthRoutes          |
                                       |  - JWT mint/verify             |
                                       |  - audit queue                 |
                                       +---------------+----------------+
                                                       |
                                            better-sqlite3 (file)
                                                       |
                                       +---------------v----------------+
                                       | ~/.mcp-coordinator/coordinator |
                                       |   .db (single SQLite file)     |
                                       +--------------------------------+
                                                       |
                              external IdP (GitHub OAuth) over TLS
```

Trust boundaries crossed:

1. **Client to reverse proxy** — TLS terminated here. Operator must front
   the coordinator. See `SECURITY.md` hardening recommendations.
2. **Reverse proxy to coordinator** — typically loopback or private VLAN.
   The coordinator trusts `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`
   per the configuration in `src/auth/cookies.ts` and the public-URL
   validation in `src/boot.ts`.
3. **Coordinator to SQLite** — same host, OS-level file permissions only.
   No encryption at rest in Phase 2 (residual risk; see below).
4. **Coordinator to GitHub** — outbound TLS to `api.github.com` via
   `src/auth/providers/github.ts`.

## Assets

The following assets are persisted by the coordinator or held in process
memory long enough to be a target. Each asset is analysed under STRIDE
in its own section.

| Asset                      | Storage                        | Sensitivity |
| -------------------------- | ------------------------------ | ----------- |
| JWT signing key            | `COORDINATOR_JWT_SECRET` env   | Critical    |
| `oauth_state` rows         | SQLite `oauth_state` table     | High        |
| `refresh_tokens` rows      | SQLite `refresh_tokens` table  | High        |
| `audit_log` rows           | SQLite `audit_log` table       | High        |
| Session cookies (browser)  | Browser cookie jar             | High        |
| `idp_access_token`         | SQLite `users.idp_access_token` (AES-256-GCM v0.10.5; plaintext if `COORDINATOR_ENCRYPTION_KEY` unset) | High |
| GitHub OAuth grant         | External (GitHub side)         | High        |

## Asset 1: JWT signing key

Source: `COORDINATOR_JWT_SECRET` env var, loaded once at boot in
`src/boot.ts` line 57 and passed to `buildJwtKeyRegistry` in
`src/auth/jwt-keys.ts`. The HS256 key is symmetric — possession of the
secret allows minting valid access tokens for any user.

### Spoofing

- **Threat**: attacker forges a JWT impersonating any user/org/scope.
- **Mitigation**: the secret never leaves the coordinator process.
  `src/boot.ts` validates a minimum of 128 bits of entropy via
  `assertSecretEntropy` (`src/auth/entropy.ts`); boot fails with a fatal
  log otherwise. `src/auth/jwt-mint.ts` uses `jose` with explicit `kid`
  (`hs256-v1`) and `iss`/`aud` claims so older formats are rejected.
- **Residual**: anyone with the env var can forge tokens. Operators must
  use a secret manager. See `docs/ops/key-rotation.md`.

### Tampering

- **Threat**: attacker modifies an issued JWT (claims tampering).
- **Mitigation**: HS256 signature verification in
  `authenticateRequest` (wired by `initPhase2Auth` in `src/auth.ts`)
  rejects any token whose MAC does not validate.

### Repudiation

- **Threat**: attacker denies having minted or used a token.
- **Mitigation**: every mint operation is audited (`auth.login.success`
  Tier 2 + service-token issuance Tier 1 — see
  `src/security/audit-events.ts`). Token `jti` is recorded; refresh
  rotation chains preserve provenance via `parent_jti` /
  `family_id` in `refresh_tokens`.

### Information disclosure

- **Threat**: the secret leaks via logs, crash dumps, env-var dumps,
  container metadata endpoints, CI secrets, or `git` commits.
- **Mitigation**: the boot log explicitly masks the secret (`src/boot.ts`
  never logs `jwtSecret` directly). The Dockerfile does not bake the
  secret in. Audit events never include the secret. Lint rule
  `scripts/lint-no-direct-env-in-auth.sh` restricts direct env reads to
  `src/boot.ts` only.
- **Residual**: an attacker with read access to the operator's env-var
  store, CI logs, or process memory still gets the secret. Operators
  must rotate per `docs/ops/key-rotation.md` on suspicion of leak;
  runbook `docs/ops/incident-signing-key-leak.md` covers the full path.

**securite-auth-03 — accepted risk: `?token=<jwt>` query-string transport
on GET.** `authenticateRequest` (`src/auth.ts`) accepts a bearer JWT via
`?token=` on GET requests only (POST/PUT/PATCH excluded — see the smuggling
comment at that call site), so `EventSource` (`/api/events` SSE) can
authenticate without custom headers. This is a **deliberate, accepted
trade-off**, not an oversight: query-string credentials are more exposed
than an `Authorization` header — they can land in reverse-proxy / web-server
access logs, browser history, the `Referer` header on outbound requests from
the same page, and any application log that prints the request URL.
Decision: **keep the mechanism** (removing it breaks EventSource-based SSE
clients with no header-injection API) but close the log-leak surface we
control:
  - The pino `REDACT_PATHS` allowlist (`src/observability/redact-paths.ts`)
    does **not** cover this — it redacts structured object paths
    (`req.headers.authorization`, `body.refresh_token`, ...), not a
    substring embedded inside a plain `url` string value.
  - `redactTokenParam()` (`src/http/utils.ts`) masks `token=...` to
    `token=[REDACTED]` before a request URL is ever logged. Applied at
    every call site in the coordinator's own logs that logs a `url` field:
    `src/serve-http.ts` (auth-rejection warn, Phase 2 auth-route error) and
    `src/http/handle-rest.ts` (per-request info/debug log).
  - Out of the coordinator's control: reverse-proxy / CDN access logs,
    browser history, and `Referer` leakage upstream of the coordinator
    process. Operators terminating TLS at a reverse proxy should configure
    it to omit query strings from its own access logs, or accept the
    residual exposure for `/api/events?token=...` specifically.

### Denial of service

- **Threat**: attacker triggers a key reload storm or a verification
  CPU bomb (very long JWTs).
- **Mitigation**: HS256 verify is constant-time per byte; `jose`
  bounds header/payload sizes. The coordinator does not implement
  hot-reload of `COORDINATOR_JWT_SECRET` — change requires a restart, so
  there is no remote reload path.

### Elevation of privilege

- **Threat**: a holder of a low-scope token escalates by forging a
  higher-scope claim.
- **Mitigation**: HS256 makes forgery infeasible without the secret.
  Scope (`read|write|admin`) is enforced server-side in route handlers,
  not trusted from the token alone.

## Asset 2: oauth_state rows

Schema: `src/database.ts` lines 587-598. Holds the PKCE `state`,
`code_verifier`, and (V3 NR1) the state-binding HMAC for the
authorisation code flow.

### Spoofing

- **Threat**: CSRF on the OAuth callback — attacker forges a
  `state` parameter to log the victim into the attacker's account.
- **Mitigation**: the state value is bound to a server-side
  hash-keyed token (`deriveStateBindingKey` in
  `src/auth/crypto-keys.ts`). `src/auth/oauth-callback.ts` requires
  atomic compare-and-swap of the state row before exchanging the code.
  A state that fails that check emits Tier 1 `auth.state.replay`.

### Tampering

- **Threat**: attacker mutates `oauth_state` rows via SQL injection or
  filesystem access.
- **Mitigation**: all queries are parameterised through better-sqlite3
  prepared statements. Filesystem access is OS-level only — out of
  Phase 2 scope (see residual risks).

### Repudiation

- Tier 1 `auth.state.replay` and `auth.state.provider_unregistered`
  events record every anomaly. See `src/security/audit-events.ts`.
  The second was called `auth.state.mixup` until #305; despite the
  name it detects no mix-up, only a state whose provider is no longer
  registered — which no third party can bring about.
- Tier 2 `auth.provider.unknown` records the converse case, where the
  provider name *is* caller-supplied: an unregistered name submitted
  to the token endpoint.

### Information disclosure

- **Threat**: `code_verifier` leak would let an attacker reuse a
  captured `code`.
- **Mitigation**: state rows are deleted atomically on consume
  (`oauth-callback.ts` consumes via DELETE...RETURNING). Expiry sweeper
  (T28 — `src/sweeper/index.ts`) removes stale rows on
  `oauth_state_ttl_seconds` (default 600s).

### Denial of service

- **Threat**: state-row flood fills SQLite disk.
- **Mitigation**: rate-limiter (`src/auth/rate-limit.ts`) caps login
  attempts per IP/user; the sweeper removes expired rows.

### Elevation of privilege

- N/A — state rows do not carry user identity until consumed.

## Asset 3: refresh_tokens rows

Schema: `src/database.ts` line 200 et seq., with family lineage columns
added at lines 600-618 (V4 FIX 6).

### Spoofing

- **Threat**: stolen refresh token used by an attacker.
- **Mitigation**: rotation on every use
  (`src/auth/refresh-rotation.ts`). The previous token is marked
  `revoked_at` atomically. If the same `parent_jti` is presented twice
  (reuse), the whole family is revoked and a Tier 1
  `auth.refresh.chain_revoked` event is emitted with reason
  `reuse_detected` (`refresh-rotation.ts` line 228).

### Tampering

- **Threat**: attacker manipulates `expires_at` to extend lifetime.
- **Mitigation**: tokens are server-side only (opaque to client);
  client only holds the bearer string keyed by `jti`. The server is
  the source of truth on expiry.

### Repudiation

- Every refresh produces `auth.refresh.rotated` (Tier 2).
  Anomalies — `chain_revoked`, `suspicious_replay`, `idle_expired` —
  are recorded at the appropriate tier; see
  `src/security/audit-events.ts`.

### Information disclosure

- **Threat**: rows include `consumer_fingerprint`, `user_id`,
  `org_id`. A DB compromise reveals session linkability.
- **Mitigation**: no plaintext token value is stored — only the opaque
  `jti`. Hashing the token client value is unnecessary because the
  value is the jti itself (random 16 bytes). Residual risk: no
  encryption at rest; see below.

### Denial of service

- **Threat**: token flood through a buggy or malicious client.
- **Mitigation**: per-user active-token cap enforced by rotation logic;
  rate limiter throttles login. Sweeper purges expired rows.

### Elevation of privilege

- Reuse detection (V4 FIX 6) immediately revokes the whole family on
  any replay, preventing a single stolen token from being used
  alongside the legitimate session.

## Asset 4: audit_log rows

Schema: see `src/database.ts` audit_log section. Two-tier emission via
`src/security/audit.ts` (sync for Tier 1, queued for Tier 2 via T11b
batched flush).

### Spoofing

- **Threat**: attacker writes fake audit rows to mask their actions.
- **Mitigation**: only the coordinator process writes. SQLite file
  permissions are OS-level only — operators must restrict shell access
  to the host. See residual risks.

### Tampering

- **Threat**: row deletion to remove evidence.
- **Mitigation**: no application code deletes from `audit_log` except
  the retention sweeper, which honours the tier-aware retention windows
  in `src/security/audit-events.ts` and `src/sweeper/index.ts`.

### Repudiation

- The audit log itself is the anti-repudiation control. Tier 1 events
  (`auth.refresh.chain_revoked`, `recovery.token_epoch_global_bump`,
  `config.key_rotation`, etc.) are flushed synchronously and not subject
  to drop-under-pressure.

### Information disclosure

- **Threat**: audit rows include user IDs, IP addresses, and event
  metadata. A DB compromise discloses this.
- **Mitigation**: no plaintext tokens or secrets land in audit rows
  (the `audit()` helper in `src/security/audit.ts` is the only writer
  and its callers do not pass tokens or PII beyond user_id/org_id/IP).
- **Residual**: no encryption at rest; IPs can be PII under some
  regulations. Operators in regulated environments should evaluate
  Phase 4 Postgres + transparent disk encryption.

### Denial of service

- **Threat**: Tier 2 queue overflow drops events.
- **Mitigation**: T11b queue has a bounded ring buffer; when overflow
  occurs, the high-water `system.shutdown.audit_loss` Tier 1 event is
  emitted on next flush. Tier 1 events bypass the queue and are written
  inline, so no security-critical evidence is lost.

### Elevation of privilege

- N/A — read-only after write.

## Asset 5: session cookies

Cookie shape and flags managed in `src/auth/cookies.ts`. Includes the
access token cookie (`__Host-`-prefixed under HTTPS) and the refresh
token cookie.

### Spoofing

- **Threat**: cookie theft via XSS.
- **Mitigation**: `HttpOnly` + `Secure` (mandatory under HTTPS;
  `COORDINATOR_INSECURE_COOKIES` opts out only for localhost dev),
  `SameSite=Lax` for the access cookie, `SameSite=Strict` for refresh.
  `__Host-` prefix on the access cookie prevents subdomain spoofing.

### Tampering

- **Threat**: attacker modifies cookie contents.
- **Mitigation**: cookies carry signed JWTs; tampering breaks the MAC.

### Repudiation

- Inherited from JWT mint + refresh-rotation audit trail.

### Information disclosure

- **Threat**: cookies in URL fragments, server access logs, or browser
  cache.
- **Mitigation**: `HttpOnly` blocks JS reads. The coordinator never
  emits the cookie value to logs.

### Denial of service

- N/A.

### Elevation of privilege

- **Threat**: CSRF via cross-origin form post.
- **Mitigation**: `SameSite` flags + the CSRF token issued by
  `src/auth/csrf.ts` (double-submit pattern) for state-changing
  endpoints. Tier 2 `auth.csrf.failed` event records failures.

## Asset 6: idp_access_token

Stored on `users.idp_access_token` per the GitHub provider, used to
look up org membership in `src/auth/membership-cache.ts`.

### Spoofing

- **Threat**: attacker uses a stolen `idp_access_token` to act as the
  user against GitHub.
- **Mitigation**: token is stored server-side; never exposed to clients.

### Tampering

- **Threat**: row mutation.
- **Mitigation**: prepared statements only; row write is gated on
  successful OAuth exchange.

### Repudiation

- IdP token revocation is recorded via `auth.idp.token_revoked`
  Tier 1 event.

### Information disclosure

- **Threat**: DB compromise discloses live GitHub OAuth grants for
  all users.
- **Mitigation (v0.10.5)**: when `COORDINATOR_ENCRYPTION_KEY` is set, the
  `idp_access_token` and `idp_refresh_token` columns are sealed with
  AES-256-GCM. AAD is bound to `user_id` + column name + `org_id`, so an
  attacker with DB-write cannot swap ciphertexts across rows or columns.
  Boot refuses to start if the DB contains encrypted rows but the key is
  absent (recovery via `COORDINATOR_ALLOW_TOKEN_LOSS` is documented in
  `docs/onboarding-self-host.md`). A 16-char key fingerprint is stored in
  `system_config.encryption.key_fingerprint`; a silent operator key-swap
  trips the boot fingerprint guard.
- **Mitigation (legacy / opt-out)**: with `COORDINATOR_ENCRYPTION_KEY`
  unset, tokens remain plaintext (boot warning, ERROR in production). Fall
  back to SQLite file permissions, no plaintext backups, prompt rotation
  on suspected DB compromise via `docs/ops/incident-refresh-leak.md`.
- **Residual**: master-key compromise reveals every encrypted token;
  master-key loss makes IdP tokens unreadable but does not destroy
  coordinator data (users re-auth). See residual-risks section below.

### Denial of service

- **Threat**: token-refresh flood against GitHub triggers GitHub-side
  rate limiting that takes the coordinator offline.
- **Mitigation**: `MembershipCache` debounces GitHub calls per user;
  membership lookups are cached.

### Elevation of privilege

- **Threat**: stolen token grants the attacker's GitHub scopes.
- **Mitigation**: coordinator requests minimal scopes (`read:org`,
  `read:user`). Operators should review the GitHub OAuth app scope
  list periodically.

## Asset 7 (operator surface): Admin UI endpoints (v0.10.6)

The v0.10.6 admin console at `/dashboard/admin.html` and its backing
`/api/admin/*` endpoints introduce no new asset type — they are an
authenticated operator-facing view onto existing tables (`users`,
`organizations`, `audit_log`). The threat model is fully covered by
the existing JWT + CSRF + audit controls; this section enumerates the
new attack surfaces and confirms which existing mitigation applies.

### `/api/admin/*` endpoints

- **Spoofing / EoP**: every admin endpoint runs through the same
  `authenticateRequest` path as the rest of Phase 2 (HS256 JWT verify
  via `src/auth/jwt-verify.ts`) and then explicitly checks
  `role === 'admin'` before dispatching. A member-role JWT receives
  `403`, audited as a Tier 2 `admin.access.denied` event.
- **CSRF**: state-changing methods (`POST` / `PATCH`) require the CSRF
  double-submit token issued at login (`src/auth/csrf.ts`). Missing or
  mismatched tokens produce `403` with `auth.csrf.failed` Tier 2.
- **DoS**: per-IP rate limit of 30 mutations / minute via the shared
  `RateLimiter` (`src/auth/rate-limit.ts`). Exceeded requests return
  `429` with `Retry-After`. Reads are unthrottled (consistent with
  other authenticated read endpoints in Phase 2).
- **Repudiation**: every successful mutation emits a Tier 1 audit row
  under one of `admin.org.created`, `admin.org.updated`,
  `admin.user.role_changed`, or
  `admin.orgs.duplicate_names_accepted`. The hash chain
  (`src/security/audit-chain.ts`) covers these rows like any other.
- **Last-admin protection**: the `PATCH /api/admin/users/:id` handler
  refuses to demote the only remaining admin, preventing accidental
  total lockout. Recovery procedure (raw SQL) is documented in
  `docs/ops/admin-ui.md`.

### Static admin pages (`/dashboard/admin.html`)

- **Spoofing**: the static asset is served without ACAO and with
  `X-Frame-Options: DENY`, so it cannot be iframed onto an
  attacker-controlled origin (clickjacking-resistant).
- **Tampering**: the page is bundled in-tree; no runtime template
  inflation. CSP restricts script sources to `self` (no inline,
  no `eval`).
- **Information disclosure**: the page itself contains no secrets;
  all admin data is fetched at runtime via the authenticated
  endpoints above.

### Residual

No new residual risks: the admin UI is a thin client over
endpoints whose threat model is identical to the rest of Phase 2.
Operators should review the per-admin audit trail
(`SELECT * FROM audit_log WHERE action LIKE 'admin.%'`) on the same
cadence as the rest of the security-relevant audit events; see
`docs/ops/admin-ui.md` for the operator runbook.

## Asset 8: GitHub OAuth grant

Lives on GitHub. Identified by `COORDINATOR_GITHUB_CLIENT_ID` /
`COORDINATOR_GITHUB_CLIENT_SECRET`. The client_secret is a coordinator
boot-time secret separate from `COORDINATOR_JWT_SECRET`.

### Spoofing

- **Threat**: attacker steals the client_secret and registers a
  malicious app posing as the coordinator.
- **Mitigation**: client_secret is read at boot only, never logged.
  `src/boot.ts` reads it via `readRequiredEnv`. Compromise procedure
  is in `docs/ops/incident-signing-key-leak.md` (covers both JWT and
  GitHub client_secret).

### Tampering, Repudiation, DoS, EoP

- Out of band of the coordinator (GitHub-side).

### Information disclosure

- **Threat**: client_secret leak (logs, env dump).
- **Mitigation**: secret-manager integration recommended; boot does not
  emit the secret. Rotation requires regenerating the secret in the
  GitHub OAuth app settings and updating the env var.

## Residual risks (known Phase 2 gaps)

These risks are accepted in Phase 2 and tracked for later phases. Each
is documented here so operators can choose deployment configurations
that compensate.

1. **Backup theft / insider direct-read of DB file** — for IdP tokens
   (`idp_access_token`, `idp_refresh_token`) this is **CLOSED** in v0.10.5
   when `COORDINATOR_ENCRYPTION_KEY` is set: column-level AES-256-GCM with
   AAD-bound ciphertext means a leaked DB file no longer discloses IdP
   credentials. Other plaintext columns (file paths, plan text, audit
   metadata, `refresh_tokens` rows) remain readable from a leaked DB file;
   mitigation = OS-level encryption (full-disk encryption on the host)
   plus restrictive file permissions on `data/coordinator.db`.

2. **Single-instance deployment only** — Phase 2 does not implement
   distributed session state. Operators running more than one
   coordinator behind a load balancer will see inconsistent
   `token_epoch` reads and broken refresh rotation. **Mitigation
   roadmap**: Phase 5 multi-instance with a Postgres or Redis-backed
   session store.

3. **`idp_access_token` / `idp_refresh_token` stored in plaintext** —
   **CLOSED in v0.10.5** when `COORDINATOR_ENCRYPTION_KEY` is set
   (column-level AES-256-GCM). Remaining sub-risks:
   (a) **Cross-row / cross-column ciphertext swap by attacker with
   DB-write access** — CLOSED: AAD-bound to `user_id` + column name +
   `org_id`, so a ciphertext cannot be transplanted across rows/columns
   without breaking GCM auth.
   (b) **Silent operator key-swap** — MITIGATED: the 16-char key
   fingerprint stored in `system_config.encryption.key_fingerprint` is
   checked at every boot; a swapped key refuses to start unless
   `COORDINATOR_ALLOW_KEY_ROTATION=1` is set deliberately.
   (c) **Silent restore-without-key** — MITIGATED: boot refuses when the
   DB contains encrypted rows but `COORDINATOR_ENCRYPTION_KEY` is unset;
   operator must either supply the original key or invoke the
   `COORDINATOR_ALLOW_TOKEN_LOSS` + `COORDINATOR_TOKEN_LOSS_CONFIRM` flow
   documented in `docs/onboarding-self-host.md`.
   (d) **Master key loss** — OPEN but bounded: IdP tokens become
   unreadable and users are forced to re-auth; original ciphertexts are
   stashed in `encryption_invalidated_tokens` for forensic recovery if the
   key later resurfaces. No permanent coordinator data loss.
   (e) **Compromised master key** — OPEN: all encrypted rows become
   readable. Mitigation = secure env handling (secret manager, never bake
   into images) plus rotation via the documented procedure
   (`COORDINATOR_ALLOW_KEY_ROTATION=1`, maintenance window with no
   concurrent backups, since rotation transits plaintext in-process).
   (f) **Process memory dump** — OUT OF SCOPE; in-memory plaintext after
   decryption is unavoidable for the coordinator to use the token.

4. **SQLite-only persistence** — better-sqlite3 is appropriate for the
   single-node Phase 2 target but unsuitable for regulated workloads
   that require a managed RDBMS with backup, replication, and audit
   guarantees. **Mitigation roadmap**: Phase 4 Postgres adapter (see
   `docs/superpowers/working/v05/p4-db-adapter-analysis.md`).

5. **No HSM-backed signing** — `COORDINATOR_JWT_SECRET` is an HS256
   secret in an env var, not an asymmetric key in an HSM or KMS.
   **Mitigation roadmap**: a v0.9+ migration to RS256/EdDSA with a KMS
   would let signing happen behind a network boundary. Phase 2 ships
   HS256 because the kid registry (`src/auth/jwt-keys.ts`) and rotation
   procedure are simpler to verify in-tree.

6. **JWT signing key rotation** — addressed in v0.8.1 via prev-secret
   overlap support (`COORDINATOR_JWT_SECRET_PREV`). Old kid `hs256-v0`
   remains verify-only during the overlap window (operator-controlled
   duration). The Tier 1 `config.key_rotation` audit row is emitted by
   `src/boot.ts` when prev is configured. Reference:
   `docs/ops/key-rotation.md`. The remaining gap is operational
   convenience (no CLI helper, no automated `_PREV_ROTATED_AT` alerting
   when overlap exceeds `refresh_TTL`) — tracked for a future minor
   release rather than as a security residual risk.

7. **No MFA at the coordinator layer** — the coordinator delegates
   identity to GitHub OAuth and does not enforce MFA itself. Operators
   relying on MFA must configure GitHub organisation-level MFA
   requirements.

8. **No fine-grained rate limiting on refresh** — `RateLimiter`
   (`src/auth/rate-limit.ts`) caps login attempts but refresh is gated
   only by the reuse-detection logic. A compromised refresh token can
   be rotated repeatedly until detected. Detection is fast (single
   second under normal load) but not instant.

9. **Audit queue drop under pressure** — Tier 2 events may be dropped
   if the queue overflows. Tier 1 events are unaffected. Operators
   should monitor `system.shutdown.audit_loss` events and alert on any
   occurrence.

10. **Audit log tamper detection** — addressed in v0.9.1 via SHA-256
    hash chain on every `audit_log` row (`prev_hash` + `row_hash`
    columns; see `src/security/audit-chain.ts`). In-place edits and
    middle-row insertions are detectable by
    `scripts/verify-audit-chain.ts` (see `docs/ops/audit-integrity.md`).
    Two gaps remain and require the operator-side tip-attestation
    workflow documented in that runbook:
    (a) `created_at` is intentionally outside the hash, so timestamp
    rewrites are not detected by the chain alone;
    (b) deletion of recent rows is indistinguishable from legitimate
    sweeper retention without an external signed tip-record.

## Review cadence

This threat model is reviewed every minor release and on any change to
`src/auth/`, `src/security/`, or `src/boot.ts`. The next mandatory
review is **v0.10** (Phase 3 admin endpoints + Postgres adapter).
Material changes are called out in CHANGELOG.md under the version's
`### Security` heading.

## Intra-org agent trust model (protocole-mcp-04, securite-surface-03)

**Assumption (documented, accepted risk).** Within a single org, all agents
are **mutually trusting** — a cooperative swarm operated by one owner. An
`agent_id` is a **self-asserted handle**, not an authenticated identity: the
`agents` table (`src/database.ts`) stores no owner/user/session binding, and
MCP tools accept `agent_id` as a caller-supplied parameter scoped only by the
session's `claims.org`. The **enforced trust boundary is the org**: the MQTT
ACL (`src/mqtt-broker.ts` `authorizeSubscribe`/`authorizePublish`) denies and
disconnects cross-org access, and consultation/thread state is org-scoped.

**Consequences accepted at this boundary:**

- An authenticated caller can act under any `agent_id` within its own org
  (post to threads, propose/approve/contest resolutions). *(protocole-mcp-04)*
- An agent can read another agent's MQTT queue within its own org — there is
  no per-agent topic isolation, only per-org. *(securite-surface-03)*

**Why this is acceptable today.** The org already is the tenant boundary: one
org = one owner running their own agents. Agents inside an org are not
adversaries of one another, so cross-agent impersonation and queue reads are
not a privilege boundary that matters in the current deployment profile.

**Deferred (revisit trigger).** Per-agent authorization (binding `agent_id`
to the session that owns it) and per-agent MQTT topic isolation are
**deferred** until a deployment runs mutually-distrusting agents inside a
single org — which, given the org-as-tenant model, is not a supported
configuration today. If that changes (e.g. shared-org multi-user swarms),
implement a session→agent ownership map and per-agent MQTT ACLs, and revisit
`protocole-mcp-04` / `securite-surface-03`.
