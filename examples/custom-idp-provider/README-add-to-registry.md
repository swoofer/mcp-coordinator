# Registering a custom IdP provider

The provider registry (`src/auth/providers/registry.ts`) exports a
`ProviderRegistry` class; `bootPhase2` constructs one instance and
attaches it to the handler context as `ctx.providers`. To add a new
provider:

1. Copy `google-provider.ts` to `src/auth/providers/<name>.ts` in
   your fork of mcp-coordinator. Update the relative imports so they
   point at sibling files rather than the cross-tree `../../src/...`
   paths used by the example.

2. Modify `src/boot.ts` to import and register the provider. Inside
   `bootPhase2`, after the existing GitHub registration on the
   `providers` registry instance:

   ```ts
   import { GoogleProvider } from "./auth/providers/google.js";

   // inside bootPhase2, after `providers.register(githubProvider)`:
   if (process.env.COORDINATOR_GOOGLE_CLIENT_ID) {
     providers.register(
       new GoogleProvider({
         clientId: process.env.COORDINATOR_GOOGLE_CLIENT_ID,
         clientSecret: process.env.COORDINATOR_GOOGLE_CLIENT_SECRET!,
       }),
     );
   }
   ```

   Use the existing pattern in `bootPhase2` -- env access goes
   through the central config object, not direct `process.env`
   reads scattered in feature modules. There's a lint rule
   (`lint-no-direct-env-in-auth`) that will flag direct `process.env`
   access inside `src/auth/`, so the registration must live in the
   boot composer where env reads are concentrated.

3. **Single-provider behaviour (v0.8 and earlier).** At v0.9.0 the
   registry is wired but `/auth/login` still routes through the
   first-registered (default) provider. The multi-provider picker
   UI activates in a later v0.9.x point release; until then
   registering additional providers is no-op at the login route,
   though the providers are still callable via `ctx.providers.get()`
   from any custom integration code.

4. **Allowlist semantics.** Phase 2's `orgs.allowlist_github_org`
   column is GitHub-specific by name. For a Google provider you
   would either:
   - reuse the column with hosted-domain values (`hd` claim), or
   - add a new column / migration for the IdP-specific allowlist
     and teach the login flow to select the right column based on
     the active provider.

   See `README.md` in this directory for the longer discussion.

5. **Audit log shape.** The `auth.login.success` audit event
   includes the provider name in its `idp_provider` field. Your
   new provider's `name` property will appear there verbatim, so
   pick a short, stable, lowercase identifier (`google`, `okta`,
   `azure_ad`).

6. **Tests.** Mirror `tests/unit/github-provider.test.ts` against
   your new provider. The integration test in
   `tests/integration/auth-flow.test.ts` is GitHub-specific and
   would need to be parameterised or duplicated; for a vendor build,
   forking the integration test is usually enough.

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
