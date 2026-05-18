import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { jwtVerify } from "jose";
import {
  handleOAuthCallback,
  __finalizeBrowserOAuthMint,
} from "../../src/auth/oauth-callback.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { computeFingerprint } from "../../src/auth/oauth-finalize.js";
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
import { PassthroughEncryption } from "../../src/security/encryption.js";

/**
 * T16c — finalizeBrowserOAuthMint (JWT mint + cookies + 302 redirect).
 *
 * Tests 1-10 drive the helper via the __finalizeBrowserOAuthMint test export
 * with a manually-constructed provisioned user (no upstream state/CAS/exchange
 * scaffolding needed). Test 11 exercises the full end-to-end path through
 * handleOAuthCallback to prove the wiring matches.
 *
 * Coverage focus: post-provisioning finalization — fingerprint, CSRF, JWT
 * mint, refresh_tokens INSERT, Tier 2 audit, 3 cookies, 302 redirect.
 */

const DIR = "data-test-oauth-callback-finalize";

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

function parseSetCookie(raw: string): {
  name: string;
  value: string;
  attrs: Record<string, string | boolean>;
} {
  const parts = raw.split(";").map((p) => p.trim());
  const [first, ...rest] = parts;
  const eq = first.indexOf("=");
  const name = first.slice(0, eq);
  const value = first.slice(eq + 1);
  const attrs: Record<string, string | boolean> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i === -1) attrs[p.toLowerCase()] = true;
    else attrs[p.slice(0, i).toLowerCase()] = p.slice(i + 1);
  }
  return { name, value, attrs };
}

/** Splice multi Set-Cookie array into a name → parsed map. */
function indexCookies(arr: string[]): Record<string, ReturnType<typeof parseSetCookie>> {
  const out: Record<string, ReturnType<typeof parseSetCookie>> = {};
  for (const raw of arr) {
    const parsed = parseSetCookie(raw);
    out[parsed.name] = parsed;
  }
  return out;
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  const defaultProvider: IdPProvider = {
    name: "github",
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in T16c direct tests");
    },
    listMemberships: async () => ["acme"],
  };
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(defaultProvider),
    rateLimiter,
    publicUrl: "http://localhost:3000",
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(SIGNING_SECRET),
    membershipCache,
    // T08: provisionUser requires encryption; default passthrough so
    // existing assertions about stored token values remain unchanged.
    encryptionProvider: new PassthroughEncryption(),
    ...overrides,
  };
}

function seedUser(
  id = "u-alice",
  role: "admin" | "member" | "service" = "member",
  orgId = "org-acme",
): { user_id: string; primary_org_id: string; role: "admin" | "member" | "service" } {
  // Caller must seed orgs first.
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id,
          idp_access_token, role, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, orgId, "alice@example.com", "github", "gh-100", "tok", role, "0");
  return { user_id: id, primary_org_id: orgId, role };
}

function seedOrg(orgId = "org-acme", login = "acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", login);
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
  clock = new FakeClock();
  rateLimiter = new RateLimiter(clock);
  membershipCache = new MembershipCache(clock);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// -- T16c direct entry point (10 cases) ------------------------------------

describe("finalizeBrowserOAuthMint — direct entry point", () => {
  it("happy path returns 302 with Location pointing at {publicUrl}/auth/success", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("http://localhost:3000/auth/success");
  });

  it("emits 3 cookies: session (HttpOnly), csrf (NOT HttpOnly), oauth_state (Max-Age=0)", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const arr = res.headers["Set-Cookie"] as string[];
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(3);
    const byName = indexCookies(arr);
    const session = byName["__Host-coordinator_session"];
    const csrf = byName["__Host-coordinator_csrf"];
    const state = byName["__Host-coordinator_oauth_state"];
    expect(session).toBeDefined();
    expect(csrf).toBeDefined();
    expect(state).toBeDefined();
    expect(session.attrs.httponly).toBe(true);
    expect(csrf.attrs.httponly).toBeUndefined();
    expect(state.attrs["max-age"]).toBe("0");
    expect(state.value).toBe("");
  });

  it("session cookie carries a verifiable access JWT signed by the registry key", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const arr = res.headers["Set-Cookie"] as string[];
    const session = indexCookies(arr)["__Host-coordinator_session"];
    expect(session.value.split(".")).toHaveLength(3); // JWS compact form
    const { payload } = await jwtVerify(
      session.value,
      new Uint8Array(SIGNING_SECRET),
      { issuer: "http://localhost:3000" },
    );
    expect(payload.sub).toBe(user.user_id);
  });

  it("access JWT claims contain sub, active_org_id, family_id, role matching the provisioned user", async () => {
    seedOrg();
    const user = seedUser("u-admin", "admin");
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const arr = res.headers["Set-Cookie"] as string[];
    const session = indexCookies(arr)["__Host-coordinator_session"];
    const { payload } = await jwtVerify(
      session.value,
      new Uint8Array(SIGNING_SECRET),
      { issuer: "http://localhost:3000" },
    );
    expect(payload.sub).toBe("u-admin");
    expect(payload.active_org_id).toBe("org-acme");
    expect(payload.role).toBe("admin");
    expect(typeof payload.family_id).toBe("string");
    expect((payload.family_id as string)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refresh_tokens row inserted with matching jti, family_id, parent_jti=NULL, consumer_fingerprint", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const rows = getDb()
      .prepare("SELECT * FROM refresh_tokens WHERE user_id = ?")
      .all(user.user_id) as Array<{
      jti: string;
      family_id: string;
      parent_jti: string | null;
      consumer_fingerprint: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].family_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].parent_jti).toBeNull();
    expect(rows[0].consumer_fingerprint).toBe(
      computeFingerprint("10.0.0.1", "ua/1.0"),
    );
  });

  it("Tier 2 audit auth.login.success emitted with user_id, org_id, role, family_id metadata", async () => {
    seedOrg();
    const user = seedUser("u-alice", "member");
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const rows = findAuditRows("auth.login.success");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.user_id).toBe("u-alice");
    expect(meta.org_id).toBe("org-acme");
    expect(meta.role).toBe("member");
    expect(typeof meta.family_id).toBe("string");
    // family_id in audit equals refresh_tokens row's family_id.
    const refresh = getDb()
      .prepare("SELECT family_id FROM refresh_tokens WHERE user_id = ?")
      .get("u-alice") as { family_id: string };
    expect(meta.family_id).toBe(refresh.family_id);
  });

  it("CSRF cookie value is 256-bit base64url (43 chars unpadded)", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    const arr = res.headers["Set-Cookie"] as string[];
    const csrf = indexCookies(arr)["__Host-coordinator_csrf"];
    // 256-bit random → 32 bytes → base64url unpadded = 43 chars.
    expect(csrf.value).toHaveLength(43);
    expect(csrf.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("consumer_fingerprint equals computeFingerprint(ip, ua) exactly", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    const ip = "192.0.2.42";
    const ua = "Mozilla/5.0 (test)";
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      ip,
      ua,
    );
    const expected = computeFingerprint(ip, ua);
    expect(expected).not.toBeNull();
    const row = getDb()
      .prepare("SELECT consumer_fingerprint FROM refresh_tokens WHERE user_id = ?")
      .get(user.user_id) as { consumer_fingerprint: string };
    expect(row.consumer_fingerprint).toBe(expected);
    // Sanity: fingerprint is a SHA-256 hex digest (64 chars).
    expect(row.consumer_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("consumer_fingerprint is NULL when both ip and userAgent are null", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx(),
      user,
      null,
      null,
    );
    const row = getDb()
      .prepare("SELECT consumer_fingerprint FROM refresh_tokens WHERE user_id = ?")
      .get(user.user_id) as { consumer_fingerprint: string | null };
    expect(row.consumer_fingerprint).toBeNull();
  });

  it("publicUrl trailing slash is stripped before constructing Location", async () => {
    seedOrg();
    const user = seedUser();
    const res = mockResponse();
    await __finalizeBrowserOAuthMint(
      res as unknown as ServerResponse,
      makeCtx({ publicUrl: "http://localhost:3000/" }),
      user,
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.headers["Location"]).toBe("http://localhost:3000/auth/success");
    // Verify the JWT issuer also gets the trailing-slash strip applied.
    const arr = res.headers["Set-Cookie"] as string[];
    const session = indexCookies(arr)["__Host-coordinator_session"];
    const { payload } = await jwtVerify(
      session.value,
      new Uint8Array(SIGNING_SECRET),
      { issuer: "http://localhost:3000" },
    );
    expect(payload.iss).toBe("http://localhost:3000");
  });
});

// -- T16c end-to-end via handleOAuthCallback (1 case) ----------------------

describe("finalizeBrowserOAuthMint — end-to-end via handleOAuthCallback", () => {
  /** Recompute the production state-binding HMAC for cookie construction. */
  function bindState(state: string, key: Buffer): string {
    const message = Buffer.concat([
      Buffer.from("state-v1", "utf8"),
      Buffer.from([0]),
      Buffer.from(state, "utf8"),
    ]);
    return crypto.createHmac("sha256", key).update(message).digest("base64url");
  }

  function insertState(state: string): void {
    const now = clock.now();
    getDb()
      .prepare(
        `INSERT INTO oauth_state
           (state, code_verifier, redirect_uri, provider, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        state,
        "v",
        "http://localhost:3000/api/auth/oauth/callback",
        "github",
        now,
        now + 600,
      );
  }

  it("full callback (state + cookie HMAC + exchangeCode + provisioning + mint) → 302 + 3 cookies + refresh row + audit", async () => {
    seedOrg();
    const state = "s-e2e";
    insertState(state);

    const provider: IdPProvider = {
      name: "github",
      buildAuthUrl: () => "https://example/unused",
      exchangeCode: async (): Promise<ExchangeCodeResult> => ({
        user: {
          idp_user_id: "gh-100",
          email: "alice@example.com",
          name: "Alice",
        },
        accessToken: "tok-abc",
      }),
      listMemberships: async () => ["acme"],
    };

    const ctx = makeCtx({ providers: singleProviderRegistry(provider) });

    const res = mockResponse();
    const req = {
      method: "GET",
      url: `/api/auth/oauth/callback?state=${state}&code=c-xyz`,
      headers: {
        cookie: `__Host-coordinator_oauth_state=${bindState(state, STATE_BINDING_KEY)}`,
        "user-agent": "e2e-agent/1.0",
      },
      socket: { remoteAddress: "10.0.0.7" },
    } as unknown as IncomingMessage;

    await handleOAuthCallback(req, res as unknown as ServerResponse, ctx);

    // 1. 302 redirect.
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("http://localhost:3000/auth/success");

    // 2. All 3 cookies emitted.
    const arr = res.headers["Set-Cookie"] as string[];
    expect(arr).toHaveLength(3);
    const cookies = indexCookies(arr);
    expect(cookies["__Host-coordinator_session"]).toBeDefined();
    expect(cookies["__Host-coordinator_csrf"]).toBeDefined();
    expect(cookies["__Host-coordinator_oauth_state"]).toBeDefined();
    expect(cookies["__Host-coordinator_oauth_state"].attrs["max-age"]).toBe("0");

    // 3. Refresh row inserted with the expected fingerprint.
    const userRow = getDb()
      .prepare("SELECT id FROM users WHERE idp_user_id = ?")
      .get("gh-100") as { id: string };
    expect(userRow).toBeDefined();
    const refresh = getDb()
      .prepare("SELECT * FROM refresh_tokens WHERE user_id = ?")
      .all(userRow.id) as Array<{ consumer_fingerprint: string | null; parent_jti: string | null }>;
    expect(refresh).toHaveLength(1);
    expect(refresh[0].parent_jti).toBeNull();
    expect(refresh[0].consumer_fingerprint).toBe(
      computeFingerprint("10.0.0.7", "e2e-agent/1.0"),
    );

    // 4. auth.login.success audit emitted (Tier 2).
    const audits = findAuditRows("auth.login.success");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(meta.user_id).toBe(userRow.id);
    expect(meta.org_id).toBe("org-acme");

    // 5. Bootstrap admin (first user, no prior admin) → user.created + admin.bootstrapped audits.
    expect(findAuditRows("auth.user.created")).toHaveLength(1);
    expect(findAuditRows("auth.admin.bootstrapped")).toHaveLength(1);
  });
});
