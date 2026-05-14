import { z } from "zod";
import type {
  IdPProvider,
  IdpUserInfo,
  ExchangeCodeResult,
  DeviceCodeResponse,
  DevicePollResult,
} from "./types.js";
import { IdPTokenRevoked, IdPTransientError } from "./errors.js";

export interface GitHubProviderConfig {
  clientId: string;
  clientSecret: string;
  // GHES support: override base URLs. Default to github.com / api.github.com.
  apiBaseUrl?: string;
  authBaseUrl?: string;
}

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_AUTH_BASE = "https://github.com";
const SCOPE = "read:user user:email read:org";
const REQUEST_TIMEOUT_MS = 5000;

// zod schemas validate untrusted IdP responses at the parse boundary.
// Kept module-private since they describe wire-format only.
const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  scope: z.string().optional(),
});

const GitHubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
});

const GitHubEmailSchema = z.object({
  email: z.string(),
  primary: z.boolean(),
  verified: z.boolean(),
});

const GitHubEmailsSchema = z.array(GitHubEmailSchema);

const GitHubOrgSchema = z.object({ login: z.string() });
const GitHubOrgsSchema = z.array(GitHubOrgSchema);

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

/**
 * Retry once on 5xx OR network/timeout. Don't retry on 4xx.
 *
 * Rationale: a single retry covers transient blips (GitHub maintenance windows,
 * brief network flaps) without amplifying load. Beyond one retry callers
 * should rely on cache (T04 membership-cache stale-on-error) and surface
 * IdPTransientError so upstream backoff policy can take over.
 */
async function fetchOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  // AbortSignal.timeout is the Node 20+ standard primitive — avoids a manual
  // setTimeout + AbortController pair and produces no anonymous closure.
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // First attempt: swallow 5xx/network errors so we get exactly one retry.
  try {
    const res = await fetchOnce(url, init, timeoutMs);
    if (res.status < 500 || res.status >= 600) return res;
  } catch {
    // fall through to retry
  }
  // Second attempt: surface whatever happens.
  return fetchOnce(url, init, timeoutMs);
}

/**
 * Map HTTP status to typed error. 401 means the token is no longer valid
 * (revoked or expired); 403 covers both rate-limit and forbidden (both are
 * transient from caller's POV — backoff or wait for rate-limit window);
 * 5xx is transient by definition.
 */
function mapHttpError(status: number): Error {
  if (status === 401) return new IdPTokenRevoked();
  if (status === 403) return new IdPTransientError(`GitHub 403 (rate limit or forbidden)`);
  if (status >= 500 && status < 600) return new IdPTransientError(`GitHub ${status}`);
  return new Error(`GitHub HTTP ${status}`);
}

/**
 * Parse RFC 5988 Link header for the `rel="next"` URL.
 *
 * Format: `<https://api.github.com/user/orgs?page=2>; rel="next", <...>; rel="last"`
 * Returns the next-page URL or null if there is no next page.
 *
 * SSRF guard: requires the next URL's origin to match `expectedOrigin`. A
 * compromised upstream (or MITM in a GHES deployment) could otherwise point
 * pagination at an attacker-controlled host, leaking the OAuth Bearer token
 * carried by `apiHeaders`.
 */
function parseNextLink(linkHeader: string | null, expectedOrigin: string): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) {
      try {
        const next = new URL(match[1]);
        if (next.origin !== expectedOrigin) return null;
        return match[1];
      } catch {
        return null;
      }
    }
  }
  return null;
}

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
      throw mapHttpError(res.status);
    }

    const tokenJson = await res.json();
    const token = TokenResponseSchema.parse(tokenJson);
    const user = await this.fetchUserInfo(token.access_token);
    return { user, accessToken: token.access_token };
  }

  async listMemberships(accessToken: string): Promise<string[]> {
    const logins: string[] = [];
    const expectedOrigin = new URL(this.apiBaseUrl).origin;
    let url: string | null = `${this.apiBaseUrl}/user/orgs?per_page=100`;
    while (url) {
      const res: Response = await fetchWithRetry(url, {
        method: "GET",
        headers: this.apiHeaders(accessToken),
      });
      if (!res.ok) {
        throw mapHttpError(res.status);
      }
      const json = await res.json();
      const orgs = GitHubOrgsSchema.parse(json);
      for (const o of orgs) {
        logins.push(o.login);
      }
      url = parseNextLink(res.headers.get("link"), expectedOrigin);
    }
    return logins;
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
      throw mapHttpError(res.status);
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
      throw mapHttpError(res.status);
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
    const user = await this.fetchUserInfo(token.access_token);
    return { status: "granted", user, accessToken: token.access_token };
  }

  /**
   * Fetch `/user` + `/user/emails` and assemble IdpUserInfo. Shared between
   * exchangeCode (web flow) and pollDeviceToken (device flow) since both
   * arrive at the same point after obtaining an access token.
   *
   * Email selection: prefer `primary && verified`; otherwise first `verified`.
   * If `/user` returned a public email and no verified email exists in
   * `/user/emails`, fall back to that. Throws if no usable email found.
   */
  private async fetchUserInfo(accessToken: string): Promise<IdpUserInfo> {
    const userRes = await fetchWithRetry(`${this.apiBaseUrl}/user`, {
      method: "GET",
      headers: this.apiHeaders(accessToken),
    });
    if (!userRes.ok) {
      throw mapHttpError(userRes.status);
    }
    const userJson = await userRes.json();
    const user = GitHubUserSchema.parse(userJson);

    const emailsRes = await fetchWithRetry(`${this.apiBaseUrl}/user/emails`, {
      method: "GET",
      headers: this.apiHeaders(accessToken),
    });
    if (!emailsRes.ok) {
      throw mapHttpError(emailsRes.status);
    }
    const emailsJson = await emailsRes.json();
    const emails = GitHubEmailsSchema.parse(emailsJson);

    const primaryVerified = emails.find((e) => e.primary && e.verified);
    const firstVerified = emails.find((e) => e.verified);
    const chosen = primaryVerified?.email ?? firstVerified?.email ?? user.email;
    if (!chosen) {
      throw new Error("GitHub user has no verified email");
    }

    return {
      idp_user_id: String(user.id),
      email: chosen,
      name: user.name ?? undefined,
    };
  }

  private apiHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }
}
