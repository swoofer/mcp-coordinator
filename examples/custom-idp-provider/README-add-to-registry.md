# Registering a custom IdP provider

The provider registry (`src/auth/providers/registry.ts`) exports a
`ProviderRegistry` class; `bootPhase2` constructs one instance and
attaches it to the handler context as `ctx.providers`. To add a new
provider:

1. Copy `google-provider.ts` to `src/auth/providers/<name>.ts` in
   your fork of mcp-coordinator, and rename the exported class (it's
   `GoogleProvider` in the example, matching the built-in
   `src/auth/providers/google.ts` -- rename it to something specific
   to your IdP, e.g. `OktaProvider`, to avoid confusion with the
   real one). Update the relative imports so they point at sibling
   files rather than the cross-tree `../../src/...` paths used by the
   example.

2. Modify `src/boot.ts` to import and register the provider. Inside
   `bootPhase2`, after the existing GitHub registration on the
   `providers` registry instance (illustrated here for a hypothetical
   `OktaProvider` -- substitute your own provider/env-var names):

   ```ts
   import { OktaProvider } from "./auth/providers/okta.js";

   // inside bootPhase2, after `providers.register(githubProvider)`:
   if (process.env.COORDINATOR_OKTA_CLIENT_ID) {
     providers.register(
       new OktaProvider({
         clientId: process.env.COORDINATOR_OKTA_CLIENT_ID,
         clientSecret: process.env.COORDINATOR_OKTA_CLIENT_SECRET!,
       }),
     );
   }
   ```

   (If your IdP speaks standard OIDC discovery, you likely don't need
   a custom class at all -- register another instance of the built-in
   `OIDCProvider` from `src/auth/providers/oidc.ts` instead, the same
   way `bootPhase2` already does for `COORDINATOR_OIDC_*`.)

   Use the existing pattern in `bootPhase2` -- env access goes
   through the central config object, not direct `process.env`
   reads scattered in feature modules. There's a lint rule
   (`lint-no-direct-env-in-auth`) that will flag direct `process.env`
   access inside `src/auth/`, so the registration must live in the
   boot composer where env reads are concentrated.

3. **Multi-provider picker UI.** `/auth/login` shows a picker whenever
   `providers.size() > 1` (`src/auth/providers/registry.ts`); the
   first-registered provider (GitHub, always registered first) stays
   the implicit default for legacy single-provider call sites. Your
   new provider is selectable via the picker as soon as it's
   registered -- no additional wiring needed for that part.

4. **Allowlist semantics.** Set `allowlistStrategy` on your provider
   class to whichever of `"memberships"`, `"idp_org_id"`,
   `"id_token_groups"`, or `"none"` matches your IdP's identity model
   (`src/auth/providers/types.ts`). `"idp_org_id"` and
   `"id_token_groups"` already have dedicated columns/handling
   (`orgs.allowlist_idp_org_id`, and `orgs.allowlist_github_org`
   reused as a group-name list respectively) -- you generally don't
   need a new migration unless none of the three existing strategies
   fit.

   See `README.md` in this directory for the longer discussion.

5. **Audit log shape.** The `auth.login.success` audit event
   includes the provider name in its `idp_provider` field. Your
   new provider's `name` property will appear there verbatim, so
   pick a short, stable, lowercase identifier (`google`, `okta`,
   `azure_ad`).

6. **Tests.** Mirror `tests/unit/github-provider.test.ts` (or
   `tests/unit/google-provider.test.ts` / `tests/unit/oidc-provider.test.ts`
   for a closer starting point) against your new provider. The
   OAuth-callback integration tests under `tests/integration/oauth-*.ts`
   exercise `handleOAuthCallback` with a swappable provider fixture
   (`singleProviderRegistry` in `tests/helpers/index.ts`) rather than
   being tied to one IdP; point that fixture at your new provider to
   exercise the callback path end-to-end.

## What you can't do without modifying src/

Without a custom build:

- Add new IdPs (this directory exists because of that)
- Disable the GitHub provider entirely (the boot composer registers
  it whenever the OAuth env vars are present)
- Change the allowlist semantics

What you CAN do without modifying src/:

- Disable OAuth entirely by setting `COORDINATOR_OAUTH_ENABLED=false`
  (this also disables the dashboard; only service tokens work)
- Restrict to a single GitHub org via `COORDINATOR_GITHUB_ORG`
- Add a reverse proxy that does its own auth in front (the
  coordinator's session cookie path is documented in
  `examples/nginx-reverse-proxy/`)

## Operator expectations for vendored builds

If you ship a fork to colleagues:

1. Pin the upstream version you forked from. The IdPProvider
   interface is not yet stable; minor versions may add required
   methods.
2. Rebuild and republish to your internal registry on each upstream
   bump. There is no runtime override path.
3. Document the env vars your custom provider reads, alongside the
   stock `COORDINATOR_*` vars. The audit log will show your
   provider's `name`; operators should know what it means.
