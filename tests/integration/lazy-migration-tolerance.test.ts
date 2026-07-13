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
import type { IdPProvider, ExchangeCodeResult } from "../../src/auth/providers/types.js";
import { IdPTokenRevoked } from "../../src/auth/providers/errors.js";
import { makeTestEncryption } from "../helpers/encryption.js";

/**
 * T09 — lazy-migration tolerance.
 *
 * When a daemon boots with COORDINATOR_ENCRYPTION_KEY set against a DB
 * holding plaintext idp_access_token rows (legacy), the refresh path must
 * tolerate them (no decrypt error) and re-encrypt on the next rotation.
 */

const DIR = "data-test-lazy-migration-tolerance";

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

function mockRequest(body: Record<string, string>): IncomingMessage {
  const encoded = new URLSearchParams(body).toString();
  const stream = Readable.from([Buffer.from(encoded, "utf8")]);
  (stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "10.0.0.1",
  };
  (stream as unknown as { headers: Record<string, string> }).headers = {
    "user-agent": "test/1.0",
  };
  return stream as unknown as IncomingMessage;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

function makeProvider(): IdPProvider {
  let calls = 0;
  return {
    name: "github-app",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("unused");
    },
    // First call: token revoked (forces refresh-token path).
    // Second call: succeeds with allowlisted membership.
    listMemberships: async () => {
      calls += 1;
      if (calls === 1) throw new IdPTokenRevoked();
      return ["acme"];
    },
    refreshIdpToken: async () => ({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    }),
  } as IdPProvider;
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

it("plaintext idp_access_token row + key set → refresh succeeds; row becomes enc:v1:", async () => {
  const enc = makeTestEncryption();

  // Seed org + user with PLAINTEXT IdP tokens (bypass encryption).
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run("org-acme", "Acme", "acme");
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, idp_refresh_token, role, last_login_at, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "u-alice",
      "org-acme",
      "alice@example.com",
      "github-app",
      "gh-1",
      "old_plaintext",
      "old_plaintext_refresh",
      "member",
      "0",
      0,
    );

  // Seed refresh row.
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "id-jti-lazy",
      "u-alice",
      "org-acme",
      "jti-lazy",
      "fam-root",
      null,
      null,
      String(clock.now() + 30 * 86400),
      String(clock.now()),
      null,
    );

  // Mint inbound refresh JWT.
  const token = await new SignJWT({
    sub: "u-alice",
    active_org_id: "org-acme",
    family_id: "fam-root",
    typ: "refresh",
  })
    .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
    .setIssuer(ISSUER)
    .setIssuedAt(clock.now())
    .setExpirationTime(clock.now() + 30 * 86400)
    .setJti("jti-lazy")
    .sign(new Uint8Array(SIGNING_SECRET));

  const ctx: AuthHandlerContext = {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(makeProvider()),
    rateLimiter,
    publicUrl: ISSUER,
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache,
    encryptionProvider: enc.provider,
  };

  const res = mockResponse();
  await refreshTokenGrant(
    mockRequest({ refresh_token: token }),
    res as unknown as ServerResponse,
    ctx,
  );

  // Refresh succeeded.
  expect(res.statusCode).toBe(200);

  // Row is now enc:v1: prefixed for both columns.
  const row = getDb()
    .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = ?")
    .get("u-alice") as { idp_access_token: string; idp_refresh_token: string };
  expect(row.idp_access_token.startsWith("enc:v1:")).toBe(true);
  expect(row.idp_refresh_token.startsWith("enc:v1:")).toBe(true);

  // Decrypt round-trip yields the rotated tokens.
  const access = enc.provider.decrypt(row.idp_access_token, {
    org_id: "org-acme",
    column: "idp_access_token",
    user_id: "u-alice",
  });
  const refresh = enc.provider.decrypt(row.idp_refresh_token, {
    org_id: "org-acme",
    column: "idp_refresh_token",
    user_id: "u-alice",
  });
  expect(access).toBe("rotated-access");
  expect(refresh).toBe("rotated-refresh");
});
