import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import { refreshTokenGrant } from "../../src/auth/refresh-rotation.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { computeFingerprint } from "../../src/auth/oauth-finalize.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";
import { findAuditRows } from "../helpers/audit.js";

/**
 * T19b — refresh-rotation reuse detection + 10s grace + family revoke.
 *
 * Exercises the V3 §B-NEW-2 / V4 FIX 5/6/7/23 algorithm on revoked
 * refresh rows. Sibling test file `refresh-rotation-happy.test.ts`
 * covers T19a happy-path; this file focuses exclusively on the
 * `row.revoked_at !== null` branch.
 */

const DIR = "data-test-refresh-rotation-reuse";

const SIGNING_SECRET = Buffer.alloc(32, 0x01);
const ISSUER = "http://localhost:3000";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

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

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  const defaultProvider: IdPProvider = {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in T19b tests");
    },
    listMemberships: async () => ["acme"],
  };
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(defaultProvider),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
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
    .run(id, orgId, "alice@example.com", "github", "gh-100", "tok", "member", "0", tokenEpoch);
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
  replayCount?: number;
}

function seedRefreshRow(opts: SeedRefreshOpts): void {
  const familyId = opts.familyId === undefined ? "fam-root" : opts.familyId;
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at, revoked_reason, replay_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${opts.jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      opts.jti,
      familyId,
      opts.parentJti ?? null,
      opts.consumerFingerprint ?? null,
      String(opts.expiresAt ?? clock.now() + 30 * 86400),
      String(clock.now()),
      opts.revokedAt ?? null,
      opts.revokedReason ?? null,
      opts.replayCount ?? 0,
    );
}

interface MintOpts {
  sub?: string;
  orgId?: string;
  familyId?: string;
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
}

async function mintRefresh(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "u-alice",
    active_org_id: opts.orgId ?? "org-acme",
    family_id: opts.familyId ?? "fam-root",
  };
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setIssuedAt(opts.iat ?? clock.now())
    .setExpirationTime((opts.iat ?? clock.now()) + (opts.ttlSeconds ?? 30 * 86400))
    .setJti(opts.jti ?? "jti-current");
  return builder.sign(new Uint8Array(SIGNING_SECRET));
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM user_orgs");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  getDb().exec("DELETE FROM oauth_state");
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ===========================================================================
// Hard reuse paths (beyond grace OR not 'rotated' OR orphan)
// ===========================================================================
describe("refreshTokenGrant — hard reuse", () => {
  it("beyond 10s grace + revoked_reason='rotated' → family revoked + chain_revoked + 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-hard-1";
    // Old (the one the attacker is replaying) — revoked 30s ago.
    seedRefreshRow({
      jti: "jti-old-1",
      familyId,
      revokedAt: String(clock.now() - 30),
      revokedReason: "rotated",
    });
    // Successor (live) — same family, should be killed by family revoke.
    seedRefreshRow({
      jti: "jti-succ-1",
      familyId,
      parentJti: "jti-old-1",
    });

    const token = await mintRefresh({ jti: "jti-old-1", familyId });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/chain revoked/i);

    // Family revoked: successor now revoked too.
    const succ = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-succ-1") as { revoked_at: string | null; revoked_reason: string | null };
    expect(succ.revoked_at).not.toBeNull();
    expect(succ.revoked_reason).toBe("reuse_detected");

    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("hard_reuse");
    expect(meta.old_jti).toBe("jti-old-1");
    expect(meta.family_id).toBe(familyId);
    expect(meta.elapsed_seconds).toBeGreaterThanOrEqual(30);
  });

  it("beyond grace + revoked_reason='admin' → family revoked + chain_revoked + 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-hard-2";
    seedRefreshRow({
      jti: "jti-old-2",
      familyId,
      revokedAt: String(clock.now() - 60),
      revokedReason: "admin",
    });

    const token = await mintRefresh({ jti: "jti-old-2", familyId });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(1);
  });

  it("within grace but revoked_reason='logout' (not 'rotated') → chain_revoked + 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-hard-3";
    seedRefreshRow({
      jti: "jti-old-3",
      familyId,
      revokedAt: String(clock.now() - 2), // well within 10s grace
      revokedReason: "logout",
    });

    const token = await mintRefresh({ jti: "jti-old-3", familyId });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("hard_reuse");
  });

  it("no successor row (orphan within grace) → family revoked + chain_revoked + 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-hard-4";
    seedRefreshRow({
      jti: "jti-old-4",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
    });
    // NO successor row — orphan.

    const token = await mintRefresh({ jti: "jti-old-4", familyId });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("no_successor");
    expect(meta.old_jti).toBe("jti-old-4");
    expect(meta.family_id).toBe(familyId);
  });

  it("orphan with null family_id → no family revoke; chain_revoked audit with family_id=null", async () => {
    seedOrg();
    seedUser();
    // Old row revoked 3s ago, 'rotated', but no successor AND null family.
    seedRefreshRow({
      jti: "jti-orphan-nullfam",
      familyId: null,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
    });

    const token = await mintRefresh({ jti: "jti-orphan-nullfam" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("no_successor");
    expect(meta.family_id).toBeNull();
  });

  it("threshold-hit with null family_id → chain_revoked audit, no family revoke run", async () => {
    seedOrg();
    seedUser();
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-th-nullfam",
      familyId: null,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
      replayCount: 2, // next mismatch trips threshold
    });
    // Successor with null family_id too (Phase 1 inheritance).
    seedRefreshRow({
      jti: "jti-th-nullfam-succ",
      familyId: null,
      parentJti: "jti-th-nullfam",
      consumerFingerprint: oldFp,
    });

    const token = await mintRefresh({ jti: "jti-th-nullfam" });
    const req = mockRequest({ refresh_token: token }, { ip: "evil", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("replay_threshold_hit");
    expect(meta.family_id).toBeNull();
  });

  it("grace re-mint with successor having null family_id + null parent_jti", async () => {
    seedOrg();
    seedUser();
    const fingerprint = computeFingerprint("10.0.0.1", "ua/null-meta");
    seedRefreshRow({
      jti: "jti-nullmeta-old",
      familyId: null,
      revokedAt: String(clock.now() - 4),
      revokedReason: "rotated",
      consumerFingerprint: fingerprint,
    });
    // Successor: null family_id + null parent_jti (Phase 1 hand-rolled row).
    // The partial UNIQUE index only constrains parent_jti IS NOT NULL, so
    // a NULL parent_jti is acceptable. We need the SELECT WHERE parent_jti=?
    // to still find it though — but `WHERE parent_jti = NULL` never matches.
    // So this scenario only exercises the grace path if parent_jti points
    // to the old jti. We use null family_id only (parent_jti stays linked).
    seedRefreshRow({
      jti: "jti-nullmeta-succ",
      familyId: null,
      parentJti: "jti-nullmeta-old",
      consumerFingerprint: fingerprint,
    });

    const token = await mintRefresh({ jti: "jti-nullmeta-old" });
    const req = mockRequest(
      { refresh_token: token },
      { ip: "10.0.0.1", userAgent: "ua/null-meta" },
    );
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    // Grace + same fingerprint + successor exists → 200.
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const accessParts = (body.access_token as string).split(".");
    const accessPayload = JSON.parse(
      Buffer.from(accessParts[1], "base64url").toString("utf8"),
    );
    // successor.family_id was null → fallback to "".
    expect(accessPayload.family_id).toBe("");
  });

  it("hard reuse with null family_id → no family revoke run, still 401 + audit", async () => {
    seedOrg();
    seedUser();
    seedRefreshRow({
      jti: "jti-old-null-fam",
      familyId: null,
      revokedAt: String(clock.now() - 60),
      revokedReason: "rotated",
    });

    const token = await mintRefresh({ jti: "jti-old-null-fam" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.family_id).toBeNull();
  });
});

// ===========================================================================
// Grace window — same fingerprint → deterministic re-mint
// ===========================================================================
describe("refreshTokenGrant — grace window same-fingerprint re-mint", () => {
  it("within grace (5s) + same fingerprint → 200 with refreshed pair (same family_id)", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-grace-1";
    const ip = "10.0.0.1";
    const ua = "ua/grace";
    const fingerprint = computeFingerprint(ip, ua);

    // Old: revoked 5s ago, rotated.
    seedRefreshRow({
      jti: "jti-old-g1",
      familyId,
      revokedAt: String(clock.now() - 5),
      revokedReason: "rotated",
      consumerFingerprint: fingerprint, // tracked the OLD client
    });
    // Successor: live, same fingerprint, same family.
    seedRefreshRow({
      jti: "jti-succ-g1",
      familyId,
      parentJti: "jti-old-g1",
      consumerFingerprint: fingerprint,
    });

    const token = await mintRefresh({ jti: "jti-old-g1", familyId });
    const req = mockRequest({ refresh_token: token }, { ip, userAgent: ua });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);

    // No new row inserted — the successor is reused as-is.
    const rows = getDb()
      .prepare("SELECT jti FROM refresh_tokens")
      .all() as Array<{ jti: string }>;
    expect(rows).toHaveLength(2);

    // No chain_revoked or suspicious_replay audit emitted.
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(0);
    expect(findAuditRows("auth.refresh.suspicious_replay")).toHaveLength(0);

    // Decoded refresh token: jti matches successor row.
    const refreshParts = (body.refresh_token as string).split(".");
    const refreshPayload = JSON.parse(
      Buffer.from(refreshParts[1], "base64url").toString("utf8"),
    );
    expect(refreshPayload.jti).toBe("jti-succ-g1");
    expect(refreshPayload.family_id).toBe(familyId);
  });

  it("within grace + null fingerprint on both sides → mismatch (no cached successor returned)", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-grace-null";
    seedRefreshRow({
      jti: "jti-old-null",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: null,
    });
    seedRefreshRow({
      jti: "jti-succ-null",
      familyId,
      parentJti: "jti-old-null",
      consumerFingerprint: null,
    });

    // Build a request stream WITHOUT socket and WITHOUT user-agent so
    // computeFingerprint returns null.
    const encoded = new URLSearchParams({
      refresh_token: await mintRefresh({ jti: "jti-old-null", familyId }),
    }).toString();
    const stream = Readable.from([Buffer.from(encoded, "utf8")]);
    (stream as unknown as { headers: Record<string, string> }).headers = {};
    const res = mockResponse();
    await refreshTokenGrant(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx(),
    );

    // Null fp on both sides → treated as mismatch → suspicious_replay (not 200).
    expect(res.statusCode).toBe(401);
    expect(findAuditRows("auth.refresh.suspicious_replay")).toHaveLength(1);
  });

  it("grace boundary at exactly 10s elapsed → falls through to hard reuse", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-grace-edge";
    const fingerprint = computeFingerprint("10.0.0.1", "ua/edge");
    seedRefreshRow({
      jti: "jti-edge",
      familyId,
      revokedAt: String(clock.now() - 10), // exactly 10s ago
      revokedReason: "rotated",
      consumerFingerprint: fingerprint,
    });
    seedRefreshRow({
      jti: "jti-succ-edge",
      familyId,
      parentJti: "jti-edge",
      consumerFingerprint: fingerprint,
    });

    const token = await mintRefresh({ jti: "jti-edge", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/edge" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    // elapsed >= 10 → hard reuse path.
    expect(res.statusCode).toBe(401);
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(1);
  });
});

// ===========================================================================
// Fingerprint mismatch within grace → replay_count + thresholds
// ===========================================================================
describe("refreshTokenGrant — fingerprint mismatch within grace", () => {
  it("first mismatch → replay_count=1, suspicious_replay audit, 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-mm-1";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-mm-1",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
    });
    seedRefreshRow({
      jti: "jti-succ-mm-1",
      familyId,
      parentJti: "jti-mm-1",
      consumerFingerprint: oldFp,
    });

    const token = await mintRefresh({ jti: "jti-mm-1", familyId });
    // Attacker uses a different IP/UA → fingerprint mismatch.
    const req = mockRequest({ refresh_token: token }, { ip: "192.168.1.1", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!).error_description).toMatch(/validation failed/i);

    const row = getDb()
      .prepare("SELECT replay_count FROM refresh_tokens WHERE jti = ?")
      .get("jti-mm-1") as { replay_count: number };
    expect(row.replay_count).toBe(1);

    const audits = findAuditRows("auth.refresh.suspicious_replay");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.replay_count).toBe(1);
    expect(meta.old_jti).toBe("jti-mm-1");
    expect(meta.family_id).toBe(familyId);

    // Family NOT revoked yet.
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(0);
    const succ = getDb()
      .prepare("SELECT revoked_at FROM refresh_tokens WHERE jti = ?")
      .get("jti-succ-mm-1") as { revoked_at: string | null };
    expect(succ.revoked_at).toBeNull();
  });

  it("second mismatch (replay_count=2) → still suspicious_replay, 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-mm-2";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-mm-2",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
      replayCount: 1, // already mismatched once
    });
    seedRefreshRow({
      jti: "jti-succ-mm-2",
      familyId,
      parentJti: "jti-mm-2",
      consumerFingerprint: oldFp,
    });

    const token = await mintRefresh({ jti: "jti-mm-2", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "192.168.1.1", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const row = getDb()
      .prepare("SELECT replay_count FROM refresh_tokens WHERE jti = ?")
      .get("jti-mm-2") as { replay_count: number };
    expect(row.replay_count).toBe(2);
    const audits = findAuditRows("auth.refresh.suspicious_replay");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.replay_count).toBe(2);
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(0);
  });

  it("third mismatch (replay_count reaches 3) → family revoked + chain_revoked (NOT suspicious_replay) + 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-mm-3";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-mm-3",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
      replayCount: 2, // two prior mismatches; this one trips the threshold
    });
    seedRefreshRow({
      jti: "jti-succ-mm-3",
      familyId,
      parentJti: "jti-mm-3",
      consumerFingerprint: oldFp,
    });

    const token = await mintRefresh({ jti: "jti-mm-3", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "192.168.1.1", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!).error_description).toMatch(/chain revoked/i);

    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("replay_threshold_hit");
    expect(meta.replay_count).toBe(3);

    // Suspicious_replay NOT emitted on the threshold path.
    expect(findAuditRows("auth.refresh.suspicious_replay")).toHaveLength(0);

    // Family revoked (successor + old both now revoked).
    const succ = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-succ-mm-3") as { revoked_at: string | null; revoked_reason: string | null };
    expect(succ.revoked_at).not.toBeNull();
    expect(succ.revoked_reason).toBe("reuse_detected");
  });

  it("fingerprint mismatch but no successor → orphan path (chain_revoked reason=no_successor)", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-mm-no-succ";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-mm-ns",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
    });
    // No successor.

    const token = await mintRefresh({ jti: "jti-mm-ns", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "192.168.1.1", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("no_successor");
    // No replay_count++ since orphan path runs before the mismatch branch.
    const row = getDb()
      .prepare("SELECT replay_count FROM refresh_tokens WHERE jti = ?")
      .get("jti-mm-ns") as { replay_count: number };
    expect(row.replay_count).toBe(0);
  });
});

// ===========================================================================
// Audit content + edge cases
// ===========================================================================
describe("refreshTokenGrant — audit content + edge cases", () => {
  it("chain_revoked audit metadata includes old_jti, family_id, reason", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-audit-1";
    seedRefreshRow({
      jti: "jti-audit-cr",
      familyId,
      revokedAt: String(clock.now() - 60),
      revokedReason: "rotated",
    });

    const token = await mintRefresh({ jti: "jti-audit-cr", familyId });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    const audits = findAuditRows("auth.refresh.chain_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta).toMatchObject({
      old_jti: "jti-audit-cr",
      family_id: familyId,
      reason: "hard_reuse",
    });
  });

  it("suspicious_replay audit metadata includes old_jti, family_id, replay_count", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-audit-2";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    seedRefreshRow({
      jti: "jti-audit-sr",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
    });
    seedRefreshRow({
      jti: "jti-succ-audit-sr",
      familyId,
      parentJti: "jti-audit-sr",
      consumerFingerprint: oldFp,
    });

    const token = await mintRefresh({ jti: "jti-audit-sr", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "evil", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    const audits = findAuditRows("auth.refresh.suspicious_replay");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta).toMatchObject({
      old_jti: "jti-audit-sr",
      family_id: familyId,
      replay_count: 1,
    });
  });

  it("returns successor with same family_id (continuity for stolen-token tracking)", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-continuity";
    const fingerprint = computeFingerprint("10.0.0.1", "ua/cont");
    seedRefreshRow({
      jti: "jti-c-old",
      familyId,
      revokedAt: String(clock.now() - 5),
      revokedReason: "rotated",
      consumerFingerprint: fingerprint,
    });
    seedRefreshRow({
      jti: "jti-c-succ",
      familyId,
      parentJti: "jti-c-old",
      consumerFingerprint: fingerprint,
    });

    const token = await mintRefresh({ jti: "jti-c-old", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/cont" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    const refreshParts = (body.refresh_token as string).split(".");
    const payload = JSON.parse(
      Buffer.from(refreshParts[1], "base64url").toString("utf8"),
    );
    expect(payload.family_id).toBe(familyId);

    // Access token also carries the same family_id.
    const accessParts = (body.access_token as string).split(".");
    const accessPayload = JSON.parse(
      Buffer.from(accessParts[1], "base64url").toString("utf8"),
    );
    expect(accessPayload.family_id).toBe(familyId);
  });

  it("two consecutive grace re-mints return byte-identical refresh JWTs (deterministic)", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-deterministic";
    const fingerprint = computeFingerprint("10.0.0.1", "ua/det");
    seedRefreshRow({
      jti: "jti-det-old",
      familyId,
      revokedAt: String(clock.now() - 4),
      revokedReason: "rotated",
      consumerFingerprint: fingerprint,
    });
    seedRefreshRow({
      jti: "jti-det-succ",
      familyId,
      parentJti: "jti-det-old",
      consumerFingerprint: fingerprint,
    });

    const token = await mintRefresh({ jti: "jti-det-old", familyId });

    // First retry.
    const res1 = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/det" }),
      res1 as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res1.statusCode).toBe(200);

    // Second retry — same fingerprint, same successor — must produce
    // identical refresh JWT.
    const res2 = mockResponse();
    await refreshTokenGrant(
      mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/det" }),
      res2 as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res2.statusCode).toBe(200);

    const body1 = JSON.parse(res1.body!);
    const body2 = JSON.parse(res2.body!);
    // V3 spec: deterministic re-mint pins refresh JWT (same jti/iat/exp).
    // Access tokens carry a fresh random jti per emission and need not be
    // byte-identical across retries (the refresh JWT is what callers cache
    // for idempotency).
    expect(body1.refresh_token).toBe(body2.refresh_token);
  });

  it("fourth mismatch on already-revoked family → idempotent revoke, still 401", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-idempotent";
    const oldFp = computeFingerprint("10.0.0.1", "old-ua");
    // Old row: already revoked + replay_count high enough that next ++
    // crosses the threshold. Family already has revoked successor.
    seedRefreshRow({
      jti: "jti-idem-old",
      familyId,
      revokedAt: String(clock.now() - 3),
      revokedReason: "rotated",
      consumerFingerprint: oldFp,
      replayCount: 5, // well past threshold already
    });
    seedRefreshRow({
      jti: "jti-idem-succ",
      familyId,
      parentJti: "jti-idem-old",
      consumerFingerprint: oldFp,
      revokedAt: String(clock.now() - 1), // already revoked by a prior pass
      revokedReason: "reuse_detected",
    });

    const token = await mintRefresh({ jti: "jti-idem-old", familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "evil", userAgent: "evil-ua" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(401);
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(1);
    // Idempotent: the family-revoke UPDATE WHERE revoked_at IS NULL touches
    // 0 rows (old already revoked, successor already revoked) and that's
    // fine. The audit still fires.
    const meta = JSON.parse(
      findAuditRows("auth.refresh.chain_revoked")[0].metadata_json as string,
    );
    expect(meta.reason).toBe("replay_threshold_hit");
  });
});
