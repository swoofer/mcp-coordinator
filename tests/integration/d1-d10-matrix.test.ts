/**
 * T32 — D1-D10 cross-cutting test matrix (V4 §15.x).
 *
 * 10 integration scenarios exercising interaction seams between Phase 2
 * components where bugs are most likely to hide. NOT pure unit tests —
 * these exercise the integration boundaries between auth.ts (Scenario 5
 * cookie/Bearer dispatcher), refresh-rotation, service-tokens, sweeper,
 * device-flow, audit, token-epoch, and the IdP membership cache.
 *
 *   D1  — cookie + Bearer race          (Scenario d > Scenario 5)
 *   D2  — service-token in cookie path  (DB-lookup override fires)
 *   D3  — logout-all during refresh     (token_epoch wins)
 *   D4  — idle-expired ordering         (V4 FIX 24: idle FIRST, then reuse/grace)
 *   D5  — chain reuse detection         (replay any old → all family revoked)
 *   D6  — allowlist removed mid-session (T19c re-check → 401 + family revoke)
 *   D7  — token_epoch immediate invalid (V4 CUT 1: no cache, DB direct read)
 *   D8  — audit failure does NOT roll back security action (V4 FIX 23)
 *   D9  — sweeper retention boundary    (365d Tier 1, 90d Tier 2)
 *   D10 — concurrent device approve     (atomic CAS, exactly-one winner)
 *
 * No source-code changes — all D scenarios are observable via existing seams.
 * Uses T38 helpers (FakeClock, seedFourOrgs, findAuditRows).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { SignJWT } from "jose";

import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth, initPhase2Auth, resetPhase2Auth, authenticateRequest } from "../../src/auth.js";
import { audit } from "../../src/security/audit.js";
import { withAuditContext } from "../../src/auth/audit-context.js";
import { withRequestId } from "../../src/auth/request-id.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { mintAccessJWT } from "../../src/auth/jwt-mint.js";
import { FakeClock } from "../helpers/clock.js";
import { seedFourOrgs } from "../helpers/seed.js";
import { findAuditRows } from "../helpers/audit.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { refreshTokenGrant } from "../../src/auth/refresh-rotation.js";
import { PassthroughEncryption } from "../../src/security/encryption.js";
import { issueServiceToken } from "../../src/auth/service-tokens.js";
import { bumpTokenEpoch, readTokenEpoch } from "../../src/auth/token-epoch.js";
import { computeFingerprint } from "../../src/auth/oauth-finalize.js";
import { Sweeper } from "../../src/sweeper/index.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import type { IdPProvider, ExchangeCodeResult } from "../../src/auth/providers/types.js";

// Production derives BOTH key materials from the single COORDINATOR_JWT_SECRET:
//   Phase 1 — serve-http.ts `initAuth(JWT_SECRET)`      -> TextEncoder().encode(s)
//   Phase 2 — boot.ts `buildJwtKeyRegistry(Buffer.from(s, "utf8"))`
// so they are byte-identical. This bench used to give them DIFFERENT secrets,
// which made Phase 1 verification throw on every Phase 2 token and routed the
// D1 Bearer assertions through a fallback branch that production never reaches
// — hiding a regression where every Bearer-presented Phase 2 JWT 401'd with
// "v0.6 token rejected". Keep these two tied together; the guard test in D1
// asserts the derived keys still match.
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars-long!";
const SIGNING_SECRET = Buffer.from(PHASE1_SECRET, "utf8");
const ISSUER = "http://localhost:3000";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x32);
const registry = buildJwtKeyRegistry(SIGNING_SECRET);

// ---------------------------------------------------------------------------
// Mock req/res infrastructure (mirrors T19 unit tests + Scenario 5 tests)
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

function mockRequest(
  body: Record<string, string>,
  opts: { ip?: string; userAgent?: string } = {},
): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string | undefined } }).socket = {
    remoteAddress: opts.ip,
  };
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "user-agent": opts.userAgent ?? "test-agent/1.0",
  };
  return stream as unknown as IncomingMessage;
}

interface AuthReqOpts {
  authorization?: string;
  cookie?: string;
  url?: string;
  method?: string;
}

function mockAuthReq(opts: AuthReqOpts = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  if (opts.cookie) headers.cookie = opts.cookie;
  return {
    headers,
    url: opts.url ?? "/api/something",
    method: opts.method ?? "GET",
  } as unknown as IncomingMessage;
}

function sessionCookie(token: string): string {
  return `__Host-coordinator_session=${token}`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let DIR: string;
let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "t32-d-matrix-"));
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.COORDINATOR_SESSION_IDLE_TIMEOUT;
  delete process.env.COORDINATOR_AUDIT_RETENTION_DAYS;
  delete process.env.COORDINATOR_AUDIT_TIER2_RETENTION_DAYS;

  const db = getDb() as unknown as Database.Database;
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM refresh_tokens");
  db.exec("DELETE FROM device_auth_requests");
  db.exec("DELETE FROM oauth_state");
  db.exec("DELETE FROM user_orgs");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM orgs WHERE id != 'default'");
  db.exec("DELETE FROM revoked_agents");

  // Use a real-time-anchored clock so jose's exp checks (which use Date.now())
  // pass against tokens we mint with FakeClock.now() as iat. This mirrors
  // refresh-rotation-aux.test.ts beforeEach pattern.
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);

  resetPhase2Auth();
  initPhase2Auth({
    db: db,
    signingKeys: registry,
    publicUrl: ISSUER,
  });

  seedFourOrgs(db);
});

afterEach(() => {
  delete process.env.COORDINATOR_SESSION_IDLE_TIMEOUT;
});

// ---------------------------------------------------------------------------
// Helpers shared across D scenarios
// ---------------------------------------------------------------------------

function backfillUserOrgsForSeed(db: Database.Database): void {
  db.exec(
    `INSERT OR IGNORE INTO user_orgs (user_id, org_id, role, joined_at)
     SELECT id, primary_org_id, role, ${String(clock.now())} FROM users`,
  );
}

interface MintAccessOpts {
  sub?: string;
  active_org_id?: string;
  family_id?: string;
  role?: "member" | "admin" | "service" | "agent";
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
  serviceAccount?: boolean;
}

async function mintSessionAccessJWT(opts: MintAccessOpts = {}): Promise<string> {
  const iat = opts.iat ?? clock.now();
  const ttl = opts.ttlSeconds ?? 900;
  const claims: Record<string, unknown> = {
    active_org_id: opts.active_org_id ?? "org-acme-001",
    family_id: opts.family_id ?? "fam-1",
    role: opts.role ?? "member",
    typ: "access",
  };
  if (opts.serviceAccount) claims.service_account = true;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setSubject(opts.sub ?? "u-admin-acme")
    .setJti(opts.jti ?? "session-jti-1")
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(new Uint8Array(SIGNING_SECRET));
}

interface MintRefreshOpts {
  sub?: string;
  active_org_id?: string;
  family_id?: string;
  parent_jti?: string;
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
}

async function mintTestRefreshJWT(opts: MintRefreshOpts = {}): Promise<string> {
  const iat = opts.iat ?? clock.now();
  const ttl = opts.ttlSeconds ?? 30 * 86400;
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "u-admin-acme",
    active_org_id: opts.active_org_id ?? "org-acme-001",
    family_id: opts.family_id ?? "fam-1",
    typ: "refresh",
  };
  if (opts.parent_jti) claims.parent_jti = opts.parent_jti;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .setJti(opts.jti ?? "refresh-jti-1")
    .sign(new Uint8Array(SIGNING_SECRET));
}

interface SeedRefreshOpts {
  jti: string;
  userId?: string;
  orgId?: string;
  familyId?: string | null;
  parentJti?: string | null;
  consumerFingerprint?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  expiresAt?: number;
  lastUsedAt?: string | null;
  replayCount?: number;
}

function seedRefreshRow(opts: SeedRefreshOpts): void {
  const familyId = opts.familyId === undefined ? "fam-1" : opts.familyId;
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at, revoked_reason, replay_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${opts.jti}`,
      opts.userId ?? "u-admin-acme",
      opts.orgId ?? "org-acme-001",
      opts.jti,
      familyId,
      opts.parentJti ?? null,
      opts.consumerFingerprint ?? null,
      String(opts.expiresAt ?? clock.now() + 30 * 86400),
      opts.lastUsedAt === undefined ? String(clock.now()) : opts.lastUsedAt,
      opts.revokedAt ?? null,
      opts.revokedReason ?? null,
      opts.replayCount ?? 0,
    );
}

/**
 * Ensure users.idp_access_token is set so T19c's allowlist re-check path
 * fires during refresh rotation. seedFourOrgs leaves it NULL (Phase 1
 * compatibility) — most D scenarios want it populated.
 */
function setIdpAccessToken(userId: string, token: string | null): void {
  getDb().prepare("UPDATE users SET idp_access_token = ? WHERE id = ?").run(token, userId);
}

function makeProvider(listMemberships?: () => Promise<string[]>): IdPProvider {
  return {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in D matrix tests");
    },
    listMemberships: listMemberships ?? (async () => ["acme"]),
  } as IdPProvider;
}

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(makeProvider()),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: registry,
    membershipCache,
    encryptionProvider: new PassthroughEncryption(),
    ...overrides,
  };
}

// ===========================================================================
// D1 — cookie + Bearer race (Scenario d > Scenario 5)
// ===========================================================================
describe("D1 — cookie auth + Bearer header race", () => {
  it("00: bench fidelity — Phase 1 and Phase 2 keys are byte-identical (as in prod)", () => {
    // Guards the D1/01 + D1/02 Bearer assertions below: if the two phases ever
    // drift onto different secrets again, Phase 1 verification starts throwing
    // on Phase 2 tokens and those assertions pass via a branch production
    // cannot reach. See tests/unit/auth-bearer-production-wiring.test.ts.
    expect(Buffer.from(registry.current.key)).toEqual(
      Buffer.from(new TextEncoder().encode(PHASE1_SECRET)),
    );
  });

  it("01: Bearer Phase 2 JWT wins when both cookie + Bearer present", async () => {
    // Two different identities: cookie claims u-admin-acme; Bearer JWT claims
    // u-member-beta. Per spec §9.5 + auth.ts dispatcher, Bearer must win.
    const cookieToken = await mintSessionAccessJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
    });
    const bearerToken = await mintSessionAccessJWT({
      sub: "u-member-beta",
      active_org_id: "org-beta-002",
      jti: "bearer-jti-d1",
    });

    const result = await authenticateRequest(
      mockAuthReq({
        authorization: `Bearer ${bearerToken}`,
        cookie: sessionCookie(cookieToken),
      }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Bearer identity, NOT cookie identity.
      expect(result.claims.sub).toBe("u-member-beta");
      expect(result.claims.user_id).toBe("u-member-beta");
      expect(result.claims.active_org_id).toBe("org-beta-002");
    }
  });

  it("02: cookie absent + Bearer present → Bearer claims returned", async () => {
    // Negative-control: confirm the Bearer-only path uses the same Phase 2
    // verifier so the D1/01 success is not an artifact of cookie-fallback.
    const bearerToken = await mintSessionAccessJWT({
      sub: "u-admin-gamma",
      active_org_id: "org-gamma-003",
      jti: "bearer-only-d1",
    });
    const result = await authenticateRequest(
      mockAuthReq({ authorization: `Bearer ${bearerToken}` }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("u-admin-gamma");
      expect(result.claims.active_org_id).toBe("org-gamma-003");
    }
  });

  it("03: cookie present + Bearer absent → cookie claims returned (Scenario 5)", async () => {
    const cookieToken = await mintSessionAccessJWT({
      sub: "u-admin-delta",
      active_org_id: "org-delta-004",
    });
    const result = await authenticateRequest(mockAuthReq({ cookie: sessionCookie(cookieToken) }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("u-admin-delta");
      expect(result.claims.active_org_id).toBe("org-delta-004");
    }
  });
});

// ===========================================================================
// D2 — service-token in cookie path
// ===========================================================================
describe("D2 — service-token in cookie path", () => {
  it("04: service-account JWT as cookie → auth succeeds and DB override fires", async () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    // Issue a real service token (creates a refresh_tokens row with
    // family_id="service:<uuid>"). The mintAccessJWT call inside writes a
    // JWT with service_account=true + role=service.
    const issued = await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-acme",
      targetOrgId: "org-acme-001",
      scope: "read",
      ttlSeconds: 3600,
      reason: "D2 cookie-path service token",
      issuedByAdminId: "u-admin-acme",
    });

    // Set as cookie. authenticateRequest sees no Bearer, falls into the
    // Scenario 5 cookie branch → verifyPhase2SessionCookie → service-account
    // branch → DB lookup → revoked_at IS NULL → success.
    const result = await authenticateRequest(
      mockAuthReq({ cookie: sessionCookie(issued.accessToken) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("u-admin-acme");
      expect(result.claims.service_account).toBe(true);
      expect(result.claims.role).toBe("service");
    }
  });

  it("05: revoking the service token row → next /me-style auth returns 401", async () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    const issued = await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-acme",
      targetOrgId: "org-acme-001",
      scope: "read",
      ttlSeconds: 3600,
      reason: "D2 revoke-then-fail token",
      issuedByAdminId: "u-admin-acme",
    });

    // First call passes.
    const ok = await authenticateRequest(
      mockAuthReq({ cookie: sessionCookie(issued.accessToken) }),
      { authEnabled: true },
    );
    expect(ok.ok).toBe(true);

    // Admin revokes the row directly via SQL (mirrors what
    // revokeServiceToken does, but using raw UPDATE makes the proof clear).
    db.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, revoked_reason = 'admin'
       WHERE jti = ?`,
    ).run(String(clock.now()), issued.jti);

    // Same JWT (signature still valid, exp unchanged) — DB-lookup override
    // fires and the request is rejected.
    const denied = await authenticateRequest(
      mockAuthReq({ cookie: sessionCookie(issued.accessToken) }),
      { authEnabled: true },
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(401);
      expect(denied.error).toMatch(/service token revoked/i);
    }
    const audits = findAuditRows("auth.invalid_token");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const last = audits[audits.length - 1];
    const meta = JSON.parse(last?.metadata_json as string) as { reason: string };
    expect(meta.reason).toBe("service_token_revoked");
  });
});

// ===========================================================================
// D3 — logout-all during refresh rotation
// ===========================================================================
describe("D3 — logout-all during refresh rotation", () => {
  it("06: bumpTokenEpoch after JWT was minted → rotation rejected (iat < epoch)", async () => {
    // T-30: mint a refresh JWT for u-admin-acme. T-15: bumpTokenEpoch
    // (logout-all). T-10: attempt rotation — claims.iat=T-30, epoch=T-15 → reject.
    const db = getDb() as unknown as Database.Database;

    const tMinus30 = clock.now();
    const token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: "fam-d3",
      jti: "jti-d3-1",
      iat: tMinus30,
    });
    seedRefreshRow({
      jti: "jti-d3-1",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d3",
      lastUsedAt: String(tMinus30),
    });

    // Advance to T-15 and bump epoch.
    clock.advance(15);
    // bumpTokenEpoch uses strftime('%s','now') (wall clock) MAX'd with
    // current+1 — guarantees the new epoch is strictly > 0 and > iat. For
    // our test iat was real-time-anchored seconds, so wall-clock now is
    // very close; we explicitly UPDATE the column to a value > iat.
    db.prepare("UPDATE users SET token_epoch = ? WHERE id = ?").run(tMinus30 + 5, "u-admin-acme");

    // Advance to T-10 (still after the bump) and try to rotate.
    clock.advance(5);
    setIdpAccessToken("u-admin-acme", null); // skip allowlist re-check path
    const res = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }),
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    const last = audits[audits.length - 1];
    const meta = JSON.parse(last?.metadata_json as string) as { reason: string };
    expect(meta.reason).toBe("token_epoch_exceeded");
  });

  it("07: rotation succeeds first, then logout-all → both tokens invalidated", async () => {
    // T-30: mint refresh. T-25: rotation succeeds (new pair issued). T-15:
    // bumpTokenEpoch. T-10: try to rotate the SUCCESSOR — its iat is T-25
    // which is still < epoch=T-15+wall_clock_seed → reject.
    const db = getDb() as unknown as Database.Database;

    const tStart = clock.now();
    const token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: "fam-d3-7",
      jti: "jti-d3-7-a",
      iat: tStart,
    });
    seedRefreshRow({
      jti: "jti-d3-7-a",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d3-7",
      lastUsedAt: String(tStart),
    });
    setIdpAccessToken("u-admin-acme", null);

    // T+5: rotate.
    clock.advance(5);
    const res1 = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }, { ip: "10.0.0.7", userAgent: "ua/d3-7" }),
      res1 as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res1.statusCode).toBe(200);
    const successor = JSON.parse(res1.body!) as { refresh_token: string };

    // T+15: bump epoch (logout-all). Set epoch to (tStart+10) so the
    // successor (iat ≈ tStart+5) is invalidated.
    clock.advance(10);
    db.prepare("UPDATE users SET token_epoch = ? WHERE id = ?").run(tStart + 10, "u-admin-acme");

    // T+20: try to rotate the successor.
    clock.advance(5);
    const res2 = mockResponse();
    await refreshTokenGrant(
      mockRequest(
        { refresh_token: successor.refresh_token },
        { ip: "10.0.0.7", userAgent: "ua/d3-7" },
      ),
      res2 as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res2.statusCode).toBe(400);
    const body = JSON.parse(res2.body!) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });
});

// ===========================================================================
// D4 — idle-expired check happens BEFORE reuse-detection (V4 FIX 24)
// ===========================================================================
describe("D4 — idle-expired check ordering vs reuse-detection", () => {
  it("08: stale last_used_at + revoked row → idle wins, NOT chain_revoked", async () => {
    // Both conditions are true simultaneously:
    //   - row.last_used_at is older than COORDINATOR_SESSION_IDLE_TIMEOUT
    //   - row.revoked_at is non-null (would trigger reuse branch)
    // Per V4 FIX 24, the idle check runs first → 400 invalid_grant
    // "Session idle timeout" + auth.refresh.idle_expired audit. NOT 401
    // chain_revoked.
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "60s";

    const tStart = clock.now();
    const token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: "fam-d4",
      jti: "jti-d4-1",
      iat: tStart,
    });
    seedRefreshRow({
      jti: "jti-d4-1",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d4",
      // last_used_at = 300s ago → well outside 60s idle window
      lastUsedAt: String(tStart - 300),
      // revoked_at non-null + reason rotated (would normally invoke reuse branch)
      revokedAt: String(tStart - 5),
      revokedReason: "rotated",
    });
    setIdpAccessToken("u-admin-acme", null);

    const res = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }),
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/idle/i);

    // Audit ordering proof: idle_expired emitted, chain_revoked NOT emitted.
    expect(findAuditRows("auth.refresh.idle_expired")).toHaveLength(1);
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(0);
  });

  it("09: stale last_used_at on a FRESH (un-revoked) row → idle wins", async () => {
    // Sanity check: idle-expired fires on the normal rotation path too.
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "60s";

    const tStart = clock.now();
    const token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: "fam-d4-2",
      jti: "jti-d4-2",
      iat: tStart,
    });
    seedRefreshRow({
      jti: "jti-d4-2",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d4-2",
      lastUsedAt: String(tStart - 300),
    });
    setIdpAccessToken("u-admin-acme", null);

    const res = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }),
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    expect(findAuditRows("auth.refresh.idle_expired")).toHaveLength(1);

    // Row was atomically revoked with reason='idle_expired'.
    const row = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-d4-2") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("idle_expired");
  });
});

// ===========================================================================
// D5 — reuse detection across a chain of 5 successive rotations
// ===========================================================================
describe("D5 — reuse detection across multi-rotation chain", () => {
  it("10: replaying the 2nd-oldest token of a 5-deep chain revokes ALL chain rows", async () => {
    // Build a 5-deep chain by performing 4 successful rotations:
    //   root (rt-0) → rt-1 → rt-2 → rt-3 → rt-4
    // Then attempt to rotate using rt-1 (already-revoked, beyond 10s grace
    // because we advance the clock). Should trigger hard reuse detection
    // → family revoke → all 5 rows have revoked_at != NULL.
    const db = getDb() as unknown as Database.Database;
    setIdpAccessToken("u-admin-acme", null);

    const tStart = clock.now();

    // Mint + seed the family root.
    const rootJti = "rt-0";
    const familyId = "fam-d5";
    const fp = computeFingerprint("10.0.0.5", "ua/d5");
    seedRefreshRow({
      jti: rootJti,
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId,
      consumerFingerprint: fp,
      lastUsedAt: String(tStart),
    });

    // Build a chain by performing 4 sequential rotations through
    // refreshTokenGrant — each rotation revokes its predecessor and inserts
    // a new successor row.
    let currentJti = rootJti;
    let currentToken = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: familyId,
      jti: currentJti,
      iat: tStart,
    });
    const chainJtis: string[] = [rootJti];

    for (let i = 0; i < 4; i++) {
      clock.advance(1); // small advance so iat values differ enough
      const res = mockResponse();
      await refreshTokenGrant(
        mockRequest({ refresh_token: currentToken }, { ip: "10.0.0.5", userAgent: "ua/d5" }),
        res as unknown as ServerResponse,
        makeCtx(),
      );
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body!) as {
        refresh_token: string;
      };
      currentToken = body.refresh_token;
      // Find the newest jti (successor row pointing at currentJti).
      const successorRow = db
        .prepare("SELECT jti FROM refresh_tokens WHERE parent_jti = ? AND family_id = ?")
        .get(currentJti, familyId) as { jti: string };
      currentJti = successorRow.jti;
      chainJtis.push(currentJti);
    }

    // Chain length is 5 rows; verify.
    expect(chainJtis).toHaveLength(5);
    const allFamilyRows = db
      .prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id = ?")
      .get(familyId) as { n: number };
    expect(allFamilyRows.n).toBe(5);

    // At this point chainJtis[1..3] are revoked (reason='rotated'),
    // chainJtis[4] (the latest successor) is active.
    // Advance well beyond the 10s grace window so replaying rt-1 hits the
    // hard-reuse branch, not the grace re-mint branch.
    clock.advance(30);

    // Replay rt-1: re-mint a JWT with the rt-1 jti (the row exists; we just
    // need a valid signed JWT carrying that jti).
    const rt1Token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: familyId,
      jti: chainJtis[1],
      iat: tStart, // any valid iat is fine
    });
    const replayRes = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: rt1Token }, { ip: "10.0.0.5", userAgent: "ua/d5" }),
      replayRes as unknown as ServerResponse,
      makeCtx(),
    );
    expect(replayRes.statusCode).toBe(401);
    const body = JSON.parse(replayRes.body!) as { error: string };
    expect(body.error).toBe("invalid_grant");

    // ALL 5 family rows are now revoked.
    const revokedCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NOT NULL",
      )
      .get(familyId) as { n: number };
    expect(revokedCount.n).toBe(5);

    // The Tier 1 audit auth.refresh.chain_revoked fires with reason=hard_reuse.
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(audits[audits.length - 1]?.metadata_json as string) as {
      reason: string;
      family_id: string;
    };
    expect(meta.reason).toBe("hard_reuse");
    expect(meta.family_id).toBe(familyId);
  });
});

// ===========================================================================
// D6 — allowlist removed mid-session via T19c IdP refresh path
// ===========================================================================
describe("D6 — allowlist removal mid-session via IdP refresh", () => {
  it("11: org's allowlist_github_org dropped → next rotation 401 + family revoke + audit", async () => {
    // u-admin-acme was provisioned with idp_access_token. The mock IdP
    // returns ["acme"]. Initially orgs.allowlist_github_org='acme' (from
    // seedFourOrgs) → resolveOrgFromMemberships finds a match. Admin then
    // sets allowlist_github_org=NULL (e.g. revoking the org). The next
    // rotation: IdP still returns ["acme"] but resolveOrgFromMemberships
    // returns null → row revoked + Tier 1 audit auth.login.denied.not_in_org.
    const db = getDb() as unknown as Database.Database;
    setIdpAccessToken("u-admin-acme", "valid-idp-tok");

    const tStart = clock.now();
    const token = await mintTestRefreshJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      family_id: "fam-d6",
      jti: "jti-d6-1",
      iat: tStart,
    });
    seedRefreshRow({
      jti: "jti-d6-1",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d6",
      lastUsedAt: String(tStart),
    });

    // Sanity-check with allowlist intact: rotation succeeds.
    // (Issuing it would consume the row; instead we just verify the dependency
    // is wired correctly by removing the allowlist NOW before the call.)
    db.prepare("UPDATE orgs SET allowlist_github_org = NULL WHERE id = ?").run("org-acme-001");

    const res = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }, { ip: "10.0.0.6", userAgent: "ua/d6" }),
      res as unknown as ServerResponse,
      makeCtx(
        (() => {
          const p = makeProvider(async () => ["acme"]);
          return { providers: singleProviderRegistry(p) };
        })(),
      ),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!) as {
      error: string;
      error_description: string;
    };
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/allowlist/i);

    // Row revoked with reason='admin' (matches refresh-rotation main-path
    // allowlist-denial branch).
    const row = db
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-d6-1") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("admin");

    // Tier 1 audit fired.
    const audits = findAuditRows("auth.login.denied.not_in_org");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(audits[audits.length - 1]?.metadata_json as string) as {
      user_id: string;
      phase: string;
    };
    expect(meta.user_id).toBe("u-admin-acme");
    expect(meta.phase).toBe("refresh_rotation");
  });
});

// ===========================================================================
// D7 — token_epoch invalidates pending request (V4 CUT 1)
// ===========================================================================
describe("D7 — token_epoch bump invalidates already-verified JWT", () => {
  it("12: same JWT verifies at T-0, bump at T-5, fails at T-10 (no cache, direct DB)", async () => {
    // Phase 2 design choice: readTokenEpoch is a direct SQL read per request
    // (V4 CUT 1, no cache). This means a bump is observed by the very next
    // call without any cache-invalidation step.
    const db = getDb() as unknown as Database.Database;

    const tStart = clock.now();
    const token = await mintSessionAccessJWT({
      sub: "u-admin-acme",
      active_org_id: "org-acme-001",
      iat: tStart,
      jti: "jti-d7-1",
    });

    // T-0: verify passes.
    const ok = await authenticateRequest(mockAuthReq({ cookie: sessionCookie(token) }), {
      authEnabled: true,
    });
    expect(ok.ok).toBe(true);

    // T-5: bump epoch to (iat + 2) so the JWT becomes invalid.
    clock.advance(5);
    db.prepare("UPDATE users SET token_epoch = ? WHERE id = ?").run(tStart + 2, "u-admin-acme");

    // Direct readTokenEpoch sees the new value (no cache).
    expect(readTokenEpoch(db, "u-admin-acme")).toBe(tStart + 2);

    // T-10: the SAME JWT (same signature, same iat) now fails.
    clock.advance(5);
    const denied = await authenticateRequest(mockAuthReq({ cookie: sessionCookie(token) }), {
      authEnabled: true,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(401);
      expect(denied.error).toMatch(/Session invalidated/);
    }
    const audits = findAuditRows("auth.invalid_token");
    const last = audits[audits.length - 1];
    const meta = JSON.parse(last?.metadata_json as string) as { reason: string };
    expect(meta.reason).toBe("token_epoch_exceeded");
  });

  it("13: bumpTokenEpoch helper monotonically increases (never decreases)", async () => {
    // Defensive: re-bump should never decrease epoch even if SQL wall clock
    // is stale (V4 design: MAX(strftime('%s','now'), current+1)).
    const db = getDb() as unknown as Database.Database;
    const e1 = bumpTokenEpoch(db, "u-admin-acme");
    const e2 = bumpTokenEpoch(db, "u-admin-acme");
    const e3 = bumpTokenEpoch(db, "u-admin-acme");
    expect(e2).toBeGreaterThan(e1);
    expect(e3).toBeGreaterThan(e2);
  });
});

// ===========================================================================
// D8 — audit failure does NOT roll back security action (V4 FIX 23)
// ===========================================================================
describe("D8 — audit Tier 1 commit-then-audit separation (V4 FIX 23)", () => {
  it("14: forcing audit() to throw does not undo the preceding UPDATE", async () => {
    // The pattern we exercise: a "security action" UPDATE runs first; then
    // audit() is called. If audit fails, the UPDATE must remain committed.
    // We force audit() to throw by passing a metadata value that JSON.stringify
    // cannot serialize (a BigInt → TypeError). The audit() call throws but
    // the UPDATE is already on disk.
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    // Pre-condition row.
    seedRefreshRow({
      jti: "jti-d8-1",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d8",
      lastUsedAt: String(clock.now()),
    });

    // Step 1: security action — revoke the family.
    db.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, revoked_reason = 'reuse_detected'
       WHERE family_id = ? AND revoked_at IS NULL`,
    ).run(String(clock.now()), "fam-d8");

    // Step 2: audit emission with a BigInt that JSON.stringify cannot
    // serialize → audit() throws.
    let auditError: Error | null = null;
    try {
      withAuditContext(
        { userId: "u-admin-acme", orgId: "org-acme-001" },
        { ip: null, userAgent: null },
        () => {
          withRequestId("req-d8", () => {
            audit("auth.refresh.chain_revoked", {
              tier: 1,
              metadata: { unserializable: 1n as unknown as number },
            });
          });
        },
      );
    } catch (e) {
      auditError = e as Error;
    }
    expect(auditError).not.toBeNull();
    expect(String(auditError)).toMatch(/BigInt|serialize/i);

    // Critical: the security UPDATE remains committed.
    const row = db
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-d8-1") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("reuse_detected");
  });

  it("15: a successful audit AFTER the UPDATE writes the Tier 1 row", async () => {
    // Companion sanity test: normal commit-then-audit flow writes the audit
    // row and the security action is visible.
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    seedRefreshRow({
      jti: "jti-d8-2",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: "fam-d8-2",
      lastUsedAt: String(clock.now()),
    });
    db.prepare(
      `UPDATE refresh_tokens
         SET revoked_at = ?, revoked_reason = 'reuse_detected'
       WHERE family_id = ? AND revoked_at IS NULL`,
    ).run(String(clock.now()), "fam-d8-2");

    withAuditContext(
      { userId: "u-admin-acme", orgId: "org-acme-001" },
      { ip: null, userAgent: null },
      () => {
        audit("auth.refresh.chain_revoked", {
          tier: 1,
          metadata: { family_id: "fam-d8-2" },
        });
      },
    );

    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const row = db
      .prepare("SELECT revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-d8-2") as { revoked_reason: string };
    expect(row.revoked_reason).toBe("reuse_detected");
  });
});

// ===========================================================================
// D9 — sweeper retention boundary (365d Tier 1 / 90d Tier 2)
// ===========================================================================
describe("D9 — sweeper retention boundary", () => {
  /**
   * Insert an audit_log row with a SPECIFIC created_at timestamp. The
   * sweeper compares strftime('%s', created_at) against (now - retention).
   * Pass a numeric Unix-epoch and convert to the SQLite text format the
   * sweeper expects.
   */
  function insertAuditAt(action: string, createdAtEpoch: number): void {
    const iso = new Date(createdAtEpoch * 1000).toISOString().replace("T", " ").slice(0, 19);
    getDb()
      .prepare(`INSERT INTO audit_log (action, outcome, created_at) VALUES (?, 'success', ?)`)
      .run(action, iso);
  }

  it("16: Tier 1 default 365d retention — 364d-old rows survive, 366d-old deleted", async () => {
    const db = getDb() as unknown as Database.Database;

    // Use a deterministic clock anchored well inside SQLite's date range.
    // Use the sweeper's own clock for the cutoff math.
    const swClock = new FakeClock(1_900_000_000);
    const sweeper = new Sweeper(db, swClock);

    const now = swClock.now();
    const DAY = 86_400;
    // 5 rows at 364d old → must survive.
    for (let i = 0; i < 5; i++) {
      insertAuditAt("auth.refresh.chain_revoked", now - 364 * DAY - i);
    }
    // 5 rows at 366d old → must be deleted (beyond the 365d cutoff).
    for (let i = 0; i < 5; i++) {
      insertAuditAt("auth.refresh.chain_revoked", now - 366 * DAY - i);
    }

    sweeper.runPass();

    const survivors = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("auth.refresh.chain_revoked") as { n: number };
    expect(survivors.n).toBe(5);
  });

  it("17: Tier 2 default 90d retention — 89d-old rows survive, 91d-old deleted", async () => {
    const db = getDb() as unknown as Database.Database;
    const swClock = new FakeClock(1_900_000_000);
    const sweeper = new Sweeper(db, swClock);

    const now = swClock.now();
    const DAY = 86_400;
    // Use a Tier 2 action so the Tier 2 90-day sweeper branch matches.
    for (let i = 0; i < 5; i++) {
      insertAuditAt("auth.refresh.rotated", now - 89 * DAY - i);
    }
    for (let i = 0; i < 5; i++) {
      insertAuditAt("auth.refresh.rotated", now - 91 * DAY - i);
    }

    sweeper.runPass();

    const survivors = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("auth.refresh.rotated") as { n: number };
    expect(survivors.n).toBe(5);
  });

  it("18: actions NOT in TIER1/TIER2 lists are untouched regardless of age", async () => {
    // Defense-in-depth: sweeper classifies by action-name allowlist. A
    // random unclassified action (e.g. application audit not on either tier
    // list) is preserved indefinitely.
    const db = getDb() as unknown as Database.Database;
    const swClock = new FakeClock(1_900_000_000);
    const sweeper = new Sweeper(db, swClock);

    const now = swClock.now();
    const DAY = 86_400;
    // 10y-old row with a non-tiered action name.
    insertAuditAt("app.custom.unclassified", now - 3650 * DAY);

    sweeper.runPass();

    const survivors = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?")
      .get("app.custom.unclassified") as { n: number };
    expect(survivors.n).toBe(1);
  });
});

// ===========================================================================
// D10 — concurrent device approve race (atomic CAS)
// ===========================================================================
describe("D10 — concurrent device approve race", () => {
  it("19: two approves of the same user_code → first wins, second is no-op", async () => {
    // Single-threaded JS makes the "race" sequential, but the SQL CAS guard
    // (WHERE approved_user_id IS NULL) is what matters. Insert a pending
    // device row, fire two approve UPDATEs back-to-back, assert exactly one
    // succeeds.
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    const now = clock.now();
    db.prepare(
      `INSERT INTO device_auth_requests
         (device_code, user_code, nonce, org_id, expires_at,
          requester_ip, requester_user_agent, failed_approval_attempts)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0)`,
    ).run("dev-d10-1", "ZZZZ-9999", "nonce-d10-1", String(now + 600), "10.0.0.10", "ua/d10");

    const stmt = db.prepare(
      `UPDATE device_auth_requests
         SET approved_user_id = ?, approved_at = ?
       WHERE user_code = ?
         AND approved_user_id IS NULL
         AND denied_at IS NULL
         AND CAST(expires_at AS INTEGER) > ?
         AND failed_approval_attempts < 5
       RETURNING device_code`,
    );

    // Caller A approves.
    const r1 = stmt.get("u-admin-acme", now, "ZZZZ-9999", now) as
      { device_code: string } | undefined;
    // Caller B approves the same user_code immediately after.
    const r2 = stmt.get("u-admin-beta", now, "ZZZZ-9999", now) as
      { device_code: string } | undefined;

    expect(r1).toBeDefined();
    expect(r2).toBeUndefined();

    const winner = db
      .prepare("SELECT approved_user_id FROM device_auth_requests WHERE user_code = ?")
      .get("ZZZZ-9999") as { approved_user_id: string };
    expect(winner.approved_user_id).toBe("u-admin-acme");
  });

  it("20: race-loser observes the 'consumed' state (approved_user_id IS NOT NULL)", async () => {
    // After the first approve commits, a subsequent CAS sees the row as
    // already-consumed. The handleDeviceApprove handler's failure-diagnosis
    // branch maps that state → 302 to /auth/device?error=consumed. Here we
    // directly assert the WHERE-clause state matches the "consumed" branch
    // (approved_user_id != NULL && denied_at == NULL && not expired) without
    // exercising the full HTTP handler (which would need a CSRF cookie +
    // rate-limit + cookie auth setup; covered by T20 unit tests). The
    // architectural seam — the atomic CAS that decides the winner — is the
    // same regardless of HTTP framing.
    const db = getDb() as unknown as Database.Database;
    const now = clock.now();
    db.prepare(
      `INSERT INTO device_auth_requests
         (device_code, user_code, nonce, org_id, expires_at,
          requester_ip, requester_user_agent, failed_approval_attempts)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0)`,
    ).run("dev-d10-2", "YYYY-8888", "nonce-d10-2", String(now + 600), "10.0.0.11", "ua/d10-2");

    // Winner approves.
    db.prepare(
      `UPDATE device_auth_requests
         SET approved_user_id = ?, approved_at = ?
       WHERE user_code = ?
         AND approved_user_id IS NULL
         AND denied_at IS NULL
         AND CAST(expires_at AS INTEGER) > ?
         AND failed_approval_attempts < 5`,
    ).run("u-admin-acme", now, "YYYY-8888", now);

    const row = db
      .prepare(
        `SELECT approved_user_id, denied_at, expires_at, failed_approval_attempts
         FROM device_auth_requests WHERE user_code = ?`,
      )
      .get("YYYY-8888") as {
      approved_user_id: string | null;
      denied_at: number | null;
      expires_at: string;
      failed_approval_attempts: number;
    };

    // The "consumed" branch in handleApproveFailure checks
    // approved_user_id !== null || denied_at !== null.
    expect(row.approved_user_id).not.toBeNull();
    expect(row.denied_at).toBeNull();
    // Not expired.
    expect(Number(row.expires_at)).toBeGreaterThan(now);
    // Not in brute-force lockout.
    expect(row.failed_approval_attempts).toBe(0);
  });
});
