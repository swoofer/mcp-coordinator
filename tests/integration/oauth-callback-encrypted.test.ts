import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { handleOAuthCallback } from "../../src/auth/oauth-callback.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import type { IdPProvider, ExchangeCodeResult } from "../../src/auth/providers/types.js";
import { makeTestEncryption, selectIdpToken } from "../helpers/encryption.js";
import type { DatabaseAdapter } from "../../src/db-adapter.js";

/**
 * T08 integration — browser OAuth callback path (handleOAuthCallback) encrypts
 * idp_access_token at provisioning. Verifies the call-site wiring in
 * oauth-callback.ts:366 propagates ctx.encryptionProvider into provisionUser.
 *
 * Drives the full state + cookie HMAC + exchangeCode + provisioning chain so
 * any regression in the call site (forgetting to pass encryption, passing
 * wrong context) shows up here.
 */

const DIR = "data-test-oauth-callback-encrypted";
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);
const SIGNING_SECRET = Buffer.alloc(32, 0x01);

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

function bindState(state: string, key: Buffer): string {
  const message = Buffer.concat([
    Buffer.from("state-v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(state, "utf8"),
  ]);
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

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
  clock = new FakeClock();
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

function seedOrg(orgId = "org-acme", login = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", login);
}

function insertState(state: string): void {
  const now = clock.now();
  getDb()
    .prepare(
      `INSERT INTO oauth_state
         (state, code_verifier, redirect_uri, provider, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(state, "v", "http://localhost:3000/api/auth/oauth/callback", "github", now, now + 600);
}

describe("handleOAuthCallback — encryption at provisioning", () => {
  it("provisions a user with ctx.encryptionProvider → users.idp_access_token persists as enc:v1: ciphertext", async () => {
    const { provider: encryption } = makeTestEncryption();
    seedOrg();
    const state = "s-enc-cb";
    insertState(state);

    const idpProvider: IdPProvider = {
      name: "github",
      buildAuthUrl: () => "https://example/unused",
      exchangeCode: async (): Promise<ExchangeCodeResult> => ({
        user: {
          idp_user_id: "gh-100",
          email: "alice@example.com",
          name: "Alice",
        },
        accessToken: "callback-plain-access",
        refreshToken: "callback-plain-refresh",
      }),
      listMemberships: async () => ["acme"],
    };

    const ctx: AuthHandlerContext = {
      db: getDb() as unknown as AuthHandlerContext["db"],
      clock,
      providers: singleProviderRegistry(idpProvider),
      rateLimiter,
      publicUrl: "http://localhost:3000",
      stateBindingKey: STATE_BINDING_KEY,
      signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
      membershipCache,
      encryptionProvider: encryption,
    };

    const res = mockResponse();
    const req = {
      method: "GET",
      url: `/api/auth/oauth/callback?state=${state}&code=c-xyz`,
      headers: {
        cookie: `__Host-coordinator_oauth_state=${bindState(state, STATE_BINDING_KEY)}`,
        "user-agent": "enc-agent/1.0",
      },
      socket: { remoteAddress: "10.0.0.7" },
    } as unknown as IncomingMessage;

    await handleOAuthCallback(req, res as unknown as ServerResponse, ctx);

    expect(res.statusCode).toBe(302);

    // Raw row → encrypted columns.
    const userRow = getDb()
      .prepare("SELECT id, idp_access_token, idp_refresh_token FROM users WHERE idp_user_id = ?")
      .get("gh-100") as {
      id: string;
      idp_access_token: string;
      idp_refresh_token: string | null;
    };
    expect(userRow).toBeDefined();
    expect(userRow.idp_access_token.startsWith("enc:v1:")).toBe(true);
    // Provider returned a refreshToken too — should also be encrypted.
    expect(userRow.idp_refresh_token).not.toBeNull();
    expect(userRow.idp_refresh_token!.startsWith("enc:v1:")).toBe(true);

    // Decrypt round-trips to the original IdP plaintexts.
    const access = selectIdpToken(
      getDb() as unknown as DatabaseAdapter,
      userRow.id,
      "idp_access_token",
      encryption,
    );
    expect(access).toBe("callback-plain-access");
    const refresh = selectIdpToken(
      getDb() as unknown as DatabaseAdapter,
      userRow.id,
      "idp_refresh_token",
      encryption,
    );
    expect(refresh).toBe("callback-plain-refresh");
  });
});
