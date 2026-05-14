import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import { __finalizeBrowserOAuth } from "../../src/auth/oauth-callback.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import {
  hashIdentifier,
  recordFailedLogin,
  DEFAULT_LOCKOUT_THRESHOLD,
} from "../../src/auth/login-lockout.js";
import { hashIdpUserId } from "../../src/auth/audit-helpers.js";
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";
import type {
  IdPProvider,
  ExchangeCodeResult,
  IdpUserInfo,
} from "../../src/auth/providers/types.js";
import { findAuditRows, expectAuditRow } from "../helpers/audit.js";

/**
 * T16b — finalizeBrowserOAuth provisioning flow (post-state, post-exchange).
 *
 * Exercises the second of three stages in handleOAuthCallback:
 *   1. login lockout (V3 §B-NEW-8)
 *   2. listMemberships via T04 cache
 *   3. allowlist resolution (T09)
 *   4. AUTO_PROVISION mode (T44)
 *   5. provisionUser inside BEGIN IMMEDIATE TX (T16helpers + V4 FIX 16)
 *   6. post-TX audits (V4 FIX 23 commit-then-audit)
 *   7. hand-off to T16c (finalizeBrowserOAuthMint → 501 stub)
 *
 * Uses the internal __finalizeBrowserOAuth export so we can drive the
 * flow without re-running the upstream state/CAS/exchange machinery (T16a
 * tests cover those).
 */

const DIR = "data-test-oauth-callback-provisioning";

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

interface StubProviderConfig {
  memberships?: string[] | (() => string[] | Promise<string[]>);
  membershipsImpl?: () => Promise<string[]>;
}

type TrackedProvider = IdPProvider & { listMembershipsCalls: number };

function stubProvider(config: StubProviderConfig = {}): TrackedProvider {
  const provider: TrackedProvider = {
    name: "github",
    listMembershipsCalls: 0,
    buildAuthUrl: () => "https://example/unused",
    exchangeCode: async (): Promise<ExchangeCodeResult> => {
      throw new Error("exchangeCode not used in T16b tests");
    },
    listMemberships: async () => {
      provider.listMembershipsCalls++;
      if (config.membershipsImpl) return config.membershipsImpl();
      if (typeof config.memberships === "function") {
        return await config.memberships();
      }
      return config.memberships ?? ["acme"];
    },
  };
  return provider;
}

const USER_ALICE: IdpUserInfo = {
  idp_user_id: "gh-100",
  email: "alice@example.com",
  name: "Alice",
};

function makeExchange(user: IdpUserInfo = USER_ALICE, token = "tok-abc"): ExchangeCodeResult {
  return { user, accessToken: token };
}

let clock: FakeClock;
let rateLimiter: RateLimiter;
let membershipCache: MembershipCache;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    githubProvider: overrides.githubProvider ?? stubProvider(),
    rateLimiter,
    publicUrl: "http://localhost:3000",
    stateBindingKey: Buffer.alloc(32, 0x01),
    signingKeys: buildJwtKeyRegistry(Buffer.alloc(32, 0x01)),
    membershipCache,
    ...overrides,
  };
}

function seedAcmeOrg(orgId = "org-acme", login = "acme"): void {
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
  delete process.env.COORDINATOR_AUTO_PROVISION;
});

afterEach(() => {
  delete process.env.COORDINATOR_AUTO_PROVISION;
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// -- Login lockout (2 cases) -------------------------------------------------

describe("finalizeBrowserOAuth — login lockout", () => {
  it("pre-locked identifier → 429 + Retry-After + LOGIN_LOCKED + Tier 1 audit auth.login.locked", async () => {
    seedAcmeOrg();
    // Consume all tokens for this identifier so the next peek reports locked.
    const ident = hashIdentifier(USER_ALICE.idp_user_id);
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD; i++) {
      recordFailedLogin(rateLimiter, ident);
    }
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx(),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
    expect(JSON.parse(res.body!).code).toBe("LOGIN_LOCKED");
    expectAuditRow("auth.login.locked", {
      metadata_json: JSON.stringify({ identifier_hash: ident }),
    });
  });

  it("after threshold not-in-org failures the next call returns LOGIN_LOCKED + emits auth.login.locked", async () => {
    // No allowlist matches → each call records a failed login. After
    // DEFAULT_LOCKOUT_THRESHOLD failures the bucket is drained; the next call's
    // isLocked peek sees zero tokens and short-circuits with 429.
    const provider = stubProvider({ memberships: ["random-org"] });
    for (let i = 0; i < DEFAULT_LOCKOUT_THRESHOLD; i++) {
      const res = mockResponse();
      // No org seeded → allowlist resolution returns null → 403 NOT_IN_ALLOWLIST.
      await __finalizeBrowserOAuth(
        res as unknown as ServerResponse,
        makeCtx({ githubProvider: provider }),
        makeExchange(),
        "10.0.0.1",
        "ua/1.0",
      );
      expect(res.statusCode).toBe(403);
    }
    // The (threshold+1)th call: peek-locked → 429 + auth.login.locked Tier 1.
    expect(findAuditRows("auth.login.locked")).toHaveLength(0);
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(429);
    expect(JSON.parse(res.body!).code).toBe("LOGIN_LOCKED");
    const locked = findAuditRows("auth.login.locked");
    expect(locked).toHaveLength(1);
    const meta = JSON.parse(locked[0].metadata_json as string);
    expect(meta.identifier_hash).toBe(hashIdentifier(USER_ALICE.idp_user_id));
  });
});

// -- listMemberships errors (3 cases) ---------------------------------------

describe("finalizeBrowserOAuth — listMemberships errors", () => {
  it("IdPTokenRevoked → 401 + WWW-Authenticate + Tier 1 audit auth.idp.token_revoked", async () => {
    seedAcmeOrg();
    const provider = stubProvider({
      membershipsImpl: async () => {
        throw new IdPTokenRevoked();
      },
    });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBeDefined();
    expect(JSON.parse(res.body!).code).toBe("IDP_TOKEN_REVOKED");
    expectAuditRow("auth.idp.token_revoked", {
      metadata_json: JSON.stringify({ phase: "callback_memberships" }),
    });
  });

  it("IdPTransientError (no cached entry) → 503 + IDP_UNAVAILABLE", async () => {
    seedAcmeOrg();
    const provider = stubProvider({
      membershipsImpl: async () => {
        throw new IdPTransientError();
      },
    });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).code).toBe("IDP_UNAVAILABLE");
  });

  it("stale-on-error: cached entry within stale window + transient error → happy path", async () => {
    seedAcmeOrg();
    // Prime cache with a successful call.
    const provider = stubProvider({ memberships: ["acme"] });
    const ctx = makeCtx({ githubProvider: provider });
    const firstRes = mockResponse();
    await __finalizeBrowserOAuth(
      firstRes as unknown as ServerResponse,
      ctx,
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    // First call provisions → bootstrap admin → 501 stub.
    expect(firstRes.statusCode).toBe(501);
    // Advance past positive TTL (60s) but stay within 10min stale window.
    clock.advance(120);
    // Now make the provider throw transient.
    let throwCount = 0;
    const provider2 = stubProvider({
      membershipsImpl: async () => {
        throwCount++;
        throw new IdPTransientError();
      },
    });
    const secondRes = mockResponse();
    await __finalizeBrowserOAuth(
      secondRes as unknown as ServerResponse,
      makeCtx({ githubProvider: provider2 }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(throwCount).toBe(1);
    // Stale-on-error served cached ["acme"] → existing user path → 501 stub.
    expect(secondRes.statusCode).toBe(501);
  });
});

// -- Allowlist (3 cases) ----------------------------------------------------

describe("finalizeBrowserOAuth — allowlist", () => {
  it("no allowlist match → 403 NOT_IN_ALLOWLIST + Tier 1 audit auth.login.denied.not_in_org", async () => {
    // No orgs seeded.
    const provider = stubProvider({ memberships: ["unknown-org"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).code).toBe("NOT_IN_ALLOWLIST");
    const rows = findAuditRows("auth.login.denied.not_in_org");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.idp_user_id_hash).toBe(hashIdpUserId(USER_ALICE.idp_user_id));
    expect(meta.memberships_count).toBe(1);
    expect(typeof meta.identifier_hash).toBe("string");
  });

  it("user in multiple matching orgs → alphabetically-first allowlist row wins", async () => {
    // Seed two orgs with allowlist logins "zeta" and "alpha". User is in both.
    getDb()
      .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
      .run("org-z", "Zeta", "zeta");
    getDb()
      .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
      .run("org-a", "Alpha", "alpha");
    const provider = stubProvider({ memberships: ["zeta", "alpha"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);
    // User was provisioned in org-a (alphabetical first).
    const row = getDb()
      .prepare("SELECT primary_org_id FROM users WHERE idp_user_id = ?")
      .get(USER_ALICE.idp_user_id) as { primary_org_id: string };
    expect(row.primary_org_id).toBe("org-a");
  });

  it("empty memberships array → 403 NOT_IN_ALLOWLIST + audit", async () => {
    seedAcmeOrg();
    const provider = stubProvider({ memberships: [] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).code).toBe("NOT_IN_ALLOWLIST");
    const rows = findAuditRows("auth.login.denied.not_in_org");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).memberships_count).toBe(0);
  });
});

// -- AUTO_PROVISION (3 cases) -----------------------------------------------

describe("finalizeBrowserOAuth — AUTO_PROVISION mode", () => {
  it("AUTO_PROVISION env unset → default 'true' → new user provisioned", async () => {
    seedAcmeOrg();
    expect(process.env.COORDINATOR_AUTO_PROVISION).toBeUndefined();
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);
    const row = getDb()
      .prepare("SELECT id FROM users WHERE idp_user_id = ?")
      .get(USER_ALICE.idp_user_id);
    expect(row).toBeDefined();
  });

  it("AUTO_PROVISION='false' + new user → 403 USER_NOT_PROVISIONED + Tier 2 audit auth.login.failure", async () => {
    seedAcmeOrg();
    process.env.COORDINATOR_AUTO_PROVISION = "false";
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).code).toBe("USER_NOT_PROVISIONED");
    // No user row created (TX rolled back).
    const row = getDb()
      .prepare("SELECT id FROM users WHERE idp_user_id = ?")
      .get(USER_ALICE.idp_user_id);
    expect(row).toBeUndefined();
    const rows = findAuditRows("auth.login.failure");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.reason).toBe("user_not_provisioned");
    expect(meta.idp_user_id_hash).toBe(hashIdpUserId(USER_ALICE.idp_user_id));
    // Crucially: no auth.user.created emitted.
    expect(findAuditRows("auth.user.created")).toHaveLength(0);
  });

  it("AUTO_PROVISION='False' (capital F) + new user → still 403 (case-insensitive parsing)", async () => {
    seedAcmeOrg();
    process.env.COORDINATOR_AUTO_PROVISION = "False";
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body!).code).toBe("USER_NOT_PROVISIONED");
    const row = getDb()
      .prepare("SELECT id FROM users WHERE idp_user_id = ?")
      .get(USER_ALICE.idp_user_id);
    expect(row).toBeUndefined();
  });

  it("AUTO_PROVISION='false' + existing user → provisioning succeeds (existing path)", async () => {
    seedAcmeOrg();
    // Pre-insert the user so existence check passes inside the TX.
    getDb()
      .prepare(
        `INSERT INTO users
           (id, primary_org_id, email, name, idp_provider, idp_user_id,
            idp_access_token, role, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "u-existing",
        "org-acme",
        USER_ALICE.email,
        USER_ALICE.name ?? null,
        "github",
        USER_ALICE.idp_user_id,
        "old-token",
        "member",
        "0",
      );
    process.env.COORDINATOR_AUTO_PROVISION = "false";
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(USER_ALICE, "new-token"),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);
    // Access token was rotated.
    const row = getDb()
      .prepare("SELECT idp_access_token FROM users WHERE id = ?")
      .get("u-existing") as { idp_access_token: string };
    expect(row.idp_access_token).toBe("new-token");
  });
});

// -- Provisioning audits (4 cases) ------------------------------------------

describe("finalizeBrowserOAuth — provisioning audits", () => {
  it("new user, no admin exists → bootstrapAdmin=true → both audits fire", async () => {
    seedAcmeOrg();
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);

    const createdRows = findAuditRows("auth.user.created");
    expect(createdRows).toHaveLength(1);
    const createdMeta = JSON.parse(createdRows[0].metadata_json as string);
    expect(createdMeta.bootstrap_admin).toBe(true);

    const bootstrappedRows = findAuditRows("auth.admin.bootstrapped");
    expect(bootstrappedRows).toHaveLength(1);
    const bootMeta = JSON.parse(bootstrappedRows[0].metadata_json as string);
    expect(bootMeta.org_id).toBe("org-acme");
  });

  it("new user, admin already exists → bootstrapAdmin=false → only auth.user.created", async () => {
    seedAcmeOrg();
    // Pre-insert an admin so the bootstrap-admin atomic check does NOT promote.
    getDb()
      .prepare(
        `INSERT INTO users
           (id, primary_org_id, email, idp_provider, idp_user_id,
            idp_access_token, role, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("u-admin", "org-acme", "admin@example.com", "github", "gh-admin", "tok", "admin", "0");
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);

    const createdRows = findAuditRows("auth.user.created");
    expect(createdRows).toHaveLength(1);
    expect(JSON.parse(createdRows[0].metadata_json as string).bootstrap_admin).toBe(false);
    expect(findAuditRows("auth.admin.bootstrapped")).toHaveLength(0);
  });

  it("existing user → no auth.user.created; idp_access_token + last_login_at updated", async () => {
    seedAcmeOrg();
    getDb()
      .prepare(
        `INSERT INTO users
           (id, primary_org_id, email, idp_provider, idp_user_id,
            idp_access_token, role, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("u-1", "org-acme", USER_ALICE.email, "github", USER_ALICE.idp_user_id, "old-token", "member", "0");
    clock.advance(1234);
    const expectedNow = String(clock.now());
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(USER_ALICE, "fresh-token"),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);
    expect(findAuditRows("auth.user.created")).toHaveLength(0);
    expect(findAuditRows("auth.admin.bootstrapped")).toHaveLength(0);
    const row = getDb()
      .prepare("SELECT idp_access_token, last_login_at FROM users WHERE id = ?")
      .get("u-1") as { idp_access_token: string; last_login_at: string };
    expect(row.idp_access_token).toBe("fresh-token");
    expect(row.last_login_at).toBe(expectedNow);
  });

  it("happy path returns 501 from finalizeBrowserOAuthMint (T16c handoff)", async () => {
    seedAcmeOrg();
    const provider = stubProvider({ memberships: ["acme"] });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body!).code).toBe("NOT_IMPLEMENTED");
    expect(JSON.parse(res.body!).message).toContain("T16c");
  });
});

// -- Misc edge cases (extra coverage) ---------------------------------------

describe("finalizeBrowserOAuth — edge cases", () => {
  it("unknown listMemberships error → re-thrown to top-level handler", async () => {
    seedAcmeOrg();
    const provider = stubProvider({
      membershipsImpl: async () => {
        throw new Error("boom");
      },
    });
    const res = mockResponse();
    await expect(
      __finalizeBrowserOAuth(
        res as unknown as ServerResponse,
        makeCtx({ githubProvider: provider }),
        makeExchange(),
        "10.0.0.1",
        "ua/1.0",
      ),
    ).rejects.toThrow("boom");
  });

  it("unknown error inside TX → re-thrown to top-level handler", async () => {
    seedAcmeOrg();
    // Inject a broken provider that returns a string that's NOT lowercase
    // — actually we can't break TX through this surface easily. Instead,
    // exercise the catch path by deleting orgs mid-flight. We use a custom
    // ctx with a wrapped db.transaction that throws a non-ProvisioningDeniedError.
    const provider = stubProvider({ memberships: ["acme"] });
    const realDb = getDb();
    const wrappedDb = new Proxy(realDb, {
      get(target, prop) {
        if (prop === "transaction") {
          return (_fn: () => unknown) => {
            const t = () => {
              throw new Error("tx-boom");
            };
            t.default = t;
            t.deferred = t;
            t.immediate = t;
            t.exclusive = t;
            return t;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const res = mockResponse();
    await expect(
      __finalizeBrowserOAuth(
        res as unknown as ServerResponse,
        makeCtx({
          githubProvider: provider,
          db: wrappedDb as unknown as AuthHandlerContext["db"],
        }),
        makeExchange(),
        "10.0.0.1",
        "ua/1.0",
      ),
    ).rejects.toThrow("tx-boom");
  });

  it("lockout identifier falls back to ip when idp_user_id is empty string", async () => {
    seedAcmeOrg();
    const provider = stubProvider({ memberships: ["acme"] });
    const userWithEmptyId: IdpUserInfo = {
      idp_user_id: "",
      email: "x@example.com",
    };
    const ident = hashIdentifier("10.0.0.99");
    // Pre-lock via the IP-based identifier.
    for (let i = 0; i <= DEFAULT_LOCKOUT_THRESHOLD; i++) {
      recordFailedLogin(rateLimiter, ident);
    }
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(userWithEmptyId),
      "10.0.0.99",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(429);
  });

  it("lockout identifier falls back to 'unknown' when no idp_user_id AND no ip", async () => {
    seedAcmeOrg();
    const provider = stubProvider({ memberships: ["acme"] });
    const userWithEmptyId: IdpUserInfo = {
      idp_user_id: "",
      email: "x@example.com",
    };
    // happy path with null ip — should resolve "unknown" → no prior lockout.
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ githubProvider: provider }),
      makeExchange(userWithEmptyId),
      null,
      null,
    );
    expect(res.statusCode).toBe(501);
  });

  it("uses default Retry-After of 900s when limiter omits retry_after_seconds", async () => {
    seedAcmeOrg();
    // Wrap the limiter's `peek` to return locked WITHOUT retry_after_seconds.
    // Exercises the `?? 900` fallback in the handler's Retry-After header.
    const wrappedLimiter = new Proxy(rateLimiter, {
      get(target, prop) {
        if (prop === "peek") {
          return () => ({ allowed: false } as unknown as ReturnType<RateLimiter["peek"]>);
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = mockResponse();
    await __finalizeBrowserOAuth(
      res as unknown as ServerResponse,
      makeCtx({ rateLimiter: wrappedLimiter }),
      makeExchange(),
      "10.0.0.1",
      "ua/1.0",
    );
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBe("900");
  });
});
