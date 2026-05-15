# GitHub App provider design

**Status**: design, not yet implemented
**Target release**: v0.10.0
**Tasks**: T53 (impl), T54 (boot + docs)
**Author**: autonomous agent loop, 2026-05-16
**References**:
  - `src/auth/providers/github.ts` (OAuth App provider; the
    incumbent)
  - GitHub: "Differences between GitHub Apps and OAuth Apps"
    https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
  - RFC 6749 (OAuth 2.0)
  - GitHub: "Authenticating with a GitHub App"
    https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app

## Motivation

The Phase 2 `GitHubProvider` (T05) is an OAuth App: a single
`client_id` + `client_secret` pair, no per-installation isolation,
coarse-grained scopes (`read:user user:email read:org`), and access
tokens that never expire unless the user revokes them. Several
enterprise customers have asked for GitHub App support instead, for
three concrete reasons:

1. **Fine-grained permissions.** GitHub Apps declare per-resource
   permissions (e.g. "read members of this org" without granting
   "read every repo I can see"). OAuth App scopes are coarser and
   tend to over-grant.
2. **Installation isolation.** A GitHub App is installed per-org
   (or per-user), so the App's footprint IS the org allowlist --
   removing the App from an org immediately revokes access without
   any coordinator config change.
3. **Short-lived tokens.** User-to-server tokens issued by a GitHub
   App have an 8-hour TTL with refresh-token rotation built in.
   OAuth App tokens are effectively permanent; the coordinator's
   own refresh family is the only kill switch.

Reasons #2 and #3 are the security wins. #1 is mostly compliance
ergonomics.

## Scope of v0.10.0

**In scope:**
- A new `GitHubAppProvider` class living in
  `src/auth/providers/github-app.ts` and implementing the
  existing `IdPProvider` interface.
- User-to-server OAuth flow (authorize -> code -> user token).
- listMemberships via the user-to-server token (same `/user/orgs`
  endpoint -- the App's permissions determine what shows up).
- Refresh-token handling: on a user-to-server 401, the provider
  exchanges the refresh token for a new access token before
  re-raising `IdPTokenRevoked`.
- Co-existence with `GitHubProvider`: both can be registered
  simultaneously (under different names: `"github"` and
  `"github-app"`) so an operator can migrate users one at a time.

**Out of scope (v0.10.x or later):**
- **App-as-itself installation tokens for membership queries.** The
  v1 implementation uses the user-to-server token to call
  `/user/orgs`, which is functionally identical to `GitHubProvider`.
  An optional v2 mode would use the App's JWT to call
  `/app/installations` and `/user/installations` to build the
  allowlist from the App's installation footprint rather than from
  the user's organization memberships. This unlocks reason #2 above
  but adds the operational burden of provisioning the App's private
  key.
- **Device flow.** GitHub Apps do not currently support RFC 8628
  device authorization. The provider returns the
  `requestDeviceCode` / `pollDeviceToken` as `undefined`
  (matching the `IdPProvider` optional contract).
- **Per-installation rate limiting.** The coordinator's rate limit
  is per-IP; GitHub's is per-token. We do not currently surface
  installation-level rate-limit telemetry. Operators monitoring
  IdP health should read the `X-RateLimit-Remaining` header from
  GitHub responses via their own observability pipeline.
- **Webhook integration.** GitHub Apps can receive webhooks for
  installation events (`installation.created`, `member_added`).
  Wiring those into the membership cache invalidation flow is
  v1.0 work.

## User identity model

Identical to `GitHubProvider`:

| `IdpUserInfo` field | Source                                  |
|---------------------|-----------------------------------------|
| `idp_user_id`       | `id` from `GET /user`                   |
| `email`             | primary+verified from `GET /user/emails` |
| `name`              | `name` from `GET /user`                 |
| `idp_org_id`        | not set; see `listMemberships`           |

`users.idp_provider` will hold `"github-app"`, distinguishing from
`"github"` (OAuth App). A user provisioned through one provider
cannot sign in via the other -- they would be treated as a new
user because the `UNIQUE(idp_provider, idp_user_id)` constraint
allows the same GitHub `id` under both providers. Operators
migrating from OAuth App to GitHub App should plan a one-shot
user table reconciliation if they want to preserve identities.

## OAuth flow

GitHub Apps reuse the OAuth 2.0 authorization-code flow with
PKCE. The endpoints are the SAME as OAuth App:

- Authorize: `https://github.com/login/oauth/authorize`
- Token:     `https://github.com/login/oauth/access_token`

The differences from OAuth App in the flow are:

1. **No `scope` query parameter.** GitHub Apps declare their
   permissions at registration time; the OAuth flow inherits them.
   Sending `scope=...` is ignored at best, error at worst.
2. **`access_token_expires_in` is present.** Currently 28800 (8h).
   The coordinator must capture this value to know when to refresh.
3. **`refresh_token_expires_in` is present.** Currently
   15897600 (6mo). After this, the user must re-authorize from
   scratch.

```
authorize URL =
  https://github.com/login/oauth/authorize
    ?client_id=Iv1.xxxxxxxxxxxxxxxx
    &redirect_uri=${publicUrl}/api/auth/oauth/callback
    &state=${state}
    &code_challenge=${challenge}
    &code_challenge_method=S256
```

`Iv1.` is the conventional GitHub App `client_id` prefix; OAuth App
client IDs are pure hex/alphanumeric. The prefix is not load-bearing
in this design but operators eyeballing logs can use it to tell
which provider type produced a row.

## Refresh-token lifecycle

After token exchange the provider receives:

```json
{
  "access_token": "ghu_...",
  "expires_in": 28800,
  "refresh_token": "ghr_...",
  "refresh_token_expires_in": 15897600,
  "token_type": "bearer",
  "scope": ""
}
```

`scope` is always empty for GitHub Apps. The coordinator stores
`access_token` in `users.idp_access_token` AND
`refresh_token` in a new `users.idp_refresh_token` column (T54
migration). At refresh-rotation time, if `listMemberships`
receives a 401:

1. Check whether the App provider returned the row. If yes:
2. Try `refreshIdpToken(refresh_token)` -- exchange refresh token
   for a new access+refresh pair.
3. If refresh succeeds, retry `listMemberships` with the new token.
4. If refresh fails (refresh token expired or revoked), bubble up
   `IdPTokenRevoked` as before.

The refresh exchange is also against `/login/oauth/access_token`
with `grant_type=refresh_token`.

## Allowlist (v1)

For v0.10.0, allowlist semantics are IDENTICAL to `GitHubProvider`:
the existing `orgs.allowlist_github_org` column holds an org login
(case-insensitive), and `listMemberships` returns the user's GitHub
org memberships. The match is the same string comparison.

The difference is operational: the App must have at least
`members:read` permission on each org the operator wants to use as
an allowlist key, AND the App must be installed in that org. If
the App is removed from the org, `listMemberships` returns an
empty list for users in that org, breaking sign-in cleanly without
a coordinator config change.

## Threat model

Adversaries:

- **Compromised user-to-server token.** Identical risk to OAuth App
  (the token in `users.idp_access_token` is the same surface).
  Mitigation: 8h TTL drastically shrinks the window; the
  coordinator's `idp_access_token` is plaintext today and is in the
  same residual-risk bucket as OAuth App (`docs/security/threat-model.md`
  Asset 6).
- **Compromised refresh token.** New surface in v0.10.0. The
  refresh token in `users.idp_refresh_token` lets an attacker mint
  fresh access tokens for 6 months. Risk equivalent to a leaked
  OAuth App access token (which is also effectively permanent), so
  net-neutral. Mitigation: GitHub rotates the refresh token on
  every refresh exchange; if the App detects two valid uses of the
  same refresh token, it should revoke the user. The coordinator's
  refresh-detection logic (T19) is for ITS OWN refresh family, not
  the IdP's -- the coordinator does NOT detect IdP refresh-token
  replay today. Documented as a residual risk.
- **App credentials compromise.** The App's `client_secret` is what
  signs the token exchange. Risk identical to OAuth App
  `client_secret` compromise. Mitigation: rotate via GitHub admin
  UI; coordinator picks up the new value at next boot.
- **App private key compromise (out of scope for v1).** Only
  relevant if we ship the App-as-itself flow. The private key
  signs JWTs that the App uses to mint installation tokens.
  Storage strategy when we add it: PEM file path via env var,
  read once at boot, never logged.
- **Installation removal during a session.** An operator removes
  the App from an org. Existing users' access tokens still work
  for 8h. Refresh fails because the App can no longer act on the
  org. listMemberships returns an empty list, allowlist match
  fails, refresh-rotation kicks them out within 8h max. Acceptable
  for the v1 scope.

## Env vars

Three new env vars, all opt-in:

```
COORDINATOR_GITHUB_APP_CLIENT_ID         # Iv1.xxxxxxxxxxxx (required)
COORDINATOR_GITHUB_APP_CLIENT_SECRET     # github_pat_xxxxxxxxx (required)
COORDINATOR_GITHUB_APP_NAME              # Optional; defaults to "github-app".
                                         # Used as the registry key (and
                                         # users.idp_provider value), so
                                         # picker URLs become
                                         # /auth/login?provider=<name>.
```

Boot wiring follows the same fail-closed pattern as Google /
generic OIDC: presence of either `_CLIENT_ID` or `_CLIENT_SECRET`
without the other is a `BootValidationError`.

When both are present, `GitHubAppProvider` registers under
`COORDINATOR_GITHUB_APP_NAME ?? "github-app"`. The GHES env vars
(`COORDINATOR_GITHUB_AUTH_BASE_URL` + `_API_BASE_URL`) are shared
with the OAuth App `GitHubProvider`; we do NOT introduce
separate `_APP_AUTH_BASE_URL` keys because GitHub Apps and OAuth
Apps live at the same hostnames in GHES too.

## Coexistence with `GitHubProvider`

Both providers can be registered in the same deployment. Picker UI
shows both ("Continue with GitHub" + "Continue with GitHub (App)").
Operators planning a migration can:

1. Register both providers.
2. Direct existing users to keep using the OAuth App flow.
3. New users sign in via the App flow.
4. Eventually drop `COORDINATOR_GITHUB_CLIENT_ID/_SECRET` and stay
   on the App-only path.

A user signing in once through each provider creates two distinct
rows in `users` (because of the `UNIQUE(idp_provider, idp_user_id)`
constraint). The coordinator does NOT auto-merge identities; an
operator-only `mcp-coordinator user-migrate` CLI verb is future
work.

## Implementation plan

**T53** (`src/auth/providers/github-app.ts`):

- Class `GitHubAppProvider` implementing `IdPProvider`.
- Reuse the GitHubProvider's HTTP helpers (`fetchWithRetry`, the
  zod schemas for `/user` + `/user/emails` + `/user/orgs`). Move
  these to a shared `src/auth/providers/github-shared.ts` module
  rather than duplicating; `GitHubProvider` becomes a thin facade.
- Add `refreshIdpToken(refresh_token): Promise<RefreshResult>`
  method (new on the IdPProvider interface, optional; only
  `GitHubAppProvider` implements it for now).
- buildAuthUrl: no scope param, S256 PKCE.
- exchangeCode: capture `expires_in`, `refresh_token`,
  `refresh_token_expires_in` in the return type
  (`ExchangeCodeResult` gains optional fields).
- listMemberships: identical to GitHubProvider.

**T54** (boot + DB + docs):

- New migration: `ALTER TABLE users ADD COLUMN idp_refresh_token TEXT`.
  Idempotent + nullable. Existing OAuth App users keep `idp_refresh_token
  IS NULL` forever; only the App provider populates it.
- boot.ts: env-var reads + registration (mirrors Google/OIDC
  pattern).
- `src/auth/refresh-rotation.ts`: at IdP-token-revoked detection,
  if the user's provider implements `refreshIdpToken`, try refresh
  before falling through to `IdPTokenRevoked`. Tested in
  refresh-rotation-aux.test.ts.
- `docs/idp-providers.md`: new "Configuring GitHub App" section,
  mirrors the Google / OIDC sections in tone and scope.

## Open questions

1. **Should `idp_refresh_token` be encrypted at rest?** It's
   currently plaintext, aligned with `idp_access_token`. Pending
   the v0.7.5 encryption-at-rest work (residual risk #1). Leaving
   plaintext for v0.10.0 is consistent with the current posture
   but doubles the surface area of plaintext IdP credentials in
   the DB. Document the increase in threat-model.md.

2. **Installation-list-based allowlist in v0.10.x?** Worth
   prototyping behind a feature flag. The App-as-itself JWT
   signing flow brings new complexity (PEM-encoded private key in
   an env var) but unlocks the "installation footprint IS
   allowlist" property that's the most enterprise-flattering
   GitHub App selling point. Defer the decision until we see real
   demand.

3. **GHES App support.** GHES has supported GitHub Apps since
   2.14. The v1 design reuses the existing GHES env vars so the
   coverage is automatic. Acceptable.

4. **Audit metadata.** Should `auth.login.success` include the
   GitHub App `client_id` (or a hash thereof) so operators can tell
   which App registration produced a login? Lean yes; cheap to add
   in T54 as `metadata.idp_app_id_hash`.
