import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { dispatchAuthRoutes } from "../../src/http/auth-routes.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";

/**
 * T14.5 — verify the auth-route dispatcher routes the 9 Phase 2 URLs to
 * the right stub handler (all of which return 501 + appError envelope),
 * returns false for non-auth URLs (caller falls through to handleRest),
 * and emits 405 + Allow header when a known auth path is hit with the
 * wrong method.
 */

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    headers: {},
    body: undefined,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) this.headers = { ...headers };
      return this;
    },
    end(payload?: string) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
  return res;
}

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

let db: Database.Database;
let ctx: AuthHandlerContext;

beforeEach(() => {
  db = new Database(":memory:");
  ctx = { db, clock: new FakeClock() };
});

afterEach(() => {
  db.close();
});

describe("dispatchAuthRoutes — non-auth URLs fall through", () => {
  it("returns false for /api/register (Phase 1 route)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/register"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("returns false for /dashboard/", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/dashboard/"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("returns false for empty path", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      { method: "GET" } as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("returns false for /.well-known/oauth-authorization-server (wired separately)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/.well-known/oauth-authorization-server"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });
});

describe("dispatchAuthRoutes — happy-path stubs return 501", () => {
  const cases: Array<{ method: string; url: string; stub: string }> = [
    { method: "GET", url: "/auth/login", stub: "handleAuthLogin" },
    { method: "GET", url: "/api/auth/oauth/callback", stub: "handleOAuthCallback" },
    { method: "POST", url: "/api/auth/oauth/token", stub: "handleOAuthToken" },
    {
      method: "POST",
      url: "/api/auth/oauth/device_authorization",
      stub: "handleDeviceAuthorization",
    },
    { method: "POST", url: "/auth/device/approve", stub: "handleDeviceApprove" },
    { method: "POST", url: "/api/auth/logout", stub: "handleLogout" },
    { method: "POST", url: "/api/auth/logout-all", stub: "handleLogoutAll" },
    { method: "POST", url: "/api/auth/revoke", stub: "handleRevoke" },
    { method: "GET", url: "/api/auth/me", stub: "handleUserinfo" },
  ];

  for (const { method, url, stub } of cases) {
    it(`returns true + 501 for ${method} ${url} (${stub})`, async () => {
      const res = mockResponse();
      const handled = await dispatchAuthRoutes(
        mockReq(method, url),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(501);
      const body = res.body as Record<string, unknown>;
      expect(body.code).toBe("NOT_IMPLEMENTED");
      expect(typeof body.message).toBe("string");
      expect((body.message as string)).toContain(stub);
      // Tests run outside withRequestId — request_id must be null.
      expect(body.request_id).toBeNull();
    });
  }
});

describe("dispatchAuthRoutes — 405 method-not-allowed on known paths", () => {
  it("POST /auth/login returns 405 + Allow: GET", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/auth/login"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
    // Tests run outside withRequestId — request_id must be null.
    expect(body.request_id).toBeNull();
  });

  it("GET /api/auth/oauth/token returns 405 + Allow: POST", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/api/auth/oauth/token"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
    expect(body.request_id).toBeNull();
  });

  it("PUT /api/auth/me returns 405 + Allow: GET (covers /api/auth/me Allow branch)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("PUT", "/api/auth/me"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
    expect(body.request_id).toBeNull();
  });

  it("GET /api/auth/oauth/callback wrong-method (DELETE) returns 405 + Allow: GET", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("DELETE", "/api/auth/oauth/callback"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
    expect(body.request_id).toBeNull();
  });
});

describe("dispatchAuthRoutes — query strings + method defaults", () => {
  it("strips query string: GET /auth/login?foo=bar routes to handleAuthLogin", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/auth/login?foo=bar&baz=qux"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(501);
    const body = res.body as Record<string, unknown>;
    expect((body.message as string)).toContain("handleAuthLogin");
  });

  it("missing req.method defaults to GET (covers method ?? branch)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      { url: "/auth/login" } as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(501);
  });
});
