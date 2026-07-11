import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  McpCoordinatorClient,
  UnauthorizedError,
  ForbiddenError,
  RateLimitedError,
  UnknownCoordinatorError,
  OAuthError,
  makeCoordinatorError,
  FileTokenStore,
  MemoryTokenStore,
  ProactiveRefresh,
  DiscoveryCache,
} from "../src/index.js";
import type { DiscoveryDoc } from "../src/discovery.js";
import type {
  TokenResponse,
  UserinfoResponse,
  DeviceCodeResponse,
} from "../src/types.js";

/** Build a minimal Response stand-in compatible with the bits the SDK touches. */
function mockResponse(opts: {
  status: number;
  body?: unknown;
  bodyText?: string;
  url?: string;
  headers?: Record<string, string>;
}): Response {
  const headersInit = opts.headers ?? {};
  const headers = new Headers(headersInit);
  const status = opts.status;
  const ok = status >= 200 && status < 300;
  const text =
    opts.bodyText !== undefined
      ? opts.bodyText
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : "";
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    url: opts.url ?? "http://test.local/",
    headers,
    json: async () => {
      if (!text) throw new SyntaxError("Unexpected end of JSON input");
      return JSON.parse(text);
    },
    text: async () => text,
  } as unknown as Response;
}

const BASE_URL = "https://coord.test";

const SAMPLE_USERINFO: UserinfoResponse = {
  user_id: "u_123",
  email: "alice@example.com",
  name: "Alice",
  role: "member",
  org: { id: "org_1", name: "Acme" },
  active_org_id: "org_1",
};

const SAMPLE_DEVICE: DeviceCodeResponse = {
  device_code: "dc_abc",
  user_code: "ABCD-EFGH",
  verification_uri: "https://coord.test/device",
  verification_uri_complete: "https://coord.test/device?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 5,
};

const SAMPLE_TOKEN_RESPONSE: TokenResponse = {
  access_token: "at_new",
  refresh_token: "rt_new",
  token_type: "Bearer",
  expires_in: 3600,
};

describe("McpCoordinatorClient", () => {
  it("whoami: happy path returns UserinfoResponse and sends Bearer header", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/auth/me`);
      expect(init?.method).toBe("GET");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer at_existing");
      return mockResponse({ status: 200, body: SAMPLE_USERINFO });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at_existing",
      refreshToken: "rt_existing",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const me = await client.whoami();
    expect(me).toEqual(SAMPLE_USERINFO);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("whoami without tokens: no Authorization header; 401 maps to UnauthorizedError", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return mockResponse({
        status: 401,
        body: { code: "UNAUTHORIZED", message: "missing bearer token", request_id: "req_1" },
      });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.whoami()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("whoami with expired token triggers maybeRefresh then retries", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      call++;
      if (call === 1) {
        // refresh
        expect(url).toBe(`${BASE_URL}/api/auth/oauth/token`);
        expect(init?.method).toBe("POST");
        expect((init?.body as string).includes("grant_type=refresh_token")).toBe(true);
        return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
      }
      // whoami
      expect(url).toBe(`${BASE_URL}/api/auth/me`);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer at_new");
      return mockResponse({ status: 200, body: SAMPLE_USERINFO });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    // expired (or about to expire) token
    client.setTokens({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) - 5,
    });
    const me = await client.whoami();
    expect(me).toEqual(SAMPLE_USERINFO);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(client.getTokens()?.accessToken).toBe("at_new");
  });

  it("logout: clears local tokens after 204", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 204 }));
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client.logout();
    expect(client.getTokens()).toBeNull();
  });

  it("logoutAll: clears local tokens after 204", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE_URL}/api/auth/logout-all`);
      return mockResponse({ status: 204 });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client.logoutAll();
    expect(client.getTokens()).toBeNull();
  });

  it("revoke: posts form body with token", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/auth/revoke`);
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const body = init?.body as string;
      expect(body).toContain("token=rt_to_revoke");
      return mockResponse({ status: 200 });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    await client.revoke("rt_to_revoke");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refresh: returns new TokenSet and updates internal state", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE }));
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const newSet = await client.refresh();
    expect(newSet.accessToken).toBe("at_new");
    expect(newSet.refreshToken).toBe("rt_new");
    expect(newSet.accessExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    expect(client.getTokens()?.accessToken).toBe("at_new");
  });

  it("refresh: posts grant_type=refresh_token with stored refresh token", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/auth/oauth/token`);
      const body = init?.body as string;
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain("refresh_token=rt_stored");
      return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at",
      refreshToken: "rt_stored",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client.refresh();
  });

  it("deviceCodeStart: returns DeviceCodeResponse", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/api/auth/oauth/device_authorization`);
      expect(init?.method).toBe("POST");
      return mockResponse({ status: 200, body: SAMPLE_DEVICE });
    });
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    const dev = await client.deviceCodeStart();
    expect(dev).toEqual(SAMPLE_DEVICE);
  });

  it("deviceCodePoll: 400 + authorization_pending -> { status: 'pending' }", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ status: 400, body: { error: "authorization_pending" } }),
    );
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.deviceCodePoll("dc_abc");
    expect("status" in result && result.status).toBe("pending");
  });

  it("deviceCodePoll: 200 returns TokenSet and sets internal tokens", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE }));
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.deviceCodePoll("dc_abc");
    expect("accessToken" in result).toBe(true);
    if ("accessToken" in result) {
      expect(result.accessToken).toBe("at_new");
      expect(result.refreshToken).toBe("rt_new");
    }
    expect(client.getTokens()?.accessToken).toBe("at_new");
  });

  it("deviceCodePoll: 400 + access_denied -> { status: 'denied' }", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 400, body: { error: "access_denied" } }));
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.deviceCodePoll("dc_abc");
    expect("status" in result && result.status).toBe("denied");
  });

  it("deviceCodePoll: 400 + slow_down -> { status: 'slow_down' }", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: 400, body: { error: "slow_down" } }));
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.deviceCodePoll("dc_abc");
    expect("status" in result && result.status).toBe("slow_down");
  });

  it("deviceCodePoll: 400 + unknown oauth error -> throws OAuthError", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({ status: 400, body: { error: "invalid_grant", error_description: "no" } }),
    );
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    await expect(client.deviceCodePoll("dc_abc")).rejects.toBeInstanceOf(OAuthError);
  });

  it("error mapping: 403 + FORBIDDEN -> ForbiddenError", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        status: 403,
        body: { code: "FORBIDDEN", message: "not allowed", request_id: "req_42" },
      }),
    );
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await expect(client.whoami()).rejects.toMatchObject({
      name: "ForbiddenError",
      code: "FORBIDDEN",
      httpStatus: 403,
      requestId: "req_42",
    });
    await expect(client.whoami()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("error mapping: 429 + RATE_LIMITED + Retry-After populates retryAfterSeconds", async () => {
    const fetchMock = vi.fn(async () =>
      mockResponse({
        status: 429,
        headers: { "Retry-After": "17" },
        body: { code: "RATE_LIMITED", message: "slow down", request_id: "req_rl" },
      }),
    );
    const client = new McpCoordinatorClient({ baseUrl: BASE_URL, fetch: fetchMock as unknown as typeof fetch });
    client.setTokens({
      accessToken: "at",
      refreshToken: "rt",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    let caught: unknown;
    try {
      await client.whoami();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSeconds).toBe(17);
    expect((caught as RateLimitedError).requestId).toBe("req_rl");
  });

  it("makeCoordinatorError: unknown code -> UnknownCoordinatorError with raw code preserved", () => {
    const err = makeCoordinatorError(
      { code: "WEIRD_NEW_CODE", message: "what", request_id: "rq", details: { foo: 1 } },
      418,
      null,
    );
    expect(err).toBeInstanceOf(UnknownCoordinatorError);
    expect(err.code).toBe("WEIRD_NEW_CODE");
    expect(err.httpStatus).toBe(418);
    expect(err.requestId).toBe("rq");
    expect(err.details).toEqual({ foo: 1 });
  });
});

describe("McpCoordinatorClient + storage / refresh integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-client-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  it("with FileTokenStore: setTokens persists; new client instance loads them", async () => {
    const filePath = path.join(tmpDir, "tokens.json");
    const store = new FileTokenStore({ filePath });
    const fetchMock = vi.fn(async () => mockResponse({ status: 204 }));

    const client1 = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      store,
    });
    client1.setTokens({
      accessToken: "at_a",
      refreshToken: "rt_a",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client1.persistTokens();
    client1.dispose();

    // New client + new store instance pointing at the same file.
    const store2 = new FileTokenStore({ filePath });
    const client2 = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      store: store2,
    });
    const loaded = await client2.loadFromStore();
    expect(loaded?.accessToken).toBe("at_a");
    expect(loaded?.refreshToken).toBe("rt_a");
    expect(client2.getTokens()?.accessToken).toBe("at_a");
    client2.dispose();
  });

  it("with ProactiveRefresh: setTokens schedules a timer that fires refresh", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () =>
        mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE }),
      );
      // Token expires in 200s, lead 120s, zero jitter -> fire in ~80s.
      const strategy = new ProactiveRefresh(120, 0, () => 0.5);
      const client = new McpCoordinatorClient({
        baseUrl: BASE_URL,
        fetch: fetchMock as unknown as typeof fetch,
        refreshStrategy: strategy,
      });
      client.setTokens({
        accessToken: "at_old",
        refreshToken: "rt_old",
        accessExpiresAt: Math.floor(Date.now() / 1000) + 200,
      });
      // Before the timer fires, no fetch yet.
      expect(fetchMock).not.toHaveBeenCalled();

      // Advance fake time past the scheduled delay (~80s).
      await vi.advanceTimersByTimeAsync(85_000);
      // The setTimeout callback fires synchronously inside advanceTimersByTimeAsync;
      // its inner await chain has had a chance to run.
      expect(fetchMock).toHaveBeenCalled();
      // Refresh call should have been to the token endpoint.
      const firstCall = fetchMock.mock.calls[0]!;
      expect(firstCall[0]).toBe(`${BASE_URL}/api/auth/oauth/token`);

      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("with refreshLockPath: second concurrent refresh adopts the first's update via store", async () => {
    const filePath = path.join(tmpDir, "tokens.json");
    const lockPath = path.join(tmpDir, "tokens.json.lock");

    // Shared memory store so both clients see updates.
    const sharedStore = new MemoryTokenStore();
    await sharedStore.save({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) - 10, // expired
    });

    // Use a FileTokenStore for the locking-coordination test so the lock path
    // actually corresponds to a real file scenario.
    const fileStore1 = new FileTokenStore({ filePath });
    const fileStore2 = new FileTokenStore({ filePath });
    await fileStore1.save({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) - 10,
    });

    // First client's fetch performs a real refresh (returns SAMPLE_TOKEN_RESPONSE,
    // access_token=at_new). We add a small artificial delay so the second
    // client is forced to wait on the lock.
    const fetch1 = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
    });
    // Second client's fetch should NEVER be invoked -- after acquiring the
    // lock it must re-read the store, find at_new (fresh), and return early.
    const fetch2 = vi.fn(async () =>
      mockResponse({ status: 200, body: { ...SAMPLE_TOKEN_RESPONSE, access_token: "at_BAD" } }),
    );

    const client1 = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetch1 as unknown as typeof fetch,
      store: fileStore1,
      refreshLockPath: lockPath,
    });
    const client2 = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetch2 as unknown as typeof fetch,
      store: fileStore2,
      refreshLockPath: lockPath,
    });

    await client1.loadFromStore();
    await client2.loadFromStore();

    // Kick client1 off first and give it a short head start. The lock is
    // acquired via an atomic `wx` file create resolved on libuv's threadpool;
    // firing both refresh() calls via Promise.all() races two async fs.open
    // calls with no guaranteed FIFO ordering, so client2 could occasionally
    // win the lock instead (observed flakily -- see PR discussion). A small
    // head start makes client1's lock acquisition deterministic while still
    // leaving client2 to hit the held lock and wait, which is what this test
    // exercises.
    const p1 = client1.refresh();
    await new Promise((r) => setTimeout(r, 20));
    const p2 = client2.refresh();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.accessToken).toBe("at_new");
    expect(r2.accessToken).toBe("at_new"); // adopted from store, not refetched
    expect(fetch1).toHaveBeenCalledTimes(1);
    expect(fetch2).not.toHaveBeenCalled();

    client1.dispose();
    client2.dispose();
  });
});

describe("McpCoordinatorClient + discovery integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `mcp-client-discovery-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  });

  function makeDiscoveryDoc(overrides: Partial<DiscoveryDoc> = {}): DiscoveryDoc {
    return {
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/auth/login`,
      token_endpoint: `${BASE_URL}/oauth2/token`, // intentionally non-default
      device_authorization_endpoint: `${BASE_URL}/oauth2/device`,
      revocation_endpoint: `${BASE_URL}/oauth2/revoke`,
      userinfo_endpoint: `${BASE_URL}/oauth2/userinfo`,
      grant_types_supported: ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      ...overrides,
    };
  }

  it("with DiscoveryCache: refresh uses token_endpoint from the discovery doc", async () => {
    const cachePath = path.join(tmpDir, "discovery-cache.json");
    const doc = makeDiscoveryDoc();
    let fetchedDiscovery = false;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        fetchedDiscovery = true;
        return mockResponse({ status: 200, body: doc });
      }
      // Refresh must hit the discovery-supplied token endpoint, not hardcoded.
      expect(url).toBe(`${BASE_URL}/oauth2/token`);
      return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
    });
    const discovery = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const client = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      discovery,
    });
    client.setTokens({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const newSet = await client.refresh();
    expect(fetchedDiscovery).toBe(true);
    expect(newSet.accessToken).toBe("at_new");
  });

  it("without DiscoveryCache: refresh keeps hardcoded /api/auth/oauth/token (existing behavior)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${BASE_URL}/api/auth/oauth/token`);
      return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
    });
    const client = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
    });
    client.setTokens({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await client.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("DiscoveryCache fetch error during refresh() bubbles up (no prior cache)", async () => {
    const cachePath = path.join(tmpDir, "discovery-cache.json");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        throw new Error("discovery boom");
      }
      return mockResponse({ status: 200, body: SAMPLE_TOKEN_RESPONSE });
    });
    const discovery = new DiscoveryCache({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      cachePath,
    });
    const client = new McpCoordinatorClient({
      baseUrl: BASE_URL,
      fetch: fetchMock as unknown as typeof fetch,
      discovery,
    });
    client.setTokens({
      accessToken: "at_old",
      refreshToken: "rt_old",
      accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await expect(client.refresh()).rejects.toThrow("discovery boom");
  });
});
