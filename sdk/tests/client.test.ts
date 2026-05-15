import { describe, expect, it, vi } from "vitest";
import {
  McpCoordinatorClient,
  UnauthorizedError,
  ForbiddenError,
  RateLimitedError,
  UnknownCoordinatorError,
  OAuthError,
  makeCoordinatorError,
} from "../src/index.js";
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
