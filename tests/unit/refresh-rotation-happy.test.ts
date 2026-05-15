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
import { findAuditRows } from "../helpers/audit.js";

/**
 * T19a — refresh-rotation happy path + JWT validation.
 *
 * 14 cases covering: JWT validation (6), service-account short-circuit (1),
 * token_epoch (1), row lookup (1), revoked-row placeholder (1), happy path
 * + side-effects (4). Reuse-detection / fingerprint / grace branches are
 * T19b's territory and are deliberately not exercised here.
 */

const DIR = "data-test-refresh-rotation-happy";

const SIGNING_SECRET = Buffer.alloc(32, 0x01);
const WRONG_SECRET = Buffer.alloc(32, 0x02);
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

/**
 * Build a mock IncomingMessage from a form-urlencoded body. We use a
 * Readable stream so the handler's `req.on("data"/"end")` consume it
 * exactly like a real request body.
 */
function mockRequest(
  body: Record<string, string>,
  opts: { ip?: string; userAgent?: string } = {},
): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  // augment the stream with the IncomingMessage extras refreshTokenGrant uses
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
      throw new Error("exchangeCode not used in T19a tests");
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

/**
 * Insert an initial refresh_tokens row keyed by jti. Returns the row's
 * family_id so callers can verify rotation reuses it.
 */
function seedRefreshRow(
  jti: string,
  opts: {
    userId?: string;
    orgId?: string;
    familyId?: string;
    parentJti?: string | null;
    consumerFingerprint?: string | null;
    revokedAt?: string | null;
    expiresAt?: number;
  } = {},
): string {
  const familyId = opts.familyId ?? "fam-root";
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      jti,
      familyId,
      opts.parentJti ?? null,
      opts.consumerFingerprint ?? null,
      String(opts.expiresAt ?? clock.now() + 30 * 86400),
      String(clock.now()),
      opts.revokedAt ?? null,
    );
  return familyId;
}

interface MintOpts {
  sub?: string;
  orgId?: string;
  familyId?: string;
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
  issuer?: string;
  secret?: Buffer;
  kid?: string;
  alg?: "HS256" | "HS384";
  serviceAccount?: boolean;
}

/**
 * Mint a refresh JWT for tests. Defaults align with seedRefreshRow's
 * defaults so the round-trip lookup matches by jti.
 */
async function mintRefresh(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: opts.sub ?? "u-alice",
    active_org_id: opts.orgId ?? "org-acme",
    family_id: opts.familyId ?? "fam-root",
  };
  if (opts.serviceAccount) claims.service_account = true;

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "HS256", kid: opts.kid ?? "hs256-v1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt(opts.iat ?? clock.now())
    .setExpirationTime((opts.iat ?? clock.now()) + (opts.ttlSeconds ?? 30 * 86400))
    .setJti(opts.jti ?? "jti-current");
  return builder.sign(new Uint8Array(opts.secret ?? SIGNING_SECRET));
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
  // Use real-time seed so jose's exp check (which uses Date.now()) passes
  // against tokens we mint with clock.now() as iat.
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// JWT validation (6 cases)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — JWT validation", () => {
  it("missing refresh_token in body → 400 invalid_request", async () => {
    seedOrg();
    seedUser();
    const req = mockRequest({});
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/missing/i);
  });

  it("malformed JWT → 400 invalid_grant + auth.invalid_token audit", async () => {
    seedOrg();
    seedUser();
    const req = mockRequest({ refresh_token: "not.a.jwt" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
  });

  it("JWT signed with wrong key → 400 invalid_grant + auth.invalid_token audit", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ secret: WRONG_SECRET });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    expect(findAuditRows("auth.invalid_token")).toHaveLength(1);
  });

  it("JWT with unknown kid → 400 invalid_grant + audit reason mentions unknown_kid", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ kid: "hs256-v999" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(String(meta.reason)).toMatch(/unknown_kid/);
  });

  it("expired JWT (beyond ±30s clock tolerance) → 400 invalid_grant + audit", async () => {
    seedOrg();
    seedUser();
    // exp = now-100s, well beyond the 30s tolerance.
    const past = clock.now() - 200;
    const token = await mintRefresh({ iat: past, ttlSeconds: 50 });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    expect(findAuditRows("auth.invalid_token")).toHaveLength(1);
  });

  it("JWT issuer mismatch → 400 invalid_grant + audit", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ issuer: "http://evil.example.com" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    expect(findAuditRows("auth.invalid_token")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Service account (1 case)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — service-account short-circuit", () => {
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
    // No audit on the cheap-reject path (the JWT was valid).
    expect(findAuditRows("auth.invalid_token")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// token_epoch (1 case)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — token_epoch", () => {
  it("claims.iat < user.token_epoch → 400 invalid_grant + audit reason=token_epoch_exceeded", async () => {
    seedOrg();
    // Force-revoke: epoch in the future relative to iat.
    seedUser("u-alice", "org-acme", clock.now() + 100);
    const token = await mintRefresh({ iat: clock.now(), jti: "jti-epoch" });
    seedRefreshRow("jti-epoch");
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("token_epoch_exceeded");
  });
});

// ---------------------------------------------------------------------------
// Row lookup (1 case)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — row lookup", () => {
  it("valid JWT but no refresh_tokens row → 400 invalid_grant + audit reason=row_not_found", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-orphan" });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.reason).toBe("row_not_found");
  });
});

// ---------------------------------------------------------------------------
// Revoked row placeholder (1 case; T19b expands)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — revoked row reuse detection (T19b takes over)", () => {
  it("row exists with revoked_at IS NOT NULL beyond grace → 401 chain_revoked", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-revoked" });
    // Revoked 60s ago — well beyond the 10s grace; hard reuse path.
    seedRefreshRow("jti-revoked", { revokedAt: String(clock.now() - 60) });
    const req = mockRequest({ refresh_token: token });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/chain revoked/i);
  });
});

// ---------------------------------------------------------------------------
// Happy path + side effects (4 cases)
// ---------------------------------------------------------------------------
describe("refreshTokenGrant — happy path", () => {
  it("valid JWT + valid row → 200 + RFC 6749 §5.1 JSON shape", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-happy" });
    seedRefreshRow("jti-happy");
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(typeof body.refresh_token).toBe("string");
    expect(body.refresh_token.split(".")).toHaveLength(3);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);
  });

  it("old row marked revoked_at=now, revoked_reason='rotated'", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-old" });
    seedRefreshRow("jti-old");
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const row = getDb()
      .prepare("SELECT revoked_at, revoked_reason FROM refresh_tokens WHERE jti = ?")
      .get("jti-old") as { revoked_at: string; revoked_reason: string };
    expect(row.revoked_at).toBe(String(clock.now()));
    expect(row.revoked_reason).toBe("rotated");
  });

  it("new row INSERTed with same family_id, parent_jti=old.jti, fingerprint set", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-shared";
    const token = await mintRefresh({ jti: "jti-pred", familyId });
    seedRefreshRow("jti-pred", { familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);

    const rows = getDb()
      .prepare(
        `SELECT jti, family_id, parent_jti, consumer_fingerprint, revoked_at
         FROM refresh_tokens
         ORDER BY created_at, id`,
      )
      .all() as Array<{
        jti: string;
        family_id: string;
        parent_jti: string | null;
        consumer_fingerprint: string | null;
        revoked_at: string | null;
      }>;
    // Exactly two rows: predecessor + successor.
    expect(rows).toHaveLength(2);
    const successor = rows.find((r) => r.parent_jti !== null);
    expect(successor).toBeDefined();
    expect(successor!.parent_jti).toBe("jti-pred");
    expect(successor!.family_id).toBe(familyId);
    expect(successor!.revoked_at).toBeNull();
    expect(successor!.consumer_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("Tier 2 audit auth.refresh.rotated emitted with old_jti, new_jti, family_id", async () => {
    seedOrg();
    seedUser();
    const familyId = "fam-audit";
    const token = await mintRefresh({ jti: "jti-audit-old", familyId });
    seedRefreshRow("jti-audit-old", { familyId });
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);

    const audits = findAuditRows("auth.refresh.rotated");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.old_jti).toBe("jti-audit-old");
    expect(typeof meta.new_jti).toBe("string");
    expect(meta.new_jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(meta.family_id).toBe(familyId);

    // And: the successor's jti matches the audit's new_jti.
    const successor = getDb()
      .prepare("SELECT jti FROM refresh_tokens WHERE parent_jti = ?")
      .get("jti-audit-old") as { jti: string };
    expect(successor.jti).toBe(meta.new_jti);
  });

  it("row.family_id IS NULL → mintTokenPair generates a new family_id (Phase 1 row)", async () => {
    seedOrg();
    seedUser();
    // Mint JWT with whatever family_id; the row's family_id is NULL,
    // forcing the `row.family_id ?? undefined` fallback branch.
    const token = await mintRefresh({ jti: "jti-null-fam", familyId: "fam-jwt-only" });
    // Insert a row that bypasses the seedRefreshRow default by setting
    // family_id to NULL explicitly via a custom INSERT.
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at, revoked_at)
         VALUES (?, 'u-alice', 'org-acme', ?, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run("id-null-fam", "jti-null-fam", String(clock.now() + 30 * 86400), String(clock.now()));

    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    // The successor's family_id is a new UUID (mintTokenPair fallback),
    // NOT the JWT's family_id claim.
    const successor = getDb()
      .prepare("SELECT family_id FROM refresh_tokens WHERE parent_jti = ?")
      .get("jti-null-fam") as { family_id: string };
    expect(successor.family_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("absent socket.remoteAddress + missing user-agent → fingerprint=null", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-null-fp" });
    seedRefreshRow("jti-null-fp");
    // Build a request stream WITHOUT a socket and WITHOUT a user-agent
    // header so both `?? null` branches fire.
    const encoded = new URLSearchParams({ refresh_token: token }).toString();
    const stream = Readable.from([Buffer.from(encoded, "utf8")]);
    (stream as unknown as { headers: Record<string, string> }).headers = {};
    // no .socket attached at all
    const res = mockResponse();
    await refreshTokenGrant(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(200);
    const successor = getDb()
      .prepare("SELECT consumer_fingerprint FROM refresh_tokens WHERE parent_jti = ?")
      .get("jti-null-fp") as { consumer_fingerprint: string | null };
    expect(successor.consumer_fingerprint).toBeNull();
  });

  it("parseFormBody emits stream error → 400 invalid_request 'Could not parse body'", async () => {
    seedOrg();
    seedUser();
    // Custom stream that emits an error event instead of data+end.
    const stream = new Readable({
      read() {
        // Defer the error so the handler's .on("error") listener is attached.
        process.nextTick(() => this.emit("error", new Error("boom")));
      },
    });
    (stream as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "10.0.0.1",
    };
    (stream as unknown as { headers: Record<string, string> }).headers = {
      "user-agent": "ua/1",
    };
    const res = mockResponse();
    await refreshTokenGrant(
      stream as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      makeCtx(),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/could not parse body/i);
  });

  it("rotation race: UPDATE returns changes=0 → 400 invalid_grant 'Rotation race'", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-race" });
    seedRefreshRow("jti-race");

    // Stub ctx.db with a thin proxy: SELECT shows revoked_at=null (legit),
    // but the rotation UPDATE returns changes=0 — simulating a concurrent
    // rotation that won the race between our SELECT and UPDATE. The
    // simplest way is to delete the row right before the UPDATE runs, so
    // the WHERE clause matches no rows.
    const realDb = getDb();
    const stubDb = {
      prepare(sql: string) {
        const stmt = realDb.prepare(sql);
        if (sql.includes("UPDATE refresh_tokens") && sql.includes("revoked_reason = 'rotated'")) {
          return {
            run: (...args: unknown[]) => {
              // Delete the row so the WHERE clause fails.
              realDb.prepare("DELETE FROM refresh_tokens WHERE jti = ?").run("jti-race");
              return stmt.run(...(args as Parameters<typeof stmt.run>));
            },
          };
        }
        return stmt;
      },
    };

    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ db: stubDb as unknown as AuthHandlerContext["db"] }),
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description).toMatch(/rotation race/i);
  });

  it("publicUrl trailing slash is stripped before issuer match", async () => {
    seedOrg();
    seedUser();
    const token = await mintRefresh({ jti: "jti-slash" });
    seedRefreshRow("jti-slash");
    const req = mockRequest({ refresh_token: token }, { ip: "10.0.0.1", userAgent: "ua/1" });
    const res = mockResponse();
    // ctx.publicUrl with trailing slash should still validate the
    // token (which set iss=ISSUER without slash) AND mint new tokens
    // with the slash-stripped issuer.
    await refreshTokenGrant(
      req,
      res as unknown as ServerResponse,
      makeCtx({ publicUrl: `${ISSUER}/` }),
    );
    expect(res.statusCode).toBe(200);
  });
});
