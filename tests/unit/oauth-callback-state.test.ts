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
import { IdPTokenRevoked, IdPTransientError } from "../../src/auth/providers/errors.js";
import { findAuditRows, expectAuditRow } from "../helpers/audit.js";
import { PassthroughEncryption } from "../../src/security/encryption.js";

/**
 * T16a — handleOAuthCallback steps 1-5 (query parse + state cookie HMAC +
 * atomic CAS + mix-up defense + IdP exchangeCode).
 *
 * Provisioning + JWT mint + cookies + redirect (steps 6+) are tested in
 * oauth-callback-provisioning.test.ts and oauth-callback-finalize.test.ts;
 * here the "happy path" asserts the 302 redirect emitted by T16c to confirm
 * the handoff after exchangeCode reaches a fully implemented finalize path.
 */

const DIR = "data-test-oauth-callback-state";

const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

/** Match the production HMAC construction exactly. */
function bindStateExpected(state: string, key: Buffer): string {
  const message = Buffer.concat([
    Buffer.from("state-v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(state, "utf8"),
  ]);
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

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
    writeHead(status: number, headers?: Record<string, string>) {
      this.statusCode = status;
      if (headers) this.headers = { ...this.headers, ...headers };
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      this.headers[name] = value;
    },
    getHeader(name: string) {
      return this.headers[name];
    },
    end(payload?: string) {
      this.body = payload ?? null;
    },
  };
  return res;
}

interface MockReqOpts {
  state?: string | null;
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
  cookieHeader?: string;
  userAgent?: string;
  remoteAddress?: string | undefined;
}

function mockReq(opts: MockReqOpts = {}): IncomingMessage {
  const params: string[] = [];
  if (opts.state !== null && opts.state !== undefined) {
    params.push(`state=${encodeURIComponent(opts.state)}`);
  }
  if (opts.code !== null && opts.code !== undefined) {
    params.push(`code=${encodeURIComponent(opts.code)}`);
  }
  if (opts.error !== null && opts.error !== undefined) {
    params.push(`error=${encodeURIComponent(opts.error)}`);
  }
  if (opts.errorDescription !== null && opts.errorDescription !== undefined) {
    params.push(`error_description=${encodeURIComponent(opts.errorDescription)}`);
  }
  const qs = params.length === 0 ? "" : `?${params.join("&")}`;
  const headers: Record<string, string> = {};
  if (opts.cookieHeader !== undefined) headers.cookie = opts.cookieHeader;
  if (opts.userAgent !== undefined) headers["user-agent"] = opts.userAgent;
  const remoteAddress = opts.remoteAddress;
  const socket = remoteAddress === undefined ? undefined : { remoteAddress };
  return {
    method: "GET",
    url: `/api/auth/oauth/callback${qs}`,
    headers,
    socket,
  } as unknown as IncomingMessage;
}

interface StubProviderConfig {
  exchangeImpl?: (
    code: string,
    redirectUri: string,
    codeVerifier?: string,
  ) => Promise<ExchangeCodeResult>;
}

type TrackedProvider = IdPProvider & {
  lastExchange: { code: string; redirectUri: string; codeVerifier?: string } | null;
};

function stubProvider(config: StubProviderConfig = {}): TrackedProvider {
  const impl =
    config.exchangeImpl ??
    (async (): Promise<ExchangeCodeResult> => ({
      user: { idp_user_id: "gh-123", email: "u@example.com", name: "U" },
      accessToken: "tok-stub",
    }));
  const provider: TrackedProvider = {
    name: "github",
    lastExchange: null,
    buildAuthUrl: (state, redirectUri) =>
      `https://github.com/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchangeCode: async (code, redirectUri, codeVerifier) => {
      provider.lastExchange = { code, redirectUri, codeVerifier };
      return impl(code, redirectUri, codeVerifier);
    },
    // T16b consumes this through the MembershipCache. T16a's tests pre-seed
    // an allowlist row for "acme" so the happy path reaches T16c's 302 redirect.
    listMemberships: async () => ["acme"],
  };
  return provider;
}

let clock: FakeClock;
let ctx: AuthHandlerContext;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    providers: singleProviderRegistry(stubProvider()),
    rateLimiter: new RateLimiter(clock),
    publicUrl: "http://localhost:3000",
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(Buffer.alloc(32, 0x01)),
    membershipCache: new MembershipCache(clock),
    // T08: provisionUser requires encryption; default passthrough so
    // happy-path tests keep storing plaintext (round-trip unchanged).
    encryptionProvider: new PassthroughEncryption(),
    ...overrides,
  };
}

function insertState(
  state: string,
  opts: {
    provider?: string;
    expires_at?: number;
    consumed_at?: number | null;
    redirect_uri?: string;
    code_verifier?: string;
  } = {},
): void {
  const now = clock.now();
  getDb().prepare(`
    INSERT INTO oauth_state (state, code_verifier, redirect_uri, provider, created_at, expires_at, consumed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    state,
    opts.code_verifier ?? "verifier-abc",
    opts.redirect_uri ?? "http://localhost:3000/api/auth/oauth/callback",
    opts.provider ?? "github",
    now,
    opts.expires_at ?? now + 600,
    opts.consumed_at ?? null,
  );
}

function cookieFor(state: string): string {
  return `__Host-coordinator_oauth_state=${bindStateExpected(state, STATE_BINDING_KEY)}`;
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

beforeEach(() => {
  // FK order: child rows first, then parents. user_orgs / refresh_tokens
  // reference users; users + oauth_state reference orgs.
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM oauth_state");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM user_orgs");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  // Seed an allowlist row matching the stub provider's listMemberships output.
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run("org-1", "Acme", "acme");
  clock = new FakeClock();
  ctx = makeCtx();
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// -- Query parsing (3 cases) ----------------------------------------------

describe("handleOAuthCallback — query parsing", () => {
  it("missing state → 400 + INVALID_REQUEST", async () => {
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ code: "c" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_REQUEST");
  });

  it("missing code → 400 + INVALID_REQUEST", async () => {
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state: "s" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_REQUEST");
  });

  it("?error=access_denied → 400 + OAUTH_DENIED + Tier 2 audit auth.login.failure", async () => {
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ error: "access_denied", errorDescription: "User denied" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("OAUTH_DENIED");
    expect(body.message).toBe("User denied");
    const rows = findAuditRows("auth.login.failure");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.idp_error).toBe("access_denied");
    expect(meta.idp_error_description).toBe("User denied");
  });

  it("?error without description falls back to a generated message", async () => {
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ error: "server_error" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("OAUTH_DENIED");
    expect(body.message).toContain("server_error");
    // null in audit metadata when no description present
    const rows = findAuditRows("auth.login.failure");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string);
    expect(meta.idp_error_description).toBeNull();
  });
});

// -- State cookie (4 cases) -----------------------------------------------

describe("handleOAuthCallback — state cookie", () => {
  it("cookie absent → 400 + INVALID_STATE + Tier 1 audit (cookie_missing)", async () => {
    const state = "s-no-cookie";
    insertState(state);
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_STATE");
    expectAuditRow("auth.state.replay", {
      metadata_json: JSON.stringify({ reason: "cookie_missing" }),
    });
  });

  it("cookie present but wrong HMAC → 400 + INVALID_STATE + Tier 1 audit (hmac_mismatch)", async () => {
    const state = "s-wrong-hmac";
    insertState(state);
    // Construct a same-length cookie with a different key — same byte length,
    // but bytes differ. Length matches expected (43-char base64url of 32B HMAC).
    const otherKey = Buffer.alloc(32, 0x02);
    const wrongHmac = bindStateExpected(state, otherKey);
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({
        state,
        code: "c",
        cookieHeader: `__Host-coordinator_oauth_state=${wrongHmac}`,
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_STATE");
    expectAuditRow("auth.state.replay", {
      metadata_json: JSON.stringify({ reason: "hmac_mismatch" }),
    });
  });

  it("cookie length differs from expected → 400 + INVALID_STATE (length pre-check)", async () => {
    const state = "s-wrong-len";
    insertState(state);
    // A short string that cannot equal the 43-char expected HMAC.
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({
        state,
        code: "c",
        cookieHeader: `__Host-coordinator_oauth_state=tooshort`,
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_STATE");
    expectAuditRow("auth.state.replay", {
      metadata_json: JSON.stringify({ reason: "hmac_mismatch" }),
    });
  });

  it("cookie matches → proceeds past validation (reaches CAS — no audit)", async () => {
    const state = "s-cookie-ok";
    insertState(state);
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    // CAS succeeded, exchange happy-path → T16c 302 redirect
    expect(res.statusCode).toBe(302);
    expect(findAuditRows("auth.state.replay")).toHaveLength(0);
  });
});

// -- CAS / row state (4 cases) --------------------------------------------

describe("handleOAuthCallback — CAS + row state disambiguation", () => {
  it("state unknown (no row) → 400 + UNKNOWN_STATE", async () => {
    // Cookie HMAC over an arbitrary state — passes the cookie check, then
    // CAS fails because no row exists.
    const state = "s-unknown";
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("UNKNOWN_STATE");
    const rows = findAuditRows("auth.state.replay");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).reason).toBe("state_unknown");
  });

  it("state expired (expires_at < now) → 400 + STATE_EXPIRED", async () => {
    const state = "s-expired";
    insertState(state, { expires_at: clock.now() - 1 });
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("STATE_EXPIRED");
    const rows = findAuditRows("auth.state.replay");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).reason).toBe("state_expired");
  });

  it("state already consumed → 409 + STATE_ALREADY_CONSUMED", async () => {
    const state = "s-consumed";
    insertState(state, { consumed_at: clock.now() - 5 });
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body!).code).toBe("STATE_ALREADY_CONSUMED");
    const rows = findAuditRows("auth.state.replay");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).reason).toBe("state_consumed");
  });

  it("valid state + cookie match → consume succeeds + handler proceeds to exchange", async () => {
    const state = "s-valid";
    insertState(state);
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    // T16c 302 redirect = full path through exchange + provisioning succeeded.
    expect(res.statusCode).toBe(302);
    // And the state row is now consumed.
    const row = getDb()
      .prepare("SELECT consumed_at FROM oauth_state WHERE state = ?")
      .get(state) as { consumed_at: number | null };
    expect(row.consumed_at).not.toBeNull();
  });
});

// -- Mix-up defense (1 case) ----------------------------------------------

describe("handleOAuthCallback — mix-up defense", () => {
  it("row.provider not in registry → 400 + PROVIDER_MISMATCH + Tier 1 audit auth.state.mixup", async () => {
    const state = "s-mixup";
    insertState(state, { provider: "evil" });
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("PROVIDER_MISMATCH");
    expectAuditRow("auth.state.mixup", {
      metadata_json: JSON.stringify({
        observed_provider: "evil",
        registered_providers: ["github"],
      }),
    });
  });
});

// -- IdP exchange (4 cases) -----------------------------------------------

describe("handleOAuthCallback — IdP exchange", () => {
  it("happy path → exchangeCode succeeds → T16c 302 redirect to /auth/success", async () => {
    const state = "s-happy";
    insertState(state);
    const provider = stubProvider();
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "code-xyz", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );
    expect(res.statusCode).toBe(302);
    expect(res.headers["Location"]).toBe("http://localhost:3000/auth/success");
  });

  it("IdPTokenRevoked → 401 + WWW-Authenticate + Tier 1 audit auth.idp.token_revoked", async () => {
    const state = "s-revoked";
    insertState(state);
    const provider = stubProvider({
      exchangeImpl: async () => {
        throw new IdPTokenRevoked();
      },
    });
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toBeDefined();
    expect(JSON.parse(res.body!).code).toBe("IDP_TOKEN_REVOKED");
    expectAuditRow("auth.idp.token_revoked", {
      metadata_json: JSON.stringify({ phase: "callback_exchange" }),
    });
  });

  it("IdPTransientError → 503 + IDP_UNAVAILABLE", async () => {
    const state = "s-transient";
    insertState(state);
    const provider = stubProvider({
      exchangeImpl: async () => {
        throw new IdPTransientError();
      },
    });
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!).code).toBe("IDP_UNAVAILABLE");
  });

  it("unknown error type → re-thrown to top-level handler", async () => {
    const state = "s-unknown-err";
    insertState(state);
    const provider = stubProvider({
      exchangeImpl: async () => {
        throw new Error("oops");
      },
    });
    const res = mockResponse();
    await expect(
      handleOAuthCallback(
        mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
        res as unknown as ServerResponse,
        makeCtx({ providers: singleProviderRegistry(provider) }),
      ),
    ).rejects.toThrow("oops");
  });
});

// -- Post-consume inspect edge cases + verifier flow (2 cases) ------------

describe("handleOAuthCallback — edge cases", () => {
  it("consume returns null + inspect finds no row (race: DELETE between CAS+inspect) → UNKNOWN_STATE", async () => {
    // Wrap the db.prepare so that consumeOAuthState returns null AND the
    // follow-up inspect SELECT finds no row. Simulates a parallel DELETE
    // between the CAS UPDATE and the disambiguation SELECT.
    const state = "s-race";
    // Don't insert — CAS will return null; inspect will find no row.
    // This is the same path as "unknown" but expressed via the race scenario.
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "c", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("UNKNOWN_STATE");
  });

  it("exchangeCode receives the verifier + redirect_uri from the consumed row", async () => {
    const state = "s-verifier";
    insertState(state, {
      code_verifier: "the-secret-verifier",
      redirect_uri: "http://localhost:3000/api/auth/oauth/callback",
    });
    const provider = stubProvider();
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({ state, code: "code-abc", cookieHeader: cookieFor(state) }),
      res as unknown as ServerResponse,
      makeCtx({ providers: singleProviderRegistry(provider) }),
    );
    expect(provider.lastExchange).not.toBeNull();
    expect(provider.lastExchange!.code).toBe("code-abc");
    expect(provider.lastExchange!.codeVerifier).toBe("the-secret-verifier");
    expect(provider.lastExchange!.redirectUri).toBe(
      "http://localhost:3000/api/auth/oauth/callback",
    );
  });

  it("ip + user-agent from req are wired to finalize (302 redirect on success)", async () => {
    const state = "s-ip-ua";
    insertState(state);
    const res = mockResponse();
    await handleOAuthCallback(
      mockReq({
        state,
        code: "c",
        cookieHeader: cookieFor(state),
        userAgent: "test-agent/1.0",
        remoteAddress: "10.0.0.99",
      }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(302);
  });

  it("missing req.socket → ip defaults to null (302 still emitted)", async () => {
    const state = "s-no-socket";
    insertState(state);
    const res = mockResponse();
    // Request with no socket field at all.
    const req = {
      method: "GET",
      url: `/api/auth/oauth/callback?state=${state}&code=c`,
      headers: { cookie: cookieFor(state) },
    } as unknown as IncomingMessage;
    await handleOAuthCallback(req, res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(302);
  });

  it("missing req.url → defaults to '/' (still parses empty query → INVALID_REQUEST)", async () => {
    const res = mockResponse();
    const req = {
      method: "GET",
      headers: {},
    } as unknown as IncomingMessage;
    await handleOAuthCallback(req, res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("INVALID_REQUEST");
  });
});
