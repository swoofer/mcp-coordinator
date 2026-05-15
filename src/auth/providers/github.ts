import { z } from "zod";
import type {
  IdPProvider,
  ExchangeCodeResult,
  DeviceCodeResponse,
  DevicePollResult,
} from "./types.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_AUTH_BASE,
  TokenResponseSchema,
  apiHeaders,
  fetchGitHubUserInfo,
  fetchWithRetry,
  listGitHubOrgs,
  mapGitHubHttpError,
} from "./github-shared.js";

export interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
  // GHES support: override base URLs. Default to github.com / api.github.com.
  apiBaseUrl?: string;
  authBaseUrl?: string;
}

const SCOPE = "read:user user:email read:org";

const DeviceCodeResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number(),
});

const DevicePollErrorSchema = z.object({
  error: z.string(),
  interval: z.number().optional(),
});

export class GitHubProvider implements IdPProvider {
  readonly name = "github";
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;

  constructor(private readonly cfg: GitHubProviderConfig) {
    this.apiBaseUrl = cfg.apiBaseUrl ?? DEFAULT_API_BASE;
    this.authBaseUrl = cfg.authBaseUrl ?? DEFAULT_AUTH_BASE;
  }

  buildAuthUrl(state: string, redirectUri: string, codeChallenge?: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      state,
      scope: SCOPE,
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
      throw mapGitHubHttpError(res.status);
    }

    const tokenJson = await res.json();
    const token = TokenResponseSchema.parse(tokenJson);
    const user = await fetchGitHubUserInfo(this.apiBaseUrl, token.access_token);
    return { user, accessToken: token.access_token };
  }

  async listMemberships(accessToken: string): Promise<string[]> {
    return listGitHubOrgs(this.apiBaseUrl, accessToken);
  }

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      scope: SCOPE,
    });
    const res = await fetchWithRetry(`${this.authBaseUrl}/login/device/code`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw mapGitHubHttpError(res.status);
    }
    const json = await res.json();
    return DeviceCodeResponseSchema.parse(json);
  }

  async pollDeviceToken(deviceCode: string): Promise<DevicePollResult> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
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
      throw mapGitHubHttpError(res.status);
    }
    const json = await res.json();

    // RFC 8628 §3.5: GitHub returns 200 with either an access_token or an
    // `error` field. Discriminate on presence of `error`.
    if (typeof (json as { error?: unknown }).error === "string") {
      const errResp = DevicePollErrorSchema.parse(json);
      switch (errResp.error) {
        case "authorization_pending":
          return { status: "authorization_pending" };
        case "slow_down":
          // RFC 8628 §3.5: a compliant server MUST include `interval` on slow_down.
          // Non-compliant server fallback: return 10s (2x the RFC minimum) as a
          // conservative guess. Caller does not pass its current interval, so we
          // cannot true add-5 here.
          return { status: "slow_down", new_interval: errResp.interval ?? 10 };
        case "expired_token":
          return { status: "expired_token" };
        case "access_denied":
          return { status: "access_denied" };
        default:
          throw new Error(`GitHub device-poll unknown error: ${errResp.error}`);
      }
    }

    const token = TokenResponseSchema.parse(json);
    const user = await fetchGitHubUserInfo(this.apiBaseUrl, token.access_token);
    return { status: "granted", user, accessToken: token.access_token };
  }

  // apiHeaders kept here as a re-export-by-method for tests that
  // assert on the constant. Implementations should prefer the
  // module-level apiHeaders from github-shared.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private _apiHeaders(accessToken: string): Record<string, string> {
    return apiHeaders(accessToken);
  }
}
