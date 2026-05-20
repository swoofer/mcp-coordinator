import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import {
  handleLogout,
  handleLogoutAll,
  handleRevoke,
} from "../../src/auth/logout.js";
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
  createToken,
} from "../../src/auth.js";
import { readTokenEpoch } from "../../src/auth/token-epoch.js";
import { findAuditRows } from "../helpers/audit.js";
import type Database from "better-sqlite3";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";

/**
 * T23 — POST /api/auth/logout, /logout-all, /revoke.
 *
 * ≥18 cases (6 per handler). Schema bootstrapped via initDatabase() so the
 * full T01a refresh_tokens / users / audit_log columns exist. Phase 2 cookie
 * auth wired in beforeEach via initPhase2Auth + reset in afterEach.
 */

const DIR = "data-test-logout";

const SIGNING_SECRET = Buffer.alloc(32, 0x11);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);
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
  body?: Record<string, string>;
  url?: string;
  method?: string;
  /** When true, emit an error on the request stream after first data chunk. */
  streamError?: boolean;
}

/**
 * Build a mock IncomingMessage. For body-bearing requests (revoke) we wrap a
 * Readable stream so parseFormBody's req.on("data"|"end") consume it; for
 * bodyless logout/logout-all we still pass a Readable so the type matches.
 */
function mockRequest(opts: MockReqOpts = {}): IncomingMessage {
  const encoded = opts.body
    ? new URLSearchParams(opts.body).toString()
    : "";
  let stream: Readable;
  if (opts.streamError) {
    stream = new Readable({
      read() {
        process.nextTick(() => this.emit("error", new Error("stream borked")));
      },
    });
  } else {
    stream = Readable.from(encoded ? [Buffer.from(encoded, "utf8")] : []);
  }
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.authorization) headers.authorization = opts.authorization;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "POST";
  (stream as unknown as { url: string }).url = opts.url ?? "/api/auth/logout";
  return stream as unknown as IncomingMessage;
}

function sessionCookie(token: string): string {
  return `__Host-coordinator_session=${token}`;
}

// ---------------------------------------------------------------------------
// Test helpers — seeds + JWT minting
// ---------------------------------------------------------------------------

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

const stubProvider: IdPProvider = {
  name: "github",
  buildAuthUrl: () => "https://example/unused",
  exchangeCode: async (): Promise<ExchangeCodeResult> => {
    throw new Error("exchangeCode not used in T23 tests");
  },
};

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
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

function seedOrg(orgId = "org-acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", "acme");
}

function seedUser(
  id = "u-alice",
  role: "member" | "admin" | "service" = "member",
  orgId = "org-acme",
  tokenEpoch = 0,
): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, orgId, `${id}@example.com`, "github", `gh-${id}`, "tok", role, "0", tokenEpoch);
}

interface SeedRefreshOpts {
  jti: string;
  userId?: string;
  orgId?: string;
  familyId?: string;
  revokedAt?: string | null;
  expiresAt?: number;
}

function seedRefreshRow(opts: SeedRefreshOpts): void {
  const familyId = opts.familyId ?? "fam-root";
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${opts.jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      opts.jti,
      familyId,
      null,
      null,
      String(opts.expiresAt ?? clock.now() + 30 * 86400),
      String(clock.now()),
      opts.revokedAt ?? null,
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

interface RefreshMintOpts {
  sub?: string;
  active_org_id?: string;
  family_id?: string;
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
}

async function mintRefreshJWT(opts: RefreshMintOpts = {}): Promise<string> {
  const iat = opts.iat ?? clock.now();
  const ttl = opts.ttlSeconds ?? 30 * 86400;
  return new SignJWT({
    active_org_id: opts.active_org_id ?? "org-acme",
    family_id: opts.family_id ?? "fam-root",
  })
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setSubject(opts.sub ?? "u-alice")
    .setJti(opts.jti ?? "refresh-jti-1")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(new Uint8Array(SIGNING_SECRET));
}

function getRefreshRow(jti: string): { user_id: string; revoked_at: string | null; revoked_reason: string | null } | undefined {
  return getDb()
    .prepare("SELECT user_id, revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
    .get(jti) as { user_id: string; revoked_at: string | null; revoked_reason: string | null } | undefined;
}

function setCookieValues(res: MockResponse): string[] {
  const sc = res.headers["Set-Cookie"];
  if (!sc) return [];
  return Array.isArray(sc) ? sc : [sc];
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
  // v0.9 (issue #79): revoked_agents now has FK on org_id → orgs(id); preserve
  // 'default' so the test below's INSERT INTO revoked_agents satisfies the FK.
  getDb().exec("DELETE FROM orgs WHERE id <> 'default'");
  getDb().prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Default Organization')").run();
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
// handleLogout — 6 cases
// ===========================================================================
describe("handleLogout", () => {
  it("unauthenticated → 401 + WWW-Authenticate", async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer/);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("revoked Phase 1 Bearer token → 403 with no WWW-Authenticate header", async () => {
    // Exercise the emit401 branch where authResult provides no wwwAuthenticate
    // (authenticateRequest's revoked-agent path returns 403 sans header).
    getDb()
      .prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)")
      .run("agent-bad", "tester");
    const token = await createToken("agent-bad", "agent");
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("authenticated cookie + family_id present → 204 + family rows revoked", async () => {
    seedOrg();
    seedUser();
    seedRefreshRow({ jti: "r-1", familyId: "fam-A" });
    seedRefreshRow({ jti: "r-2", familyId: "fam-A" });
    // Different family — must NOT be revoked.
    seedRefreshRow({ jti: "r-3", familyId: "fam-B" });
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(204);
    expect(getRefreshRow("r-1")?.revoked_at).not.toBeNull();
    expect(getRefreshRow("r-1")?.revoked_reason).toBe("logout");
    expect(getRefreshRow("r-2")?.revoked_at).not.toBeNull();
    expect(getRefreshRow("r-3")?.revoked_at).toBeNull();
  });

  it("authenticated cookie + no family_id (Phase 1 token compat) → 204, no DB writes", async () => {
    seedOrg();
    seedUser();
    seedRefreshRow({ jti: "r-untouched", familyId: "fam-A" });
    // family_id intentionally absent from JWT claims.
    const token = await mintSessionJWT({});
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(204);
    expect(getRefreshRow("r-untouched")?.revoked_at).toBeNull();
  });

  it("clears both session + csrf cookies with Max-Age=0", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    const cookies = setCookieValues(res);
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("__Host-coordinator_session=") && /Max-Age=0/.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-coordinator_csrf=") && /Max-Age=0/.test(c))).toBe(true);
  });

  it("emits Tier 2 audit auth.logout.local with user_id + family_id", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    const audits = findAuditRows("auth.logout.local");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.user_id).toBe("u-alice");
    expect(meta.family_id).toBe("fam-A");
  });

  it("idempotent: does not touch already-revoked rows in the same family", async () => {
    seedOrg();
    seedUser();
    // Pre-existing revoked row, with a sentinel timestamp + reason.
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at, revoked_reason)
         VALUES ('id-prev', 'u-alice', 'org-acme', 'r-prev', 'fam-A', NULL, NULL,
                 ?, ?, '12345', 'rotated')`,
      )
      .run(String(clock.now() + 30 * 86400), String(clock.now()));
    seedRefreshRow({ jti: "r-active", familyId: "fam-A" });
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogout(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(204);
    // Pre-existing revoked row untouched (still 12345 / 'rotated').
    const prev = getRefreshRow("r-prev")!;
    expect(prev.revoked_at).toBe("12345");
    expect(prev.revoked_reason).toBe("rotated");
    // Active row now revoked with reason='logout'.
    const active = getRefreshRow("r-active")!;
    expect(active.revoked_at).not.toBeNull();
    expect(active.revoked_reason).toBe("logout");
  });
});

// ===========================================================================
// handleLogoutAll — 6 cases
// ===========================================================================
describe("handleLogoutAll", () => {
  it("unauthenticated → 401 + WWW-Authenticate", async () => {
    const req = mockRequest();
    const res = mockResponse();
    await handleLogoutAll(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer/);
  });

  it("authenticated → 204 + all unrevoked refresh rows revoked", async () => {
    seedOrg();
    seedUser();
    seedRefreshRow({ jti: "r-1", familyId: "fam-A" });
    seedRefreshRow({ jti: "r-2", familyId: "fam-B" });
    // Pre-revoked row stays as-is.
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at, revoked_reason)
         VALUES ('id-r3', 'u-alice', 'org-acme', 'r-3', 'fam-C', NULL, NULL, ?, ?, '99', 'rotated')`,
      )
      .run(String(clock.now() + 30 * 86400), String(clock.now()));
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogoutAll(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(204);
    expect(getRefreshRow("r-1")?.revoked_at).not.toBeNull();
    expect(getRefreshRow("r-1")?.revoked_reason).toBe("logout_all");
    expect(getRefreshRow("r-2")?.revoked_at).not.toBeNull();
    expect(getRefreshRow("r-2")?.revoked_reason).toBe("logout_all");
    expect(getRefreshRow("r-3")?.revoked_at).toBe("99");
    expect(getRefreshRow("r-3")?.revoked_reason).toBe("rotated");
  });

  it("rate-limited: 6th call within 1 hour → 429 + Retry-After", async () => {
    seedOrg();
    seedUser();
    // Each successful call bumps token_epoch by at least +1 (T03 monotonic).
    // We re-mint a fresh JWT before every call with an iat in the future so
    // claims.iat >= epoch still holds after multiple bumps. 1000s headroom
    // dwarfs the +6 bumps this test triggers.
    const futureIat = clock.now() + 1000;
    const mkReq = async () => mockRequest({
      cookie: sessionCookie(
        await mintSessionJWT({ family_id: "fam-A", iat: futureIat }),
      ),
    });
    // First 5 succeed.
    for (let i = 0; i < 5; i++) {
      const res = mockResponse();
      await handleLogoutAll(await mkReq(), res as unknown as ServerResponse, makeCtx());
      expect(res.statusCode).toBe(204);
    }
    // 6th call exceeds the bucket.
    const res6 = mockResponse();
    await handleLogoutAll(await mkReq(), res6 as unknown as ServerResponse, makeCtx());
    expect(res6.statusCode).toBe(429);
    expect(res6.headers["Retry-After"]).toBeDefined();
    expect(Number(res6.headers["Retry-After"] as string)).toBeGreaterThan(0);
    const body = JSON.parse(res6.body!);
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("emits Tier 1 audit auth.logout.global", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogoutAll(req, res as unknown as ServerResponse, makeCtx());
    const audits = findAuditRows("auth.logout.global");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.user_id).toBe("u-alice");
  });

  it("clears session + csrf cookies", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogoutAll(req, res as unknown as ServerResponse, makeCtx());
    const cookies = setCookieValues(res);
    expect(cookies).toHaveLength(2);
    expect(cookies.some((c) => c.startsWith("__Host-coordinator_session=") && /Max-Age=0/.test(c))).toBe(true);
    expect(cookies.some((c) => c.startsWith("__Host-coordinator_csrf=") && /Max-Age=0/.test(c))).toBe(true);
  });

  it("bumps token_epoch for the caller (T03 readTokenEpoch reflects increase)", async () => {
    seedOrg();
    seedUser("u-alice", "member", "org-acme", 0);
    const before = readTokenEpoch(getDb() as unknown as Database.Database, "u-alice");
    const token = await mintSessionJWT({ family_id: "fam-A" });
    const req = mockRequest({ cookie: sessionCookie(token) });
    const res = mockResponse();
    await handleLogoutAll(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(204);
    const after = readTokenEpoch(getDb() as unknown as Database.Database, "u-alice");
    expect(after).toBeGreaterThan(before);
  });
});

// ===========================================================================
// handleRevoke — 8 cases (≥6 required; we add a couple admin + idempotent)
// ===========================================================================
describe("handleRevoke", () => {
  it("unauthenticated → 401 + WWW-Authenticate", async () => {
    const req = mockRequest({ body: { token: "x" } });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer/);
  });

  it("body without `token` field → 200 (no-op)", async () => {
    seedOrg();
    seedUser();
    const session = await mintSessionJWT({});
    const req = mockRequest({ cookie: sessionCookie(session), body: {} });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("malformed JWT in body → 200 (no-op)", async () => {
    seedOrg();
    seedUser();
    const session = await mintSessionJWT({});
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: "not.a.jwt" },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("valid JWT with unknown jti → 200 (no-op), no audit", async () => {
    seedOrg();
    seedUser();
    const session = await mintSessionJWT({});
    // Mint a refresh JWT whose jti has no row in refresh_tokens.
    const unknownToken = await mintRefreshJWT({ jti: "jti-ghost" });
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: unknownToken },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("valid JWT + jti owned by caller → 200 + row revoked + Tier 1 audit", async () => {
    seedOrg();
    seedUser();
    seedRefreshRow({ jti: "jti-mine", familyId: "fam-A" });
    const session = await mintSessionJWT({});
    const refresh = await mintRefreshJWT({ jti: "jti-mine" });
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: refresh },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const row = getRefreshRow("jti-mine")!;
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("admin");
    const audits = findAuditRows("auth.token.revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.jti).toBe("jti-mine");
    expect(meta.revoked_by).toBe("u-alice");
    expect(meta.target_user_id).toBe("u-alice");
  });

  it("valid JWT + jti owned by another user, caller not admin → 200 silent reject, no audit, row untouched", async () => {
    seedOrg();
    seedUser("u-alice", "member");
    seedUser("u-bob", "member");
    seedRefreshRow({ jti: "jti-bob", userId: "u-bob", familyId: "fam-B" });
    const session = await mintSessionJWT({ sub: "u-alice", role: "member" });
    const refresh = await mintRefreshJWT({ sub: "u-bob", jti: "jti-bob" });
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: refresh },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(getRefreshRow("jti-bob")?.revoked_at).toBeNull();
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("valid JWT + jti owned by another user, caller IS admin → 200 + row revoked + Tier 1 audit", async () => {
    seedOrg();
    seedUser("u-admin", "admin");
    seedUser("u-bob", "member");
    seedRefreshRow({ jti: "jti-bob", userId: "u-bob", familyId: "fam-B" });
    const session = await mintSessionJWT({ sub: "u-admin", role: "admin" });
    const refresh = await mintRefreshJWT({ sub: "u-bob", jti: "jti-bob" });
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: refresh },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(getRefreshRow("jti-bob")?.revoked_at).not.toBeNull();
    expect(getRefreshRow("jti-bob")?.revoked_reason).toBe("admin");
    const audits = findAuditRows("auth.token.revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.revoked_by).toBe("u-admin");
    expect(meta.target_user_id).toBe("u-bob");
  });

  it("already-revoked jti → 200 (idempotent), no audit", async () => {
    seedOrg();
    seedUser();
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at, revoked_reason)
         VALUES ('id-x', 'u-alice', 'org-acme', 'jti-prev', 'fam-A', NULL, NULL,
                 ?, ?, '50', 'rotated')`,
      )
      .run(String(clock.now() + 30 * 86400), String(clock.now()));
    const session = await mintSessionJWT({});
    const refresh = await mintRefreshJWT({ jti: "jti-prev" });
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: refresh },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    // Pre-existing revoked_at/reason unchanged.
    const row = getRefreshRow("jti-prev")!;
    expect(row.revoked_at).toBe("50");
    expect(row.revoked_reason).toBe("rotated");
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("JWT without jti claim → 200 (no-op)", async () => {
    seedOrg();
    seedUser();
    const session = await mintSessionJWT({});
    // Mint a JWT without jti (set via SignJWT API by NOT calling setJti).
    const noJti = await new SignJWT({
      active_org_id: "org-acme",
      family_id: "fam-A",
    })
      .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
      .setIssuer(ISSUER)
      .setSubject("u-alice")
      .setIssuedAt(clock.now())
      .setExpirationTime(clock.now() + 3600)
      .sign(new Uint8Array(SIGNING_SECRET));
    const req = mockRequest({
      cookie: sessionCookie(session),
      body: { token: noJti },
    });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });

  it("unparseable body stream → 200 (no-op)", async () => {
    seedOrg();
    seedUser();
    const session = await mintSessionJWT({});
    const req = mockRequest({ cookie: sessionCookie(session), streamError: true });
    const res = mockResponse();
    await handleRevoke(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(findAuditRows("auth.token.revoked")).toHaveLength(0);
  });
});
