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
import type {
  IdPProvider,
  ExchangeCodeResult,
} from "../../src/auth/providers/types.js";
import {
  IdPTokenRevoked,
  IdPTransientError,
} from "../../src/auth/providers/errors.js";
import { findAuditRows } from "../helpers/audit.js";

/**
 * T19c — refresh-rotation aux paths:
 *   - Idle timeout (V4 FIX 24)
 *   - IdP membership refresh + errors
 *   - Allowlist re-check on rotation + grace branch (V4 FIX 7)
 *   - Service-account rejection (regression — unchanged from T19a)
 *
 * 13 cases. Run alongside refresh-rotation-happy + refresh-rotation-reuse
 * for 100% branch coverage on refresh-rotation.ts.
 */

const DIR = "data-test-refresh-rotation-aux";

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

/**
 * Build a provider stub. By default listMemberships returns ["acme"] —
 * matches the default seedOrg allowlist. Override per-test for IdP-error
 * scenarios.
 */
function makeProvider(
  listMemberships?: () => Promise<string[]>,
): IdPProvider {
  return {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in T19c tests");
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
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache,
    ...overrides,
  };
}

function seedOrg(orgId = "org-acme", allowlist = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", allowlist);
}

function seedUser(
  opts: {
    id?: string;
    orgId?: string;
    tokenEpoch?: number;
    idpAccessToken?: string | null;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id ?? "u-alice",
      opts.orgId ?? "org-acme",
      "alice@example.com",
      "github",
      "gh-100",
      opts.idpAccessToken === undefined ? "idp-tok" : opts.idpAccessToken,
      "member",
      "0",
      opts.tokenEpoch ?? 0,
    );
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
  lastUsedAt?: string | null;
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
      opts.lastUsedAt === undefined ? String(clock.now()) : opts.lastUsedAt,
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
  serviceAccount?: boolean;
}

async function mintRefresh(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "u-alice",
    active_org_id: opts.orgId ?? "org-acme",
    family_id: opts.familyId ?? "fam-root",
  };
  if (opts.serviceAccount) claims.service_account = true;
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
  delete process.env.COORDINATOR_SESSION_IDLE_TIMEOUT;
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
  delete process.env.COORDINATOR_SESSION_IDLE_TIMEOUT;
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ===========================================================================
// Idle timeout (V4 FIX 24)
// ===========================================================================
describe("refreshTokenGrant — idle timeout (V4 FIX 24)", () => {
  it("COORDINATOR_SESSION_IDLE_TIMEOUT unset → no idle check, rotation proceeds", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-1" });
    // last_used_at way in the past — but no env set, so check is skipped.
    seedRefreshRow({ jti: "jti-idle-1", lastUsedAt: String(clock.now() - 100000) });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
  });

  it('COORDINATOR_SESSION_IDLE_TIMEOUT="0" → no idle check', async () => {
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "0";
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-2" });
    seedRefreshRow({ jti: "jti-idle-2", lastUsedAt: String(clock.now() - 100000) });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
  });

  it('COORDINATOR_SESSION_IDLE_TIMEOUT="15m", recent last_used_at → rotation proceeds', async () => {
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "15m";
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-3" });
    // 5 minutes ago — within 15m window.
    seedRefreshRow({ jti: "jti-idle-3", lastUsedAt: String(clock.now() - 5 * 60) });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
  });

  it('COORDINATOR_SESSION_IDLE_TIMEOUT="15m", stale last_used_at → 400 + idle_expired audit + revoked_reason set', async () => {
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "15m";
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-4" });
    // 30 minutes ago — beyond the 15m window.
    seedRefreshRow({ jti: "jti-idle-4", lastUsedAt: String(clock.now() - 30 * 60) });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/idle/i);

    const audits = findAuditRows("auth.refresh.idle_expired");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.jti).toBe("jti-idle-4");
    expect(meta.user_id).toBe("u-alice");
    expect(typeof meta.idle_elapsed).toBe("number");
    expect(meta.idle_timeout).toBe(900);

    const row = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-idle-4") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).toBe(String(clock.now()));
    expect(row.revoked_reason).toBe("idle_expired");
  });
});

describe("refreshTokenGrant — idle timeout edge cases", () => {
  it("parseDuration handles all units (s, m, h, d) — 60s, 1h, 1d each pass through fresh row", async () => {
    // Drives the "s"/"h"/"d" switch-case branches of parseDuration. The "m"
    // case is covered by the four primary idle tests. For each unit, set
    // the env, seed a fresh user/org/row, and assert rotation succeeds.
    for (const unit of ["60s", "1h", "1d"] as const) {
      getDb().exec("DELETE FROM audit_log");
      getDb().exec("DELETE FROM refresh_tokens");
      getDb().exec("DELETE FROM user_orgs");
      getDb().exec("DELETE FROM users");
      getDb().exec("DELETE FROM orgs");
      process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = unit;
      seedOrg();
      seedUser();
      const jti = `jti-idle-unit-${unit}`;
      const token = await mintRefresh({ jti });
      seedRefreshRow({ jti, lastUsedAt: String(clock.now()) });
      const req = mockRequest({ refresh_token: token });
      const res = mockResponse();
      await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
      expect(res.statusCode).toBe(200);
    }
  });

  it("parseDuration on invalid env value → throws (propagates)", async () => {
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "not-a-duration";
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-bad" });
    seedRefreshRow({ jti: "jti-idle-bad" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await expect(
      refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx()),
    ).rejects.toThrow(/invalid duration/);
  });

  it("idle check with NULL last_used_at → falls back to claims.iat (no expiry)", async () => {
    process.env.COORDINATOR_SESSION_IDLE_TIMEOUT = "15m";
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-idle-null" });
    // Explicit NULL last_used_at — defensive fallback path.
    seedRefreshRow({ jti: "jti-idle-null", lastUsedAt: null });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    // claims.iat == clock.now() (set by mintRefresh default), so idle_elapsed
    // is 0; rotation proceeds.
    expect(res.statusCode).toBe(200);
  });
});

// ===========================================================================
// Grace branch with NULL family_id (V4 FIX 7 defensive)
// ===========================================================================
describe("refreshTokenGrant — grace allowlist denial with NULL family_id", () => {
  it("grace + allowlist denied + family_id IS NULL → 401 + audit but no family revoke", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: "tok" });

    const { computeFingerprint } = await import("../../src/auth/oauth-finalize.js");
    const fp = computeFingerprint("10.0.0.7", "ua/null-fam");

    // Predecessor with family_id = NULL (Phase 1 legacy row).
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at, revoked_reason)
         VALUES (?, 'u-alice', 'org-acme', ?, NULL, NULL, ?, ?, ?, ?, 'rotated')`,
      )
      .run(
        "id-jti-null-fam-old",
        "jti-null-fam-old",
        fp,
        String(clock.now() + 30 * 86400),
        String(clock.now()),
        String(clock.now() - 2),
      );
    // Successor — same fingerprint as the incoming request.
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at)
         VALUES (?, 'u-alice', 'org-acme', ?, NULL, ?, ?, ?, ?, NULL)`,
      )
      .run(
        "id-jti-null-fam-new",
        "jti-null-fam-new",
        "jti-null-fam-old",
        fp,
        String(clock.now() + 30 * 86400),
        String(clock.now()),
      );

    const provider = makeProvider(async () => ["other-org"]);
    const token = await mintRefresh({ jti: "jti-null-fam-old" });
    const req = mockRequest(
      { refresh_token: token },
      { ip: "10.0.0.7", userAgent: "ua/null-fam" },
    );
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );

    expect(res.statusCode).toBe(401);
    expect(findAuditRows("auth.login.denied.not_in_org")).toHaveLength(1);
    // No family revoke (family_id was null), successor still untouched.
    const succ = getDb()
      .prepare("SELECT revoked_at FROM refresh_tokens WHERE jti = ?")
      .get("jti-null-fam-new") as { revoked_at: string | null };
    expect(succ.revoked_at).toBeNull();
  });
});

// ===========================================================================
// IdP errors
// ===========================================================================
describe("refreshTokenGrant — IdP errors", () => {
  it("IdPTokenRevoked from membership lookup → 401 + WWW-Authenticate + Tier 1 audit auth.idp.token_revoked", async () => {
    seedOrg();
    seedUser({ idpAccessToken: "stale-tok" });
    const token = await mintRefresh({ jti: "jti-idp-revoked" });
    seedRefreshRow({ jti: "jti-idp-revoked" });

    const provider = makeProvider(async () => {
      throw new IdPTokenRevoked();
    });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toMatch(/Bearer realm="coordinator"/);
    expect(res.headers["WWW-Authenticate"]).toMatch(/error="invalid_token"/);

    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/identity provider/i);

    const audits = findAuditRows("auth.idp.token_revoked");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.user_id).toBe("u-alice");
    expect(meta.phase).toBe("refresh_membership_check");
  });

  it("IdPTransientError (no stale cache) → 503 temporarily_unavailable", async () => {
    seedOrg();
    seedUser({ idpAccessToken: "tok" });
    const token = await mintRefresh({ jti: "jti-idp-503" });
    seedRefreshRow({ jti: "jti-idp-503" });

    const provider = makeProvider(async () => {
      throw new IdPTransientError();
    });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("temporarily_unavailable");
  });

  it("Unknown IdP error → propagates out of handler", async () => {
    seedOrg();
    seedUser({ idpAccessToken: "tok" });
    const token = await mintRefresh({ jti: "jti-idp-unknown" });
    seedRefreshRow({ jti: "jti-idp-unknown" });

    const provider = makeProvider(async () => {
      throw new Error("unexpected boom");
    });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();

    await expect(
      refreshTokenGrant(
        req,
        res as unknown as ServerResponse,
        makeCtx({ providers: singleProviderRegistry(provider) }),
      ),
    ).rejects.toThrow(/unexpected boom/);
  });
});

// ===========================================================================
// Allowlist re-check on main rotation path
// ===========================================================================
describe("refreshTokenGrant — allowlist re-check (main path)", () => {
  it("user still in allowlist → rotation proceeds (happy path)", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: "tok" });
    const token = await mintRefresh({ jti: "jti-allow-1" });
    seedRefreshRow({ jti: "jti-allow-1" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    // Default provider returns ["acme"] — matches.
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
  });

  it("user no longer in allowlist → 401 + Tier 1 audit auth.login.denied.not_in_org + row revoked", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: "tok" });
    const token = await mintRefresh({ jti: "jti-allow-2" });
    seedRefreshRow({ jti: "jti-allow-2" });
    // Provider returns memberships that don't match the allowlist.
    const provider = makeProvider(async () => ["other-org"]);
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/not in any allowlisted org/i);

    const audits = findAuditRows("auth.login.denied.not_in_org");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.user_id).toBe("u-alice");
    expect(meta.jti).toBe("jti-allow-2");
    expect(meta.phase).toBe("refresh_rotation");

    // Row revoked with reason='admin'.
    const row = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-allow-2") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe("admin");
  });

  it("users.idp_access_token IS NULL → allowlist check skipped, rotation proceeds", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: null });
    const token = await mintRefresh({ jti: "jti-allow-3" });
    seedRefreshRow({ jti: "jti-allow-3" });
    // Provider would throw if called — but it shouldn't be called.
    const provider = makeProvider(async () => {
      throw new Error("must not be called when idp_access_token is null");
    });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );
    expect(res.statusCode).toBe(200);
  });
});

// ===========================================================================
// Grace + allowlist re-check (V4 FIX 7)
// ===========================================================================
describe("refreshTokenGrant — grace branch allowlist re-check (V4 FIX 7)", () => {
  it("grace + same fingerprint + still in allowlist → returns cached successor", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: "tok" });
    const familyId = "fam-grace-ok";

    // Same fingerprint must be computed deterministically from the
    // request ip+ua. Use computeFingerprint with the same args.
    const { computeFingerprint } = await import("../../src/auth/oauth-finalize.js");
    const fp = computeFingerprint("10.0.0.5", "ua/grace");

    // Predecessor (revoked just now, rotated reason — within 10s grace).
    seedRefreshRow({
      jti: "jti-grace-old",
      familyId,
      revokedAt: String(clock.now() - 2),
      revokedReason: "rotated",
      consumerFingerprint: fp,
    });
    // Successor — same fingerprint as the request → legitimate retry.
    seedRefreshRow({
      jti: "jti-grace-new",
      familyId,
      parentJti: "jti-grace-old",
      consumerFingerprint: fp,
    });

    const token = await mintRefresh({ jti: "jti-grace-old", familyId });
    const req = mockRequest(
      { refresh_token: token },
      { ip: "10.0.0.5", userAgent: "ua/grace" },
    );
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
  });

  it("grace + same fingerprint + REMOVED from allowlist → revokes family + 401 + Tier 1 audit auth.login.denied.not_in_org", async () => {
    seedOrg("org-acme", "acme");
    seedUser({ idpAccessToken: "tok" });
    const familyId = "fam-grace-denied";

    const { computeFingerprint } = await import("../../src/auth/oauth-finalize.js");
    const fp = computeFingerprint("10.0.0.6", "ua/grace2");

    seedRefreshRow({
      jti: "jti-grace-old-2",
      familyId,
      revokedAt: String(clock.now() - 2),
      revokedReason: "rotated",
      consumerFingerprint: fp,
    });
    seedRefreshRow({
      jti: "jti-grace-new-2",
      familyId,
      parentJti: "jti-grace-old-2",
      consumerFingerprint: fp,
    });

    // Provider returns memberships not in allowlist → user removed.
    const provider = makeProvider(async () => ["other-org"]);
    const token = await mintRefresh({ jti: "jti-grace-old-2", familyId });
    const req = mockRequest(
      { refresh_token: token },
      { ip: "10.0.0.6", userAgent: "ua/grace2" },
    );
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/no longer in allowlisted/i);

    // NOT chain_revoked — this is policy denial via not_in_org audit.
    expect(findAuditRows("auth.refresh.chain_revoked")).toHaveLength(0);
    const audits = findAuditRows("auth.login.denied.not_in_org");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.jti).toBe("jti-grace-old-2");
    expect(meta.phase).toBe("refresh_grace");
    expect(meta.family_id).toBe(familyId);

    // Family revoked: successor row now marked.
    const succ = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-grace-new-2") as { revoked_at: string | null; revoked_reason: string | null };
    expect(succ.revoked_at).not.toBeNull();
    expect(succ.revoked_reason).toBe("reuse_detected");
  });
});

// ===========================================================================
// Service-account rejection (regression — unchanged from T19a)
// ===========================================================================
describe("refreshTokenGrant — service-account rejection (regression)", () => {
  it("claims.service_account=true → 400 invalid_grant 'Service tokens do not rotate'", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ serviceAccount: true });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/service tokens do not rotate/i);
  });
});
