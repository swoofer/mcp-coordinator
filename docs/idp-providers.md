# IdP providers -- adding a new identity provider

mcp-coordinator's OAuth flow is decoupled from the underlying identity
provider via the `IdPProvider` interface. **v0.9.0 ships three concrete
implementations out of the box**: `GitHubProvider`, `GoogleProvider`,
and a generic `OIDCProvider` for any conformant OpenID Connect issuer
(tested against Okta / Auth0 / Azure AD / Keycloak / Authentik).

This document covers two scenarios:

1. **Configuring** one of the built-in providers via env vars -- jump
   to "Configuring Google", "Configuring generic OIDC", or "Configuring
   Azure AD / Entra ID" below.
2. **Adding** a fully custom IdP that isn't OIDC-conformant -- read the
   `IdPProvider` interface section then vendor a subclass into a fork.
   The contract is small enough that custom IdPs are usually well under
   200 lines.

References:

- `src/auth/providers/types.ts` -- the `IdPProvider` interface
- `src/auth/providers/registry.ts` -- `ProviderRegistry` class (one
  instance per server, attached to `AuthHandlerContext.providers`)
- `src/auth/providers/github.ts` -- the canonical GitHub implementation
- `src/auth/providers/google.ts` -- Google OAuth + OIDC with id_token
  signature verification (T47)
- `src/auth/providers/oidc.ts` -- generic OIDC with discovery (T48)
- `src/auth/providers/errors.ts` -- typed errors all providers must throw

## The `IdPProvider` interface

```ts
// src/auth/providers/types.ts (T02)
export interface IdpUserInfo {
  idp_user_id: string;          // stable identifier from the IdP
  email: string;                // verified primary email
  name?: string;                // optional display name
  idp_org_id?: string;          // optional org/tenant from the IdP
}

export interface ExchangeCodeResult {
  user: IdpUserInfo;
  accessToken: string;          // raw IdP token (for listMemberships)
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: "authorization_pending" }
  | { status: "slow_down"; new_interval: number }
  | { status: "expired_token" }
  | { status: "access_denied" }
  | ({ status: "granted" } & ExchangeCodeResult);

export interface IdPProvider {
  readonly name: string;

  // Return type widened to allow async providers (T48 OIDCProvider
  // fetches its discovery doc lazily on first call). GitHub + Google
  // stay synchronous.
  buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
  ): string | Promise<string>;

  exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ): Promise<ExchangeCodeResult>;

  listMemberships?(accessToken: string): Promise<string[]>;
  requestDeviceCode?(): Promise<DeviceCodeResponse>;
  pollDeviceToken?(deviceCode: string): Promise<DevicePollResult>;
}
```

### Contract notes

- `name` is the registry key. Must be lowercase and URL-safe. Used as
  `users.idp_provider` and in audit-log metadata.
- `buildAuthUrl` MUST include the `state` parameter unchanged. PKCE
  S256 `codeChallenge` is optional but recommended for any provider that
  supports it.
- `exchangeCode` returns BOTH the user and the raw IdP access token. The
  caller stores the token in `users.idp_access_token` so refresh-time
  membership re-checks (V4 FIX 7) have something to call.
- `listMemberships` (optional) returns LOWERCASE org/tenant strings.
  Determinism matters: the deterministic alphabetical tie-break in
  `resolveOrgFromMemberships` (T09, V4 FIX 22) assumes case-folded input.
- `requestDeviceCode` / `pollDeviceToken` are optional. Provide both or
  neither -- partial implementation is a bug.

### Typed errors

All providers MUST throw these typed errors instead of bare `Error`:

- `IdPTokenRevoked` -- HTTP 401 from the IdP. The caller fails the request
  with `WWW-Authenticate: Bearer error="invalid_token"`.
- `IdPTransientError` -- HTTP 5xx, network timeout, or HTTP 403 (which
  conflates rate-limit and forbidden -- both are transient from the
  caller's POV). The caller serves cached membership data when available
  (T04 stale-on-error) or surfaces a 503.

Other errors (4xx non-401, schema validation failures) should be plain
`Error` -- the caller treats them as user-facing 4xx.

## The canonical example: GitHubProvider (T05)

`src/auth/providers/github.ts` is the reference implementation. Reproduced
here in skeletal form -- consult the source for the production version:

```ts
export class GitHubProvider implements IdPProvider {
  public readonly name = "github";

  constructor(private readonly config: GitHubProviderConfig) {
    // clientId / clientSecret / optional apiBaseUrl + authBaseUrl for GHES
  }

  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string {
    const u = new URL(`${this.authBaseUrl}/login/oauth/authorize`);
    u.searchParams.set("client_id", this.config.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("scope", SCOPE);              // read:user user:email read:org
    u.searchParams.set("state", state);
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  }

  async exchangeCode(code, redirectUri, codeVerifier): Promise<ExchangeCodeResult> {
    // POST /login/oauth/access_token  -> parse zod schema, return access_token
    // GET  /user                       -> idp_user_id + name
    // GET  /user/emails                -> filter primary && verified
    // 5s AbortSignal.timeout + 1 retry on 5xx
    // Maps 401 -> IdPTokenRevoked, 403/5xx -> IdPTransientError
  }

  async listMemberships(accessToken: string): Promise<string[]> {
    // GET /user/orgs (paginated via RFC 5988 Link: rel="next")
    // SSRF guard: validate next URL origin matches apiBaseUrl
    // Returns lowercase org.login[]
  }

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    // POST /login/device/code with scope
  }

  async pollDeviceToken(deviceCode: string): Promise<DevicePollResult> {
    // POST /login/oauth/access_token with grant_type=device_code
    // Maps GitHub's error codes (authorization_pending, slow_down,
    // expired_token, access_denied) to DevicePollResult variants
  }
}
```

### Patterns to copy

- **zod schemas at the parse boundary**. Every untrusted IdP response is
  parsed through a zod schema (`TokenResponseSchema`, `GitHubUserSchema`,
  etc.). Module-private, since they describe wire format only.
- **`AbortSignal.timeout(5000) + 1 retry on 5xx`**. Caps tail latency
  without amplifying load. Beyond one retry the caller falls back to
  cached membership (T04 stale-on-error).
- **SSRF guard on pagination**. Validate `Link: rel="next"` URL origin
  matches the configured `apiBaseUrl` before following. A compromised
  upstream (or MITM in a GHES deployment) could otherwise point pagination
  at an attacker-controlled host, leaking the OAuth Bearer token.
- **GHES override**. `apiBaseUrl` and `authBaseUrl` constructor params
  enable self-hosted GitHub Enterprise Server. New providers should
  follow the same pattern for any IdP that has a self-hosted variant.

### Registration

`registry.ts` exports a `ProviderRegistry` class. `bootPhase2` constructs
exactly one instance per server and attaches it to
`AuthHandlerContext.providers`:

```ts
class ProviderRegistry {
  register(p: IdPProvider): void;
  get(name: string): IdPProvider | null;
  has(name: string): boolean;
  list(): IdPProvider[];
  names(): string[];
  size(): number;
  getDefault(): IdPProvider | null;     // first-registered, or set explicitly
  setDefault(name: string): void;
}
```

The first registration becomes the implicit default (so single-provider
deployments keep working without configuration). `setDefault(name)`
overrides if you need a non-GitHub default. `/auth/login` renders a
picker page whenever `size() > 1`; otherwise it 302s straight to the
default.

The current boot path always registers `GitHubProvider`, and conditionally
registers `GoogleProvider` and `OIDCProvider` based on env vars:

```ts
const providers = new ProviderRegistry();

providers.register(new GitHubProvider({
  clientId: env.COORDINATOR_GITHUB_CLIENT_ID,
  clientSecret: env.COORDINATOR_GITHUB_CLIENT_SECRET,
}));

if (env.COORDINATOR_GOOGLE_CLIENT_ID && env.COORDINATOR_GOOGLE_CLIENT_SECRET) {
  providers.register(new GoogleProvider({ ... }));
}

if (env.COORDINATOR_OIDC_ISSUER_URL && env.COORDINATOR_OIDC_CLIENT_ID
    && env.COORDINATOR_OIDC_CLIENT_SECRET) {
  providers.register(new OIDCProvider({ ... }));
}
```

The provider's `name` field becomes the value stored in
`users.idp_provider` for users who sign in via that flow. Once a user
exists, their provider is sticky -- subsequent refresh-rotation
re-checks always go back through the IdP that originally provisioned
them, even if the deployment later adds or removes other providers.

## Configuring Google

Built-in. Wire it on with two env vars:

```sh
export COORDINATOR_GOOGLE_CLIENT_ID=...
export COORDINATOR_GOOGLE_CLIENT_SECRET=...
```

Setting only one is a fail-closed boot error -- the coordinator refuses
to start half-configured.

### Setup

1. Google Cloud Console -> APIs & Services -> Credentials -> Create
   OAuth 2.0 Client ID
2. Application type: Web application
3. Authorized redirect URIs:
   `${COORDINATOR_PUBLIC_URL}/api/auth/oauth/callback`
4. Copy Client ID and Client Secret into the env vars above

### Required scopes

`GoogleProvider.buildAuthUrl` always requests `openid email profile`.
You don't need to add anything in the Google Cloud Console scope list.

### id_token verification (mandatory)

Every Google sign-in verifies the returned `id_token` against Google's
public JWKS (jose `createRemoteJWKSet`):

- `alg=RS256` only
- `iss=https://accounts.google.com`
- `aud` must equal your `COORDINATOR_GOOGLE_CLIENT_ID`
- `exp` must be in the future

Any failure maps to `IdPTokenRevoked` (401 to the caller). JWKS-fetch
failures map to `IdPTransientError` (503).

### Claim mapping

| `IdpUserInfo` field | Google id_token claim |
|---------------------|-----------------------|
| `idp_user_id`       | `sub`                 |
| `email`             | `email`               |
| `name`              | `name` (optional)     |
| `idp_org_id`        | `hd` (Workspace hosted domain, optional) |

### Gotchas

- **`hd` claim for org allowlist**. The `hd` claim only appears for
  Workspace accounts. A consumer Gmail user (`@gmail.com`) will produce
  an `IdpUserInfo` with `idp_org_id` undefined -- the allowlist code
  treats them as un-allowlisted.
- **Device flow**. `GoogleProvider.requestDeviceCode` / `pollDeviceToken`
  are not implemented yet. Google's RFC 8628 endpoint
  (`https://oauth2.googleapis.com/device/code`) is limited to installed
  app clients, which the coordinator's web-app client registration
  cannot satisfy.
- **`listMemberships` throws** -- Google has no GitHub-org equivalent.
  Allowlist deployments must drive off the `hd` claim instead;
  schema-level hd allowlist is planned for v0.10.

## Configuring generic OIDC

Built-in. Wire it on with three env vars:

```sh
export COORDINATOR_OIDC_ISSUER_URL=https://your-tenant.example.com
export COORDINATOR_OIDC_CLIENT_ID=...
export COORDINATOR_OIDC_CLIENT_SECRET=...
```

All three are required together; any partial config is a fail-closed
boot error. The issuer URL is parse-and-protocol checked at boot.

### Discovery

On the first call to `/auth/login`, `OIDCProvider` fetches
`${ISSUER}/.well-known/openid-configuration` and caches:

- `authorization_endpoint`
- `token_endpoint`
- `jwks_uri`

The discovery doc's own `issuer` field MUST equal the configured
`COORDINATOR_OIDC_ISSUER_URL` -- if not, boot is fine but the first
`/auth/login` fails with a `discovery issuer mismatch` error. This
defends against an attacker who can redirect requests to a malicious
discovery URL.

The cache lives for the process lifetime (OIDC issuers publish stable
endpoint URLs by contract; a boot redeploy is the implicit invalidator).

### id_token verification (mandatory)

Every OIDC sign-in verifies the returned `id_token` against the
discovered JWKS:

- `alg=RS256` only (`alg=none` and HS256 are rejected)
- `iss` must equal `COORDINATOR_OIDC_ISSUER_URL` exactly (no trailing
  slash normalization on the compare -- if your IdP returns
  `https://issuer.example/` in `iss`, configure that exact value here)
- `aud` must equal `COORDINATOR_OIDC_CLIENT_ID`
- `exp` must be in the future

JWKS-by-`kid` lookup is automatic. Verification failure -> 401;
JWKS-fetch failure -> 503.

### Claim mapping

| `IdpUserInfo` field | OIDC claim                                                             |
|---------------------|------------------------------------------------------------------------|
| `idp_user_id`       | `sub`                                                                  |
| `email`             | `email` -> `preferred_username` -> `sub` (first non-empty wins)        |
| `name`              | `name` (optional)                                                      |
| `idp_org_id`        | not set (generic OIDC has no portable org claim; see Gotchas)          |

### Provider name in the picker

The registry key is `"oidc"` and the picker label is `"Single
Sign-On"`. If you want a more specific label (e.g. `"Okta"`), construct
the provider with an explicit `name`:

```ts
new OIDCProvider({ ..., name: "okta" });
```

Then `?provider=okta` is the picker target; the title-cased fallback
gives the user "Continue with Okta".

### Gotchas

- **`listMemberships` throws** -- generic OIDC has no portable group
  model. Some IdPs publish `groups`, others use
  `realm_access.roles` (Keycloak) or App Role claims (Azure AD).
  Deployments needing OIDC-driven allowlisting must vendor a subclass
  that knows the issuer-specific claim shape.
- **Device flow is not implemented**. RFC 8628 support is optional in
  OIDC core; a future PR will probe `device_authorization_endpoint`
  in the discovery doc and conditionally implement
  `requestDeviceCode` / `pollDeviceToken`.
- **`nonce` is not currently sent or verified**. PKCE + state HMAC
  already provide proof-of-possession; nonce-as-defense-in-depth
  requires an extra `oauth_state.nonce` column (planned).

## Configuring Azure AD / Entra ID

Microsoft Entra ID (formerly Azure Active Directory) is OIDC-compliant
and works through the built-in `OIDCProvider`. Use the `_v2.0` issuer
URL -- v1.0 is deprecated and does not advertise discovery:

```sh
export COORDINATOR_OIDC_ISSUER_URL=https://login.microsoftonline.com/${TENANT_ID}/v2.0
export COORDINATOR_OIDC_CLIENT_ID=...
export COORDINATOR_OIDC_CLIENT_SECRET=...
```

For multi-tenant apps use `common` or `organizations` as the tenant
segment; the discovery doc handles the rest.

### Setup

1. Entra admin center -> App registrations -> New registration
2. Supported account types: choose single-tenant (recommended) or
   multi-tenant
3. Redirect URI: `${COORDINATOR_PUBLIC_URL}/api/auth/oauth/callback`
4. Authentication -> Allow public client flows: enable for device flow
5. Certificates & secrets -> Client secret

### Required scopes

- `openid`
- `email`
- `profile`
- `User.Read` (Microsoft Graph) -- for richer user info
- `GroupMember.Read.All` -- for group/tenant allowlisting (admin consent)

### Claim mapping

| `IdpUserInfo` field | Entra source                               |
|---------------------|--------------------------------------------|
| `idp_user_id`       | `oid` claim (immutable; preferred over `sub`) |
| `email`             | `email` or `preferred_username`            |
| `name`              | `name`                                     |
| `idp_org_id`        | `tid` claim (tenant ID)                    |

### Gotchas

- **`oid` vs `sub`**. The `oid` (object ID) is immutable across the
  user's lifetime and consistent across apps in the same tenant. The
  `sub` is per-app and changes if you re-register. Always use `oid` as
  `idp_user_id` for Entra.
- **Multi-tenant apps**. If you register multi-tenant, the `tid` claim
  identifies the user's tenant. Map this to `idp_org_id` for
  per-tenant allowlisting. Single-tenant apps have a constant `tid`
  and should ignore it.
- **Group membership over Microsoft Graph**. Calling
  `https://graph.microsoft.com/v1.0/me/memberOf` requires
  `GroupMember.Read.All` AND admin consent. Without admin consent the
  call returns 403 -- map to `IdPTransientError` for cache fallback.
- **Token endpoint origin**. Entra v2.0 endpoint is
  `https://login.microsoftonline.com/${tid}/oauth2/v2.0/token` -- the
  tenant ID is in the URL path. For multi-tenant apps use
  `common` or `organizations` as the tenant placeholder.
- **Device flow**. Supported via
  `https://login.microsoftonline.com/${tid}/oauth2/v2.0/devicecode`.

## Checklist for custom providers

If your IdP isn't OIDC-conformant and you need to vendor a subclass into
a fork, ensure:

- [ ] `class MyProvider implements IdPProvider`
- [ ] `name` is lowercase, URL-safe, unique in the registry
- [ ] zod schemas for all IdP response shapes
- [ ] `AbortSignal.timeout(5000)` on every fetch
- [ ] One retry on 5xx / network error; no retry on 4xx (where applicable)
- [ ] `IdPTokenRevoked` thrown on 401
- [ ] `IdPTransientError` thrown on 403 / 5xx / network
- [ ] If you return a signed token (id_token / SAML assertion / JWT
      access token), verify its signature against the IdP's public keys
      and pin the algorithm. Mirror the `GoogleProvider` or `OIDCProvider`
      pattern (jose `createRemoteJWKSet` + `jwtVerify` with
      `algorithms: ["RS256"]`)
- [ ] `listMemberships` returns LOWERCASE strings (or throws fail-fast
      if your IdP has no portable group model)
- [ ] SSRF guard on any paginated `Link: rel="next"` (or equivalent)
- [ ] Self-hosted variant override (GHES / Azure Gov / etc.) via
      constructor params
- [ ] Conditional registration in `bootPhase2` based on env vars
- [ ] Unit tests with mocked fetch (follow `tests/unit/google-provider.test.ts`
      or `tests/unit/oidc-provider.test.ts` for the JWKS + signed-token
      verification pattern). 100% branch coverage enforced via vitest
      thresholds.
- [ ] Audit-log events use the existing `audit()` API; no new tier
      categories required
- [ ] Provider label rendered by the picker comes from
      `src/auth/pages/login-picker.html.ts`. Either pick a registry
      name whose title-case rendering looks right ("okta" -> "Okta") or
      patch `providerLabel()` to add a friendly mapping.
