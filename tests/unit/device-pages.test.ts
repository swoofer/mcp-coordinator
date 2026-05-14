import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { handleDevicePage } from "../../src/auth/pages/device.html.js";
import { handleDeviceConfirmPage } from "../../src/auth/pages/device-confirm.html.js";
import { handleSuccessPage } from "../../src/auth/pages/success.html.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { FakeClock } from "../helpers/clock.js";
import { RateLimiter } from "../../src/auth/rate-limit.js";

/**
 * T21 — three unauthenticated HTML pages for the device-authorization flow:
 *   GET /auth/device         → user_code entry form
 *   GET /auth/device/confirm → consent page (DB lookup + per-code CSRF)
 *   GET /auth/success        → minimal post-OAuth landing page
 *
 * Verifies status codes, CSP headers from sendHtml(), Set-Cookie CSRF cookies,
 * XSS resistance via escapeHtml(), and DB-driven status code branching for
 * the confirm page (missing/invalid/expired/consumed user_code).
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

function mockReq(url: string): IncomingMessage {
  return { method: "GET", url } as IncomingMessage;
}

function setCookieEntries(res: MockResponse): string[] {
  const sc = res.headers["Set-Cookie"];
  if (Array.isArray(sc)) return sc;
  if (typeof sc === "string") return [sc];
  return [];
}

/** Build an in-memory schema matching T21's expected device_auth_requests
 *  shape (Phase 2 v0.8 + a denied_at column that T20's migration will
 *  add — for T21's page-rendering need, an inline column is enough). */
function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE device_auth_requests (
      device_code             TEXT PRIMARY KEY,
      user_code               TEXT NOT NULL UNIQUE,
      nonce                   TEXT NOT NULL,
      approved_user_id        TEXT,
      denied_at               INTEGER,
      org_id                  TEXT,
      expires_at              INTEGER NOT NULL,
      requester_ip            TEXT,
      requester_user_agent    TEXT,
      requester_country       TEXT,
      failed_approval_attempts INTEGER NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

interface InsertRowOpts {
  user_code: string;
  expires_at: number;
  approved_user_id?: string | null;
  denied_at?: number | null;
  requester_ip?: string | null;
  requester_user_agent?: string | null;
  requester_country?: string | null;
}

function insertRow(db: Database.Database, opts: InsertRowOpts): void {
  db.prepare(
    `INSERT INTO device_auth_requests
     (device_code, user_code, nonce, approved_user_id, denied_at,
      expires_at, requester_ip, requester_user_agent, requester_country)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `dc-${opts.user_code}`,
    opts.user_code,
    `nonce-${opts.user_code}`,
    opts.approved_user_id ?? null,
    opts.denied_at ?? null,
    opts.expires_at,
    opts.requester_ip ?? null,
    opts.requester_user_agent ?? null,
    opts.requester_country ?? null,
  );
}

let db: Database.Database;
let clock: FakeClock;
let ctx: AuthHandlerContext;

beforeEach(() => {
  db = new Database(":memory:");
  setupSchema(db);
  clock = new FakeClock(1_700_000_000);
  // T15 extended AuthHandlerContext; device-page handlers don't read these
  // fields but TypeScript requires they be present. Stub with safe defaults.
  ctx = {
    db,
    clock,
    githubProvider: {
      name: "github",
      buildAuthUrl: () => "https://example/unused",
      exchangeCode: async () => {
        throw new Error("not used in device-pages tests");
      },
    },
    rateLimiter: new RateLimiter(clock),
    publicUrl: "http://localhost:3000",
    stateBindingKey: Buffer.alloc(32, 0x01),
  };
});

afterEach(() => {
  db.close();
});

// -------------------------------------------------------------------------
// device.html.ts (5 tests)
// -------------------------------------------------------------------------

describe("handleDevicePage (GET /auth/device)", () => {
  it("returns 200 + HTML body containing the user_code entry form", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("<form");
    expect(res.body).toContain('name="user_code"');
    expect(res.body).toContain('action="/auth/device/confirm"');
  });

  it("sets __Host-coordinator_csrf cookie with Secure + SameSite=Strict + Max-Age=600", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device"),
      res as unknown as ServerResponse,
      ctx,
    );
    const cookies = setCookieEntries(res);
    expect(cookies.length).toBe(1);
    const csrfCookie = cookies[0]!;
    expect(csrfCookie).toMatch(/^__Host-coordinator_csrf=/);
    expect(csrfCookie).toContain("Secure");
    expect(csrfCookie.toLowerCase()).toContain("samesite=strict");
    expect(csrfCookie).toContain("Max-Age=600");
    expect(csrfCookie).toContain("Path=/");
  });

  it("renders no error block when ?error= is not present", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).not.toContain('class="error"');
  });

  it("renders the invalid_code error message for ?error=invalid_code", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device?error=invalid_code"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).toContain('class="error"');
    expect(res.body).toContain("That code wasn&#39;t recognized");
  });

  it("renders the expired error message for ?error=expired", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device?error=expired"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).toContain("That code has expired");
  });

  it("renders the consumed error message for ?error=consumed", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device?error=consumed"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).toContain("That code was already used");
  });

  it("renders the lockout error message for ?error=lockout", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device?error=lockout"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).toContain("Too many failed attempts");
  });

  it("renders the default fallback message for an unknown ?error= code", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device?error=BOGUS"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.body).toContain('class="error"');
    expect(res.body).toContain("Something went wrong");
  });

  it("emits the CSP + X-Frame-Options + Cache-Control headers via sendHtml", async () => {
    const res = mockResponse();
    await handleDevicePage(
      mockReq("/auth/device"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(res.headers["X-Frame-Options"]).toBe("DENY");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("defaults to root path when req.url is undefined (covers ?? branch)", async () => {
    const res = mockResponse();
    await handleDevicePage(
      { method: "GET" } as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('class="error"');
  });
});

// -------------------------------------------------------------------------
// device-confirm.html.ts (8 tests)
// -------------------------------------------------------------------------

describe("handleDeviceConfirmPage (GET /auth/device/confirm)", () => {
  it("returns 400 + missing error page when user_code is absent", async () => {
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("No device code provided");
  });

  it("returns 400 + invalid_code page when no row matches the user_code", async () => {
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=NOPE"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("wasn&#39;t recognized");
  });

  it("returns 400 + expired page when the row's expires_at is in the past", async () => {
    insertRow(db, { user_code: "OLDCODE", expires_at: clock.now() - 10 });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=OLDCODE"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("has expired");
  });

  it("returns 409 + consumed page when the row is already approved", async () => {
    insertRow(db, {
      user_code: "DONECODE",
      expires_at: clock.now() + 600,
      approved_user_id: "user-123",
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=DONECODE"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("already approved or denied");
  });

  it("returns 409 + consumed page when the row is already denied", async () => {
    insertRow(db, {
      user_code: "DENIED1",
      expires_at: clock.now() + 600,
      denied_at: clock.now() - 5,
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=DENIED1"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("already approved or denied");
  });

  it("returns 200 + full consent page for a valid pending row", async () => {
    insertRow(db, {
      user_code: "GOOD-1234",
      expires_at: clock.now() + 600,
      requester_ip: "203.0.113.5",
      requester_user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
      requester_country: "US",
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=GOOD-1234"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/auth/device/approve"');
    expect(res.body).toContain('name="_csrf"');
    expect(res.body).toContain('name="user_code"');
    expect(res.body).toContain("value=\"GOOD-1234\"");
    expect(res.body).toContain("203.0.113.5");
    expect(res.body).toContain("Mozilla/5.0");
    expect(res.body).toContain("US");
  });

  it("renders 'unknown' for NULL requester_ip/user_agent/country", async () => {
    insertRow(db, {
      user_code: "BARECODE",
      expires_at: clock.now() + 600,
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=BARECODE"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    // 3 placeholders (ip + ua + country) all default to "unknown"
    const matches = (res.body ?? "").match(/unknown/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("escapes malicious requester_ip to defeat HTML injection", async () => {
    insertRow(db, {
      user_code: "XSSCODE",
      expires_at: clock.now() + 600,
      requester_ip: "<script>alert(1)</script>",
      requester_user_agent: "<img src=x onerror=alert(2)>",
      requester_country: "\"><b>boom</b>",
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=XSSCODE"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).not.toContain("<img src=x onerror=alert(2)>");
    expect(res.body).not.toContain("\"><b>boom</b>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.body).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("sets per-user_code __Host-coordinator_csrf cookie with Max-Age=600", async () => {
    insertRow(db, {
      user_code: "CSRFCODE",
      expires_at: clock.now() + 600,
    });
    const res = mockResponse();
    await handleDeviceConfirmPage(
      mockReq("/auth/device/confirm?user_code=CSRFCODE"),
      res as unknown as ServerResponse,
      ctx,
    );
    const cookies = setCookieEntries(res);
    expect(cookies.length).toBe(1);
    const cookie = cookies[0]!;
    expect(cookie).toMatch(/^__Host-coordinator_csrf=/);
    expect(cookie).toContain("Secure");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
    expect(cookie).toContain("Max-Age=600");
  });

  it("defaults to root path when req.url is undefined (covers ?? branch)", async () => {
    const res = mockResponse();
    await handleDeviceConfirmPage(
      { method: "GET" } as IncomingMessage,
      res as unknown as ServerResponse,
      ctx,
    );
    // No user_code on root → 400 missing
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("No device code provided");
  });
});

// -------------------------------------------------------------------------
// success.html.ts (3 tests)
// -------------------------------------------------------------------------

describe("handleSuccessPage (GET /auth/success)", () => {
  it("returns 200 + HTML body", async () => {
    const res = mockResponse();
    await handleSuccessPage(
      mockReq("/auth/success"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
  });

  it("body contains 'You're signed in' confirmation text", async () => {
    const res = mockResponse();
    await handleSuccessPage(
      mockReq("/auth/success"),
      res as unknown as ServerResponse,
      ctx,
    );
    // Literal text in the template — no escapeHtml applied. Plain apostrophe.
    expect(res.body).toContain("You're signed in");
  });

  it("emits CSP + X-Frame-Options + Cache-Control headers via sendHtml", async () => {
    const res = mockResponse();
    await handleSuccessPage(
      mockReq("/auth/success"),
      res as unknown as ServerResponse,
      ctx,
    );
    expect(res.headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(res.headers["X-Frame-Options"]).toBe("DENY");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});
