import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { dispatchAuthRoutes } from "../../src/http/auth-routes.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";

/**
 * T14.5 — verify the auth-route dispatcher routes the Phase 2 URLs to
 * the right handler. Stub handlers (T15-T24 still pending) return 501 +
 * appError envelope. T21 ships 3 real handlers (device/device-confirm/
 * success HTML pages); those are verified via separate device-pages
 * tests — here we only assert the dispatcher routes them (handled=true)
 * and (for the URL-only paths) returns an HTML 200.
 *
 * Also verifies the dispatcher returns false for non-auth URLs (caller
 * falls through to handleRest) and emits 405 + Allow header when a
 * known auth path is hit with the wrong method.
 */

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string | string[]>;
  body: unknown;
  rawBody: string | null;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | undefined;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    headers: {},
    body: undefined,
    rawBody: null,
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) this.headers = { ...this.headers, ...headers };
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      this.headers[name] = value;
    },
    getHeader(name: string) {
      return this.headers[name];
    },
    end(payload?: string) {
      this.rawBody = payload ?? null;
      const ct = this.headers["Content-Type"];
      const isJson = typeof ct === "string" && ct.includes("application/json");
      if (payload && isJson) {
        this.body = JSON.parse(payload);
      } else {
        this.body = payload ?? null;
      }
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
    // NOTE: /auth/device, /auth/device/confirm, /auth/success were stubs
    // in T14.5 but are now real T21 handlers — verified in
    // device-pages.test.ts, plus the dispatcher-routing check below.
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

describe("dispatchAuthRoutes — T21 HTML pages dispatched (not 501 stubs)", () => {
  it("GET /auth/device routes to handleDevicePage (200 HTML, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/auth/device"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("GET /auth/device/confirm (no user_code) routes to handleDeviceConfirmPage (400 HTML)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/auth/device/confirm"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });

  it("GET /auth/success routes to handleSuccessPage (200 HTML)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/auth/success"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/html");
  });
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

  it("POST /auth/device returns 405 + Allow: GET (T21 path)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/auth/device"),
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

  it("POST /auth/device/confirm returns 405 + Allow: GET (T21 path)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/auth/device/confirm"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
  });

  it("POST /auth/success returns 405 + Allow: GET (T21 path)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/auth/success"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
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
