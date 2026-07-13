// T07 (v0.10.6) — dispatch tests for the 5 new admin endpoints wired into
// src/http/auth-routes.ts:
//
//   GET   /api/admin/orgs            → handleListOrgs
//   POST  /api/admin/orgs            → handleCreateOrg     (per-IP RL)
//   PATCH /api/admin/orgs/:id        → handleUpdateOrg     (per-IP RL)
//   GET   /api/admin/users           → handleListUsers
//   PATCH /api/admin/users/:id       → handleUpdateUser    (per-IP RL)
//
// Per the task spec: focused dispatch tests only — the handler modules are
// mocked via vi.mock so we exercise routing, parameter extraction, method
// gating, the per-IP rate limit, and the 405 / fall-through branches WITHOUT
// pulling in auth/CSRF/DB plumbing. End-to-end behavior of each handler is
// already covered by handle-admin-orgs.test.ts and handle-admin-users.test.ts.
//
// vi.mock is hoisted by vitest so the mocked modules are in place before
// auth-routes.ts pulls them in via its static imports.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

// Mock the admin handler modules. Each mock writes a 200 envelope tagged
// with the handler name so we can assert dispatch went to the right handler
// without re-implementing handler internals.
vi.mock("../../src/admin/handle-admin-orgs.js", () => ({
  handleListOrgs: vi.fn(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ handler: "handleListOrgs" }));
  }),
  handleCreateOrg: vi.fn(async (_req, res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ handler: "handleCreateOrg" }));
  }),
  handleUpdateOrg: vi.fn(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ handler: "handleUpdateOrg" }));
  }),
}));

vi.mock("../../src/admin/handle-admin-users.js", () => ({
  handleListUsers: vi.fn(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ handler: "handleListUsers" }));
  }),
  handleUpdateUser: vi.fn(async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ handler: "handleUpdateUser" }));
  }),
}));

// Import AFTER vi.mock so dispatchAuthRoutes pulls in the mocked modules.
// Also re-import the handler mocks so we can assert call counts/arguments.
import { dispatchAuthRoutes } from "../../src/http/auth-routes.js";
import {
  handleListOrgs,
  handleCreateOrg,
  handleUpdateOrg,
} from "../../src/admin/handle-admin-orgs.js";
import { handleListUsers, handleUpdateUser } from "../../src/admin/handle-admin-users.js";

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
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) this.headers = { ...this.headers, ...headers };
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    end(payload) {
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

interface MockReqOpts {
  ip?: string;
}

function mockReq(method: string, url: string, opts: MockReqOpts = {}): IncomingMessage {
  return {
    method,
    url,
    headers: {},
    socket: { remoteAddress: opts.ip ?? "10.0.0.1" },
  } as unknown as IncomingMessage;
}

let db: Database.Database;
let ctx: AuthHandlerContext;

const stubProvider: IdPProvider = {
  name: "github",
  buildAuthUrl: () => "https://github.com/login/oauth/authorize",
  exchangeCode: async () => {
    throw new Error("not used");
  },
};

beforeEach(() => {
  db = new Database(":memory:");
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
  // Reset all handler-mock spies between tests.
  vi.mocked(handleListOrgs).mockClear();
  vi.mocked(handleCreateOrg).mockClear();
  vi.mocked(handleUpdateOrg).mockClear();
  vi.mocked(handleListUsers).mockClear();
  vi.mocked(handleUpdateUser).mockClear();
});

describe("dispatchAuthRoutes — admin orgs routes (T05)", () => {
  it("GET /api/admin/orgs routes to handleListOrgs with (req, res, ctx)", async () => {
    const res = mockResponse();
    const req = mockReq("GET", "/api/admin/orgs");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleListOrgs).toHaveBeenCalledTimes(1);
    expect(handleListOrgs).toHaveBeenCalledWith(req, res, ctx);
    expect(res.statusCode).toBe(200);
    expect((res.body as { handler: string }).handler).toBe("handleListOrgs");
  });

  it("POST /api/admin/orgs routes to handleCreateOrg", async () => {
    const res = mockResponse();
    const req = mockReq("POST", "/api/admin/orgs");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleCreateOrg).toHaveBeenCalledTimes(1);
    expect(handleCreateOrg).toHaveBeenCalledWith(req, res, ctx);
    expect(res.statusCode).toBe(201);
  });

  it("PATCH /api/admin/orgs/:id routes to handleUpdateOrg (id parsed by handler)", async () => {
    const res = mockResponse();
    const req = mockReq("PATCH", "/api/admin/orgs/abc-123");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleUpdateOrg).toHaveBeenCalledTimes(1);
    expect(handleUpdateOrg).toHaveBeenCalledWith(req, res, ctx);
    expect(res.statusCode).toBe(200);
  });

  it("404-style fall-through for /api/admin/orgs/x/extra (regex doesn't match deep paths)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("PATCH", "/api/admin/orgs/abc/extra"),
      res as unknown as ServerResponse,
      ctx,
    );
    // Deep path is NOT in KNOWN_AUTH_PATHS and the regex requires a single
    // segment, so we fall through (handleRest will 404). No handler invoked.
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
    expect(handleUpdateOrg).not.toHaveBeenCalled();
  });

  it("DELETE /api/admin/orgs returns 405 + Allow: GET, POST", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("DELETE", "/api/admin/orgs"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
    expect((res.body as Record<string, unknown>).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("GET /api/admin/orgs/:id falls through (parameterized non-PATCH not gated)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/api/admin/orgs/abc-123"),
      res as unknown as ServerResponse,
      ctx,
    );
    // GET on parameterized path is not registered; matches the existing
    // service-tokens convention (revoke path is POST-only; non-POST falls
    // through to handleRest's 404).
    expect(handled).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("URL with query string still dispatches: PATCH /api/admin/orgs/abc?x=1", async () => {
    const res = mockResponse();
    const req = mockReq("PATCH", "/api/admin/orgs/abc?x=1");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleUpdateOrg).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchAuthRoutes — admin users routes (T06)", () => {
  it("GET /api/admin/users routes to handleListUsers", async () => {
    const res = mockResponse();
    const req = mockReq("GET", "/api/admin/users");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleListUsers).toHaveBeenCalledTimes(1);
    expect(handleListUsers).toHaveBeenCalledWith(req, res, ctx);
  });

  it("PATCH /api/admin/users/:id routes to handleUpdateUser", async () => {
    const res = mockResponse();
    const req = mockReq("PATCH", "/api/admin/users/user-abc");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleUpdateUser).toHaveBeenCalledTimes(1);
    expect(handleUpdateUser).toHaveBeenCalledWith(req, res, ctx);
  });

  it("POST /api/admin/users (unsupported method on list) returns 405 + Allow: GET", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/users"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET");
  });

  it("404-style fall-through for /api/admin/users/x/extra", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("PATCH", "/api/admin/users/abc/extra"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
    expect(handleUpdateUser).not.toHaveBeenCalled();
  });

  it("encoded :id reaches the handler raw (handler does decodeURIComponent)", async () => {
    // The dispatcher does NOT decode :id for orgs/users — it just routes.
    // The handler is responsible for decoding (matches T05/T06 handler code).
    // This test asserts the handler is called even with encoded chars, so
    // the handler's decodeURIComponent failure path (returns BAD_PATH 400)
    // is reachable end-to-end. The "%C3%28" pair is an invalid UTF-8 sequence
    // that would trip decodeURIComponent if the dispatcher did decode it;
    // since the dispatcher doesn't decode, the route still matches.
    const res = mockResponse();
    const req = mockReq("PATCH", "/api/admin/users/%C3%28");
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(handleUpdateUser).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchAuthRoutes — per-IP admin mutation rate limit (V3 PATCH 4)", () => {
  it("blocks the 31st POST from the same IP within the 60s window (429 + Retry-After)", async () => {
    // Limit is 30 per 60s, so calls 1..30 are allowed and 31 is blocked.
    let lastRes: MockResponse | null = null;
    for (let i = 1; i <= 30; i++) {
      const res = mockResponse();
      lastRes = res;
      const handled = await dispatchAuthRoutes(
        mockReq("POST", "/api/admin/orgs", { ip: "192.0.2.10" }),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(handled).toBe(true);
      expect(res.statusCode, `call ${i} should be allowed`).toBe(201);
    }
    expect(lastRes).not.toBeNull();
    expect(handleCreateOrg).toHaveBeenCalledTimes(30);

    // 31st call from the same IP exceeds capacity → 429 + Retry-After.
    const res31 = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "192.0.2.10" }),
      res31 as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res31.statusCode).toBe(429);
    expect(typeof res31.headers["Retry-After"]).toBe("string");
    expect(Number(res31.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    const body = res31.body as Record<string, unknown>;
    expect(body.code).toBe("RATE_LIMITED");
    // Handler must NOT have been invoked on the blocked call.
    expect(handleCreateOrg).toHaveBeenCalledTimes(30);
  });

  it("rate limit applies across mutation routes (orgs POST + users PATCH share bucket)", async () => {
    // Exhaust the bucket via PATCH /users/:id, then verify POST /orgs is also
    // blocked from the same IP. The shared admin:mut:<ip> key is the point.
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("PATCH", "/api/admin/users/u-1", { ip: "192.0.2.11" }),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(res.statusCode).toBe(200);
    }
    const res31 = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "192.0.2.11" }),
      res31 as unknown as ServerResponse,
      ctx,
    );
    expect(res31.statusCode).toBe(429);
    expect(handleCreateOrg).not.toHaveBeenCalled();
  });

  it("PATCH /api/admin/orgs/:id 31st request from same IP returns 429 (covers orgs PATCH RL branch)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("PATCH", "/api/admin/orgs/org-1", { ip: "192.0.2.20" }),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(res.statusCode).toBe(200);
    }
    const blocked = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("PATCH", "/api/admin/orgs/org-1", { ip: "192.0.2.20" }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(blocked.statusCode).toBe(429);
    expect((blocked.body as Record<string, unknown>).code).toBe("RATE_LIMITED");
    // handleUpdateOrg called 30 times; 31st blocked before reaching handler.
    expect(handleUpdateOrg).toHaveBeenCalledTimes(30);
  });

  it("PATCH /api/admin/users/:id 31st request from same IP returns 429 (covers users PATCH RL branch)", async () => {
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("PATCH", "/api/admin/users/u-2", { ip: "192.0.2.21" }),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(res.statusCode).toBe(200);
    }
    const blocked = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("PATCH", "/api/admin/users/u-2", { ip: "192.0.2.21" }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(blocked.statusCode).toBe(429);
    expect((blocked.body as Record<string, unknown>).code).toBe("RATE_LIMITED");
    expect(handleUpdateUser).toHaveBeenCalledTimes(30);
  });

  it("GETs are NOT rate limited (same IP can list freely past the mutation cap)", async () => {
    // Burn the bucket with POSTs from one IP.
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("POST", "/api/admin/orgs", { ip: "192.0.2.12" }),
        res as unknown as ServerResponse,
        ctx,
      );
    }
    // Now POST is blocked.
    const blocked = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "192.0.2.12" }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(blocked.statusCode).toBe(429);

    // But GETs from the same IP still succeed (the GET branches skip the RL
    // check entirely). Run 50 — well past the 30/min mutation cap.
    for (let i = 0; i < 50; i++) {
      const res = mockResponse();
      const handled = await dispatchAuthRoutes(
        mockReq("GET", "/api/admin/orgs", { ip: "192.0.2.12" }),
        res as unknown as ServerResponse,
        ctx,
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    }
    expect(handleListOrgs).toHaveBeenCalledTimes(50);
  });

  it("different IPs use independent buckets", async () => {
    // Exhaust IP A.
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("POST", "/api/admin/orgs", { ip: "203.0.113.1" }),
        res as unknown as ServerResponse,
        ctx,
      );
    }
    const blockedA = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "203.0.113.1" }),
      blockedA as unknown as ServerResponse,
      ctx,
    );
    expect(blockedA.statusCode).toBe(429);

    // IP B has its own bucket — first call succeeds.
    const allowedB = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "203.0.113.2" }),
      allowedB as unknown as ServerResponse,
      ctx,
    );
    expect(allowedB.statusCode).toBe(201);
  });

  it("missing req.socket.remoteAddress falls back to 'unknown' bucket (no crash)", async () => {
    const req: IncomingMessage = {
      method: "POST",
      url: "/api/admin/orgs",
      headers: {},
      socket: {}, // no remoteAddress
    } as unknown as IncomingMessage;
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(req, res as unknown as ServerResponse, ctx);
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(201);
    expect(handleCreateOrg).toHaveBeenCalledTimes(1);
  });

  it("RL bucket recovers when the FakeClock advances past the window", async () => {
    const clock = ctx.clock as FakeClock;
    // Exhaust the bucket.
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await dispatchAuthRoutes(
        mockReq("POST", "/api/admin/orgs", { ip: "198.51.100.5" }),
        res as unknown as ServerResponse,
        ctx,
      );
    }
    const blocked = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "198.51.100.5" }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(blocked.statusCode).toBe(429);

    // Advance past the 60s window → bucket expires and is recreated full.
    clock.advance(120);
    const recovered = mockResponse();
    await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/orgs", { ip: "198.51.100.5" }),
      recovered as unknown as ServerResponse,
      ctx,
    );
    expect(recovered.statusCode).toBe(201);
  });
});

describe("dispatchAuthRoutes — regression: existing service-tokens routes still work", () => {
  it("POST /api/admin/service-tokens still dispatches (handler not mocked → real 401 unauth)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/service-tokens"),
      res as unknown as ServerResponse,
      ctx,
    );
    // We didn't mock handle-service-tokens, so the real handler runs and
    // rejects on missing Authorization (401 UNAUTHORIZED via authenticateRequest).
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect((res.body as Record<string, unknown>).code).toBe("UNAUTHORIZED");
  });

  it("POST /api/admin/service-tokens/<jti>/revoke still dispatches (401 unauth)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("POST", "/api/admin/service-tokens/jti-xyz/revoke"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/admin/service-tokens still returns 405 + Allow: GET, POST", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("DELETE", "/api/admin/service-tokens"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
  });

  it("non-admin URL still falls through (handled=false)", async () => {
    const res = mockResponse();
    const handled = await dispatchAuthRoutes(
      mockReq("GET", "/api/register"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(handled).toBe(false);
  });
});
