# Custom IdP provider template

This directory shows how to implement a non-GitHub IdP for
mcp-coordinator by writing a class that satisfies the `IdPProvider`
interface in `src/auth/providers/types.ts`.

> Status -- read this before you start.
>
> mcp-coordinator ships four `IdPProvider` implementations built in:
> `GitHubProvider`, `GitHubAppProvider`, `GoogleProvider`, and a
> generic `OIDCProvider` for any conformant OIDC issuer (Okta, Auth0,
> Azure AD, Keycloak, Authentik). The boot composer (`src/boot.ts`)
> registers GitHub unconditionally and the others opt-in via env vars
> (`COORDINATOR_GOOGLE_CLIENT_ID`/`_SECRET`,
> `COORDINATOR_GITHUB_APP_CLIENT_ID`/`_SECRET`,
> `COORDINATOR_OIDC_ISSUER_URL`/`_CLIENT_ID`/`_CLIENT_SECRET`). See
> `docs/idp-providers.md` for configuring any of the built-ins -- you
> likely don't need this directory at all if your IdP is GitHub,
> Google, or speaks standard OIDC discovery. The multi-provider
> login picker UI on `/auth/login` is already active whenever more
> than one provider is registered.
>
> The `google-provider.ts` file in this directory is therefore
> reference material for "what a from-scratch `IdPProvider`
> implementation looks like" rather than a runtime template --
> production Google sign-in uses the built-in
> `src/auth/providers/google.ts` (which additionally verifies the
> id_token signature against Google's JWKS instead of calling
> `/userinfo`). If you need a custom IdP beyond GitHub / Google /
> OIDC, this directory still shows the shape you'd vendor into a
> fork (see `README-add-to-registry.md`).

## What you get in this directory

- `google-provider.ts` -- a full `IdPProvider` implementation for
  Google OAuth 2.0, including the auth-code + PKCE flow, userinfo
  fetch, error mapping to `IdPTokenRevoked` / `IdPTransientError`,
  and notes on what device-flow and listMemberships would need.
- `README-add-to-registry.md` -- step-by-step on wiring a custom
  provider into `bootPhase2` and the provider registry.

## The IdPProvider contract

The interface is small:

```ts
interface IdPProvider {
  readonly name: string;
  readonly allowlistStrategy?: "memberships" | "idp_org_id" | "id_token_groups" | "none";
  buildAuthUrl(state, redirectUri, codeChallenge?, nonce?): string | Promise<string>;
  exchangeCode(code, redirectUri, codeVerifier?, nonce?): Promise<ExchangeCodeResult>;
  listMemberships?(accessToken): Promise<string[]>;
  requestDeviceCode?(): Promise<DeviceCodeResponse>;
  pollDeviceToken?(deviceCode): Promise<DevicePollResult>;
  refreshIdpToken?(refreshToken): Promise<IdpRefreshResult>;
}
```

(See `src/auth/providers/types.ts` for the exact, current signatures
-- this is a condensed view.)

Required methods are `buildAuthUrl` and `exchangeCode`. The rest are
optional capabilities:

- `allowlistStrategy` tells the org-allowlist check how to match this
  provider's users: `"memberships"` (default when omitted) calls
  `listMemberships`; `"idp_org_id"` matches `IdpUserInfo.idp_org_id`
  directly (what `GoogleProvider` uses, via the `hd` claim);
  `"id_token_groups"` matches entries in `IdpUserInfo.groups`
  (`OIDCProvider`, when configured with a groups claim); `"none"`
  means the provider has no portable allowlist model and callers must
  vendor a subclass.
- `listMemberships` is called by the org-allowlist check when
  `allowlistStrategy` is `"memberships"` (or omitted). If your IdP has
  no group / org concept, use `"idp_org_id"` or `"none"` instead of
  implementing this.
- `requestDeviceCode` + `pollDeviceToken` enable the RFC 8628 device
  flow used by `mcp-coordinator auth login` over MCP HTTP. Skip
  these and only the browser-based auth-code flow will work.
- `refreshIdpToken` exchanges a stored refresh token for a fresh
  access token; implement it only if your IdP issues expiring access
  tokens with a refresh token (GitHub Apps and Google with
  `access_type=offline` do).
- Both `buildAuthUrl` and `exchangeCode` take a `nonce` (OIDC Core
  1.0 §3.1.2.1, defence-in-depth against id_token replay). Forward it
  into the authorize URL and verify it against the id_token's `nonce`
  claim in `exchangeCode` if your IdP issues signed id_tokens.

Returned `IdpUserInfo` must include `idp_user_id` (stable, opaque,
per-IdP) and `email`. `idp_org_id` and `groups` are optional and only
consulted when `allowlistStrategy` is `"idp_org_id"` or
`"id_token_groups"` respectively.

## Allowlist semantics for non-GitHub IdPs

The `orgs` table has three allowlist columns, one per strategy in
`AllowlistStrategy` (`src/auth/providers/types.ts`):

- `allowlist_github_org` -- matched via `listMemberships()` when
  `allowlistStrategy` is `"memberships"` (GitHub OAuth App / GitHub
  App).
- `allowlist_idp_org_id` -- matched directly against
  `IdpUserInfo.idp_org_id` when `allowlistStrategy` is `"idp_org_id"`.
  This is what the built-in `GoogleProvider` uses (Workspace `hd`
  claim); see `src/auth/allowlist.ts`.
- an `id_token_groups` strategy that matches entries in
  `IdpUserInfo.groups` against `allowlist_github_org` (the column is
  reused; the semantic is "group name" instead of "GitHub org" for
  this strategy). This is what `OIDCProvider` uses when configured
  with `COORDINATOR_OIDC_GROUPS_CLAIM`.

For a genuinely custom IdP, pick whichever strategy matches your
identity model instead of shoehorning everything into
`allowlist_github_org` -- set `allowlistStrategy = "idp_org_id"` (as
`google-provider.ts` in this directory does) or `"id_token_groups"`
rather than inventing a new column.

## Test pattern

Provider tests in this codebase use `msw` (mock service worker) to
intercept the outbound HTTP calls. See `tests/unit/github-provider.test.ts`
for the template, or `tests/unit/google-provider.test.ts` /
`tests/unit/oidc-provider.test.ts` for the built-ins closest to this
example. For a Google-shaped provider you would mock:

- `POST https://oauth2.googleapis.com/token`
- `GET https://openidconnect.googleapis.com/v1/userinfo`

Coverage to aim for:

- happy-path code exchange returns the expected `IdpUserInfo`
- 401 from token endpoint surfaces as `IdPTokenRevoked`
- 5xx from token endpoint surfaces as `IdPTransientError`
- malformed userinfo response fails Zod validation cleanly
- AbortSignal.timeout(5000) actually times out the slow response
  (use `vi.useFakeTimers()` and `vi.advanceTimersByTime(6000)`)

## Provider-specific gotchas

### Google

- The `hd` claim is only present for Google Workspace (formerly G
  Suite) users; consumer @gmail.com accounts omit it. Plan your
  allowlist accordingly.
- `access_type=offline` is required to receive a refresh token, and
  even then Google only issues one on first consent. For repeat
  consent during development, append `&prompt=consent` to force a
  fresh refresh token.

### OIDC providers (Auth0, Okta, Keycloak)

- Pull endpoint URLs from the discovery document at
  `<issuer>/.well-known/openid-configuration` rather than hardcoding
  them. This makes your provider work across tenants without code
  changes.
- Org-equivalent claims live in custom claim namespaces and need to
  be configured server-side first.

### Azure AD / Entra ID

- The userinfo endpoint is `https://graph.microsoft.com/v1.0/me`
  (Graph API), not the standard OIDC `/userinfo`. You'll need an
  `openid email profile User.Read` scope and a Bearer call to Graph.
- The org-equivalent claim is `tid` (tenant ID), or for groups use
  `https://graph.microsoft.com/v1.0/me/memberOf`.

## Steps to ship a custom provider

1. Copy `google-provider.ts` into `src/auth/providers/<name>.ts` in
   your fork.
2. Add unit tests under `tests/unit/<name>-provider.test.ts`
   following the `github-provider.test.ts` template.
3. Wire into the boot composer per `README-add-to-registry.md`.
4. Update `docs/idp-providers.md` to document the new env vars.
5. Pick an `allowlistStrategy` (`"idp_org_id"`, `"id_token_groups"`,
   or `"none"`) matching your IdP's identity model instead of
   inventing a new allowlist column -- see "Allowlist semantics"
   above.

## Why this isn't a plugin system yet

A loadable-plugin architecture (entry points, dynamic require, etc.)
introduces a supply-chain attack surface that doesn't pay for itself
at the current deployment scale. Adding a new IdP today means
vendoring a provider class into a fork, as this directory
demonstrates, rather than dropping in a plugin package.
