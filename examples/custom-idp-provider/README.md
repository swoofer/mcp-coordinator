# Custom IdP provider template

This directory shows how to implement a non-GitHub IdP for
mcp-coordinator by writing a class that satisfies the `IdPProvider`
interface in `src/auth/providers/types.ts`.

> Status -- read this before you start.
>
> v0.9.0 ships with `GitHubProvider` AND `GoogleProvider` built in.
> The boot composer in `src/boot.ts` registers GitHub unconditionally
> and Google when `COORDINATOR_GOOGLE_CLIENT_ID` +
> `COORDINATOR_GOOGLE_CLIENT_SECRET` are set. A generic
> `OIDCProvider` for Okta / Auth0 / Azure AD / Keycloak follows in
> T48 alongside the multi-provider login picker UI.
>
> The `google-provider.ts` file in this directory is therefore now
> reference material for "what an IdPProvider implementation looks
> like" rather than a runtime template -- production Google sign-in
> uses `src/auth/providers/google.ts`. If you need a custom IdP
> beyond GitHub / Google / OIDC, this directory still shows the
> shape you'd vendor into a fork (see
> `README-add-to-registry.md`).

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
  buildAuthUrl(state, redirectUri, codeChallenge?): string;
  exchangeCode(code, redirectUri, codeVerifier?): Promise<ExchangeCodeResult>;
  listMemberships?(accessToken): Promise<string[]>;
  requestDeviceCode?(): Promise<DeviceCodeResponse>;
  pollDeviceToken?(deviceCode): Promise<DevicePollResult>;
}
```

Required methods are `buildAuthUrl` and `exchangeCode`. The rest are
optional capabilities:

- `listMemberships` is called by the org-allowlist check. If your
  IdP has no group / org concept, throw `ProviderCapabilityError`
  and rely on email-domain matching at a higher layer.
- `requestDeviceCode` + `pollDeviceToken` enable the RFC 8628 device
  flow used by `mcp-coordinator auth login` over MCP HTTP. Skip
  these and only the browser-based auth-code flow will work.

Returned `IdpUserInfo` must include `idp_user_id` (stable, opaque,
per-IdP) and `email`. `idp_org_id` is optional and currently unused
outside the GitHub-specific allowlist path.

## Allowlist semantics for non-GitHub IdPs

The Phase 2 `orgs` table has a single `allowlist_github_org` column.
Approaches for non-GitHub providers:

1. **Hosted-domain proxy** (Google Workspace, similar). Use the
   IdP's hosted-domain claim (`hd` for Google, `tid` for Azure AD)
   as the value stored in `allowlist_github_org`. The semantics
   change but the schema doesn't.
2. **Email-domain match.** Strip the domain from the returned
   `email` and use it as the allowlist key.
3. **Custom claim.** Map an IdP-specific group / role claim into the
   existing column.

Phase 4 introduces a polymorphic allowlist table; until then you're
adapting your IdP's model to the GitHub-org shape.

## Test pattern

Provider tests in this codebase use `msw` (mock service worker) to
intercept the outbound HTTP calls. See
`tests/unit/github-provider.test.ts` for the template. For a Google
provider you would mock:

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
4. Update `docs/idp-providers.md` (if your fork keeps that file)
   to document the new env vars.
5. Decide on your allowlist semantics and either reuse the
   `allowlist_github_org` column or add a column / table.

## Why this isn't a plugin system yet

A loadable-plugin architecture (entry points, dynamic require, etc.)
introduces a supply-chain attack surface that doesn't pay for itself
at Phase 2's scale. We expect to revisit this in Phase 5 once we
have a concrete set of operator-driven IdP needs to drive the
abstraction.
