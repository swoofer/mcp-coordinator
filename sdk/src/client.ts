import { makeCoordinatorError, OAuthError } from "./errors.js";
import type {
  TokenResponse,
  TokenSet,
  OAuthErrorEnvelope,
  AppErrorEnvelope,
  DeviceCodeResponse,
  UserinfoResponse,
} from "./types.js";

export interface McpCoordinatorClientOptions {
  baseUrl: string;
  /** Optional fetch override for testing. */
  fetch?: typeof fetch;
}

export class McpCoordinatorClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private tokens: TokenSet | null = null;

  constructor(opts: McpCoordinatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setTokens(tokens: TokenSet): void {
    this.tokens = tokens;
  }

  getTokens(): TokenSet | null {
    return this.tokens;
  }

  clearTokens(): void {
    this.tokens = null;
  }

  /** GET /api/auth/me */
  async whoami(): Promise<UserinfoResponse> {
    await this.maybeRefresh();
    const res = await this.fetch(`${this.baseUrl}/api/auth/me`, {
      method: "GET",
      headers: this.authHeader(),
    });
    return this.handleJson<UserinfoResponse>(res);
  }

  /** POST /api/auth/logout -- revokes current refresh; clears local tokens. */
  async logout(): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: this.authHeader(),
    });
    this.handleEmptyResponse(res);
    this.tokens = null;
  }

  /** POST /api/auth/logout-all -- bumps user.token_epoch; clears local tokens. */
  async logoutAll(): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/logout-all`, {
      method: "POST",
      headers: this.authHeader(),
    });
    this.handleEmptyResponse(res);
    this.tokens = null;
  }

  /** POST /api/auth/revoke -- RFC 7009 (always 200). */
  async revoke(token: string): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/revoke`, {
      method: "POST",
      headers: {
        ...this.authHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token }).toString(),
    });
    this.handleEmptyResponse(res);
  }

  /** POST /api/auth/oauth/token grant=refresh_token */
  async refresh(): Promise<TokenSet> {
    if (!this.tokens) throw new Error("No refresh token; call setTokens() first");
    const res = await this.fetch(`${this.baseUrl}/api/auth/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refreshToken,
      }).toString(),
    });
    const tokenResponse = await this.handleJson<TokenResponse>(res, /* expectOAuthError */ true);
    const newSet: TokenSet = {
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      accessExpiresAt: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
    };
    this.tokens = newSet;
    return newSet;
  }

  /** POST /api/auth/oauth/device_authorization (RFC 8628 init) */
  async deviceCodeStart(): Promise<DeviceCodeResponse> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/oauth/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    return this.handleJson<DeviceCodeResponse>(res);
  }

  /** POST /api/auth/oauth/token grant=device_code (one poll). Caller loops with interval. */
  async deviceCodePoll(
    deviceCode: string,
  ): Promise<TokenSet | { status: "pending" | "slow_down" | "expired" | "denied" }> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      }).toString(),
    });
    if (res.status === 200) {
      const tokenResponse = (await res.json()) as TokenResponse;
      const newSet: TokenSet = {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        accessExpiresAt: Math.floor(Date.now() / 1000) + tokenResponse.expires_in,
      };
      this.tokens = newSet;
      return newSet;
    }
    if (res.status === 400) {
      const env = (await res.json()) as OAuthErrorEnvelope;
      const map: Record<string, "pending" | "slow_down" | "expired" | "denied"> = {
        authorization_pending: "pending",
        slow_down: "slow_down",
        expired_token: "expired",
        access_denied: "denied",
      };
      if (env.error in map) return { status: map[env.error]! };
      throw new OAuthError(env, res.status);
    }
    throw await this.makeErrorFromResponse(res);
  }

  // ---- internals ----

  private authHeader(): Record<string, string> {
    if (!this.tokens) return {};
    return { Authorization: `Bearer ${this.tokens.accessToken}` };
  }

  private async maybeRefresh(): Promise<void> {
    if (!this.tokens) return;
    const skewS = 60;
    if (this.tokens.accessExpiresAt - Math.floor(Date.now() / 1000) < skewS) {
      try {
        await this.refresh();
      } catch {
        /* fall through; the upcoming request will surface the 401 */
      }
    }
  }

  private async handleJson<T>(res: Response, expectOAuthError = false): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    if (expectOAuthError && res.status === 400) {
      const env = (await res.json()) as OAuthErrorEnvelope;
      throw new OAuthError(env, res.status);
    }
    throw await this.makeErrorFromResponse(res);
  }

  private handleEmptyResponse(res: Response): void {
    if (!res.ok && res.status !== 204) {
      throw new Error(`Unexpected status ${res.status} from ${res.url}`);
    }
  }

  private async makeErrorFromResponse(res: Response): Promise<Error> {
    let envelope: AppErrorEnvelope | null = null;
    try {
      envelope = (await res.json()) as AppErrorEnvelope;
    } catch {
      /* not JSON */
    }
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    if (envelope?.code) return makeCoordinatorError(envelope, res.status, retryAfter);
    return new Error(`HTTP ${res.status} ${res.statusText}`);
  }
}
