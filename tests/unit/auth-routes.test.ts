import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { dispatchAuthRoutes } from "../../src/http/auth-routes.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

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

const stubProvider: IdPProvider = {
  name: "github",
  buildAuthUrl: (state, redirectUri, codeChallenge) => {
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", "TEST");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  },
  exchangeCode: async () => {
    throw new Error("not used");
  },
};

beforeEach(() => {
  db = new Database(":memory:");
  // Minimal oauth_state schema so the real /auth/login handler (T15)
  // can INSERT during the dispatcher routing test.
  db.exec(`
    CREATE TABLE oauth_state (
      state           TEXT PRIMARY KEY,
      code_verifier   TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      provider        TEXT NOT NULL,
      org_id          TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      consumed_at     INTEGER,
      nonce           TEXT
    );
  `);
  const clock = new FakeClock();
  ctx = {
    db,
    clock,
    providers: singleProviderRegistry(stubProvider),
    rateLimiter: new RateLimiter(clock),
    publicUrl: "http://localhost:3000",
    stateBindingKey: Buffer.alloc(32, 0x01),
    signingKeys: buildJwtKeyRegistry(Buffer.alloc(32, 0x01)),
    membershipCache: new MembershipCache(clock),
  };
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

// All T14.5 stub routes have shipped real Phase 2 handlers (T15/T16a/T17/T18/
// T19/T20/T21/T23/T24). Each per-handler routing assertion now lives in its
// own `describe` block below, replacing the legacy 501-stub loop:
//   - GET  /auth/login                              → T15 (302)
//   - GET  /auth/device, /auth/device/confirm,
//          /auth/success                            → T21 (200 HTML)
//   - GET  /api/auth/oauth/callback                 → T16a (400 INVALID_REQUEST)
//   - POST /api/auth/oauth/token                    → T18 (400 invalid_request)
//   - POST /api/auth/oauth/device_authorization     → T17 (200 with body)
//   - POST /auth/device/approve                     → T20 (401 UNAUTHORIZED)
//   - POST /api/auth/logout                         → T23 (401 UNAUTHORIZED)
//   - POST /api/auth/logout-all                     → T23 (401 UNAUTHORIZED)
//   - POST /api/auth/revoke                         → T23 (401 UNAUTHORIZED)
//   - GET  /api/auth/me                             → T24 (401 UNAUTHORIZED)
// See device-approve.test.ts for the full T20 contract.

describe("dispatchAuthRoutes — T23 logout/logout-all/revoke dispatched (not 501 stubs)", () => {
  // mockReq enriched with headers — T23 handlers call authenticateRequest,
  // which reads req.headers.authorization. Plain {method,url} would crash.
  function mockReqWithHeaders(method: string, url: string): IncomingMessage {
    return { method, url, headers: {} } as unknown as IncomingMessage;
  }

  it("POST /api/auth/logout routes to handleLogout (401, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/api/auth/logout"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /api/auth/logout-all routes to handleLogoutAll (401, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/api/auth/logout-all"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /api/auth/revoke routes to handleRevoke (401, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/api/auth/revoke"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("GET /api/auth/me routes to handleUserinfo (401, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("GET", "/api/auth/me"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /auth/device/approve routes to handleDeviceApprove (401, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/auth/device/approve"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /api/admin/service-tokens routes to handleIssueServiceToken (401 unauth)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/api/admin/service-tokens"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("GET /api/admin/service-tokens routes to handleListServiceTokens (401 unauth)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("GET", "/api/admin/service-tokens"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /api/admin/service-tokens/<jti>/revoke routes to handleRevokeServiceToken (401 unauth)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("POST", "/api/admin/service-tokens/jti-abc-123/revoke"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("GET /api/admin/service-tokens/<jti>/revoke (wrong method) falls through (handled=false)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("GET", "/api/admin/service-tokens/jti-abc/revoke"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("DELETE /api/admin/service-tokens returns 405 + Allow: GET, POST", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReqWithHeaders("DELETE", "/api/admin/service-tokens"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
    expect((res.body as Record<string, unknown>).code).toBe("METHOD_NOT_ALLOWED");
  });
});

describe("dispatchAuthRoutes — T15 /auth/login dispatched (not 501 stub)", () => {
  it("GET /auth/login routes to handleAuthLogin (302 redirect, not 501)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/auth/login"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(302);
    expect(typeof res.headers.Location).toBe("string");
  });
});

describe("dispatchAuthRoutes — T16a /api/auth/oauth/callback dispatched (not 501 stub)", () => {
  it("GET /api/auth/oauth/callback routes to handleOAuthCallback (400 INVALID_REQUEST, not 501)", async () => {
    // mockReq has no query params → the real T16a handler returns
    // 400 INVALID_REQUEST (missing state/code). Proves the route is wired.
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/api/auth/oauth/callback"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
  });
});

describe("dispatchAuthRoutes — T18 /api/auth/oauth/token dispatched (not 501 stub)", () => {
  it("POST /api/auth/oauth/token routes to handleOAuthToken (not 501)", async () => {
    // mockReq is a plain object — parseFormBody's req.on() throws and the
    // dispatcher's .catch falls back to an empty body, which trips the
    // missing-grant_type branch → 400 invalid_request. Proves the route
    // reached the real T18 handler (not the 501 stub).
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/auth/oauth/token"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });

  // #318: the endpoint had no rate limit on any of its three grants. It is
  // unauthenticated by design -- it is what mints the bearer -- so an
  // anonymous caller could drive it as fast as the box allowed. The device
  // poll's own slow_down is keyed on the device_code and does nothing against
  // a caller rotating them.
  it("POST /api/auth/oauth/token answers 429 once the per-IP budget is spent", async () => {
    // Spend the bucket the dispatcher will consult, without going through the
    // handler: what is under test is that the guard answers first. mockReq has
    // no socket, so the key is the `unknown` IP for every call.
    for (let i = 0; i < 60; i++) {
      await ctx.rateLimiter.check("oauth-token:unknown", { per: 60, window_seconds: 60 });
    }

    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/auth/oauth/token"),
      res as unknown as ServerResponse,
      ctx,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
    expect((res.body as Record<string, unknown>).code).toBe("RATE_LIMITED");
  });

  // The negative control for the case above: one request short of the budget
  // still reaches the handler, which answers 400 for the unparseable body.
  // Without it, a guard that rejected everything would look just as green.
  it("a request inside the budget still reaches the handler", async () => {
    for (let i = 0; i < 59; i++) {
      await ctx.rateLimiter.check("oauth-token:unknown", { per: 60, window_seconds: 60 });
    }

    const res = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/auth/oauth/token"),
      res as unknown as ServerResponse,
      ctx,
    );

    expect(res.statusCode).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBe("invalid_request");
  });
});

describe("dispatchAuthRoutes — T17 /api/auth/oauth/device_authorization dispatched (not 501 stub)", () => {
  it("POST /api/auth/oauth/device_authorization routes to handleDeviceAuthorization (not 501)", async () => {
    // The test's mockReq is a plain {method,url} object — it has no
    // req.on('data') stream surface, so the real handler's parseFormBody
    // rejects and the handler returns 400 INVALID_REQUEST. That's still
    // sufficient proof that dispatchAuthRoutes routes the URL to the new
    // T17 handler (not the 501 stub).
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/auth/oauth/device_authorization"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.code).toBe("INVALID_REQUEST");
  });
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
    // T15 handler now returns 302 (was 501 stub in T14.5).
    expect(res.statusCode).toBe(302);
    expect(typeof res.headers.Location).toBe("string");
  });

  it("missing req.method defaults to GET (covers method ?? branch)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      { url: "/auth/login" } as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    // T15 handler now returns 302 (was 501 stub in T14.5).
    expect(res.statusCode).toBe(302);
  });
});
