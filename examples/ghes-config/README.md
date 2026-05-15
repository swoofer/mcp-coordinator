# GHES (GitHub Enterprise Server) configuration

This directory documents how to point mcp-coordinator at a GitHub
Enterprise Server instance instead of github.com. The included
`.env.example` shows the full set of environment variables you need.

> As of v0.8.1, `bootPhase2` reads `COORDINATOR_GITHUB_AUTH_BASE_URL`
> and `COORDINATOR_GITHUB_API_BASE_URL` from the environment and
> passes them through to the `GitHubProvider` constructor. Both env
> vars are optional; unset/empty falls back to the github.com defaults.
> Both values are validated at boot — they must parse as URLs and use
> `http://` or `https://`.
>
> The `.env.example` in this directory ships as-is for GHES
> deployments; no source patch is needed.

## How GitHubProvider's URLs are used

The provider takes two separate base URLs because GHES (and github.com)
expose login endpoints and REST API endpoints under different prefixes.

### `authBaseUrl`

Used to build:

- `${authBaseUrl}/login/oauth/authorize` -- the page the browser is
  redirected to during the OAuth dance
- `${authBaseUrl}/login/oauth/access_token` -- the server-side POST
  that exchanges the authorization code for an access token

For github.com this is `https://github.com`. For GHES this is your
instance hostname, for example `https://github.example.com`.

### `apiBaseUrl`

Used to build:

- `${apiBaseUrl}/user` -- the logged-in user's profile
- `${apiBaseUrl}/user/emails` -- the user's primary email
- `${apiBaseUrl}/user/memberships/orgs/{org}` -- membership check
  against the allowlisted org

For github.com this is `https://api.github.com`. For GHES this is
`https://<host>/api/v3` -- note the `/api/v3` suffix is part of the
GHES REST layout.

## Where to find each value in your GHES deployment

1. **GHES hostname** -- the URL admins use to access the web UI, e.g.
   `https://github.example.com`. Strip any trailing slash.
2. **OAuth app credentials** -- create an OAuth App in the GHES
   instance at `https://<host>/settings/applications/new` (for a
   personal app) or `https://<host>/organizations/<org>/settings/applications`
   (for an org-owned app, recommended for production).
   - Homepage URL: `https://coordinator.internal.example.com`
   - Authorization callback URL:
     `https://coordinator.internal.example.com/auth/callback`
3. **Org slug** -- the URL component, e.g. for
   `https://github.example.com/acme-platform` the slug is
   `acme-platform`. Not the display name.

## Network reachability

The coordinator container or process must be able to reach:

- `COORDINATOR_GITHUB_AUTH_BASE_URL` on 443 (token exchange)
- `COORDINATOR_GITHUB_API_BASE_URL` on 443 (user + org lookups)

For air-gapped GHES installs sitting behind an internal firewall,
ensure egress from the coordinator's host or pod is allowed to the
GHES instance. The browser side of the OAuth dance happens between
the user's browser and the GHES login page directly; the
coordinator only sees the back-channel token exchange.

If your GHES uses a private CA, the coordinator's Node.js process
needs the CA cert in its trust store. Set `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`
in the environment or supply a Node TLS CA file at build time. Self-
signed certs without a CA bundle will cause the token exchange to
fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

## Differences from github.com

| Concern | github.com | GHES |
| --- | --- | --- |
| OAuth app registration | github.com/settings/applications/new | INSIDE your GHES instance, at `https://<host>/settings/applications/new` |
| Auth endpoint host | github.com | your GHES hostname |
| API endpoint host | api.github.com | `<ghes-host>/api/v3` |
| Rate limits | global per token (5000/hr) | per-app, often higher; check `/api/v3/rate_limit` |
| Org membership API | identical shape | identical shape |
| Device flow support | yes | depends on GHES version (3.1+) |

The most common mistake is creating the OAuth app at github.com when
the coordinator will sign users in against GHES. The two are
separate OAuth realms; an app registered at github.com cannot
authenticate GHES users.

## Org allowlist matching

The coordinator checks org membership via
`GET ${apiBaseUrl}/user/memberships/orgs/${COORDINATOR_GITHUB_ORG}`.
The value of `COORDINATOR_GITHUB_ORG` must be the GHES org's URL
slug, lowercase, exactly as it appears in URLs on the GHES instance.

If you allowlist multiple orgs, today's schema accepts only one;
multi-org allowlisting is on the roadmap.

## Verifying the configuration

End-to-end smoke (v0.8.1+ ships the wiring; no source patch needed):

1. `curl https://<ghes-host>/api/v3/rate_limit` from the coordinator
   host -- confirms network reachability and TLS trust.
2. Boot the coordinator, watch logs for `idp_provider_registered name=github`
   with the configured `auth_base_url` and `api_base_url`.
3. Open `https://coordinator.internal.example.com/auth/login` in a
   browser. It should redirect to your GHES instance's OAuth login
   page, NOT to github.com. If it redirects to github.com, the env
   vars are not flowing through.
4. Complete the OAuth dance. The coordinator should issue a session
   cookie and the dashboard should load with your GHES username.

## What this example does NOT cover

- SAML SSO at the GHES layer (handled entirely inside GHES; the
  coordinator sees only the resulting OAuth tokens)
- GHES API tokens / PATs (the coordinator uses OAuth user tokens
  short-lived via the authorization-code flow)
- GHES Actions runner integration
- Migration from github.com to GHES (sessions and refresh-token
  families would all need to be reissued under the new IdP identity)
