/**
 * Example: minimal OAuth 2.0 IdPProvider implementation, shaped after
 * Google's authorization-code flow.
 *
 * mcp-coordinator ships GitHubProvider, GitHubAppProvider,
 * GoogleProvider, AND a generic OIDCProvider built in (see
 * `src/auth/providers/{github,github-app,google,oidc}.ts`) --
 * production Google sign-in already uses `src/auth/providers/google.ts`,
 * which additionally verifies the id_token signature against Google's
 * JWKS rather than making a plain userinfo round-trip. This file is a
 * TEMPLATE for a fully custom (non-OIDC-conformant) IdP that satisfies
 * the `IdPProvider` interface via a userinfo-endpoint call instead --
 * copy it into your fork and register via `src/auth/providers/registry.ts`
 * at boot (see `README-add-to-registry.md` in this directory) only if
 * your IdP isn't already covered by one of the built-ins. If your IdP
 * speaks standard OIDC discovery (Auth0, Okta, Azure AD, Keycloak,
 * Authentik), use the built-in `src/auth/providers/oidc.ts` instead of
 * vendoring a new provider.
 *
 * Note: this file lives under examples/ which is OUTSIDE the
 * coordinator's tsconfig.json rootDir, so it is documentation-by-
 * code rather than something the build system compiles. The imports
 * below are written as if it had been copied into src/auth/providers/
 * already.
 */

import { z } from "zod";
import type {
  IdPProvider,
  ExchangeCodeResult,
  IdpUserInfo,
  DeviceCodeResponse,
  DevicePollResult,
} from "../../src/auth/providers/types.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";

export interface GoogleProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // for buildAuthUrl convenience; otherwise per-call
}

const TokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
  id_token: z.string().optional(),
  refresh_token: z.string().optional(),
});

const UserInfoSchema = z.object({
  sub: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
  hd: z.string().optional(), // hosted domain for Google Workspace
});

export class GoogleProvider implements IdPProvider {
  readonly name = "google-example";
  /** This IdP has no GitHub-org equivalent, so the allowlist match
   *  goes through `idp_org_id` (the Workspace `hd` claim) rather than
   *  the default "memberships" strategy -- mirrors the real
   *  `GoogleProvider` in `src/auth/providers/google.ts`. See
   *  `AllowlistStrategy` in `src/auth/providers/types.ts`. */
  readonly allowlistStrategy = "idp_org_id" as const;

  constructor(private readonly cfg: GoogleProviderConfig) {}

  buildAuthUrl(
    state: string,
    redirectUri: string,
    codeChallenge?: string,
    nonce?: string,
  ): string {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", "openid email profile");
    u.searchParams.set("response_type", "code");
    u.searchParams.set("access_type", "offline");
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    // Current IdPProvider interface (src/auth/providers/types.ts) passes
    // a per-request `nonce` (OIDC Core 1.0 §3.1.2.1, defence-in-depth
    // against id_token replay). Forward it whenever present; if your
    // exchangeCode doesn't verify an id_token signature (as this
    // example doesn't -- see note there), the nonce round-trip is
    // still worth sending since real OIDC-conformant IdPs expect it.
    if (nonce) {
      u.searchParams.set("nonce", nonce);
    }
    return u.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
    _nonce?: string | null,
  ): Promise<ExchangeCodeResult> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    if (codeVerifier) body.set("code_verifier", codeVerifier);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (tokenRes.status === 401) throw new IdPTokenRevoked();
    if (tokenRes.status >= 500) {
      throw new IdPTransientError(`Google token endpoint ${tokenRes.status}`);
    }
    if (!tokenRes.ok) throw new Error(`Google exchange failed: ${tokenRes.status}`);
    const token = TokenSchema.parse(await tokenRes.json());

    // NOTE: this example authenticates the user via a userinfo-endpoint
    // round-trip instead of verifying the id_token's signature. That's
    // a legitimate, simpler pattern for a hand-rolled OAuth 2.0 IdP,
    // but it is NOT what the built-in `GoogleProvider`
    // (src/auth/providers/google.ts) does -- that one verifies the
    // id_token against Google's JWKS with `jose` and never calls
    // /userinfo. If you're vendoring an IdP that issues a signed
    // id_token, prefer verifying it directly (fewer round-trips, one
    // less trust boundary) -- see google.ts for the reference pattern.
    const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (userRes.status === 401) throw new IdPTokenRevoked();
    if (userRes.status >= 500) {
      throw new IdPTransientError(`Google userinfo ${userRes.status}`);
    }
    const user = UserInfoSchema.parse(await userRes.json());

    const idp: IdpUserInfo = {
      idp_user_id: user.sub,
      email: user.email,
      name: user.name,
      // idp_org_id is the Workspace hosted-domain (`hd`) claim, matched
      // against orgs.allowlist_idp_org_id per this provider's
      // allowlistStrategy = "idp_org_id" above. Absent for personal
      // @gmail.com accounts (no Workspace tenant).
      idp_org_id: user.hd,
    };
    return { user: idp, accessToken: token.access_token };
  }

  async listMemberships(_accessToken: string): Promise<string[]> {
    // Google has no direct equivalent of GitHub orgs, and this
    // provider's allowlistStrategy is "idp_org_id" (see above), so
    // listMemberships is never called by the allowlist check in normal
    // operation. It's implemented as a hard failure rather than
    // omitted so any code path that calls it unconditionally gets a
    // clear stack trace instead of a silent empty-memberships denial.
    throw new Error(
      "listMemberships not implemented; this provider uses the idp_org_id allowlist strategy instead",
    );
  }

  // Google supports device flow at:
  //   https://oauth2.googleapis.com/device/code
  // Implementation follows the same RFC 8628 pattern as
  // GitHubProvider; omitted for brevity. See
  // src/auth/providers/github.ts requestDeviceCode + pollDeviceToken
  // for the template. Add as instance methods on this class with
  // signatures matching DeviceCodeResponse / DevicePollResult from
  // src/auth/providers/types.ts -- the IdPProvider interface
  // declares them as optional, so absence here is fine for the
  // browser-only auth-code path. refreshIdpToken is likewise optional
  // and only worth implementing if your IdP issues expiring access
  // tokens with a refresh token (Google's do, when access_type=offline
  // is requested, as above).
  //
  // Type-only imports kept above so the references compile if you
  // uncomment skeleton stubs below.
  //   async requestDeviceCode(): Promise<DeviceCodeResponse> { ... }
  //   async pollDeviceToken(deviceCode: string): Promise<DevicePollResult> { ... }
}

// Re-export the unused type aliases so IDEs don't flag them as dead
// imports while you're filling in the device-flow methods.
export type { DeviceCodeResponse, DevicePollResult };
