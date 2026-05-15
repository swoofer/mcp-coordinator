import { makeCoordinatorError, OAuthError } from "./errors.js";
import type {
  TokenResponse,
  TokenSet,
  OAuthErrorEnvelope,
  AppErrorEnvelope,
  DeviceCodeResponse,
  UserinfoResponse,
} from "./types.js";
import type { TokenStore } from "./storage.js";
import type { RefreshStrategy } from "./refresh-strategy.js";
import type { DiscoveryCache } from "./discovery.js";

export interface McpCoordinatorClientOptions {
  baseUrl: string;
  /** Optional fetch override for testing. */
  fetch?: typeof fetch;
  /** Optional persistent token store. If provided, the client loads tokens
   *  on first call (via loadFromStore) and saves after refresh / setTokens.
   *  Default: in-memory only. */
  store?: TokenStore;
  /** Optional proactive refresh strategy. When set, the client schedules
   *  a timer to refresh tokens BEFORE expiry. Default: lazy refresh in
   *  maybeRefresh on the next API call. */
  refreshStrategy?: RefreshStrategy;
  /** Lock file path for multi-process refresh coordination. When set,
   *  refresh() acquires this lock before issuing the network call so
   *  concurrent CLI instances don't all refresh at once. */
  refreshLockPath?: string;
  /** Optional discovery-doc cache. When provided, the client resolves
   *  token / device-authorization / revocation / userinfo endpoints from
   *  the cached `${baseUrl}/.well-known/oauth-authorization-server`
   *  document rather than hardcoding paths. Default: hardcoded paths. */
  discovery?: DiscoveryCache;
}

export class McpCoordinatorClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof globalThis.fetch;
  private tokens: TokenSet | null = null;
  private readonly store: TokenStore | null;
  private readonly refreshStrategy: RefreshStrategy | null;
  private readonly refreshLockPath: string | null;
  private readonly discovery: DiscoveryCache | null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: McpCoordinatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.store = opts.store ?? null;
    this.refreshStrategy = opts.refreshStrategy ?? null;
    this.refreshLockPath = opts.refreshLockPath ?? null;
    this.discovery = opts.discovery ?? null;
  }

  // ---- endpoint resolution (discovery-doc-aware) ----

  private async tokenEndpoint(): Promise<string> {
    if (!this.discovery) return `${this.baseUrl}/api/auth/oauth/token`;
    const doc = await this.discovery.load();
    return doc.token_endpoint;
  }

  private async deviceAuthorizationEndpoint(): Promise<string> {
    if (!this.discovery) return `${this.baseUrl}/api/auth/oauth/device_authorization`;
    const doc = await this.discovery.load();
    return doc.device_authorization_endpoint;
  }

  private async revocationEndpoint(): Promise<string> {
    if (!this.discovery) return `${this.baseUrl}/api/auth/revoke`;
    const doc = await this.discovery.load();
    return doc.revocation_endpoint;
  }

  private async userinfoEndpoint(): Promise<string> {
    if (!this.discovery) return `${this.baseUrl}/api/auth/me`;
    const doc = await this.discovery.load();
    // userinfo_endpoint is optional in the OpenAPI; fall back to hardcoded.
    return doc.userinfo_endpoint ?? `${this.baseUrl}/api/auth/me`;
  }

  setTokens(tokens: TokenSet): void {
    this.tokens = tokens;
    void this.store?.save(tokens); // fire-and-forget; call persistTokens() to await
    this.scheduleProactiveRefresh();
  }

  getTokens(): TokenSet | null {
    return this.tokens;
  }

  clearTokens(): void {
    this.tokens = null;
    this.cancelProactiveRefresh();
    void this.store?.clear();
  }

  /** Load tokens from store (if configured) on first use. Idempotent. */
  async loadFromStore(): Promise<TokenSet | null> {
    if (!this.store) return this.tokens;
    if (!this.tokens) {
      this.tokens = await this.store.load();
      if (this.tokens) this.scheduleProactiveRefresh();
    }
    return this.tokens;
  }

  /** Explicit await-able persist hook for callers that need durability after setTokens. */
  async persistTokens(): Promise<void> {
    if (this.store && this.tokens) {
      await this.store.save(this.tokens);
    }
  }

  /** Cancel timers + close resources. Call on app shutdown. */
  dispose(): void {
    this.cancelProactiveRefresh();
  }

  /** GET /api/auth/me (or discovery-resolved userinfo_endpoint) */
  async whoami(): Promise<UserinfoResponse> {
    await this.maybeRefresh();
    const url = await this.userinfoEndpoint();
    const res = await this.fetch(url, {
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
    this.clearTokens();
  }

  /** POST /api/auth/logout-all -- bumps user.token_epoch; clears local tokens. */
  async logoutAll(): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/api/auth/logout-all`, {
      method: "POST",
      headers: this.authHeader(),
    });
    this.handleEmptyResponse(res);
    this.clearTokens();
  }

  /** POST /api/auth/revoke (or discovery-resolved revocation_endpoint) -- RFC 7009 (always 200). */
  async revoke(token: string): Promise<void> {
    const url = await this.revocationEndpoint();
    const res = await this.fetch(url, {
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
    if (this.refreshLockPath) {
      const lockPath = this.refreshLockPath;
      const { withLock } = await import("./single-flight.js");
      return withLock({ lockPath }, async () => {
        // After acquiring the lock, re-read the store -- another process may
        // have already refreshed.
        if (this.store) {
          const stored = await this.store.load();
          if (stored && stored.accessExpiresAt > Math.floor(Date.now() / 1000) + 60) {
            // Another process refreshed; adopt those tokens.
            this.tokens = stored;
            this.scheduleProactiveRefresh();
            return stored;
          }
        }
        return this.doRefresh();
      });
    }
    return this.doRefresh();
  }

  private async doRefresh(): Promise<TokenSet> {
    if (!this.tokens) throw new Error("No refresh token; call setTokens() first");
    const url = await this.tokenEndpoint();
    const res = await this.fetch(url, {
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
    if (this.store) await this.store.save(newSet);
    this.scheduleProactiveRefresh();
    return newSet;
  }

  /** POST /api/auth/oauth/device_authorization (RFC 8628 init; or discovery-resolved device_authorization_endpoint) */
  async deviceCodeStart(): Promise<DeviceCodeResponse> {
    const url = await this.deviceAuthorizationEndpoint();
    const res = await this.fetch(url, {
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
    const url = await this.tokenEndpoint();
    const res = await this.fetch(url, {
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
      if (this.store) await this.store.save(newSet);
      this.scheduleProactiveRefresh();
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

  private scheduleProactiveRefresh(): void {
    this.cancelProactiveRefresh();
    if (!this.refreshStrategy || !this.tokens) return;
    const delayMs = this.refreshStrategy.nextRefreshDelayMs(this.tokens);
    if (delayMs === null) return; // already past trigger; lazy refresh will handle
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch(() => {
        /* errors will surface on next request */
      });
    }, delayMs);
    const timer = this.refreshTimer as { unref?: () => void };
    if (typeof timer.unref === "function") timer.unref();
  }

  private cancelProactiveRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
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
