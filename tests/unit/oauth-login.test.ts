import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { findAuditRows } from "../helpers/audit.js";
import { handleAuthLogin } from "../../src/auth/oauth-login.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { singleProviderRegistry } from "../helpers/index.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";

/**
 * T15 — GET /auth/login handler.
 *
 * Coverage targets:
 *   - 302 redirect to GitHub authorize URL with state + PKCE S256
 *   - HMAC-bound state cookie (V4 FIX 19 canonical construction)
 *   - Rate-limit (30/min/IP) + 429 with Retry-After
 *   - Trailing-slash normalization on publicUrl → redirect_uri
 *   - PKCE verifier persisted in oauth_state matches the code_challenge
 */

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

function mockReq(
  remoteAddress: string | undefined = "127.0.0.1",
  url = "/auth/login",
): IncomingMessage {
  // Cast a minimal duck-typed object as IncomingMessage. The handler only
  // reads req.socket?.remoteAddress and req.url; everything else stays
  // undefined.
  const socket = remoteAddress === undefined ? undefined : { remoteAddress };
  return { method: "GET", url, socket } as unknown as IncomingMessage;
}

function setCookieEntries(res: MockResponse): string[] {
  const sc = res.headers["Set-Cookie"];
  if (Array.isArray(sc)) return sc;
  if (typeof sc === "string") return [sc];
  return [];
}

/** Parse a single Set-Cookie line into { value, attrs }. */
function parseSetCookie(raw: string): { value: string; attrs: Record<string, string | boolean> } {
  const parts = raw.split(";").map((p) => p.trim());
  const [first, ...rest] = parts;
  const eq = first.indexOf("=");
  const value = first.slice(eq + 1);
  const attrs: Record<string, string | boolean> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i === -1) attrs[p.toLowerCase()] = true;
    else attrs[p.slice(0, i).toLowerCase()] = p.slice(i + 1);
  }
  return { value, attrs };
}

const STUB_PROVIDER: IdPProvider = {
  name: "github",
  buildAuthUrl: (state, redirectUri, codeChallenge) => {
    const u = new URL("https://github.com/login/oauth/authorize");
    u.searchParams.set("client_id", "TEST");
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    if (codeChallenge) {
      u.searchParams.set("code_challenge", codeChallenge);
      u.searchParams.set("code_challenge_method", "S256");
    }
    return u.toString();
  },
  exchangeCode: async () => {
    throw new Error("not used");
  },
};

const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

function bindStateExpected(state: string, key: Buffer): string {
  const message = Buffer.concat([
    Buffer.from("state-v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(state, "utf8"),
  ]);
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

let db: Database.Database;
let clock: FakeClock;
let ctx: AuthHandlerContext;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db,
    clock,
    providers: singleProviderRegistry(STUB_PROVIDER),
    rateLimiter: new RateLimiter(clock),
    publicUrl: "http://localhost:3000",
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(Buffer.alloc(32, 0x01)),
    membershipCache: new MembershipCache(clock),
    ...overrides,
  };
}

// #320: audit() writes through the module-level getDb(), which this file never
// initialised -- ctx.db is a bare in-memory handle carrying only oauth_state.
// A real database is opened alongside it so the audit rows have somewhere to
// land; the handler keeps using ctx.db for state, exactly as before.
let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(nodePath.join(tmpdir(), "oauth-login-audit-"));
  initDatabase(auditDir);
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE oauth_state (
      state           TEXT PRIMARY KEY,
      code_verifier   TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      provider        TEXT NOT NULL,
      org_id          TEXT,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      consumed_at     INTEGER,
      nonce           TEXT
    );
  `);
  clock = new FakeClock();
  ctx = makeCtx();
});

afterEach(() => {
  db.close();
  closeDb();
  try {
    rmSync(auditDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite handle a moment after close.
  }
});

describe("handleAuthLogin — happy path", () => {
  it("returns 302 with Location header pointing to GitHub authorize", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(302);
    const loc = res.headers.Location;
    expect(typeof loc).toBe("string");
    expect(loc as string).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  });

  it("Location URL includes state matching the persisted row", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state");
    expect(state).not.toBeNull();
    const row = db.prepare("SELECT * FROM oauth_state WHERE state = ?").get(state) as
      { state: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.state).toBe(state);
  });

  it("Location URL includes code_challenge = SHA-256(code_verifier).base64url", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state")!;
    const challenge = loc.searchParams.get("code_challenge");
    expect(challenge).not.toBeNull();

    const row = db.prepare("SELECT code_verifier FROM oauth_state WHERE state = ?").get(state) as {
      code_verifier: string;
    };
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(row.code_verifier, "ascii")
      .digest("base64url");
    expect(challenge).toBe(expectedChallenge);
  });

  it("Location URL includes code_challenge_method=S256", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("response body is empty (302 has no body)", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.body).toBeNull();
  });
});

describe("handleAuthLogin — state cookie attributes", () => {
  it("sets __Host-coordinator_oauth_state with SameSite=Lax + HttpOnly + Secure + Path=/ + Max-Age=600", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const cookies = setCookieEntries(res);
    expect(cookies).toHaveLength(1);
    const raw = cookies[0];
    expect(raw.startsWith("__Host-coordinator_oauth_state=")).toBe(true);
    const { attrs } = parseSetCookie(raw);
    expect(attrs.httponly).toBe(true);
    expect(attrs.secure).toBe(true);
    expect(attrs.path).toBe("/");
    expect(String(attrs.samesite).toLowerCase()).toBe("lax");
    expect(attrs["max-age"]).toBe("600");
    expect(attrs.domain).toBeUndefined();
  });

  it("cookie value is HMAC-SHA-256 over 'state-v1' || 0x00 || state, base64url-encoded", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const cookies = setCookieEntries(res);
    const { value: cookieValue } = parseSetCookie(cookies[0]);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state")!;
    const expected = bindStateExpected(state, STATE_BINDING_KEY);
    expect(cookieValue).toBe(expected);
    // Sanity: also verifiable with crypto.timingSafeEqual semantics.
    expect(
      crypto.timingSafeEqual(
        Buffer.from(cookieValue, "base64url"),
        Buffer.from(expected, "base64url"),
      ),
    ).toBe(true);
  });
});

describe("handleAuthLogin — PKCE persistence", () => {
  it("oauth_state row's code_verifier hashes to the URL's code_challenge", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state")!;
    const challenge = loc.searchParams.get("code_challenge")!;
    const row = db.prepare("SELECT code_verifier FROM oauth_state WHERE state = ?").get(state) as {
      code_verifier: string;
    };
    const recomputed = crypto
      .createHash("sha256")
      .update(row.code_verifier, "ascii")
      .digest("base64url");
    expect(recomputed).toBe(challenge);
  });

  it("state entropy >= 256 bits (43-char base64url)", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state")!;
    expect(state).toHaveLength(43);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("code_verifier entropy >= 256 bits (43-char base64url)", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state")!;
    const row = db.prepare("SELECT code_verifier FROM oauth_state WHERE state = ?").get(state) as {
      code_verifier: string;
    };
    expect(row.code_verifier).toHaveLength(43);
    expect(row.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("handleAuthLogin — redirect URI normalization", () => {
  it("redirectUri matches publicUrl + /api/auth/oauth/callback", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    const loc = new URL(res.headers.Location as string);
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/oauth/callback",
    );
    // And the persisted row carries the same URI.
    const state = loc.searchParams.get("state")!;
    const row = db.prepare("SELECT redirect_uri FROM oauth_state WHERE state = ?").get(state) as {
      redirect_uri: string;
    };
    expect(row.redirect_uri).toBe("http://localhost:3000/api/auth/oauth/callback");
  });

  it("publicUrl with trailing slash → redirectUri has no double slash", async () => {
    const slashedCtx = makeCtx({ publicUrl: "http://localhost:3000/" });
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, slashedCtx);
    const loc = new URL(res.headers.Location as string);
    expect(loc.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/oauth/callback",
    );
    expect(loc.searchParams.get("redirect_uri")).not.toContain("//api");
  });
});

describe("handleAuthLogin — rate limiting", () => {
  it("31st request from same IP returns 429 with Retry-After + RATE_LIMITED envelope", async () => {
    const sharedCtx = makeCtx();
    // 30 allowed
    for (let i = 0; i < 30; i++) {
      const res = mockResponse();
      await handleAuthLogin(mockReq("1.2.3.4"), res as unknown as ServerResponse, sharedCtx);
      expect(res.statusCode).toBe(302);
    }
    // 31st blocked
    const blocked = mockResponse();
    await handleAuthLogin(mockReq("1.2.3.4"), blocked as unknown as ServerResponse, sharedCtx);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    const ct = blocked.headers["Content-Type"];
    expect(typeof ct).toBe("string");
    expect(ct as string).toContain("application/json");
    const body = JSON.parse(blocked.body!) as { code: string; message: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  it("rate limit is independent per IP (two IPs each get 30 allowed)", async () => {
    const sharedCtx = makeCtx();
    for (let i = 0; i < 30; i++) {
      const a = mockResponse();
      await handleAuthLogin(mockReq("10.0.0.1"), a as unknown as ServerResponse, sharedCtx);
      expect(a.statusCode).toBe(302);
      const b = mockResponse();
      await handleAuthLogin(mockReq("10.0.0.2"), b as unknown as ServerResponse, sharedCtx);
      expect(b.statusCode).toBe(302);
    }
    // 31st on either IP blocks for THAT IP only.
    const a31 = mockResponse();
    await handleAuthLogin(mockReq("10.0.0.1"), a31 as unknown as ServerResponse, sharedCtx);
    expect(a31.statusCode).toBe(429);
    const b31 = mockResponse();
    await handleAuthLogin(mockReq("10.0.0.2"), b31 as unknown as ServerResponse, sharedCtx);
    expect(b31.statusCode).toBe(429);
    // A fresh IP still works.
    const fresh = mockResponse();
    await handleAuthLogin(mockReq("10.0.0.3"), fresh as unknown as ServerResponse, sharedCtx);
    expect(fresh.statusCode).toBe(302);
  });

  it("missing req.socket falls back to the 'unknown' bucket", async () => {
    const sharedCtx = makeCtx();
    const res = mockResponse();
    // Provide a request with NO socket field at all → optional chain returns undefined.
    const req = { method: "GET", url: "/auth/login" } as unknown as IncomingMessage;
    await handleAuthLogin(req, res as unknown as ServerResponse, sharedCtx);
    expect(res.statusCode).toBe(302);
  });

  it("missing socket.remoteAddress falls back to the 'unknown' bucket", async () => {
    const sharedCtx = makeCtx();
    const res = mockResponse();
    await handleAuthLogin(mockReq(undefined), res as unknown as ServerResponse, sharedCtx);
    expect(res.statusCode).toBe(302);
  });
});

// -- T49: multi-provider picker --------------------------------------

import { ProviderRegistry } from "../../src/auth/providers/registry.js";

function makeStubProvider(name: string): IdPProvider {
  return {
    name,
    buildAuthUrl: (state, redirectUri, codeChallenge) => {
      const u = new URL(`https://${name}.example/authorize`);
      u.searchParams.set("state", state);
      u.searchParams.set("redirect_uri", redirectUri);
      if (codeChallenge) u.searchParams.set("code_challenge", codeChallenge);
      return u.toString();
    },
    exchangeCode: async () => {
      throw new Error("not used");
    },
  };
}

function multiProviderRegistry(...names: string[]): ProviderRegistry {
  const r = new ProviderRegistry();
  for (const name of names) {
    r.register(makeStubProvider(name));
  }
  return r;
}

describe("handleAuthLogin — picker (multi-provider)", () => {
  it("single provider: skips picker, redirects straight to authorize URL", async () => {
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(302);
  });

  it("two providers, no ?provider= param: renders 200 HTML picker", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const res = mockResponse();
    await handleAuthLogin(mockReq(), res as unknown as ServerResponse, sharedCtx);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/<title>Sign in/);
    // Both providers should appear as buttons linking to ?provider=X.
    expect(res.body).toContain("/auth/login?provider=github");
    expect(res.body).toContain("/auth/login?provider=google");
    expect(res.body).toContain("Continue with GitHub");
    expect(res.body).toContain("Continue with Google");
  });

  it("two providers, ?provider=github: redirects to that provider's authorize URL", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=github"),
      res as unknown as ServerResponse,
      sharedCtx,
    );
    expect(res.statusCode).toBe(302);
    const loc = res.headers.Location as string;
    expect(loc).toMatch(/^https:\/\/github\.example\/authorize\?/);
  });

  it("two providers, ?provider=google: redirects to google authorize URL", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=google"),
      res as unknown as ServerResponse,
      sharedCtx,
    );
    expect(res.statusCode).toBe(302);
    const loc = res.headers.Location as string;
    expect(loc).toMatch(/^https:\/\/google\.example\/authorize\?/);
  });

  it("?provider= with unknown name: 400 UNKNOWN_PROVIDER (does not silently fall back)", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=evil"),
      res as unknown as ServerResponse,
      sharedCtx,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.code).toBe("UNKNOWN_PROVIDER");
    expect(body.message).toContain("evil");
  });

  // #320: this 400 used to be silent. It is one of exactly two paths where a
  // third party chooses the provider name -- #305 audited the other one (the
  // token endpoint) and left this, so an enumeration probe could simply move
  // across. Same event, same Tier 2, same metadata shape.
  it("?provider= with unknown name emits auth.provider.unknown", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    await handleAuthLogin(
      mockReq("198.51.100.4", "/auth/login?provider=evil"),
      mockResponse() as unknown as ServerResponse,
      sharedCtx,
    );

    const rows = findAuditRows("auth.provider.unknown");
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("denied");
    expect(JSON.parse(rows[0].metadata_json as string)).toEqual({
      observed_provider: "evil",
      registered_providers: ["github", "google"],
      phase: "login_redirect",
      client_ip: "198.51.100.4",
    });
  });

  // The handler reads `req.socket?.remoteAddress ?? null`; without a request
  // that actually lacks a socket, that fallback is never taken and
  // oauth-login.ts drops below its coverage floor.
  //
  // Built inline rather than via mockReq(undefined, ...): passing undefined
  // triggers the parameter default and hands back 127.0.0.1, which is exactly
  // the opposite of what this pins.
  it("records a null client_ip when the request carries no socket", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const socketless = {
      method: "GET",
      url: "/auth/login?provider=evil",
    } as unknown as IncomingMessage;
    await handleAuthLogin(socketless, mockResponse() as unknown as ServerResponse, sharedCtx);

    const rows = findAuditRows("auth.provider.unknown");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata_json as string).client_ip).toBeNull();
  });

  // The picker path is not a probe: no name was submitted, so nothing to audit.
  it("no ?provider= with several registered emits nothing", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    await handleAuthLogin(
      mockReq("198.51.100.4", "/auth/login"),
      mockResponse() as unknown as ServerResponse,
      sharedCtx,
    );
    expect(findAuditRows("auth.provider.unknown")).toHaveLength(0);
  });

  it("?provider= with unknown name on single-provider setup: still 400 (not silent fallback)", async () => {
    // ctx has only github registered. An explicit ?provider=oidc must
    // not redirect to github -- the user typed something specific.
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=oidc"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).code).toBe("UNKNOWN_PROVIDER");
  });

  it("?provider=github on single-provider setup: redirects normally", async () => {
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=github"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(302);
  });

  it("oauth_state row records the selected provider (not the default)", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    const res = mockResponse();
    await handleAuthLogin(
      mockReq("127.0.0.1", "/auth/login?provider=google"),
      res as unknown as ServerResponse,
      sharedCtx,
    );
    const loc = new URL(res.headers.Location as string);
    const state = loc.searchParams.get("state");
    const row = db.prepare("SELECT provider FROM oauth_state WHERE state = ?").get(state) as {
      provider: string;
    };
    expect(row.provider).toBe("google");
  });

  it("picker render still consumes a rate-limit token", async () => {
    const sharedCtx = makeCtx({
      providers: multiProviderRegistry("github", "google"),
    });
    // Burn 30 tokens via picker renders.
    for (let i = 0; i < 30; i++) {
      const r = mockResponse();
      await handleAuthLogin(mockReq(), r as unknown as ServerResponse, sharedCtx);
      expect(r.statusCode).toBe(200);
    }
    // 31st should 429.
    const blocked = mockResponse();
    await handleAuthLogin(mockReq(), blocked as unknown as ServerResponse, sharedCtx);
    expect(blocked.statusCode).toBe(429);
  });
});
