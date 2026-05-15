import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs";
import { SignJWT } from "jose";
import type Database from "better-sqlite3";
import { handleDeviceApprove } from "../../src/auth/device-flow.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth, initPhase2Auth, resetPhase2Auth, createToken } from "../../src/auth.js";
import { findAuditRows } from "../helpers/audit.js";

/**
 * T20 — POST /auth/device/approve (approve or deny a pending device flow).
 *
 * ≥15 cases covering:
 *   - Auth (cookie via T27 Scenario 5; unauth → 401)
 *   - Form parsing (missing user_code/action, invalid action)
 *   - CSRF double-submit (missing/mismatch cookie → 403 + Tier 2 audit)
 *   - Approve happy path (302 /auth/success + auth.device.approved audit
 *     + row.approved_user_id + row.approved_at set)
 *   - Approve failures (invalid_code / expired / consumed)
 *   - Brute-force lockout (V4 FIX 21: failed_approval_attempts ≥ 5 →
 *     denied_reason='too_many_failed_approvals' + audit reason='brute_force'
 *     + ?error=lockout)
 *   - Deny happy path + no-op deny (info-leak defense)
 *   - Rate limit 10/min + 20/hr per user (V4 NR11)
 */

const DIR = "data-test-device-approve";
const SIGNING_SECRET = Buffer.alloc(32, 0x55);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x05);
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
  body?: string;
  url?: string;
  method?: string;
  /** Force the body stream to error (forces parseFormBody reject). */
  streamError?: boolean;
}

function mockRequest(opts: MockReqOpts = {}): IncomingMessage {
  const bodyStr = opts.body ?? "";
  let stream: Readable;
  if (opts.streamError) {
    stream = new Readable({
      read() {
        process.nextTick(() => this.emit("error", new Error("stream boom")));
      },
    });
  } else {
    stream = Readable.from([Buffer.from(bodyStr, "utf8")]);
  }
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "POST";
  (stream as unknown as { url: string }).url = opts.url ?? "/auth/device/approve";
  (stream as unknown as { socket: unknown }).socket = { remoteAddress: "127.0.0.1" };
  return stream as unknown as IncomingMessage;
}

function buildCookie(parts: Record<string, string>): string {
  return Object.entries(parts)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function buildBody(parts: Record<string, string>): string {
  return new URLSearchParams(parts).toString();
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
  exchangeCode: async () => {
    throw new Error("not used in T20 tests");
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
): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, name, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, orgId, `${id}@example.com`, "User", "github", `gh-${id}`, "tok", role, "0", 0);
}

interface DeviceRowOpts {
  userCode?: string;
  deviceCode?: string;
  expiresAtOffset?: number;
  approvedUserId?: string | null;
  deniedAt?: number | null;
  deniedReason?: string | null;
  failedAttempts?: number;
  requesterIp?: string | null;
  requesterUa?: string | null;
}

function seedDeviceRow(opts: DeviceRowOpts = {}): {
  user_code: string;
  device_code: string;
} {
  const userCode = opts.userCode ?? "BCDF-GHJK";
  const deviceCode = opts.deviceCode ?? `dev-${userCode}`;
  const expiresAt = String(clock.now() + (opts.expiresAtOffset ?? 600));
  const nonce = crypto.randomBytes(16).toString("base64url");
  getDb()
    .prepare(
      `INSERT INTO device_auth_requests
         (device_code, user_code, nonce, approved_user_id, org_id, expires_at,
          requester_ip, requester_user_agent, requester_country,
          failed_approval_attempts, denied_at, denied_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deviceCode,
      userCode,
      nonce,
      opts.approvedUserId ?? null,
      null,
      expiresAt,
      opts.requesterIp ?? "203.0.113.5",
      opts.requesterUa ?? "essaim-cli/1.0",
      null,
      opts.failedAttempts ?? 0,
      opts.deniedAt ?? null,
      opts.deniedReason ?? null,
    );
  return { user_code: userCode, device_code: deviceCode };
}

async function mintSessionJWT(sub = "u-alice", orgId = "org-acme"): Promise<string> {
  const iat = clock.now();
  return new SignJWT({ active_org_id: orgId, role: "member" })
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setSubject(sub)
    .setJti(`session-${sub}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 900)
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
  getDb().exec("DELETE FROM device_auth_requests");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
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

afterEach(() => {
  resetPhase2Auth();
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ===========================================================================
// Tests
// ===========================================================================

describe("handleDeviceApprove — auth", () => {
  it("unauthenticated → 401 UNAUTHORIZED + WWW-Authenticate", async () => {
    const req = mockRequest({ body: "user_code=ABCD-EFGH&action=approve" });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBeDefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("revoked Phase 1 Bearer agent → 403 UNAUTHORIZED with no WWW-Authenticate header", async () => {
    // Exercises the auth-failure branch where authResult provides no
    // wwwAuthenticate header (authenticateRequest's revoked-agent path
    // returns 403 sans header) — covers the conditional spread on
    // wwwAuthenticate at the top of handleDeviceApprove.
    getDb()
      .prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)")
      .run("agent-revoked-da", "tester");
    const token = await createToken("agent-revoked-da", "agent", undefined, {
      user_id: "agent-revoked-da",
      org: "org-acme",
    });
    const req = mockRequest({ body: "" });
    (req.headers as Record<string, string>).authorization = `Bearer ${token}`;
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("authenticated cookie + valid CSRF + valid user_code + approve → 302 /auth/success + audit + row updated", async () => {
    seedOrg();
    seedUser("u-alice");
    const seeded = seedDeviceRow({ userCode: "BCDF-GHJK" });
    const csrf = "csrftok-double-submit-xyz";
    const token = await mintSessionJWT("u-alice");
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/success`);

    const row = getDb()
      .prepare("SELECT approved_user_id, approved_at FROM device_auth_requests WHERE user_code = ?")
      .get(seeded.user_code) as { approved_user_id: string | null; approved_at: number | null };
    expect(row.approved_user_id).toBe("u-alice");
    expect(typeof row.approved_at).toBe("number");
    expect(row.approved_at).toBe(clock.now());

    const audits = findAuditRows("auth.device.approved");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string) as Record<string, unknown>;
    expect(meta.actor_user_id).toBe("u-alice");
    expect(meta.requester_ip).toBe("203.0.113.5");
    expect(meta.requester_user_agent).toBe("essaim-cli/1.0");
  });
});

describe("handleDeviceApprove — form parsing", () => {
  it("missing user_code → 400 INVALID_REQUEST", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({ "__Host-coordinator_session": token }),
      body: buildBody({ action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("missing action → 400 INVALID_REQUEST", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({ "__Host-coordinator_session": token }),
      body: buildBody({ user_code: "BCDF-GHJK" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("action='invalid' → 400 INVALID_ACTION (after CSRF passes)", async () => {
    seedOrg();
    seedUser();
    const csrf = "csrftok-action-invalid";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: "BCDF-GHJK", _csrf: csrf, action: "invalid" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_ACTION");
  });

  it("body stream error → 400 INVALID_REQUEST", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT();
    // The auth path reads cookies from headers (not the body stream), so a
    // body stream error after auth still trips parseFormBody.
    const req = mockRequest({
      cookie: buildCookie({ "__Host-coordinator_session": token }),
      streamError: true,
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });
});

describe("handleDeviceApprove — CSRF", () => {
  it("missing csrf cookie → 403 CSRF_FAILED + Tier 2 audit", async () => {
    seedOrg();
    seedUser();
    seedDeviceRow();
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({ "__Host-coordinator_session": token }),
      body: buildBody({ user_code: "BCDF-GHJK", _csrf: "any", action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("CSRF_FAILED");
    const audits = findAuditRows("auth.csrf.failed");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string) as Record<string, unknown>;
    expect(meta.user_id).toBe("u-alice");
    expect(meta.endpoint).toBe("/auth/device/approve");
  });

  it("csrf cookie != form value → 403 CSRF_FAILED + Tier 2 audit", async () => {
    seedOrg();
    seedUser();
    seedDeviceRow();
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": "cookie-value",
      }),
      body: buildBody({ user_code: "BCDF-GHJK", _csrf: "form-value", action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("CSRF_FAILED");
    expect(findAuditRows("auth.csrf.failed")).toHaveLength(1);
  });
});

describe("handleDeviceApprove — approve failures", () => {
  it("unknown user_code → 302 ?error=invalid_code (no audit, no row created)", async () => {
    seedOrg();
    seedUser();
    const csrf = "csrf-1";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: "ZZZZ-ZZZZ", _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=invalid_code`);
    expect(findAuditRows("auth.device.approved")).toHaveLength(0);
  });

  it("expired user_code (expires_at <= now) → 302 ?error=expired", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow({ expiresAtOffset: -1 });
    const csrf = "csrf-2";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=expired`);
    // Row should remain unchanged (no approved_user_id, no increment)
    const row = getDb()
      .prepare("SELECT approved_user_id, failed_approval_attempts FROM device_auth_requests WHERE user_code = ?")
      .get(seeded.user_code) as { approved_user_id: string | null; failed_approval_attempts: number };
    expect(row.approved_user_id).toBeNull();
    expect(row.failed_approval_attempts).toBe(0);
  });

  it("already approved (approved_user_id NOT NULL) → 302 ?error=consumed", async () => {
    seedOrg();
    seedUser("u-alice");
    seedUser("u-bob", "member", "org-acme");
    const seeded = seedDeviceRow({ approvedUserId: "u-bob" });
    const csrf = "csrf-3";
    const token = await mintSessionJWT("u-alice");
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=consumed`);
    // Row not overwritten
    const row = getDb()
      .prepare("SELECT approved_user_id FROM device_auth_requests WHERE user_code = ?")
      .get(seeded.user_code) as { approved_user_id: string };
    expect(row.approved_user_id).toBe("u-bob");
  });

  it("already denied (denied_at NOT NULL) → 302 ?error=consumed", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow({ deniedAt: clock.now() - 10, deniedReason: "user_denied" });
    const csrf = "csrf-4";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=consumed`);
  });
});

describe("handleDeviceApprove — brute-force lockout (V4 FIX 21)", () => {
  it("approve when failed_approval_attempts >= 5 → increment + lockout + audit reason=brute_force + 302 ?error=lockout", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow({ failedAttempts: 5 });
    const csrf = "csrf-lockout";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=lockout`);

    // Row should be locked: denied_at set, denied_reason='too_many_failed_approvals',
    // failed_approval_attempts incremented to 6.
    const row = getDb()
      .prepare(`
        SELECT denied_at, denied_reason, failed_approval_attempts, approved_user_id
        FROM device_auth_requests WHERE user_code = ?
      `)
      .get(seeded.user_code) as {
        denied_at: number | null;
        denied_reason: string | null;
        failed_approval_attempts: number;
        approved_user_id: string | null;
      };
    expect(row.denied_at).toBe(clock.now());
    expect(row.denied_reason).toBe("too_many_failed_approvals");
    expect(row.failed_approval_attempts).toBe(6);
    expect(row.approved_user_id).toBeNull();

    const audits = findAuditRows("auth.device.denied");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string) as Record<string, unknown>;
    expect(meta.reason).toBe("brute_force");
    expect(meta.actor_user_id).toBe("u-alice");
  });

  it("approve fails via race (row present, not expired, not consumed, attempts<4) → increment + 302 ?error=consumed (no lockout)", async () => {
    // Simulate the race-condition branch in handleApproveFailure: the
    // approve UPDATE matched 0 rows, the diagnostic SELECT shows the row is
    // still pending (not expired/consumed), AND the increment doesn't push
    // attempts to >= 5. We achieve this by wrapping ctx.db.prepare so the
    // approve UPDATE returns undefined (forcing the failure path), then
    // delegating to the real prepare for inspection + increment.
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow({ failedAttempts: 0 });
    const csrf = "csrf-race";
    const token = await mintSessionJWT();

    const realDb = getDb();
    const proxyDb = {
      prepare: (sql: string) => {
        const stmt = realDb.prepare(sql);
        if (
          sql.includes("UPDATE device_auth_requests") &&
          sql.includes("approved_user_id = ?, approved_at = ?")
        ) {
          // Force the approve UPDATE to look like it matched 0 rows.
          return {
            ...stmt,
            get: (..._args: unknown[]) => undefined,
            run: stmt.run.bind(stmt),
          };
        }
        return stmt;
      },
    } as unknown as AuthHandlerContext["db"];

    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx({ db: proxyDb }));
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=consumed`);

    // Increment happened (0 → 1). Row still pending (not denied).
    const row = getDb()
      .prepare("SELECT failed_approval_attempts, denied_at FROM device_auth_requests WHERE user_code = ?")
      .get(seeded.user_code) as { failed_approval_attempts: number; denied_at: number | null };
    expect(row.failed_approval_attempts).toBe(1);
    expect(row.denied_at).toBeNull();
    // No brute_force audit emitted (threshold not crossed).
    const audits = findAuditRows("auth.device.denied");
    expect(audits).toHaveLength(0);
  });

  it("post-lockout subsequent approve attempt → ?error=consumed (denied_at now set)", async () => {
    seedOrg();
    seedUser();
    // Pre-seed already-locked row: failed_attempts=6 AND denied_at set
    const seeded = seedDeviceRow({
      failedAttempts: 6,
      deniedAt: clock.now() - 30,
      deniedReason: "too_many_failed_approvals",
    });
    const csrf = "csrf-post-lockout";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?error=consumed`);
    // No new audit row from this call (the failed_attempts increment path
    // doesn't fire because denied_at is set → "consumed" branch).
    expect(findAuditRows("auth.device.denied")).toHaveLength(0);
  });
});

describe("handleDeviceApprove — deny action", () => {
  it("deny happy path → 302 /auth/device?status=denied + denied_at set + audit reason=user_denied", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow();
    const csrf = "csrf-deny";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "deny" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?status=denied`);
    const row = getDb()
      .prepare("SELECT denied_at, denied_reason, approved_user_id FROM device_auth_requests WHERE user_code = ?")
      .get(seeded.user_code) as { denied_at: number | null; denied_reason: string | null; approved_user_id: string | null };
    expect(row.denied_at).toBe(clock.now());
    expect(row.denied_reason).toBe("user_denied");
    expect(row.approved_user_id).toBeNull();
    const audits = findAuditRows("auth.device.denied");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string) as Record<string, unknown>;
    expect(meta.reason).toBe("user_denied");
    expect(meta.actor_user_id).toBe("u-alice");
  });

  it("deny on unknown user_code → 302 /auth/device?status=denied + no audit + no row change (info-leak defense)", async () => {
    seedOrg();
    seedUser();
    const csrf = "csrf-deny-unknown";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: "GHOST-CODE", _csrf: csrf, action: "deny" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?status=denied`);
    expect(findAuditRows("auth.device.denied")).toHaveLength(0);
  });

  it("deny on expired user_code → 302 /auth/device?status=denied + no audit (UPDATE matches 0 rows)", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow({ expiresAtOffset: -10 });
    const csrf = "csrf-deny-expired";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "deny" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/device?status=denied`);
    expect(findAuditRows("auth.device.denied")).toHaveLength(0);
  });
});

describe("handleDeviceApprove — rate limiting", () => {
  it("11th approve from same user within 60s → 429 per-minute", async () => {
    seedOrg();
    seedUser();
    const csrf = "csrf-rl-min";
    const token = await mintSessionJWT();
    const ctx = makeCtx();
    // First 10 succeed (each operates on a fresh row → returns ?error=invalid_code,
    // but the rate-limiter still consumed a token).
    for (let i = 0; i < 10; i++) {
      const req = mockRequest({
        cookie: buildCookie({
          "__Host-coordinator_session": token,
          "__Host-coordinator_csrf": csrf,
        }),
        body: buildBody({ user_code: `BCDF-XX${i}X`, _csrf: csrf, action: "approve" }),
      });
      const res = mockResponse();
      await handleDeviceApprove(req, res as unknown as ServerResponse, ctx);
      expect(res.statusCode).toBe(302);
    }
    // 11th → 429.
    const blocked = mockResponse();
    await handleDeviceApprove(
      mockRequest({
        cookie: buildCookie({
          "__Host-coordinator_session": token,
          "__Host-coordinator_csrf": csrf,
        }),
        body: buildBody({ user_code: "BCDF-OVRX", _csrf: csrf, action: "approve" }),
      }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    const body = JSON.parse(blocked.body!);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toContain("per minute");
  });

  it("per-hour cap trips even when per-minute bucket is refilled (V4 NR11)", async () => {
    seedOrg();
    seedUser();
    const csrf = "csrf-rl-hour";
    const token = await mintSessionJWT();
    const ctx = makeCtx();
    // Drain per-hour bucket (20) across two 61s windows of 10 each.
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let i = 0; i < 10; i++) {
        const req = mockRequest({
          cookie: buildCookie({
            "__Host-coordinator_session": token,
            "__Host-coordinator_csrf": csrf,
          }),
          body: buildBody({ user_code: `C${cycle}DF-X${i}XX`, _csrf: csrf, action: "approve" }),
        });
        const res = mockResponse();
        await handleDeviceApprove(req, res as unknown as ServerResponse, ctx);
        expect(res.statusCode).toBe(302);
      }
      clock.advance(61);
    }
    // 21st call — per-minute has refilled, per-hour bucket exhausted.
    const blocked = mockResponse();
    await handleDeviceApprove(
      mockRequest({
        cookie: buildCookie({
          "__Host-coordinator_session": token,
          "__Host-coordinator_csrf": csrf,
        }),
        body: buildBody({ user_code: "ZZZZ-21XX", _csrf: csrf, action: "approve" }),
      }),
      blocked as unknown as ServerResponse,
      ctx,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    const body = JSON.parse(blocked.body!);
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toContain("per hour");
  });
});

describe("handleDeviceApprove — publicUrl normalization", () => {
  it("publicUrl with trailing slash → no double-slash in redirect Location", async () => {
    seedOrg();
    seedUser();
    const seeded = seedDeviceRow();
    const csrf = "csrf-trailing";
    const token = await mintSessionJWT();
    const req = mockRequest({
      cookie: buildCookie({
        "__Host-coordinator_session": token,
        "__Host-coordinator_csrf": csrf,
      }),
      body: buildBody({ user_code: seeded.user_code, _csrf: csrf, action: "approve" }),
    });
    const res = mockResponse();
    await handleDeviceApprove(
      req,
      res as unknown as ServerResponse,
      makeCtx({ publicUrl: `${ISSUER}/` }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe(`${ISSUER}/auth/success`);
    expect(res.headers["Location"]).not.toMatch(/\/\/auth/);
  });
});
