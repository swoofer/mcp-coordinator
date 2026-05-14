import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import crypto from "node:crypto";
import fs from "node:fs";
import { handleDeviceAuthorization, handleDeviceApprove } from "../../src/auth/device-flow.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { MembershipCache } from "../../src/auth/membership-cache.js";
import type { IdPProvider } from "../../src/auth/providers/types.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { findAuditRows } from "../helpers/audit.js";

/**
 * T17 — POST /api/auth/oauth/device_authorization (RFC 8628 §3.1 init).
 *
 * Coverage targets:
 *   - 200 + JSON shape (device_code, user_code, verification_uri[_complete],
 *     expires_in=600, interval=5) per RFC 8628 §3.2
 *   - device_code = 256-bit base64url
 *   - user_code = 8 chars from unambiguous alphabet, XXXX-XXXX format
 *   - DB row persisted with requester forensics
 *   - Cache-Control: no-store
 *   - Rate limit per IP: 5/min + 20/hr (V4 NR11), 429 + Retry-After
 *   - Per-IP isolation
 *   - Tier 2 audit auth.device.code_issued
 *   - UNIQUE collision retry (≤3 attempts) → success / 500-on-exhaustion
 *   - Phase 2 tolerates missing client_id and empty body
 *   - publicUrl trailing-slash normalization
 */

const DIR = "data-test-oauth-device-auth";

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

interface MockReqOptions {
  body?: string;
  ip?: string;
  userAgent?: string;
  /** When true, omit the socket field entirely (forces req.socket?. fallback). */
  noSocket?: boolean;
}

function mockReq(opts: MockReqOptions = {}): IncomingMessage {
  const body = opts.body ?? "client_id=test-client";
  const ip = "ip" in opts ? opts.ip : "127.0.0.1";
  const stream = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  // Attach the minimal IncomingMessage surface the handler reads.
  const socket = opts.noSocket
    ? undefined
    : ip === undefined
      ? {}
      : { remoteAddress: ip };
  const headers: Record<string, string> = {};
  if (opts.userAgent !== undefined) headers["user-agent"] = opts.userAgent;
  (stream as unknown as { method: string }).method = "POST";
  (stream as unknown as { url: string }).url = "/api/auth/oauth/device_authorization";
  (stream as unknown as { socket: unknown }).socket = socket;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
}

// Stub IdP — handleDeviceAuthorization never calls into the provider (Phase 2
// uses GitHub device flow only at poll time, not init). Provided to satisfy
// the AuthHandlerContext type.
const STUB_PROVIDER: IdPProvider = {
  name: "github",
  buildAuthUrl: () => "https://github.com/login/oauth/authorize?stub=1",
  exchangeCode: async () => {
    throw new Error("not used in T17");
  },
};

const STATE_BINDING_KEY = Buffer.alloc(32, 0x01);

let clock: FakeClock;
let ctx: AuthHandlerContext;

function makeCtx(overrides: Partial<AuthHandlerContext> = {}): AuthHandlerContext {
  return {
    db: getDb() as unknown as AuthHandlerContext["db"],
    clock,
    githubProvider: STUB_PROVIDER,
    rateLimiter: new RateLimiter(clock),
    publicUrl: "http://localhost:3000",
    stateBindingKey: STATE_BINDING_KEY,
    signingKeys: buildJwtKeyRegistry(Buffer.alloc(32, 0x01)),
    membershipCache: new MembershipCache(clock),
    ...overrides,
  };
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Reset device_auth_requests + audit_log between tests so per-test
  // assertions on row counts / unique constraints stay isolated.
  getDb().exec("DELETE FROM device_auth_requests");
  getDb().exec("DELETE FROM audit_log");
  clock = new FakeClock();
  ctx = makeCtx();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleDeviceAuthorization — happy path", () => {
  it("returns 200 + RFC 8628 §3.2 JSON shape", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!) as Record<string, unknown>;
    expect(body).toHaveProperty("device_code");
    expect(body).toHaveProperty("user_code");
    expect(body).toHaveProperty("verification_uri");
    expect(body).toHaveProperty("verification_uri_complete");
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it("device_code is 43-char base64url (256-bit entropy)", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    const body = JSON.parse(res.body!) as { device_code: string };
    expect(body.device_code).toHaveLength(43);
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("user_code matches the unambiguous-alphabet XXXX-XXXX pattern", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    const body = JSON.parse(res.body!) as { user_code: string };
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  });

  it("user_code never contains ambiguous chars I, O, 0, 1, U (alphabet is 20-char unambiguous set)", async () => {
    // Run many iterations to catch a regression that admitted any ambiguous
    // char — alphabet has 20 chars, so single-shot risk is high without bulk.
    // Note: the canonical alphabet "BCDFGHJKLMNPQRSTVWXZ" intentionally
    // includes V (commonly readable in monospace TV/CLI fonts) while
    // excluding U; this matches the spec's literal alphabet string.
    for (let i = 0; i < 50; i++) {
      const res = mockResponse();
      await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, makeCtx());
      const body = JSON.parse(res.body!) as { user_code: string };
      expect(body.user_code).not.toMatch(/[IO01U]/);
    }
  });

  it("Cache-Control: no-store header is set", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("Content-Type is application/json", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    const ct = res.headers["Content-Type"];
    expect(typeof ct).toBe("string");
    expect(ct as string).toContain("application/json");
  });
});

describe("handleDeviceAuthorization — DB persistence", () => {
  it("inserts a row with matching device_code, user_code, requester_ip", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "203.0.113.7" }),
      res as unknown as ServerResponse,
      ctx,
    );
    const body = JSON.parse(res.body!) as { device_code: string; user_code: string };
    const row = getDb()
      .prepare("SELECT * FROM device_auth_requests WHERE device_code = ?")
      .get(body.device_code) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row?.user_code).toBe(body.user_code);
    expect(row?.requester_ip).toBe("203.0.113.7");
    expect(row?.org_id).toBeNull();
    expect(row?.requester_country).toBeNull();
  });

  it("populates requester_user_agent from the User-Agent header", async () => {
    const res = mockResponse();
    const ua = "essaim-cli/1.2.3 (linux)";
    await handleDeviceAuthorization(
      mockReq({ userAgent: ua }),
      res as unknown as ServerResponse,
      ctx,
    );
    const body = JSON.parse(res.body!) as { device_code: string };
    const row = getDb()
      .prepare("SELECT requester_user_agent FROM device_auth_requests WHERE device_code = ?")
      .get(body.device_code) as { requester_user_agent: string | null };
    expect(row.requester_user_agent).toBe(ua);
  });

  it("missing User-Agent header stores requester_user_agent = NULL", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ /* no userAgent */ }),
      res as unknown as ServerResponse,
      ctx,
    );
    const body = JSON.parse(res.body!) as { device_code: string };
    const row = getDb()
      .prepare("SELECT requester_user_agent FROM device_auth_requests WHERE device_code = ?")
      .get(body.device_code) as { requester_user_agent: string | null };
    expect(row.requester_user_agent).toBeNull();
  });

  it("stores expires_at = now + 600s (as stringified epoch seconds)", async () => {
    clock.set(1_700_000_000);
    const freshCtx = makeCtx();
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, freshCtx);
    const body = JSON.parse(res.body!) as { device_code: string };
    const row = getDb()
      .prepare("SELECT expires_at FROM device_auth_requests WHERE device_code = ?")
      .get(body.device_code) as { expires_at: string };
    expect(typeof row.expires_at).toBe("string");
    expect(Number(row.expires_at)).toBe(1_700_000_600);
  });

  it("missing socket.remoteAddress stores requester_ip = NULL ('unknown' bucket → null)", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ noSocket: true }),
      res as unknown as ServerResponse,
      ctx,
    );
    const body = JSON.parse(res.body!) as { device_code: string };
    const row = getDb()
      .prepare("SELECT requester_ip FROM device_auth_requests WHERE device_code = ?")
      .get(body.device_code) as { requester_ip: string | null };
    expect(row.requester_ip).toBeNull();
  });
});

describe("handleDeviceAuthorization — verification URIs", () => {
  it("verification_uri = publicUrl + /auth/device", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    const body = JSON.parse(res.body!) as { verification_uri: string };
    expect(body.verification_uri).toBe("http://localhost:3000/auth/device");
  });

  it("verification_uri_complete carries the URL-encoded user_code as a query param", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    const body = JSON.parse(res.body!) as {
      user_code: string;
      verification_uri_complete: string;
    };
    // Hyphen is RFC 3986 unreserved → encodeURIComponent leaves it literal.
    // Validate the URL parses and the user_code query param round-trips.
    const expected = `http://localhost:3000/auth/device/confirm?user_code=${encodeURIComponent(body.user_code)}`;
    expect(body.verification_uri_complete).toBe(expected);
    const parsed = new URL(body.verification_uri_complete);
    expect(parsed.searchParams.get("user_code")).toBe(body.user_code);
  });

  it("publicUrl with trailing slash → no double slash in verification URIs", async () => {
    const slashedCtx = makeCtx({ publicUrl: "http://localhost:3000/" });
    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, slashedCtx);
    const body = JSON.parse(res.body!) as {
      verification_uri: string;
      verification_uri_complete: string;
    };
    expect(body.verification_uri).toBe("http://localhost:3000/auth/device");
    expect(body.verification_uri).not.toContain("//auth");
    expect(body.verification_uri_complete).not.toContain("//auth");
  });
});

describe("handleDeviceAuthorization — rate limiting", () => {
  it("6th request from same IP within a minute returns 429 + Retry-After", async () => {
    const sharedCtx = makeCtx();
    for (let i = 0; i < 5; i++) {
      const r = mockResponse();
      await handleDeviceAuthorization(
        mockReq({ ip: "1.2.3.4" }),
        r as unknown as ServerResponse,
        sharedCtx,
      );
      expect(r.statusCode).toBe(200);
    }
    const blocked = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "1.2.3.4" }),
      blocked as unknown as ServerResponse,
      sharedCtx,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(blocked.body!) as { code: string; message: string };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toContain("per minute");
  });

  it("per-hour cap trips even when per-minute bucket is refilled (V4 NR11)", async () => {
    // The per-hour bucket (20 / 3600s) drains independently of the per-minute
    // bucket. Cycle 5 calls + advance 61s 4 times = 20 successful calls in
    // 244s; the token-bucket model leaves a small partial refill (244 *
    // 20/3600 = 1.36 tokens) so call 21 still goes through. Call 22, made
    // in the same tick as call 21, finds the per-hour bucket below 1 token
    // and trips the per-hour 429 branch (per-min still has spare tokens).
    const sharedCtx = makeCtx();
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let i = 0; i < 5; i++) {
        const r = mockResponse();
        await handleDeviceAuthorization(
          mockReq({ ip: "5.6.7.8" }),
          r as unknown as ServerResponse,
          sharedCtx,
        );
        expect(r.statusCode).toBe(200);
      }
      clock.advance(61);
    }
    // Call 21: per-min refilled to 5, per-hour around 1.36 → consumed → 0.36
    const ok21 = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "5.6.7.8" }),
      ok21 as unknown as ServerResponse,
      sharedCtx,
    );
    expect(ok21.statusCode).toBe(200);

    // Call 22: same tick (no advance) → per-min still has 4 tokens, per-hour
    // is now < 1 → per-hour branch trips.
    const blocked = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "5.6.7.8" }),
      blocked as unknown as ServerResponse,
      sharedCtx,
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["Retry-After"]).toBeDefined();
    const body = JSON.parse(blocked.body!) as { code: string; message: string };
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toContain("per hour");
  });

  it("rate limit is per-IP independent (5 from IP-A doesn't block IP-B)", async () => {
    const sharedCtx = makeCtx();
    for (let i = 0; i < 5; i++) {
      const a = mockResponse();
      await handleDeviceAuthorization(
        mockReq({ ip: "10.0.0.1" }),
        a as unknown as ServerResponse,
        sharedCtx,
      );
      expect(a.statusCode).toBe(200);
    }
    // IP-A blocked
    const aBlocked = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "10.0.0.1" }),
      aBlocked as unknown as ServerResponse,
      sharedCtx,
    );
    expect(aBlocked.statusCode).toBe(429);
    // IP-B still fine
    const b = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "10.0.0.2" }),
      b as unknown as ServerResponse,
      sharedCtx,
    );
    expect(b.statusCode).toBe(200);
  });
});

describe("handleDeviceAuthorization — audit emission", () => {
  it("emits Tier 2 auth.device.code_issued audit row with user_code in metadata", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ ip: "172.16.0.9", userAgent: "audit-test/1" }),
      res as unknown as ServerResponse,
      ctx,
    );
    const body = JSON.parse(res.body!) as { user_code: string };
    const rows = findAuditRows("auth.device.code_issued");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json as string) as Record<string, unknown>;
    expect(meta.user_code).toBe(body.user_code);
    expect(meta.requester_ip).toBe("172.16.0.9");
    expect(meta.requester_ua).toBe("audit-test/1");
  });
});

describe("handleDeviceAuthorization — RFC 8628 client_id tolerance (Phase 2)", () => {
  it("missing client_id form field is accepted (Phase 2 single-client)", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ body: "" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
  });

  it("empty form body is accepted (no required fields validated)", async () => {
    const res = mockResponse();
    await handleDeviceAuthorization(
      mockReq({ body: "" }),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!) as { device_code: string; user_code: string };
    expect(body.device_code).toBeDefined();
    expect(body.user_code).toBeDefined();
  });

  it("400 INVALID_REQUEST when the body stream errors", async () => {
    // Force parseFormBody to reject by emitting an error on the stream.
    const failing = new Readable({
      read() {
        process.nextTick(() => this.emit("error", new Error("stream boom")));
      },
    }) as unknown as IncomingMessage;
    (failing as unknown as { method: string }).method = "POST";
    (failing as unknown as { url: string }).url = "/api/auth/oauth/device_authorization";
    (failing as unknown as { socket: unknown }).socket = { remoteAddress: "1.1.1.1" };
    (failing as unknown as { headers: Record<string, string> }).headers = {};

    const res = mockResponse();
    await handleDeviceAuthorization(failing, res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!) as { code: string };
    expect(body.code).toBe("INVALID_REQUEST");
  });
});

describe("handleDeviceApprove — stub", () => {
  it("stub returns 501 NOT_IMPLEMENTED envelope (T20 owner)", async () => {
    // T17 ships only handleDeviceAuthorization; the approve handler remains a
    // stub. This test pins the stub's response contract so future regressions
    // accidentally swapping it for an empty handler fail loudly.
    const res = mockResponse();
    await handleDeviceApprove(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(501);
    const body = JSON.parse(res.body!) as { code: string };
    expect(body.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("handleDeviceAuthorization — collision retry", () => {
  it("retry succeeds after one UNIQUE collision on user_code", async () => {
    // Force first generateUserCode() call to produce 'BBBB-BBBB' (8 zeros from
    // randomInt(0,20) → alphabet[0] = 'B'), then 'CCCC-CCCC' (8 ones → 'C').
    // Pre-insert a row with user_code='BBBB-BBBB' so attempt #1 collides,
    // attempt #2 succeeds.
    getDb().prepare(
      `INSERT INTO device_auth_requests
        (device_code, user_code, nonce, expires_at, requester_ip, requester_user_agent, requester_country)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "preexisting-device-code-collision",
      "BBBB-BBBB",
      crypto.randomBytes(16).toString("base64url"),
      String(clock.now() + 600),
      null,
      null,
      null,
    );

    const spy = vi.spyOn(crypto, "randomInt") as unknown as ReturnType<typeof vi.fn>;
    let call = 0;
    spy.mockImplementation(((..._args: unknown[]) => {
      // First 8 calls → 0 ('B'), next 8 → 1 ('C'). Subsequent calls (shouldn't
      // happen) fall through to 0 to avoid surprise.
      const idx = call++;
      if (idx < 8) return 0;
      if (idx < 16) return 1;
      return 0;
    }) as unknown as (...args: unknown[]) => number);

    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!) as { user_code: string };
    expect(body.user_code).toBe("CCCC-CCCC");
  });

  it("returns 500 INTERNAL_ERROR after 3 consecutive UNIQUE collisions", async () => {
    // Pre-insert 'BBBB-BBBB' and force every randomInt() call to return 0 so
    // all 3 retries regenerate the same colliding code → exhaustion path.
    getDb().prepare(
      `INSERT INTO device_auth_requests
        (device_code, user_code, nonce, expires_at, requester_ip, requester_user_agent, requester_country)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "preexisting-device-code-3coll",
      "BBBB-BBBB",
      crypto.randomBytes(16).toString("base64url"),
      String(clock.now() + 600),
      null,
      null,
      null,
    );

    const spy = vi.spyOn(crypto, "randomInt") as unknown as ReturnType<typeof vi.fn>;
    spy.mockImplementation(((..._args: unknown[]) => 0) as unknown as (...args: unknown[]) => number);

    const res = mockResponse();
    await handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, ctx);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body!) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("Could not allocate a device code");
  });

  it("non-UNIQUE INSERT failures propagate (not swallowed by retry)", async () => {
    // Replace ctx.db.prepare to return a stmt whose run() throws a non-UNIQUE
    // SQL error. The handler should rethrow rather than retry.
    const fakeDb = {
      prepare: () => ({
        run: () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
      }),
    } as unknown as AuthHandlerContext["db"];
    const brokenCtx = makeCtx({ db: fakeDb });
    const res = mockResponse();
    await expect(
      handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, brokenCtx),
    ).rejects.toThrow(/SQLITE_BUSY/);
  });

  it("INSERT throwing a non-Error (no .message) still propagates via the no-collision branch", async () => {
    // Hits the `?? ""` defensive branch on (err as Error).message — covers
    // the case where some lower layer throws a plain object/string instead
    // of an Error instance.
    const fakeDb = {
      prepare: () => ({
        run: () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw { not_an_error: true };
        },
      }),
    } as unknown as AuthHandlerContext["db"];
    const brokenCtx = makeCtx({ db: fakeDb });
    const res = mockResponse();
    await expect(
      handleDeviceAuthorization(mockReq(), res as unknown as ServerResponse, brokenCtx),
    ).rejects.toBeDefined();
  });
});
