import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import { handleOAuthToken } from "../../src/auth/oauth-token.js";
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
 * T08 integration — CLI authorization_code grant (handleOAuthToken) encrypts
 * idp_access_token at provisioning. Verifies the call-site wiring in
 * oauth-token.ts:229 propagates ctx.encryptionProvider into provisionUser.
 */

const DIR = "data-test-oauth-token-encrypted";
const SIGNING_SECRET = Buffer.alloc(32, 0x01);
const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);
const ISSUER = "http://localhost:3000";

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

function seedOrg(orgId = "org-acme", login = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", login);
}

describe("handleOAuthToken — authorization_code encrypts IdP tokens", () => {
  it("happy-path CLI grant → users.idp_access_token + idp_refresh_token persist as enc:v1: ciphertext", async () => {
    const { provider: encryption } = makeTestEncryption();
    seedOrg();

    const idpProvider: IdPProvider = {
      name: "github",
      buildAuthUrl: () => "https://example/unused",
      exchangeCode: async (): Promise<ExchangeCodeResult> => ({
        user: {
          idp_user_id: "gh-token-1",
          email: "cli@example.com",
          name: "CLI User",
        },
        accessToken: "cli-plain-access",
        refreshToken: "cli-plain-refresh",
      }),
      listMemberships: async () => ["acme"],
    };

    const ctx: AuthHandlerContext = {
      db: getDb() as unknown as AuthHandlerContext["db"],
      clock,
      providers: singleProviderRegistry(idpProvider),
      rateLimiter,
      publicUrl: ISSUER,
      stateBindingKey: STATE_BINDING_KEY,
      signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
      membershipCache,
      encryptionProvider: encryption,
    };

    const req = mockRequest(
      {
        grant_type: "authorization_code",
        code: "c-enc",
        redirect_uri: "http://localhost/cb",
        code_verifier: "verifier-xyz",
      },
      { ip: "10.0.0.7", userAgent: "cli/1.0" },
    );
    const res = mockResponse();
    await handleOAuthToken(req, res as unknown as ServerResponse, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(typeof body.access_token).toBe("string");

    const userRow = getDb()
      .prepare("SELECT id, idp_access_token, idp_refresh_token FROM users WHERE idp_user_id = ?")
      .get("gh-token-1") as {
      id: string;
      idp_access_token: string;
      idp_refresh_token: string | null;
    };
    expect(userRow).toBeDefined();
    expect(userRow.idp_access_token.startsWith("enc:v1:")).toBe(true);
    expect(userRow.idp_refresh_token).not.toBeNull();
    expect(userRow.idp_refresh_token!.startsWith("enc:v1:")).toBe(true);

    // Decrypt round-trips to original plaintext.
    expect(
      selectIdpToken(
        getDb() as unknown as DatabaseAdapter,
        userRow.id,
        "idp_access_token",
        encryption,
      ),
    ).toBe("cli-plain-access");
    expect(
      selectIdpToken(
        getDb() as unknown as DatabaseAdapter,
        userRow.id,
        "idp_refresh_token",
        encryption,
      ),
    ).toBe("cli-plain-refresh");
  });
});
