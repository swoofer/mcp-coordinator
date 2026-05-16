import type {
  IdPProvider,
  ExchangeCodeResult,
  IdpRefreshResult,
} from "./types.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_AUTH_BASE,
  TokenResponseSchema,
  fetchGitHubUserInfo,
  fetchWithRetry,
  listGitHubAppInstallations,
  listGitHubOrgs,
  mapGitHubHttpError,
} from "./github-shared.js";

/**
 * GitHub App provider (T53, v0.10.0).
 *
 * Differences from GitHubProvider (OAuth App):
 *   - No `scope` query parameter on the authorize URL -- GitHub Apps
 *     declare permissions at registration time; sending scope at all
 *     is rejected by GitHub for App OAuth flows.
 *   - User-to-server tokens have an 8h TTL (`expires_in: 28800`) and
 *     come with a refresh token (`refresh_token` + 6mo
 *     `refresh_token_expires_in`). The provider surfaces those
 *     fields in ExchangeCodeResult so refresh-rotation can store
 *     them and use refreshIdpToken later.
 *   - listMemberships uses the same /user/orgs endpoint. What the
 *     user can see is gated by the App's permissions AND the
 *     installations on the user's orgs; if the App isn't installed
 *     in an org, that org won't appear.
 *   - No device flow (GitHub Apps do not currently support RFC 8628;
 *     `requestDeviceCode` / `pollDeviceToken` stay undefined per the
 *     IdPProvider optional contract).
 *
 * Design rationale, threat model, and out-of-scope items are
 * documented in docs/superpowers/specs/2026-05-16-github-app-design.md.
 */
/**
 * T57 (v0.10.3): how the App provider sources the allowlist
 * candidate list at sign-in time.
 *
 *   "user_orgs"          (default) -- call `GET /user/orgs` with the
 *                         user's user-to-server token; returns the
 *                         user's GitHub-org memberships. Mirrors
 *                         OAuth App behaviour.
 *   "user_installations" -- call `GET /user/installations`; returns
 *                         the App-installations the user can access.
 *                         The App's installation footprint IS the
 *                         allowlist -- uninstalling the App from an
 *                         org evicts users from that org without any
 *                         coordinator config change. No App private
 *                         key needed; the user's user-to-server
 *                         token is sufficient.
 */
export type GitHubAppAllowlistSource = "user_orgs" | "user_installations";

export interface GitHubAppProviderConfig {
  clientId: string;
  clientSecret: string;
  // GHES support: shared with GitHubProvider since both endpoints
  // live at the same hostnames in GHES too.
  apiBaseUrl?: string;
  authBaseUrl?: string;
  // Optional override of the registry key; defaults to "github-app".
  // The picker will title-case this for display, so prefer short
  // lowercase strings.
  name?: string;
  /** T57: see GitHubAppAllowlistSource. Defaults to "user_orgs" for
   *  backward compatibility with v0.10.0. */
  allowlistSource?: GitHubAppAllowlistSource;
}

export class GitHubAppProvider implements IdPProvider {
  readonly name: string;
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;
  private readonly allowlistSource: GitHubAppAllowlistSource;

  constructor(private readonly cfg: GitHubAppProviderConfig) {
    this.name = cfg.name ?? "github-app";
    this.apiBaseUrl = cfg.apiBaseUrl ?? DEFAULT_API_BASE;
    this.authBaseUrl = cfg.authBaseUrl ?? DEFAULT_AUTH_BASE;
    this.allowlistSource = cfg.allowlistSource ?? "user_orgs";
  }

  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
    });
    if (codeChallenge) {
      params.set("code_challenge", codeChallenge);
      params.set("code_challenge_method", "S256");
    }
    return `${this.authBaseUrl}/login/oauth/authorize?${params.toString()}`;
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
    });
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }

    const res = await fetchWithRetry(`${this.authBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw mapGitHubHttpError(res.status, "GitHub App");
    }

    const tokenJson = await res.json();
    const token = TokenResponseSchema.parse(tokenJson);
    const user = await fetchGitHubUserInfo(this.apiBaseUrl, token.access_token);
    return {
      user,
      accessToken: token.access_token,
      ...(token.expires_in !== undefined
        ? { accessTokenExpiresIn: token.expires_in }
        : {}),
      ...(token.refresh_token !== undefined
        ? { refreshToken: token.refresh_token }
        : {}),
      ...(token.refresh_token_expires_in !== undefined
        ? { refreshTokenExpiresIn: token.refresh_token_expires_in }
        : {}),
    };
  }

  async listMemberships(accessToken: string): Promise<string[]> {
    if (this.allowlistSource === "user_installations") {
      return listGitHubAppInstallations(this.apiBaseUrl, accessToken);
    }
    return listGitHubOrgs(this.apiBaseUrl, accessToken);
  }

  /**
   * Exchange a refresh token for a fresh access+refresh pair. Called
   * by refresh-rotation when a user-to-server access token comes back
   * 401 from /user/orgs. Refresh-token replay detection is NOT
   * implemented here -- if the same refresh token is used twice
   * concurrently, both calls may succeed and GitHub will silently
   * revoke at its discretion. Documented as a residual risk.
   */
  async refreshIdpToken(refreshToken: string): Promise<IdpRefreshResult> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetchWithRetry(`${this.authBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw mapGitHubHttpError(res.status, "GitHub App refresh");
    }
    const tokenJson = await res.json();
    // GitHub returns {error: "bad_refresh_token"} as a 200 body for
    // some failure modes. Treat any token-response missing
    // access_token as a revoke signal.
    if (
      typeof (tokenJson as { error?: unknown }).error === "string" ||
      typeof (tokenJson as { access_token?: unknown }).access_token !== "string"
    ) {
      throw mapGitHubHttpError(401, "GitHub App refresh");
    }
    const token = TokenResponseSchema.parse(tokenJson);
    return {
      accessToken: token.access_token,
      ...(token.expires_in !== undefined
        ? { accessTokenExpiresIn: token.expires_in }
        : {}),
      ...(token.refresh_token !== undefined
        ? { refreshToken: token.refresh_token }
        : {}),
      ...(token.refresh_token_expires_in !== undefined
        ? { refreshTokenExpiresIn: token.refresh_token_expires_in }
        : {}),
    };
  }
}
