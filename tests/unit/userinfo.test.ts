import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import { handleUserinfo } from "../../src/auth/userinfo.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  initAuth,
  initPhase2Auth,
  resetPhase2Auth,
  createToken,
} from "../../src/auth.js";
import type Database from "better-sqlite3";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";

/**
 * T24 — GET /api/auth/me (userinfo).
 *
 * ≥8 cases. Schema bootstrapped via initDatabase(). Phase 2 cookie auth wired
 * in beforeEach via initPhase2Auth + reset in afterEach.
 */

const DIR = "data-test-userinfo";

const SIGNING_SECRET = Buffer.alloc(32, 0x22);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x02);
const registry = buildJwtKeyRegistry(SIGNING_SECRET);

// ---------------------------------------------------------------------------
// Mock req/res
// ---------------------------------------------------------------------------

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
  cookie?: string;
  authorization?: string;
  url?: string;
  method?: string;
}

function mockRequest(opts: MockReqOpts = {}): IncomingMessage {
  const stream = Readable.from([]);
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.authorization) headers.authorization = opts.authorization;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "GET";
  (stream as unknown as { url: string }).url = opts.url ?? "/api/auth/me";
  return stream as unknown as IncomingMessage;
}

function sessionCookie(token: string): string {
  return `__Host-coordinator_session=${token}`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

const stubProvider: IdPProvider = {
  name: "github",
  buildAuthUrl: () => "https://example/unused",
  exchangeCode: async (): Promise<ExchangeCodeResult> => {
    throw new Error("exchangeCode not used in T24 tests");
  },
};

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    githubProvider: stubProvider,
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
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, name, "acme");
}

function seedUser(
  id = "u-alice",
  role: "member" | "admin" | "service" = "member",
  orgId = "org-acme",
  email?: string,
  name: string | null = "Alice Example",
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
      email ?? `${id}@example.com`,
      name,
      "github",
      `gh-${id}`,
      "tok",
      role,
      "0",
      0,
    );
}

interface SessionMintOpts {
  sub?: string;
  active_org_id?: string;
  family_id?: string;
  role?: "member" | "admin" | "service" | "agent";
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
}

async function mintSessionJWT(opts: SessionMintOpts = {}): Promise<string> {
  const iat = opts.iat ?? clock.now();
  const ttl = opts.ttlSeconds ?? 900;
  const claims: Record<string, unknown> = {
    active_org_id: opts.active_org_id ?? "org-acme",
    role: opts.role ?? "member",
  };
  if (opts.family_id !== undefined) claims.family_id = opts.family_id;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setSubject(opts.sub ?? "u-alice")
    .setJti(opts.jti ?? "session-jti-1")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(new Uint8Array(SIGNING_SECRET));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
  clock = new FakeClock(Math.floor(Date.now() / 1000));
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
// Tests
// ===========================================================================
describe("handleUserinfo", () => {
  it("unauthenticated → 401 + WWW-Authenticate + UNAUTHORIZED envelope", async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer/);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("revoked Phase 1 Bearer token → 403 with no WWW-Authenticate header", async () => {
    // Exercises the auth-failure branch where authResult provides no
    // wwwAuthenticate (authenticateRequest's revoked-agent path returns
    // 403 sans header) — covers the conditional spread in handleUserinfo.
    getDb()
      .prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)")
      .run("agent-bad", "tester");
    const token = await createToken("agent-bad", "agent", undefined, {
      user_id: "agent-bad",
      org: "org-acme",
    });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("authenticated cookie + user + org → 200 + full JSON shape", async () => {
    seedOrg("org-acme", "Acme Corp");
    seedUser("u-alice", "member", "org-acme", "alice@acme.com", "Alice Example");
    const token = await mintSessionJWT({ sub: "u-alice", role: "member" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body).toEqual({
      user_id: "u-alice",
      email: "alice@acme.com",
      name: "Alice Example",
      role: "member",
      org: { id: "org-acme", name: "Acme Corp" },
      active_org_id: "org-acme",
    });
  });

  it("authenticated Bearer (Phase 1 token) → 200 (degraded: org may be 'default')", async () => {
    // Phase 1 v0.7 token. createToken sets org="default" by default; the
    // userinfo handler looks up the user by user_id and reads
    // primary_org_id from the users row (not the token org claim) — so we
    // seed the user with primary_org_id="org-default" and an "org-default"
    // org row. This proves Bearer auth path works end-to-end.
    seedOrg("org-default", "Default Org");
    seedUser("u-bearer", "admin", "org-default", "bearer@x.com", "Bearer User");
    const token = await createToken("u-bearer", "admin", undefined, {
      user_id: "u-bearer",
      org: "org-default",
    });
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.user_id).toBe("u-bearer");
    expect(body.role).toBe("admin");
    expect(body.org.id).toBe("org-default");
  });

  it("user_id in claims but no users row → 404 USER_NOT_FOUND", async () => {
    // No seedUser — the cookie's sub doesn't exist in DB.
    const token = await mintSessionJWT({ sub: "u-ghost" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("USER_NOT_FOUND");
  });

  it("user exists but org row missing → 404 ORG_NOT_FOUND", async () => {
    // User references a primary_org_id whose orgs row no longer exists.
    // Achieved by temporarily disabling FK enforcement for the SET (sqlite
    // FK PRAGMA is per-connection) so we can simulate the orphan state
    // that handleUserinfo's defensive 404 guards against.
    seedOrg("org-real", "Real");
    seedUser("u-orphan", "member", "org-real", "orphan@x.com", "Orphan");
    getDb().exec("PRAGMA foreign_keys = OFF");
    try {
      getDb()
        .prepare("UPDATE users SET primary_org_id = ? WHERE id = ?")
        .run("org-vanished", "u-orphan");
    } finally {
      getDb().exec("PRAGMA foreign_keys = ON");
    }
    const token = await mintSessionJWT({ sub: "u-orphan" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("ORG_NOT_FOUND");
  });

  it("Cache-Control: no-store on success", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({});
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("rate-limited: 601st call within 1 minute → 429 + Retry-After + RATE_LIMITED envelope", async () => {
    seedOrg();
    seedUser();
    const futureIat = clock.now() + 10;
    const token = await mintSessionJWT({ iat: futureIat });
    const cookie = sessionCookie(token);
    // First 600 succeed
    for (let i = 0; i < 600; i++) {
      const res = mockResponse();
      await handleUserinfo(
        mockRequest({ cookie }),
        res as unknown as ServerResponse,
        makeCtx(),
      );
      expect(res.statusCode).toBe(200);
    }
    // 601st exceeds
    const res601 = mockResponse();
    await handleUserinfo(
      mockRequest({ cookie }),
      res601 as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res601.statusCode).toBe(429);
    expect(res601.headers["Retry-After"]).toBeDefined();
    expect(Number(res601.headers["Retry-After"] as string)).toBeGreaterThan(0);
    const body = JSON.parse(res601.body!);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("rate-limit independent per user (two users each get 600 allowed)", async () => {
    seedOrg();
    seedUser("u-alice");
    seedUser("u-bob", "member", "org-acme", "bob@x.com", "Bob");
    const aliceToken = await mintSessionJWT({ sub: "u-alice" });
    const bobToken = await mintSessionJWT({ sub: "u-bob" });
    // Drain Alice's bucket (600 calls).
    for (let i = 0; i < 600; i++) {
      const res = mockResponse();
      await handleUserinfo(
        mockRequest({ cookie: sessionCookie(aliceToken) }),
        res as unknown as ServerResponse,
        makeCtx(),
      );
      expect(res.statusCode).toBe(200);
    }
    // Alice's 601st rate-limited
    const aliceOver = mockResponse();
    await handleUserinfo(
      mockRequest({ cookie: sessionCookie(aliceToken) }),
      aliceOver as unknown as ServerResponse,
      makeCtx(),
    );
    expect(aliceOver.statusCode).toBe(429);
    // Bob's first call still succeeds (independent bucket).
    const bobRes = mockResponse();
    await handleUserinfo(
      mockRequest({ cookie: sessionCookie(bobToken) }),
      bobRes as unknown as ServerResponse,
      makeCtx(),
    );
    expect(bobRes.statusCode).toBe(200);
  });

  it("response includes active_org_id as alias of org.id", async () => {
    seedOrg("org-zeta", "Zeta");
    seedUser("u-z", "member", "org-zeta", "z@x.com", "Z");
    const token = await mintSessionJWT({ sub: "u-z", active_org_id: "org-zeta" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.org.id).toBe("org-zeta");
    expect(body.active_org_id).toBe("org-zeta");
    expect(body.active_org_id).toBe(body.org.id);
  });

  it("role=admin returned correctly", async () => {
    seedOrg();
    seedUser("u-admin", "admin", "org-acme", "admin@acme.com", "Admin");
    const token = await mintSessionJWT({ sub: "u-admin", role: "admin" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.role).toBe("admin");
  });

  it("role=service returned correctly + name=null preserved", async () => {
    seedOrg();
    seedUser("u-svc", "service", "org-acme", "svc@acme.com", null);
    const token = await mintSessionJWT({ sub: "u-svc", role: "service" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.role).toBe("service");
    expect(body.name).toBeNull();
  });

  it("Content-Type is application/json on success", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({});
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleUserinfo(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/application\/json/);
  });
});
