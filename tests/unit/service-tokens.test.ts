import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { jwtVerify } from "jose";
import {
  issueServiceToken,
  listServiceTokens,
  revokeServiceToken,
  verifyServiceTokenJti,
  ServiceTokenValidationError,
  SERVICE_TOKEN_MAX_TTL_S,
} from "../../src/auth/service-tokens.js";
import { handleIssueServiceToken } from "../../src/admin/handle-service-tokens.js";
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
import { findAuditRows } from "../helpers/audit.js";

/**
 * T25 - Service token issuance + verification override.
 *
 * Covers issueServiceToken validation + DB writes, listServiceTokens filters,
 * revokeServiceToken row affecting, verifyServiceTokenJti override semantics,
 * and the POST /api/admin/service-tokens HTTP endpoint (admin gate + JSON
 * body handling + audit emission).
 */

const DIR = "data-test-service-tokens";

const SIGNING_SECRET = Buffer.alloc(32, 0x55);
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
  authorization?: string;
  method?: string;
  url?: string;
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
  if (opts.authorization) headers.authorization = opts.authorization;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { method: string }).method = opts.method ?? "POST";
  (stream as unknown as { url: string }).url =
    opts.url ?? "/api/admin/service-tokens";
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
  role: "member" | "admin" | "service" = "admin",
  orgId = "org-acme",
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

function seedUserOrgMembership(
  userId: string,
  orgId: string,
  role: "member" | "admin" | "service" = "member",
): void {
  getDb()
    .prepare(
      `INSERT INTO user_orgs (user_id, org_id, role, joined_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, orgId, role, "0");
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
// issueServiceToken
// ===========================================================================
describe("issueServiceToken", () => {
  it("happy path: returns jti, accessToken, familyId, expiresAt", async () => {
    seedOrg("org-acme");
    seedUser("u-target", "member", "org-acme");
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-target",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "CI/CD deploy pipeline",
      issuedByAdminId: "u-admin",
    });
    expect(issued.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.familyId).toMatch(/^service:[0-9a-f-]{36}$/);
    expect(issued.expiresAt).toBe(clock.now() + 3600);
    expect(typeof issued.accessToken).toBe("string");

    // JWT verifies and carries the expected claims.
    const { payload, protectedHeader } = await jwtVerify(
      issued.accessToken,
      new Uint8Array(SIGNING_SECRET),
      { algorithms: ["HS256"], issuer: ISSUER },
    );
    expect(protectedHeader.kid).toBe("hs256-v1");
    expect(payload.sub).toBe("u-target");
    expect(payload.active_org_id).toBe("org-acme");
    expect(payload.family_id).toBe(issued.familyId);
    expect(payload.role).toBe("service");
    expect(payload.service_account).toBe(true);
    expect(payload.scope).toBe("read");
    expect(payload.issued_by).toBe("u-admin");
    expect(payload.jti).toBe(issued.jti);
  });

  it("TTL > 90 days throws TTL_EXCEEDS_MAX", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: SERVICE_TOKEN_MAX_TTL_S + 1,
        reason: "way too long pipeline",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({
      code: "TTL_EXCEEDS_MAX",
      name: "ServiceTokenValidationError",
    });
  });

  it("TTL = 0 throws INVALID_TTL", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: 0,
        reason: "zero ttl test",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TTL" });
  });

  it("TTL negative throws INVALID_TTL", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: -1,
        reason: "negative ttl",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TTL" });
  });

  it("reason < 10 chars throws REASON_TOO_SHORT", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: 3600,
        reason: "short",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "REASON_TOO_SHORT" });
  });

  it("empty reason throws REASON_TOO_SHORT", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: 3600,
        reason: "",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "REASON_TOO_SHORT" });
  });

  it("invalid scope throws INVALID_SCOPE", async () => {
    seedOrg();
    seedUser();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-acme",
        scope: "owner" as never,
        ttlSeconds: 3600,
        reason: "valid reason text",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SCOPE" });
  });

  it("USER_NOT_FOUND when target user does not exist", async () => {
    seedOrg();
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-ghost",
        targetOrgId: "org-acme",
        scope: "read",
        ttlSeconds: 3600,
        reason: "ghost user test",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it("USER_NOT_IN_ORG when target org is neither primary nor membership", async () => {
    seedOrg("org-acme");
    seedOrg("org-other", "Other");
    seedUser("u-alice", "member", "org-acme");
    await expect(
      issueServiceToken({
        db: getDb() as unknown as Database.Database,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-alice",
        targetOrgId: "org-other",
        scope: "read",
        ttlSeconds: 3600,
        reason: "cross-org attempt",
        issuedByAdminId: "u-admin",
      }),
    ).rejects.toMatchObject({ code: "USER_NOT_IN_ORG" });
  });

  it("succeeds when target org is in user_orgs (not primary)", async () => {
    seedOrg("org-acme");
    seedOrg("org-second", "Second");
    seedUser("u-alice", "member", "org-acme");
    seedUserOrgMembership("u-alice", "org-second");
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-second",
      scope: "write",
      ttlSeconds: 3600,
      reason: "second-org service",
      issuedByAdminId: "u-admin",
    });
    expect(issued.familyId).toMatch(/^service:[0-9a-f-]{36}$/);
  });

  it("inserts refresh_tokens row with parent_jti=NULL and consumer_fingerprint=NULL", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "admin",
      ttlSeconds: 86400,
      reason: "admin scope service",
      issuedByAdminId: "u-admin",
    });
    const row = getDb()
      .prepare(
        `SELECT user_id, org_id, jti, family_id, parent_jti,
                consumer_fingerprint, expires_at, last_used_at, revoked_at
         FROM refresh_tokens WHERE jti = ?`,
      )
      .get(issued.jti) as Record<string, unknown>;
    expect(row.user_id).toBe("u-alice");
    expect(row.org_id).toBe("org-acme");
    expect(row.family_id).toBe(issued.familyId);
    expect(row.parent_jti).toBeNull();
    expect(row.consumer_fingerprint).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(String(row.expires_at)).toBe(String(clock.now() + 86400));
    expect(String(row.last_used_at)).toBe(String(clock.now()));
  });

  it("TTL at exactly 90d ceiling succeeds (boundary)", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: SERVICE_TOKEN_MAX_TTL_S,
      reason: "max ttl boundary",
      issuedByAdminId: "u-admin",
    });
    expect(issued.expiresAt).toBe(clock.now() + SERVICE_TOKEN_MAX_TTL_S);
  });

  it("ServiceTokenValidationError instance carries code property", () => {
    const err = new ServiceTokenValidationError("X_CODE", "msg");
    expect(err.code).toBe("X_CODE");
    expect(err.name).toBe("ServiceTokenValidationError");
    expect(err.message).toBe("msg");
  });
});

// ===========================================================================
// listServiceTokens
// ===========================================================================
describe("listServiceTokens", () => {
  it("returns empty array when no service tokens exist", () => {
    expect(listServiceTokens(getDb() as unknown as Database.Database)).toEqual(
      [],
    );
  });

  it("lists all service tokens ordered by created_at DESC", async () => {
    seedOrg();
    seedUser();
    const a = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "first token issuance",
      issuedByAdminId: "u-admin",
    });
    // Advance the clock so created_at differs and DESC ordering is observable.
    clock.advance(2);
    const b = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "write",
      ttlSeconds: 3600,
      reason: "second token issuance",
      issuedByAdminId: "u-admin",
    });
    const rows = listServiceTokens(getDb() as unknown as Database.Database);
    expect(rows).toHaveLength(2);
    // DEFAULT CURRENT_TIMESTAMP resolution is 1s. Both rows may share the
    // same created_at -- assert membership, not strict ordering.
    const jtis = rows.map((r) => r.jti);
    expect(jtis).toContain(a.jti);
    expect(jtis).toContain(b.jti);
  });

  it("activeOnly filter excludes revoked tokens", async () => {
    seedOrg();
    seedUser();
    const active = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "active token row",
      issuedByAdminId: "u-admin",
    });
    const toRevoke = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "revoked token row",
      issuedByAdminId: "u-admin",
    });
    revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      toRevoke.jti,
      "u-admin",
    );
    const all = listServiceTokens(getDb() as unknown as Database.Database);
    expect(all).toHaveLength(2);
    const onlyActive = listServiceTokens(
      getDb() as unknown as Database.Database,
      { activeOnly: true },
    );
    expect(onlyActive).toHaveLength(1);
    expect(onlyActive[0]!.jti).toBe(active.jti);
  });

  it("userId + orgId filters work", async () => {
    seedOrg("org-a", "A");
    seedOrg("org-b", "B");
    seedUser("u-1", "member", "org-a");
    seedUser("u-2", "member", "org-b");
    await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-1",
      targetOrgId: "org-a",
      scope: "read",
      ttlSeconds: 3600,
      reason: "u-1 in org-a service",
      issuedByAdminId: "u-admin",
    });
    await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-2",
      targetOrgId: "org-b",
      scope: "read",
      ttlSeconds: 3600,
      reason: "u-2 in org-b service",
      issuedByAdminId: "u-admin",
    });
    const filteredByUser = listServiceTokens(
      getDb() as unknown as Database.Database,
      { userId: "u-1" },
    );
    expect(filteredByUser).toHaveLength(1);
    expect(filteredByUser[0]!.user_id).toBe("u-1");
    const filteredByOrg = listServiceTokens(
      getDb() as unknown as Database.Database,
      { orgId: "org-b" },
    );
    expect(filteredByOrg).toHaveLength(1);
    expect(filteredByOrg[0]!.org_id).toBe("org-b");
  });
});

// ===========================================================================
// revokeServiceToken
// ===========================================================================
describe("revokeServiceToken", () => {
  it("active service token: sets revoked_at + reason=admin, returns true", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "revoke target token",
      issuedByAdminId: "u-admin",
    });
    clock.advance(10);
    const ok = revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      issued.jti,
      "u-admin",
    );
    expect(ok).toBe(true);
    const row = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get(issued.jti) as Record<string, unknown>;
    expect(String(row.revoked_at)).toBe(String(clock.now()));
    expect(row.revoked_reason).toBe("admin");
  });

  it("non-service refresh token is NOT affected (returns false)", () => {
    seedOrg();
    seedUser();
    // Insert a regular refresh token (family_id NOT starting with "service:").
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        "row-1",
        "u-alice",
        "org-acme",
        "regular-jti",
        "fam-regular-abc",
        String(clock.now() + 3600),
        String(clock.now()),
      );
    const ok = revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      "regular-jti",
      "u-admin",
    );
    expect(ok).toBe(false);
    // Confirm row was not touched.
    const row = getDb()
      .prepare("SELECT revoked_at FROM refresh_tokens WHERE jti = ?")
      .get("regular-jti") as Record<string, unknown>;
    expect(row.revoked_at).toBeNull();
  });

  it("already-revoked token returns false (no-op)", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "double revoke target",
      issuedByAdminId: "u-admin",
    });
    const first = revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      issued.jti,
      "u-admin",
    );
    expect(first).toBe(true);
    const second = revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      issued.jti,
      "u-admin",
    );
    expect(second).toBe(false);
  });

  it("unknown jti returns false", () => {
    const ok = revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      "no-such-jti",
      "u-admin",
    );
    expect(ok).toBe(false);
  });
});

// ===========================================================================
// verifyServiceTokenJti
// ===========================================================================
describe("verifyServiceTokenJti", () => {
  it("active service jti returns true", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "verify active jti",
      issuedByAdminId: "u-admin",
    });
    expect(
      verifyServiceTokenJti(
        getDb() as unknown as Database.Database,
        issued.jti,
      ),
    ).toBe(true);
  });

  it("revoked service jti returns false", async () => {
    seedOrg();
    seedUser();
    const issued = await issueServiceToken({
      db: getDb() as unknown as Database.Database,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-alice",
      targetOrgId: "org-acme",
      scope: "read",
      ttlSeconds: 3600,
      reason: "verify revoked jti",
      issuedByAdminId: "u-admin",
    });
    revokeServiceToken(
      getDb() as unknown as Database.Database,
      clock,
      issued.jti,
      "u-admin",
    );
    expect(
      verifyServiceTokenJti(
        getDb() as unknown as Database.Database,
        issued.jti,
      ),
    ).toBe(false);
  });

  it("unknown jti returns false", () => {
    expect(
      verifyServiceTokenJti(
        getDb() as unknown as Database.Database,
        "no-such-jti",
      ),
    ).toBe(false);
  });

  it("non-service jti (regular refresh) returns false (LIKE 'service:%' filters)", () => {
    seedOrg();
    seedUser();
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        "row-2",
        "u-alice",
        "org-acme",
        "regular-jti-2",
        "fam-not-service",
        String(clock.now() + 3600),
        String(clock.now()),
      );
    expect(
      verifyServiceTokenJti(
        getDb() as unknown as Database.Database,
        "regular-jti-2",
      ),
    ).toBe(false);
  });
});

// ===========================================================================
// POST /api/admin/service-tokens
// ===========================================================================
describe("handleIssueServiceToken", () => {
  it("unauthenticated -> 401 UNAUTHORIZED", async () => {
    const req = mockRequest({ body: "{}" });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("auth failure with no WWW-Authenticate header (covers wwwAuthenticate ?? branch)", async () => {
    // Revoked-agent path returns 403 without a wwwAuthenticate header.
    seedOrg();
    seedUser("u-revoked", "admin", "org-acme");
    getDb()
      .prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)")
      .run("u-revoked", "tester");
    const token = await createToken("u-revoked", "admin", undefined, {
      user_id: "u-revoked",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: "{}",
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(403);
    expect(res.headers["WWW-Authenticate"]).toBeUndefined();
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  it("non-admin role -> 403 FORBIDDEN", async () => {
    seedOrg();
    seedUser("u-member", "member", "org-acme");
    const token = await createToken("u-member", "member", undefined, {
      user_id: "u-member",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: "{}",
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("FORBIDDEN");
  });

  it("admin + valid body -> 200 + jti/access_token/expires_at + Tier 1 audit", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    seedUser("u-target", "member", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const reqBody = JSON.stringify({
      user_id: "u-target",
      org_id: "org-acme",
      scope: "read",
      ttl: "30d",
      reason: "CI pipeline service token",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: reqBody,
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(body.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.expires_at).toBe("string");
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(0);

    const auditRows = findAuditRows("auth.service_token.issued");
    expect(auditRows).toHaveLength(1);
    const meta = JSON.parse(auditRows[0]!.metadata_json as string);
    expect(meta.issued_by).toBe("u-admin");
    expect(meta.target_user_id).toBe("u-target");
    expect(meta.scope).toBe("read");
    expect(meta.ttl_seconds).toBe(30 * 86400);
    expect(meta.reason).toBe("CI pipeline service token");
  });

  it("missing required field -> 400 INVALID_REQUEST", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: JSON.stringify({ user_id: "u-target" }),
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("malformed JSON body -> 400 INVALID_REQUEST", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: "{not json",
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("body too large (>4KB) -> 400 INVALID_REQUEST", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const huge = "x".repeat(5000);
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: huge,
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_REQUEST");
  });

  it("invalid TTL format -> 400 INVALID_TTL", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    seedUser("u-target", "member", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: JSON.stringify({
        user_id: "u-target",
        org_id: "org-acme",
        scope: "read",
        ttl: "thirty-days",
        reason: "bad TTL format",
      }),
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("INVALID_TTL");
  });

  it("ServiceTokenValidationError surfaces as 400 with original code", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    // No target user seeded -> issueServiceToken throws USER_NOT_FOUND.
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: JSON.stringify({
        user_id: "u-ghost",
        org_id: "org-acme",
        scope: "read",
        ttl: "1d",
        reason: "ghost user service",
      }),
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("USER_NOT_FOUND");
  });

  it("TTL parsing supports s/m/h/d units", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    seedUser("u-target", "member", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    for (const [unit, sec] of [
      ["60s", 60],
      ["5m", 300],
      ["2h", 7200],
      ["1d", 86400],
    ] as const) {
      getDb().exec("DELETE FROM refresh_tokens");
      getDb().exec("DELETE FROM audit_log");
      const req = mockRequest({
        authorization: `Bearer ${token}`,
        body: JSON.stringify({
          user_id: "u-target",
          org_id: "org-acme",
          scope: "read",
          ttl: unit,
          reason: `unit test for ${unit}`,
        }),
      });
      const res = mockResponse();
      await handleIssueServiceToken(
        req,
        res as unknown as ServerResponse,
        makeCtx(),
      );
      expect(res.statusCode).toBe(200);
      const auditRows = findAuditRows("auth.service_token.issued");
      const meta = JSON.parse(auditRows[0]!.metadata_json as string);
      expect(meta.ttl_seconds).toBe(sec);
    }
  });

  it("strips trailing slash from publicUrl when building issuer", async () => {
    seedOrg("org-acme");
    seedUser("u-admin", "admin", "org-acme");
    seedUser("u-target", "member", "org-acme");
    const token = await createToken("u-admin", "admin", undefined, {
      user_id: "u-admin",
      org: "org-acme",
    });
    const req = mockRequest({
      authorization: `Bearer ${token}`,
      body: JSON.stringify({
        user_id: "u-target",
        org_id: "org-acme",
        scope: "write",
        ttl: "1h",
        reason: "issuer slash trim test",
      }),
    });
    const res = mockResponse();
    await handleIssueServiceToken(
      req,
      res as unknown as ServerResponse,
      makeCtx({ publicUrl: `${ISSUER}/` }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const { payload } = await jwtVerify(
      body.access_token,
      new Uint8Array(SIGNING_SECRET),
      { algorithms: ["HS256"], issuer: ISSUER },
    );
    expect(payload.iss).toBe(ISSUER);
  });
});
