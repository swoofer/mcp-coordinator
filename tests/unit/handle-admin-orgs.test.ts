// T05 (v0.10.6) — unit tests for src/admin/handle-admin-orgs.ts.
//
// Exercises the auth gate, CSRF check, body parsing, validation, DB writes,
// audit emission, and HTTP envelope for all three orgs endpoints. The handler
// emits Tier 1 audit events that depend on AsyncLocalStorage contexts
// (withRequestId + withAuditContext) so every handler call here is wrapped to
// mirror the live serve-http.ts dispatch.
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
import {
  handleListOrgs,
  handleCreateOrg,
  handleUpdateOrg,
} from "../../src/admin/handle-admin-orgs.js";
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
import type Database from "better-sqlite3";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";
import { makeAdminSession, type AdminSession } from "../helpers/admin-session.js";
import { withAuditContext } from "../../src/auth/audit-context.js";
import { withRequestId } from "../../src/auth/request-id.js";
import { findAuditRows } from "../helpers/audit.js";
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/auth/cookies.js";

const DIR = "data-test-handle-admin-orgs";
const SIGNING_SECRET = Buffer.alloc(32, 0x77);
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
  body?: string | Buffer[];
  method?: string;
  url?: string;
  session?: AdminSession;
  /** Override or omit the X-CSRF-Token header. If `session` is set and
   *  csrfHeader is undefined, the session's CSRF header is used. Pass
   *  `null` explicitly to send NO header. */
  csrfHeader?: string | null;
  /** Override Cookie header (default: session.cookieHeader). Use `null` to
   *  omit cookies entirely. */
  cookieHeader?: string | null;
  /** When true, prepend an Authorization Bearer header from session.jwt. */
  useBearer?: boolean;
}

function mockRequest(opts: MockReqOpts = {}): IncomingMessage {
  let chunks: Buffer[];
  if (Array.isArray(opts.body)) {
    chunks = opts.body;
  } else if (typeof opts.body === "string") {
    chunks = [Buffer.from(opts.body, "utf8")];
  } else {
    chunks = [];
  }
  const stream = Readable.from(chunks);
  const headers: Record<string, string> = {};

  if (opts.session) {
    if (opts.useBearer) {
      headers.authorization = `Bearer ${opts.session.jwt}`;
    }
    const cookieHeader =
      opts.cookieHeader === null
        ? undefined
        : (opts.cookieHeader ?? opts.session.cookieHeader);
    if (cookieHeader) headers.cookie = cookieHeader;
    const csrf =
      opts.csrfHeader === null
        ? undefined
        : (opts.csrfHeader ?? opts.session.csrfHeader);
    if (csrf !== undefined) headers["x-csrf-token"] = csrf;
  } else {
    if (opts.cookieHeader && opts.cookieHeader !== null) {
      headers.cookie = opts.cookieHeader;
    }
    if (opts.csrfHeader && opts.csrfHeader !== null) {
      headers["x-csrf-token"] = opts.csrfHeader;
    }
  }

  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "POST";
  (stream as unknown as { url: string }).url = opts.url ?? "/api/admin/orgs";
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

function makeCtx(): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(stubProvider),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: registry,
    membershipCache,
  };
}

/** Seed an org row directly (bypassing the handler). */
function seedOrg(
  id: string,
  name: string,
  allowGh: string | null = null,
  allowIdp: string | null = null,
): void {
  getDb()
    .prepare(
      `INSERT INTO orgs (id, name, allowlist_github_org, allowlist_idp_org_id, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, name, allowGh, allowIdp);
}

function seedUser(
  id: string,
  role: "admin" | "member" = "admin",
  orgId = "org-acme-001",
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
      `${id}@example.com`,
      id,
      "github",
      `gh-${id}`,
      "tok",
      role,
      "0",
      0,
    );
}

/** Wrap a handler invocation in the AsyncLocalStorage contexts the live
 *  dispatcher provides (withRequestId from serve-http.ts T10; withAuditContext
 *  composed in oauth-finalize / device-flow). */
async function runHandler<T>(
  fn: () => Promise<T>,
  opts: { userId?: string | null; orgId?: string | null; requestId?: string } = {},
): Promise<T> {
  const reqId = opts.requestId ?? "req-test-" + Math.random().toString(36).slice(2);
  return await withRequestId(reqId, () =>
    withAuditContext(
      { userId: opts.userId ?? null, orgId: opts.orgId ?? null },
      { ip: "127.0.0.1", userAgent: "test-agent" },
      async () => fn(),
    ),
  );
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM revoked_agents");
  getDb().exec("DELETE FROM user_orgs");
  getDb().exec("DELETE FROM users");
  // Preserve 'default' org seeded by SCHEMA; delete everything else.
  getDb().exec("DELETE FROM orgs WHERE id != 'default'");
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

async function adminSession(role: "admin" | "member" = "admin"): Promise<AdminSession> {
  const userId = role === "admin" ? "u-admin" : "u-member";
  // Create org + user row so Phase2 cookie verification has the token_epoch row.
  if (!getDb().prepare("SELECT id FROM orgs WHERE id = ?").get("org-acme-001")) {
    seedOrg("org-acme-001", "Acme");
  }
  seedUser(userId, role);
  return await makeAdminSession({
    userId,
    orgId: "org-acme-001",
    registry,
    issuer: ISSUER,
    role,
  });
}

function parseBody(res: MockResponse): Record<string, unknown> {
  expect(res.body).not.toBeNull();
  return JSON.parse(res.body!);
}

// ===========================================================================
// GET /api/admin/orgs
// ===========================================================================
describe("handleListOrgs", () => {
  it("returns 401 when no session", async () => {
    const req = mockRequest({ method: "GET" });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(401);
    const body = parseBody(res);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.request_id).toBeTypeOf("string");
  });

  it("returns 403 for non-admin role", async () => {
    const session = await adminSession("member");
    const req = mockRequest({ method: "GET", session, useBearer: true });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).code).toBe("FORBIDDEN");
  });

  it("returns 200 with all orgs for admin", async () => {
    const session = await adminSession("admin");
    seedOrg("org-1", "Alpha");
    seedOrg("org-2", "Beta", "beta-gh", "beta-idp");

    const req = mockRequest({ method: "GET", session, useBearer: true });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(200);
    const body = parseBody(res) as { orgs: Array<Record<string, unknown>> };
    // includes default, org-acme-001 (from seed), org-1, org-2
    const ids = body.orgs.map((o) => o.id);
    expect(ids).toContain("org-1");
    expect(ids).toContain("org-2");
    expect(ids).toContain("default");
    // shape: each row carries the five SELECTed columns
    for (const row of body.orgs) {
      expect(row).toHaveProperty("id");
      expect(row).toHaveProperty("name");
      expect(row).toHaveProperty("allowlist_github_org");
      expect(row).toHaveProperty("allowlist_idp_org_id");
      expect(row).toHaveProperty("created_at");
    }
  });

  it("works with cookie-based session (no Bearer) — also exercises the cookie auth scenario", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "GET",
      session,
      useBearer: false,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(200);
  });

  it("does not emit any audit row", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({ method: "GET", session, useBearer: true });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    const rows = getDb()
      .prepare("SELECT * FROM audit_log WHERE action LIKE 'admin.org.%'")
      .all();
    expect(rows).toHaveLength(0);
  });
});

// ===========================================================================
// POST /api/admin/orgs
// ===========================================================================
describe("handleCreateOrg", () => {
  it("returns 401 when no session", async () => {
    const req = mockRequest({ method: "POST", body: JSON.stringify({ name: "X" }) });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for non-admin role", async () => {
    const session = await adminSession("member");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "X" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 CSRF_FAILED when CSRF cookie is missing", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "NewOrg" }),
      session,
      useBearer: true,
      cookieHeader: `${SESSION_COOKIE_NAME}=${session.jwt}`, // omit CSRF cookie
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).code).toBe("CSRF_FAILED");
  });

  it("returns 403 CSRF_FAILED when CSRF cookie and header mismatch", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "NewOrg" }),
      session,
      useBearer: true,
      csrfHeader: "wrong-value-different-length",
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).code).toBe("CSRF_FAILED");
  });

  it("returns 403 CSRF_FAILED when CSRF cookie and header mismatch (same length)", async () => {
    const session = await adminSession("admin");
    // craft a header value the same byte length as csrfCookieValue (43 chars)
    // so the verifyCsrfToken length-check passes but timingSafeEqual fails.
    const same = "A".repeat(session.csrfCookieValue.length);
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "NewOrg" }),
      session,
      useBearer: true,
      csrfHeader: same,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 INVALID_REQUEST on empty body", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: "",
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("INVALID_REQUEST");
  });

  it("returns 400 INVALID_REQUEST on malformed JSON", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: "{not json",
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 INVALID_REQUEST when body is a JSON array", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: "[]",
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 INVALID_REQUEST when body is JSON null", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: "null",
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 INVALID_REQUEST on request body > 4096 bytes", async () => {
    const session = await adminSession("admin");
    const big = "x".repeat(5000);
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: big }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("INVALID_REQUEST");
  });

  it("returns 400 UNKNOWN_FIELD when body has an extra field", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "X", evil: 1 }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("UNKNOWN_FIELD");
  });

  it("returns 400 MISSING_FIELD when name is missing", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ allowlist_github_org: "foo" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("MISSING_FIELD");
  });

  it("returns 400 WRONG_TYPE when name is not a string", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: 42 }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("WRONG_TYPE");
  });

  it("returns 400 TOO_LONG when name > 200 bytes utf8", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "a".repeat(201) }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("TOO_LONG");
  });

  it("returns 400 CONTROL_BYTES when name contains a control byte", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "badname" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("CONTROL_BYTES");
  });

  it("returns 400 when allowlist_github_org is wrong type", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "OK", allowlist_github_org: 42 }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("WRONG_TYPE");
  });

  it("returns 400 when allowlist_idp_org_id is wrong type", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "OK", allowlist_idp_org_id: 1 }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("WRONG_TYPE");
  });

  it("returns 201 and persists row + audit on valid create (all fields)", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({
        name: "Brand New Org",
        allowlist_github_org: "bnoq-gh",
        allowlist_idp_org_id: "bnoq-idp",
      }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as { org: Record<string, unknown> };
    expect(body.org.name).toBe("Brand New Org");
    expect(body.org.allowlist_github_org).toBe("bnoq-gh");
    expect(body.org.allowlist_idp_org_id).toBe("bnoq-idp");
    expect(typeof body.org.id).toBe("string");
    expect(typeof body.org.created_at).toBe("string");

    // DB row exists
    const dbRow = getDb()
      .prepare("SELECT * FROM orgs WHERE id = ?")
      .get(body.org.id as string) as Record<string, unknown>;
    expect(dbRow.name).toBe("Brand New Org");

    // Audit row exists
    const audits = findAuditRows("admin.org.created");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0]!.metadata_json as string);
    expect(meta.org_id).toBe(body.org.id);
    expect(meta.target_org_id).toBe(body.org.id);
    expect(meta.name).toBe("Brand New Org");
    expect(meta.allowlist_github_org).toBe("bnoq-gh");
    expect(meta.allowlist_idp_org_id).toBe("bnoq-idp");
    expect(audits[0]!.actor_user_id).toBe(session.userId);
    // flat scalars only — no nested objects
    for (const v of Object.values(meta)) {
      expect(typeof v === "string" || typeof v === "number" || v === null).toBe(true);
    }
  });

  it("returns 201 with null allowlists when omitted from body", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "Minimal" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as { org: Record<string, unknown> };
    expect(body.org.allowlist_github_org).toBeNull();
    expect(body.org.allowlist_idp_org_id).toBeNull();

    const meta = JSON.parse(
      (findAuditRows("admin.org.created")[0]!.metadata_json as string) ?? "{}",
    );
    expect(meta.allowlist_github_org).toBeNull();
    expect(meta.allowlist_idp_org_id).toBeNull();
  });

  it("returns 201 when allowlists explicitly null (clears)", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({
        name: "NullsOK",
        allowlist_github_org: null,
        allowlist_idp_org_id: null,
      }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(201);
    const body = parseBody(res) as { org: Record<string, unknown> };
    expect(body.org.allowlist_github_org).toBeNull();
  });

  it("returns 409 ORG_NAME_TAKEN on duplicate name", async () => {
    const session = await adminSession("admin");
    seedOrg("org-existing", "ConflictName");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "ConflictName" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(409);
    const body = parseBody(res);
    expect(body.code).toBe("ORG_NAME_TAKEN");
    expect(body.request_id).toBeTypeOf("string");

    // No created audit row for the failed insert
    expect(findAuditRows("admin.org.created")).toHaveLength(0);
  });
});

// ===========================================================================
// PATCH /api/admin/orgs/:id
// ===========================================================================
describe("handleUpdateOrg", () => {
  function patchReq(opts: {
    pathId?: string;
    body?: string;
    session: AdminSession;
    csrfHeader?: string | null;
    cookieHeader?: string | null;
  }): IncomingMessage {
    const id = opts.pathId ?? "org-target";
    return mockRequest({
      method: "PATCH",
      url: `/api/admin/orgs/${id}`,
      body: opts.body ?? JSON.stringify({ name: "Renamed" }),
      session: opts.session,
      useBearer: true,
      csrfHeader: opts.csrfHeader,
      cookieHeader: opts.cookieHeader,
    });
  }

  it("returns 401 when no session", async () => {
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/orgs/org-x",
      body: JSON.stringify({ name: "X" }),
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const session = await adminSession("member");
    seedOrg("org-target", "Old");
    const req = patchReq({ session });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
  });

  it("returns 403 CSRF_FAILED when CSRF missing", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({
      session,
      cookieHeader: `${SESSION_COOKIE_NAME}=${session.jwt}`,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody(res).code).toBe("CSRF_FAILED");
  });

  it("returns 400 BAD_PATH on URL that doesn't match /api/admin/orgs/:id", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/orgs/", // trailing slash, empty id
      body: JSON.stringify({ name: "X" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("BAD_PATH");
  });

  it("returns 400 BAD_PATH on malformed URL encoding in id", async () => {
    const session = await adminSession("admin");
    // %E0%A4%A — incomplete percent-encoded sequence triggers URIError in decodeURIComponent
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/orgs/bad%E0%A4%A",
      body: JSON.stringify({ name: "X" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("BAD_PATH");
  });

  it("returns 400 BAD_ID when path id is too long or contains bad chars", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/orgs/" + "a".repeat(65),
      body: JSON.stringify({ name: "X" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("BAD_ID");
  });

  it("returns 400 INVALID_REQUEST on empty raw body", async () => {
    const session = await adminSession("admin");
    const req = patchReq({ session, body: "" });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("INVALID_REQUEST");
  });

  it("returns 400 EMPTY_BODY on JSON {} (no fields)", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({ session, body: "{}" });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("EMPTY_BODY");
  });

  it("returns 400 UNKNOWN_FIELD on unknown body field", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({
      session,
      body: JSON.stringify({ name: "OK", evil: 1 }),
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("UNKNOWN_FIELD");
  });

  it("returns 400 when name validation fails (TOO_LONG)", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({
      session,
      body: JSON.stringify({ name: "x".repeat(201) }),
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("TOO_LONG");
  });

  it("returns 400 when allowlist field validation fails", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({
      session,
      body: JSON.stringify({ allowlist_github_org: 42 }),
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("WRONG_TYPE");
  });

  it("returns 400 when allowlist_idp_org_id validation fails", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old");
    const req = patchReq({
      session,
      body: JSON.stringify({ allowlist_idp_org_id: 1 }),
    });
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("WRONG_TYPE");
  });

  it("returns 404 NOT_FOUND for non-existent org id", async () => {
    const session = await adminSession("admin");
    const req = patchReq({
      session,
      pathId: "org-ghost",
      body: JSON.stringify({ name: "Whatever" }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).code).toBe("NOT_FOUND");

    // no audit row written
    expect(findAuditRows("admin.org.updated")).toHaveLength(0);
  });

  it("returns 200 + updates row + emits audit on a name change", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "OldName", "gh-old", "idp-old");
    const req = patchReq({
      session,
      body: JSON.stringify({ name: "NewName" }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    const body = parseBody(res) as { org: Record<string, unknown> };
    expect(body.org.name).toBe("NewName");
    // unchanged columns still present
    expect(body.org.allowlist_github_org).toBe("gh-old");
    expect(body.org.allowlist_idp_org_id).toBe("idp-old");

    const dbRow = getDb()
      .prepare("SELECT name FROM orgs WHERE id = ?")
      .get("org-target") as Record<string, unknown>;
    expect(dbRow.name).toBe("NewName");

    const audits = findAuditRows("admin.org.updated");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0]!.metadata_json as string);
    expect(meta.org_id).toBe("org-target");
    expect(meta.target_org_id).toBe("org-target");
    expect(meta.changed_fields).toEqual(["name"]);
    expect(meta.name_before).toBe("OldName");
    expect(meta.name_after).toBe("NewName");
    // _before/_after for unchanged fields must NOT appear
    expect(meta.allowlist_github_org_before).toBeUndefined();
    expect(meta.allowlist_github_org_after).toBeUndefined();
    expect(meta.allowlist_idp_org_id_before).toBeUndefined();
    expect(meta.allowlist_idp_org_id_after).toBeUndefined();
  });

  it("clears allowlist_github_org with explicit null and audits the change", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old", "gh-old", null);
    const req = patchReq({
      session,
      body: JSON.stringify({ allowlist_github_org: null }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    const dbRow = getDb()
      .prepare("SELECT allowlist_github_org FROM orgs WHERE id = ?")
      .get("org-target") as Record<string, unknown>;
    expect(dbRow.allowlist_github_org).toBeNull();

    const audits = findAuditRows("admin.org.updated");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0]!.metadata_json as string);
    expect(meta.changed_fields).toEqual(["allowlist_github_org"]);
    expect(meta.allowlist_github_org_before).toBe("gh-old");
    expect(meta.allowlist_github_org_after).toBeNull();
  });

  it("clears allowlist_idp_org_id with explicit null and audits the change", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old", null, "idp-old");
    const req = patchReq({
      session,
      body: JSON.stringify({ allowlist_idp_org_id: null }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    const dbRow = getDb()
      .prepare("SELECT allowlist_idp_org_id FROM orgs WHERE id = ?")
      .get("org-target") as Record<string, unknown>;
    expect(dbRow.allowlist_idp_org_id).toBeNull();

    const meta = JSON.parse(
      findAuditRows("admin.org.updated")[0]!.metadata_json as string,
    );
    expect(meta.changed_fields).toEqual(["allowlist_idp_org_id"]);
    expect(meta.allowlist_idp_org_id_before).toBe("idp-old");
    expect(meta.allowlist_idp_org_id_after).toBeNull();
  });

  it("updates multiple fields and lists them all in changed_fields", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Old", "gh-old", "idp-old");
    const req = patchReq({
      session,
      body: JSON.stringify({
        name: "New",
        allowlist_github_org: "gh-new",
        allowlist_idp_org_id: "idp-new",
      }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(
      findAuditRows("admin.org.updated")[0]!.metadata_json as string,
    );
    expect(meta.changed_fields).toEqual([
      "name",
      "allowlist_github_org",
      "allowlist_idp_org_id",
    ]);
    expect(meta.name_after).toBe("New");
    expect(meta.allowlist_github_org_after).toBe("gh-new");
    expect(meta.allowlist_idp_org_id_after).toBe("idp-new");
    // flat scalars only
    for (const [k, v] of Object.entries(meta)) {
      if (k === "changed_fields") continue; // array is fine
      expect(typeof v === "string" || typeof v === "number" || v === null).toBe(true);
    }
  });

  it("emits audit with empty changed_fields when body fields all equal current values", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Same", "gh-same", null);
    const req = patchReq({
      session,
      body: JSON.stringify({
        name: "Same",
        allowlist_github_org: "gh-same",
      }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    const meta = JSON.parse(
      findAuditRows("admin.org.updated")[0]!.metadata_json as string,
    );
    expect(meta.changed_fields).toEqual([]);
    expect(meta.name_before).toBeUndefined();
  });

  it("returns 409 ORG_NAME_TAKEN when renaming to an existing name", async () => {
    const session = await adminSession("admin");
    seedOrg("org-a", "AlphaName");
    seedOrg("org-b", "BetaName");
    const req = patchReq({
      session,
      pathId: "org-b",
      body: JSON.stringify({ name: "AlphaName" }),
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).code).toBe("ORG_NAME_TAKEN");
    // No audit row on the failed update
    expect(findAuditRows("admin.org.updated")).toHaveLength(0);
  });

  it("accepts a percent-encoded path id and decodes it", async () => {
    const session = await adminSession("admin");
    seedOrg("org-target", "Original");
    // %2D is "-"; %6F is "o"; "org%2Dtarget" decodes to "org-target".
    const req = mockRequest({
      method: "PATCH",
      url: "/api/admin/orgs/org%2Dtarget",
      body: JSON.stringify({ name: "Decoded" }),
      session,
      useBearer: true,
    });
    const res = mockResponse();
    await runHandler(
      () => handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(200);
    expect((parseBody(res) as { org: { name: string } }).org.name).toBe("Decoded");
  });
});

// ===========================================================================
// Defensive branches (revoked agent gate, array CSRF header, missing req.url)
// ===========================================================================
describe("defensive branches", () => {
  it("returns 403 without WWW-Authenticate when admin agent is revoked", async () => {
    const session = await adminSession("admin");
    // Revoking adds to revoked_agents; authenticateRequest returns
    // { ok: false, status: 403, error: "Agent has been revoked" } with NO
    // wwwAuthenticate. Exercises the wwwAuthenticate-undefined branch.
    getDb()
      .prepare(
        "INSERT INTO revoked_agents (agent_id, org_id, revoked_by) VALUES (?, 'org-acme-001', 'tester')",
      )
      .run(session.userId);
    const req = mockRequest({ method: "GET", session, useBearer: true });
    const res = mockResponse();
    await runHandler(() =>
      handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(403);
    // Header object must NOT contain WWW-Authenticate
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
  });

  it("accepts an array-valued X-CSRF-Token header (uses first element)", async () => {
    const session = await adminSession("admin");
    // Build the request manually so we can set headers["x-csrf-token"] as an array.
    const stream = Readable.from([
      Buffer.from(JSON.stringify({ name: "ArrayHeader" }), "utf8"),
    ]);
    const headers: Record<string, string | string[]> = {
      authorization: `Bearer ${session.jwt}`,
      cookie: session.cookieHeader,
      "x-csrf-token": [session.csrfHeader, "other"],
    };
    (stream as unknown as { headers: typeof headers }).headers = headers;
    (stream as unknown as { method: string }).method = "POST";
    (stream as unknown as { url: string }).url = "/api/admin/orgs";
    const req = stream as unknown as IncomingMessage;
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { userId: session.userId, orgId: session.orgId },
    );
    expect(res.statusCode).toBe(201);
  });

  it("treats missing req.url as BAD_PATH on PATCH", async () => {
    const session = await adminSession("admin");
    const stream = Readable.from([Buffer.from(JSON.stringify({ name: "X" }))]);
    const headers: Record<string, string> = {
      authorization: `Bearer ${session.jwt}`,
      cookie: session.cookieHeader,
      "x-csrf-token": session.csrfHeader,
    };
    (stream as unknown as { headers: typeof headers }).headers = headers;
    (stream as unknown as { method: string }).method = "PATCH";
    // url left unset → req.url is undefined; exercises the `?? ""` fallback
    // on line 314 plus the `?? ""` on line 315.
    const req = stream as unknown as IncomingMessage;
    const res = mockResponse();
    await runHandler(() =>
      handleUpdateOrg(req, res as unknown as ServerResponse, makeCtx()),
    );
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).code).toBe("BAD_PATH");
  });
});

// ===========================================================================
// Cross-cutting (request_id propagation across error paths)
// ===========================================================================
describe("request_id propagation", () => {
  it("auto-injects request_id on error envelope", async () => {
    const req = mockRequest({ method: "GET" });
    const res = mockResponse();
    await runHandler(
      () => handleListOrgs(req, res as unknown as ServerResponse, makeCtx()),
      { requestId: "req-fixed-id-123" },
    );
    expect(res.statusCode).toBe(401);
    expect(parseBody(res).request_id).toBe("req-fixed-id-123");
  });

  it("auto-injects request_id on POST error envelope (CSRF)", async () => {
    const session = await adminSession("admin");
    const req = mockRequest({
      method: "POST",
      body: JSON.stringify({ name: "X" }),
      session,
      useBearer: true,
      cookieHeader: `${SESSION_COOKIE_NAME}=${session.jwt}`,
    });
    const res = mockResponse();
    await runHandler(
      () => handleCreateOrg(req, res as unknown as ServerResponse, makeCtx()),
      { requestId: "req-csrf-id-456" },
    );
    expect(parseBody(res).request_id).toBe("req-csrf-id-456");
  });
});

// Silence the unused-import lint by referencing CSRF_COOKIE_NAME (the cookie
// name is exercised implicitly via session.cookieHeader; keeping the import
// makes future audit-context work obvious).
void CSRF_COOKIE_NAME;
