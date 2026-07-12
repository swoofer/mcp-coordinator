import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { SignJWT } from "jose";
import { initAuth, authenticateRequest, initPhase2Auth, resetPhase2Auth } from "../../src/auth.js";
import { mintAccessJWT, mintRefreshJWT } from "../../src/auth/jwt-mint.js";
import { refreshTokenGrant } from "../../src/auth/refresh-rotation.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { findAuditRows } from "../helpers/audit.js";
import { PassthroughEncryption } from "../../src/security/encryption.js";
import type Database from "better-sqlite3";
import type { IdPProvider, ExchangeCodeResult } from "../../src/auth/providers/types.js";

/**
 * Task 1.3 (securite-auth-01) — token-type confusion.
 *
 * Before this fix, neither the Phase 2 session-cookie/Bearer verifier
 * (src/auth.ts verifyPhase2SessionCookie) nor the refresh-rotation JWT
 * verifier (src/auth/refresh-rotation.ts) distinguished an access-token
 * from a refresh-token: both are plain HS256 JWTs signed by the same key
 * registry, so a stolen refresh-token could be presented as a session
 * cookie / Bearer credential and would be ACCEPTED, fully bypassing the
 * rotation/reuse-detection protections that only apply at the refresh
 * endpoint. The fix mints `typ: "access"` / `typ: "refresh"` and rejects
 * the wrong type (and any legacy token minted before this fix, which
 * carries no `typ` claim at all — fail-closed) at both verifiers.
 */

const DIR = "data-test-token-type-confusion";
const SIGNING_SECRET = Buffer.alloc(32, 0x51);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";

const registry = buildJwtKeyRegistry(SIGNING_SECRET);

interface MockReqOpts {
  authorization?: string;
  cookie?: string;
  url?: string;
  method?: string;
}

function mockReq(opts: MockReqOpts = {}): IncomingMessage {
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

function seedOrg(orgId = "org-acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", "acme");
}

function seedUser(id = "u-alice", orgId = "org-acme", tokenEpoch = 0): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id, role, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, orgId, `${id}@example.com`, "github", `gh-${id}`, "member", tokenEpoch);
}

function seedRefreshRow(
  jti: string,
  opts: {
    userId?: string;
    orgId?: string;
    familyId?: string;
    parentJti?: string | null;
    expiresAt?: number;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      `id-${jti}`,
      opts.userId ?? "u-alice",
      opts.orgId ?? "org-acme",
      jti,
      opts.familyId ?? "fam-root",
      opts.parentJti ?? null,
      String(opts.expiresAt ?? Math.floor(Date.now() / 1000) + 30 * 86400),
      String(Math.floor(Date.now() / 1000)),
    );
}

// ---------------------------------------------------------------------------
// Refresh-rotation request/response mocks (mirrors refresh-rotation-happy.test.ts)
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

function mockTokenRequest(body: Record<string, string>): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string | undefined } }).socket = {
    remoteAddress: "10.0.0.1",
  };
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "user-agent": "test-agent/1.0",
  };
  return stream as unknown as IncomingMessage;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

function makeCtx(): AuthHandlerContext {
  const defaultProvider: IdPProvider = {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in token-type-confusion tests");
    },
    listMemberships: async () => ["acme"],
  };
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(defaultProvider),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: Buffer.alloc(32, 0x01),
    signingKeys: registry,
    membershipCache,
    encryptionProvider: new PassthroughEncryption(),
  };
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  resetPhase2Auth();
  initPhase2Auth({
    db: getDb() as unknown as Database.Database,
    signingKeys: registry,
    publicUrl: ISSUER,
  });
  clock = new FakeClock(Math.floor(Date.now() / 1000));
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// R1 / R5(1) — refresh-token presented as a session credential
// ---------------------------------------------------------------------------
describe("token-type confusion — refresh token presented as access credential", () => {
  it("rejects a refresh token presented as a session cookie", async () => {
    seedOrg();
    seedUser();
    const { jwt } = await mintRefreshJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-1" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 3600,
    });
    const req = mockReq({ cookie: sessionCookie(jwt) });
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
    const audits = findAuditRows("auth.invalid_token");
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(audits[audits.length - 1].metadata_json as string);
    expect(meta.reason).toBe("wrong_token_type");
  });

  it("rejects a refresh token presented as a Bearer credential", async () => {
    seedOrg();
    seedUser();
    const { jwt } = await mintRefreshJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-1" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 3600,
    });
    const req = mockReq({ authorization: `Bearer ${jwt}` });
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// R3 — end-to-end via authenticateRequest + refreshTokenGrant
// ---------------------------------------------------------------------------
describe("token-type confusion — end-to-end flow", () => {
  it("(a) a normally-minted access token IS accepted as a session cookie", async () => {
    seedOrg();
    seedUser();
    const jwt = await mintAccessJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-1", role: "member" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const req = mockReq({ cookie: sessionCookie(jwt) });
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("u-alice");
  });

  it("(b) a refresh token presented as a session cookie is rejected (401)", async () => {
    seedOrg();
    seedUser();
    const { jwt } = await mintRefreshJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-1" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 3600,
    });
    const result = await authenticateRequest(mockReq({ cookie: sessionCookie(jwt) }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("(c) normal refresh rotation still works end-to-end with a real refresh token", async () => {
    seedOrg();
    seedUser();
    const { jwt, jti } = await mintRefreshJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-root" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 30 * 86400,
      jti: "jti-e2e",
    });
    seedRefreshRow(jti);
    const req = mockTokenRequest({ refresh_token: jwt });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Refresh-rotation endpoint: reject wrong type / legacy tokens
// ---------------------------------------------------------------------------
describe("token-type confusion — refresh-rotation endpoint", () => {
  it("rejects an access token presented as a refresh token", async () => {
    seedOrg();
    seedUser();
    const jwt = await mintAccessJWT({
      claims: { sub: "u-alice", active_org_id: "org-acme", family_id: "fam-1", role: "member" },
      registry,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const req = mockTokenRequest({ refresh_token: jwt });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    const meta = JSON.parse(audits[audits.length - 1].metadata_json as string);
    expect(meta.reason).toBe("wrong_token_type");
  });

  it("rejects a legacy refresh token minted without a typ claim (fail-closed)", async () => {
    seedOrg();
    seedUser();
    const jti = "jti-legacy-refresh";
    const now = clock.now();
    const legacyJwt = await new SignJWT({
      sub: "u-alice",
      active_org_id: "org-acme",
      family_id: "fam-root",
      // no `typ` claim -- mirrors a token minted before this fix.
    })
      .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
      .setIssuer(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 30 * 86400)
      .setJti(jti)
      .sign(SIGNING_SECRET);
    seedRefreshRow(jti);
    const req = mockTokenRequest({ refresh_token: legacyJwt });
    const res = mockResponse();
    await refreshTokenGrant(req, res as unknown as ServerResponse, makeCtx());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe("invalid_grant");
    const audits = findAuditRows("auth.invalid_token");
    const meta = JSON.parse(audits[audits.length - 1].metadata_json as string);
    expect(meta.reason).toBe("wrong_token_type");
  });
});

// ---------------------------------------------------------------------------
// R5(2) — session-cookie verifier: legacy tokens without `typ` (fail-closed)
// ---------------------------------------------------------------------------
describe("token-type confusion — legacy tokens without typ (fail-closed compat)", () => {
  it("rejects a pre-fix session JWT that carries no typ claim at all", async () => {
    seedOrg();
    seedUser();
    const now = Math.floor(Date.now() / 1000);
    const legacyJwt = await new SignJWT({
      active_org_id: "org-acme",
      family_id: "fam-1",
      role: "member",
      // no `typ` claim -- mirrors a session JWT minted before this fix.
    })
      .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
      .setIssuer(ISSUER)
      .setSubject("u-alice")
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .setJti("legacy-session-jti")
      .sign(SIGNING_SECRET);
    const result = await authenticateRequest(mockReq({ cookie: sessionCookie(legacyJwt) }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    const audits = findAuditRows("auth.invalid_token");
    const meta = JSON.parse(audits[audits.length - 1].metadata_json as string);
    expect(meta.reason).toBe("wrong_token_type");
  });
});
