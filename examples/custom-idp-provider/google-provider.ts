/**
 * Example: Google OAuth 2.0 IdPProvider implementation.
 *
 * This file is a TEMPLATE -- copy into your fork of mcp-coordinator
 * and register via src/auth/providers/registry.ts at boot. Phase 2
 * ships with GitHubProvider only; multi-provider registration is
 * Phase 4.
 *
 * Tested against Google OAuth 2.0 (https://accounts.google.com).
 * For OIDC providers (Auth0, Okta, Azure AD), see oidc-provider.ts
 * (not included here; the structure is similar -- discover via the
 * OIDC Discovery doc at /.well-known/openid-configuration).
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
  readonly name = "google";

  constructor(private readonly cfg: GoogleProviderConfig) {}

  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string {
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
    return u.toString();
  }

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string,
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
      // idp_org_id intentionally undefined; mcp-coordinator's
      // allowlist is per-GitHub-org. For Google: use `hd` (hosted
      // domain) as a proxy by setting orgs.allowlist_github_org=<hd>.
      // Or extend the schema with allowlist_google_hd (Phase 4
      // territory).
    };
    return { user: idp, accessToken: token.access_token };
  }

  async listMemberships(_accessToken: string): Promise<string[]> {
    // Google has no direct equivalent of GitHub orgs. Options:
    //   1. Use the user's `hd` (hosted domain) as a singleton "org"
    //   2. Use Google Workspace Directory API (requires admin scope)
    //   3. Hardcode allowlist by email domain in
    //      orgs.allowlist_github_org
    //
    // Phase 4 will need to abstract the allowlist column to support
    // multiple IdPs. For now this throws -- callers fall back to the
    // hd-as-org pattern in exchangeCode above.
    throw new Error(
      "Google listMemberships not implemented; use hd-based allowlist instead",
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
  // browser-only auth-code path.
  //
  // Type-only imports kept above so the references compile if you
  // uncomment skeleton stubs below.
  //   async requestDeviceCode(): Promise<DeviceCodeResponse> { ... }
  //   async pollDeviceToken(deviceCode: string): Promise<DevicePollResult> { ... }
}

// Re-export the unused type aliases so IDEs don't flag them as dead
// imports while you're filling in the device-flow methods.
export type { DeviceCodeResponse, DevicePollResult };
