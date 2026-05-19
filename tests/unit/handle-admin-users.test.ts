import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import type Database from "better-sqlite3";
import {
  handleListUsers,
  handleUpdateUser,
} from "../../src/admin/handle-admin-users.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  initAuth,
  initPhase2Auth,
  resetPhase2Auth,
} from "../../src/auth.js";
import { makeAdminSession } from "../helpers/admin-session.js";
import { findAuditRows } from "../helpers/audit.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";

/**
 * T06 — handle-admin-users unit tests. Covers:
 *   - GET /api/admin/users (admin gate, ?org filter, role-IN filter,
 *     admin_count meta).
 *   - PATCH /api/admin/users/:id (admin gate, CSRF, body validation,
 *     last-admin TOCTOU-safe protection, NOT_HUMAN_USER, no-op no-audit,
 *     Tier 1 audit emission on successful role change).
 *
 * Uses cookie-based Phase 2 session auth via tests/helpers/admin-session.ts
 * so the CSRF double-submit path is exercised end-to-end (Bearer-token auth
 * doesn't carry a CSRF cookie). better-sqlite3 file-backed DB is wiped per
 * test for full isolation.
 */

const DIR = "data-test-handle-admin-users";

const SIGNING_SECRET = Buffer.alloc(32, 0x66);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x02);
const registry = buildJwtKeyRegistry(SIGNING_SECRET);

interface MockResponse {
  statusCode: number | null;
  headers: Record<string, string | string[]>;
  body: string | null;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | undefined;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    headers: {},
    body: null,
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
      this.body = payload ?? null;
    },
  };
  return res;
}

interface MockReqOpts {
  body?: string;
  method?: string;
  url?: string;
  cookieHeader?: string;
  csrfHeader?: string;
  authorization?: string;
}

function mockRequest(opts: MockReqOpts = {}): IncomingMessage {
  const chunks: Buffer[] =
    typeof opts.body === "string" ? [Buffer.from(opts.body, "utf8")] : [];
  const stream = Readable.from(chunks);
  const headers: Record<string, string> = {};
  if (opts.cookieHeader) headers.cookie = opts.cookieHeader;
  if (opts.csrfHeader) headers["x-csrf-token"] = opts.csrfHeader;
  if (opts.authorization) headers.authorization = opts.authorization;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "GET";
  (stream as unknown as { url: string }).url =
    opts.url ?? "/api/admin/users";
  return stream as unknown as IncomingMessage;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

const stubProvider: IdPProvider = {
  name: "github",
  buildAuthUrl: () => "https://example/unused",
  exchangeCode: async (): Promise<ExchangeCodeResult> => {
    throw new Error("not used");
  },
};

function makeCtx(
  overrides: Partial<AuthHandlerContext> = {},
): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(stubProvider),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: registry,
    membershipCache,
    ...overrides,
  };
}

function seedOrg(orgId = "org-acme", name = "Acme"): void {
  getDb()
    .prepare(
      "INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
    )
    .run(orgId, name, "acme");
}

function seedUser(
  id: string,
  role: "admin" | "member" | "agent" | "service",
  orgId = "org-acme",
  opts: { email?: string; name?: string | null; lastLoginAt?: string | null } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, name, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      orgId,
      opts.email ?? `${id}@example.com`,
      opts.name === undefined ? id : opts.name,
      "github",
      `gh-${id}`,
      "tok",
      role,
      opts.lastLoginAt === undefined ? "0" : opts.lastLoginAt,
      0,
    );
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM user_orgs");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  getDb().exec("DELETE FROM revoked_agents");
  resetPhase2Auth();
  clock = new FakeClock(1_700_000_000);
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
  initPhase2Auth({
    db: getDb() as unknown as Database.Database,
    signingKeys: registry,
    publicUrl: ISSUER,
  });
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ===========================================================================
// GET /api/admin/users — auth gate
// ===========================================================================
describe("handleListUsers — auth gate", () => {
  it("no session → 401 UNAUTHORIZED with request_id", async () => {
    const req = mockRequest({ method: "GET", url: "/api/admin/users" });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
    expect("request_id" in body).toBe(true);
  });

  it("non-admin (member) → 403 FORBIDDEN", async () => {
    seedOrg();
    seedUser("u-member", "member");
    const session = await makeAdminSession({
      userId: "u-member",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
      role: "member",
    });
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      cookieHeader: session.cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("auth failure WITHOUT WWW-Authenticate header (revoked-agent path)", async () => {
    // Covers the `wwwAuthenticate ?? {...}` else branch in requireAdmin —
    // some auth failure modes (revoked-agent, ADMIN_ONLY_ROUTES path) return
    // 403 without a WWW-Authenticate header. Force the path by issuing a
    // legitimate Bearer token then revoking the agent.
    const { createToken } = await import("../../src/auth.js");
    seedOrg();
    seedUser("u-revoked", "admin");
    getDb()
      .prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)")
      .run("u-revoked", "tester");
    const token = await createToken("u-revoked", "admin", undefined, {
      user_id: "u-revoked",
      org: "org-acme",
    });
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      authorization: `Bearer ${token}`,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    // No WWW-Authenticate header on this auth-failure path.
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("admin → 200", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      cookieHeader: session.cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
  });
});

// ===========================================================================
// GET /api/admin/users — behavior
// ===========================================================================
describe("handleListUsers — behavior", () => {
  async function seedAdminAndSession(
    userId = "u-admin",
    orgId = "org-acme",
  ): Promise<{ cookieHeader: string }> {
    seedOrg(orgId);
    seedUser(userId, "admin", orgId);
    const session = await makeAdminSession({
      userId,
      orgId,
      registry,
      issuer: ISSUER,
    });
    return { cookieHeader: session.cookieHeader };
  }

  it("happy path: returns list + meta.admin_count", async () => {
    const { cookieHeader } = await seedAdminAndSession();
    seedUser("u-bob", "member");
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users).toHaveLength(2);
    expect(body.meta.admin_count).toBe(1);
    // Returned columns match the spec.
    const u = body.users[0];
    expect(u).toHaveProperty("id");
    expect(u).toHaveProperty("email");
    expect(u).toHaveProperty("name");
    expect(u).toHaveProperty("role");
    expect(u).toHaveProperty("primary_org_id");
    expect(u).toHaveProperty("created_at");
    expect(u).toHaveProperty("last_login_at");
  });

  it("?org filter scopes to a single primary_org_id", async () => {
    const { cookieHeader } = await seedAdminAndSession();
    seedOrg("org-other", "Other");
    seedUser("u-other", "member", "org-other");
    seedUser("u-mine", "member", "org-acme");
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users?org=org-acme",
      cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const ids = body.users.map((u: { id: string }) => u.id).sort();
    expect(ids).toEqual(["u-admin", "u-mine"]);
  });

  it("excludes 'agent' and 'service' role users", async () => {
    const { cookieHeader } = await seedAdminAndSession();
    seedUser("u-agent", "agent");
    seedUser("u-svc", "service");
    seedUser("u-human", "member");
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const ids = body.users.map((u: { id: string }) => u.id).sort();
    expect(ids).toEqual(["u-admin", "u-human"]);
  });

  it("admin_count = 0 when zero admins exist (after orphan delete impossible — assert with seed-only flow)", async () => {
    // We cannot have 0 admins AND have an authenticated admin caller, so
    // assert this through a freshly authenticated admin + DB tweak: directly
    // demote the admin AFTER cookie issuance (the cookie is still valid for
    // its TTL even if the underlying user's role changed).
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    // Demote the only admin under the hood. The session cookie's `role`
    // claim is still "admin" so requireAdmin still passes.
    getDb()
      .prepare("UPDATE users SET role = 'member' WHERE id = ?")
      .run("u-admin");
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users",
      cookieHeader: session.cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.meta.admin_count).toBe(0);
  });

  it("admin_count reflects GLOBAL count, NOT per-org filter", async () => {
    const { cookieHeader } = await seedAdminAndSession();
    // Seed 2 more admins in a different org. Filter to org-acme.
    seedOrg("org-other", "Other");
    seedUser("u-a2", "admin", "org-other");
    seedUser("u-a3", "admin", "org-other");
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users?org=org-acme",
      cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    // Only u-admin in org-acme listed
    expect(body.users).toHaveLength(1);
    // But admin_count is global = 3
    expect(body.meta.admin_count).toBe(3);
  });

  it("?org with invalid format → 400 BAD_ID", async () => {
    const { cookieHeader } = await seedAdminAndSession();
    const req = mockRequest({
      method: "GET",
      url: "/api/admin/users?org=" + encodeURIComponent("bad/value"),
      cookieHeader,
    });
    const res = mockResponse();
    await handleListUsers(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("BAD_ID");
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id — auth + CSRF gates
// ===========================================================================
describe("handleUpdateUser — auth + CSRF gates", () => {
  it("no session → 401 UNAUTHORIZED", async () => {
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-bob",
      body: JSON.stringify({ role: "admin" }),
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("non-admin → 403 FORBIDDEN", async () => {
    seedOrg();
    seedUser("u-member", "member");
    const session = await makeAdminSession({
      userId: "u-member",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
      role: "member",
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-member",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("missing CSRF header → 403 CSRF_FAILED", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-bob", "member");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-bob",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      // no csrfHeader
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("CSRF_FAILED");
  });

  it("CSRF header arriving as an array (Node multi-value) uses the first element", async () => {
    // Defensive: req.headers values are typed as `string | string[]`. Node
    // de-duplicates X-CSRF-Token to a string in practice, but the type
    // allows an array. Cover the Array.isArray branch by attaching one.
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-bob", "member");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const chunks = [Buffer.from(JSON.stringify({ role: "admin" }), "utf8")];
    const stream = Readable.from(chunks);
    const headers: Record<string, string | string[]> = {
      cookie: session.cookieHeader,
      // Array form: first element is the valid CSRF token.
      "x-csrf-token": [session.csrfHeader, "decoy"],
    };
    (stream as unknown as { headers: Record<string, string | string[]> }).headers = headers;
    (stream as unknown as { method: string }).method = "PATCH";
    (stream as unknown as { url: string }).url = "/api/admin/users/u-bob";
    const res = mockResponse();
    await handleUpdateUser(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.user).toEqual({ id: "u-bob", role: "admin" });
  });

  it("mismatched CSRF header → 403 CSRF_FAILED", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-bob", "member");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-bob",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: "not-the-real-token-1234567890abcdefghij1",
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("CSRF_FAILED");
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id — path + body validation
// ===========================================================================
describe("handleUpdateUser — path + body validation", () => {
  async function adminSession(): Promise<{
    cookieHeader: string;
    csrfHeader: string;
  }> {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    return {
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    };
  }

  it("malformed URL path → 400 BAD_PATH", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users", // no /:id segment
      body: JSON.stringify({ role: "member" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("BAD_PATH");
  });

  it("invalid percent-encoding in URL → 400 BAD_PATH", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/%E0%A4%A", // truncated UTF-8 percent escape
      body: JSON.stringify({ role: "admin" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("BAD_PATH");
  });

  it("path id with forbidden chars → 400 BAD_ID", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/" + encodeURIComponent("bad id with spaces"),
      body: JSON.stringify({ role: "admin" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("BAD_ID");
  });

  it("body too large → 400 INVALID_REQUEST", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const huge = "x".repeat(5000);
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: huge,
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("empty body → 400 INVALID_REQUEST", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: "",
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("malformed JSON → 400 INVALID_REQUEST", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: "{not json",
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("non-object body (array) → 400 INVALID_REQUEST", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify(["role", "admin"]),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("empty object body → 400 EMPTY_BODY", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({}),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("EMPTY_BODY");
  });

  it("unknown field → 400 UNKNOWN_FIELD", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({ role: "admin", extra: "x" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNKNOWN_FIELD");
  });

  it("missing role → 400 INVALID_ROLE (validateRoleField)", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    // role omitted but body is non-empty (use a smuggled allowed key… we
    // only allow "role", so omitting role triggers INVALID_ROLE on undefined.
    // To get past validateUpdateBody we need a key — but only `role` is
    // allowed. So if role is absent the body must be empty → EMPTY_BODY.
    // To hit INVALID_ROLE we send role:null explicitly.
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({ role: null }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_ROLE");
  });

  it("invalid role value 'ADMIN' (case) → 400 INVALID_ROLE", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({ role: "ADMIN" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_ROLE");
  });

  it("invalid role value 'agent' (non-human) → 400 INVALID_ROLE", async () => {
    const { cookieHeader, csrfHeader } = await adminSession();
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({ role: "agent" }),
      cookieHeader,
      csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_ROLE");
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id — happy path + audit
// ===========================================================================
describe("handleUpdateUser — happy path + audit", () => {
  it("member → admin: 200 + DB updated + Tier 1 audit emitted", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-bob", "member");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-bob",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(body.user).toEqual({ id: "u-bob", role: "admin" });

    // DB row updated.
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-bob") as { role: string };
    expect(row.role).toBe("admin");

    // Tier 1 audit row emitted with flat scalar metadata.
    const rows = findAuditRows("admin.user.role_changed");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]!.metadata_json as string);
    expect(meta).toEqual({
      target_user_id: "u-bob",
      old_role: "member",
      new_role: "admin",
    });
    // Metadata is flat scalars only (no nested objects/arrays).
    for (const v of Object.values(meta)) {
      expect(["string", "number", "boolean"]).toContain(typeof v);
    }
  });

  it("admin → admin (no-op): 200, no audit emitted, no DB write", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-other-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-other-admin",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.user).toEqual({ id: "u-other-admin", role: "admin" });

    // No audit row for a no-op.
    const rows = findAuditRows("admin.user.role_changed");
    expect(rows).toHaveLength(0);
  });

  it("response includes request_id in error envelopes", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-nonexistent",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("NOT_FOUND");
    expect("request_id" in body).toBe(true);
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id — 404 + NOT_HUMAN_USER
// ===========================================================================
describe("handleUpdateUser — 404 + NOT_HUMAN_USER", () => {
  it("non-existent user id → 404 NOT_FOUND", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-ghost",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("NOT_FOUND");
    // No audit for a 404.
    expect(findAuditRows("admin.user.role_changed")).toHaveLength(0);
  });

  it("targeting an 'agent' user → 400 NOT_HUMAN_USER", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-agent", "agent");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-agent",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("NOT_HUMAN_USER");
    // No audit for an NOT_HUMAN_USER refusal.
    expect(findAuditRows("admin.user.role_changed")).toHaveLength(0);
    // DB role unchanged.
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-agent") as { role: string };
    expect(row.role).toBe("agent");
  });

  it("targeting a 'service' user → 400 NOT_HUMAN_USER", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-svc", "service");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-svc",
      body: JSON.stringify({ role: "member" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("NOT_HUMAN_USER");
  });
});

// ===========================================================================
// PATCH /api/admin/users/:id — LAST_ADMIN (V3 PATCH 1)
// ===========================================================================
describe("handleUpdateUser — LAST_ADMIN guard (V3 PATCH 1)", () => {
  it("self-demote of the only admin → 409 LAST_ADMIN, no audit, no DB change", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-admin",
      body: JSON.stringify({ role: "member" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("LAST_ADMIN");

    // No audit emitted for the refused change (the refusal-itself audit
    // outcome semantics from V3 PATCH 1 split into self_demotion vs
    // last_admin denied rows are out of scope for the T06 task spec —
    // task explicitly says "Audit NOT emitted for the refused change".)
    expect(findAuditRows("admin.user.role_changed")).toHaveLength(0);

    // DB row unchanged.
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-admin") as { role: string };
    expect(row.role).toBe("admin");
  });

  it("demoting last admin (different user case) → 409 LAST_ADMIN", async () => {
    // Setup: A=admin (actor + only admin in DB), B=member.
    // Promote B to admin via the endpoint first (200), then demote A.
    // Now B is the only admin. Re-issue session as B and demote B → 409.
    seedOrg();
    seedUser("u-a", "admin");
    seedUser("u-b", "member");
    const sessionA = await makeAdminSession({
      userId: "u-a",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });

    // Step 1: A promotes B to admin.
    const req1 = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-b",
      body: JSON.stringify({ role: "admin" }),
      cookieHeader: sessionA.cookieHeader,
      csrfHeader: sessionA.csrfHeader,
    });
    const res1 = mockResponse();
    await handleUpdateUser(req1, res1 as unknown as ServerResponse, makeCtx());
    expect(res1.statusCode).toBe(200);

    // Step 2: A demotes A (now A,B both admin → demote leaves 1 admin = B).
    const req2 = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-a",
      body: JSON.stringify({ role: "member" }),
      cookieHeader: sessionA.cookieHeader,
      csrfHeader: sessionA.csrfHeader,
    });
    const res2 = mockResponse();
    await handleUpdateUser(req2, res2 as unknown as ServerResponse, makeCtx());
    expect(res2.statusCode).toBe(200);

    // Step 3: B is now the only admin. Issue a session for B and have B
    // attempt to demote B → 409.
    const sessionB = await makeAdminSession({
      userId: "u-b",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    const req3 = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-b",
      body: JSON.stringify({ role: "member" }),
      cookieHeader: sessionB.cookieHeader,
      csrfHeader: sessionB.csrfHeader,
    });
    const res3 = mockResponse();
    await handleUpdateUser(req3, res3 as unknown as ServerResponse, makeCtx());
    expect(res3.statusCode).toBe(409);
    const body3 = JSON.parse(res3.body!);
    expect(body3.code).toBe("LAST_ADMIN");
  });

  it("demote when 2 admins exist → 200 (not last admin)", async () => {
    seedOrg();
    seedUser("u-a", "admin");
    seedUser("u-b", "admin");
    const session = await makeAdminSession({
      userId: "u-a",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    // A demotes B → 200, B becomes member, A is still admin.
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/users/u-b",
      body: JSON.stringify({ role: "member" }),
      cookieHeader: session.cookieHeader,
      csrfHeader: session.csrfHeader,
    });
    const res = mockResponse();
    await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-b") as { role: string };
    expect(row.role).toBe("member");
    // Audit emitted for the successful change.
    expect(findAuditRows("admin.user.role_changed")).toHaveLength(1);
  });

  // TOCTOU sentinel — not a true concurrency test. better-sqlite3 is
  // synchronous and single-threaded inside the Node event loop, so we
  // cannot interleave two transactions mid-execution. This test confirms
  // the SQL doesn't compose wrong when invoked twice back-to-back against
  // a last-admin row. The real protection is `.immediate()` (V3 PATCH 2)
  // which acquires the RESERVED lock at BEGIN. A multi-process deployment
  // would surface SQLITE_BUSY on the second writer (V3 PATCH 5), which is
  // out of scope for this single-process unit test.
  it("TOCTOU sentinel: two back-to-back attempts both 409 against the last admin", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    const session = await makeAdminSession({
      userId: "u-admin",
      orgId: "org-acme",
      registry,
      issuer: ISSUER,
    });
    for (let i = 0; i < 2; i++) {
      const req = mockRequest({
        method: "PATCH",
        url: "/api/admin/users/u-admin",
        body: JSON.stringify({ role: "member" }),
        cookieHeader: session.cookieHeader,
        csrfHeader: session.csrfHeader,
      });
      const res = mockResponse();
      await handleUpdateUser(req, res as unknown as ServerResponse, makeCtx());
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body!).code).toBe("LAST_ADMIN");
    }
    // Across both attempts: zero audit rows + DB role unchanged.
    expect(findAuditRows("admin.user.role_changed")).toHaveLength(0);
    const row = getDb()
      .prepare("SELECT role FROM users WHERE id = ?")
      .get("u-admin") as { role: string };
    expect(row.role).toBe("admin");
  });
});
