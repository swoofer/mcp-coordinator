# IdP providers -- adding a new identity provider

mcp-coordinator's Phase 2 OAuth flow is decoupled from the underlying
identity provider via the `IdPProvider` interface (T02). Phase 2 ships
exactly one concrete implementation: `GitHubProvider` (T05). This document
shows how to add additional providers (Google, generic OIDC, Azure AD)
for Phase 4.

**Scope**: this is forward-looking scaffolding documentation. None of
the providers below are wired into v0.8.0. The registry pattern is
production-ready -- the missing piece is the per-provider implementation
plus boot-time registration.

References:

- `src/auth/providers/types.ts` (T02) -- the `IdPProvider` interface
- `src/auth/providers/registry.ts` (T02) -- the global Map<string, IdPProvider>
- `src/auth/providers/github.ts` (T05) -- the canonical GitHub implementation
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

  buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
  ): string;

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

`registry.ts` exposes:

```ts
export function registerProvider(p: IdPProvider): void;
export function getProvider(name: string): IdPProvider | null;
```

Provider registration happens during `bootPhase2(opts)` (T29) based on
env vars. The current boot path conditionally registers GitHub:

```ts
if (env.COORDINATOR_GITHUB_CLIENT_ID && env.COORDINATOR_GITHUB_CLIENT_SECRET) {
  registerProvider(new GitHubProvider({
    clientId: env.COORDINATOR_GITHUB_CLIENT_ID,
    clientSecret: env.COORDINATOR_GITHUB_CLIENT_SECRET,
  }));
}
```

To add a provider in Phase 4, follow the same pattern: read the
provider-specific env vars, instantiate, register. The provider key
(`p.name`) becomes the active IdP for users created via that flow;
users keep their original provider on their `users.idp_provider` column.

## Adding Google (Phase 4)

OAuth 2.1 + OpenID Connect via Google Identity Platform.

### Setup

1. Google Cloud Console -> APIs & Services -> Credentials -> Create
   OAuth 2.0 Client ID
2. Application type: Web application
3. Authorized redirect URIs:
   `${COORDINATOR_PUBLIC_URL}/api/auth/oauth/callback`
4. Copy Client ID and Client Secret

### Required scopes

- `openid`
- `email` -- maps to `IdpUserInfo.email` (validated via the `email_verified`
  claim before trusting)
- `profile` -- maps to `IdpUserInfo.name`

For Google Workspace org allowlisting:

- `https://www.googleapis.com/auth/admin.directory.group.readonly` -- list
  the user's Workspace groups (membership-equivalent semantics)

### Claim mapping

| `IdpUserInfo` field | Google source                              |
|---------------------|--------------------------------------------|
| `idp_user_id`       | `sub` claim from the ID token              |
| `email`             | `email` claim (require `email_verified=true`) |
| `name`              | `name` claim (optional)                    |
| `idp_org_id`        | `hd` claim (hosted domain, e.g. "example.com") |

### Gotchas

- **Discovery doc**. Google publishes
  `https://accounts.google.com/.well-known/openid-configuration` -- fetch
  once at boot, cache the `token_endpoint` and `authorization_endpoint`
  URIs.
- **`hd` claim for org allowlist**. The `hd` claim is unverified for
  consumer Gmail accounts. For Workspace tenancy, additionally verify the
  user is in the expected Workspace customer via the Admin SDK
  (otherwise an attacker can spoof `hd` with a custom OAuth client of
  their own).
- **Device flow**. Google supports RFC 8628 via the
  `https://oauth2.googleapis.com/device/code` endpoint. Limited to
  installed app clients; web app clients cannot use device flow.
- **Refresh tokens**. Google issues refresh tokens only when
  `access_type=offline` is included in the auth URL and the user has
  not previously consented. The coordinator's own refresh-token rotation
  is independent of the IdP refresh, but storing the IdP refresh is
  necessary if you ever need to re-poll membership without re-prompting
  the user.

## Adding generic OIDC (Phase 4)

For any RFC 6749 + OIDC-compliant IdP not specifically supported (Okta,
Auth0, Keycloak, ...).

### Setup

- Issuer URL: `https://your-tenant.example.com`
- Discover via `${ISSUER}/.well-known/openid-configuration`
- Required env vars (template):

```
COORDINATOR_OIDC_ISSUER_URL=
COORDINATOR_OIDC_CLIENT_ID=
COORDINATOR_OIDC_CLIENT_SECRET=
COORDINATOR_OIDC_NAME=okta              # registry key
COORDINATOR_OIDC_SCOPES=openid email profile groups
```

### Claim mapping

OIDC standard claims map directly:

| `IdpUserInfo` field | OIDC claim                                 |
|---------------------|--------------------------------------------|
| `idp_user_id`       | `sub`                                      |
| `email`             | `email` (require `email_verified=true`)    |
| `name`              | `name`                                     |
| `idp_org_id`        | `groups` (first match, or per allowlist)   |

### Gotchas

- **ID token signature verification**. Unlike GitHub (which returns an
  opaque access token), OIDC returns a signed JWT ID token. You MUST
  verify the signature against the IdP's JWKS (`jwks_uri` from the
  discovery doc), validate `iss`, `aud`, `exp`, `iat`, and `nonce` (if
  used). The jose library used elsewhere in the codebase handles all of
  this -- pin algorithm via `algorithms: [...]` allowlist, never accept
  `alg=none`.
- **JWKS rotation**. Cache the JWKS with a short TTL (10 minutes) and
  refresh on `kid` miss. Do NOT call `jwks_uri` on every login.
- **Groups encoding**. Some IdPs return `groups` as an array of strings;
  others as a space-delimited string; Keycloak nests them in
  `realm_access.roles`. Use a configurable JSONPath or per-provider
  override.
- **Device flow**. RFC 8628 support is optional in OIDC. Probe
  `device_authorization_endpoint` in the discovery doc; absence means
  pollDeviceToken / requestDeviceCode should throw "not supported" at
  construction time.

## Adding Azure AD / Entra ID (Phase 4+)

Microsoft Entra ID (formerly Azure Active Directory) is OIDC-compliant
but has Microsoft-specific quirks worth a dedicated implementation.

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

## Checklist for new providers

When adding a provider in Phase 4, ensure:

- [ ] `class MyProvider implements IdPProvider`
- [ ] `name` is lowercase, URL-safe, unique in the registry
- [ ] zod schemas for all IdP response shapes
- [ ] `AbortSignal.timeout(5000)` on every fetch
- [ ] One retry on 5xx / network error; no retry on 4xx
- [ ] `IdPTokenRevoked` thrown on 401
- [ ] `IdPTransientError` thrown on 403 / 5xx / network
- [ ] `listMemberships` returns LOWERCASE strings
- [ ] SSRF guard on any paginated `Link: rel="next"` (or equivalent)
- [ ] Self-hosted variant override (GHES / Azure Gov / etc.) via
      constructor params
- [ ] Conditional registration in `bootPhase2` based on env vars
- [ ] Unit tests with mocked fetch (follow `tests/auth/providers/github.test.ts`
      pattern); per-file 100% branch coverage enforced via vitest
      threshold
- [ ] Integration test for the OAuth callback happy path
- [ ] Audit-log events use the existing `audit()` API; no new tier
      categories required

Out-of-scope for v0.8.0; planned for Phase 4. The IdPProvider interface
(T02) and GitHubProvider (T05) are production-ready and serve as the
foundation.
