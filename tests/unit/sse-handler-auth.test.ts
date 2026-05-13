/**
 * Task 21.5 — SSE handler auth: EventSource-compatible token transport.
 *
 * Tests the ?token= query-param fallback in authenticateRequest and the
 * 401 gate behavior. All tests exercise authenticateRequest at the unit level
 * (the same function handleSse delegates to), which avoids the AUTH_ENABLED
 * module-load-time constant limitation while still fully verifying the
 * security contract.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initAuth, createToken, authenticateRequest } from "../../src/auth.js";
import type { IncomingMessage } from "http";
import { initDatabase, closeDb } from "../../src/database.js";
import fs from "fs";

const TEST_DIR = "data-test-sse-handler-auth";
const SECRET = "test-secret-at-least-32-characters-long!";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  initAuth(SECRET);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// Module-state hygiene: reset auth so prevKey doesn't contaminate later files.
afterAll(() => {
  initAuth(SECRET);
});

// Helper — build a minimal IncomingMessage mock
function mockRequest(
  headers: Record<string, string> = {},
  url = "/api/events",
  method = "GET",
): IncomingMessage {
  return { headers, url, method } as unknown as IncomingMessage;
}

// ─── authenticateRequest unit tests (token extraction) ────────────────────────

describe("authenticateRequest — ?token= query-param fallback", () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await createToken("sse-agent", "agent", undefined, { org: "acme" });
  });

  it("accepts a valid JWT via ?token= on a GET request", async () => {
    const req = mockRequest({}, `/api/events?token=${validToken}`, "GET");
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("sse-agent");
      expect(result.claims.org).toBe("acme");
    }
  });

  it("does NOT honor ?token= on POST (smuggling defense)", async () => {
    const req = mockRequest({}, `/api/events?token=${validToken}`, "POST");
    const result = await authenticateRequest(req, { authEnabled: true });
    // POST with no Authorization header must return 401, not 200
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("Authorization header takes precedence over ?token=", async () => {
    // ?token= carries an "acme" org token; header carries a "default" org token
    const headerToken = await createToken("sse-header", "agent", undefined, { org: "default" });
    const req = mockRequest(
      { authorization: `Bearer ${headerToken}` },
      `/api/events?token=${validToken}`,
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must have used the header token ("sse-header"), not the ?token= one ("sse-agent")
      expect(result.claims.sub).toBe("sse-header");
      expect(result.claims.org).toBe("default");
    }
  });
});

// ─── 401 gate behavior (unit-level, same path as handleSse delegates to) ─────

describe("handleSse auth gate — no credentials → 401 under AUTH_ENABLED=true", () => {
  it("returns 401 when neither Authorization header nor ?token= is present and AUTH_ENABLED=true", async () => {
    // handleSse calls authenticateRequest(req, { authEnabled: AUTH_ENABLED }).
    // When AUTH_ENABLED=true and no credentials are present this must return
    // { ok: false, status: 401 }. We test that directly at the same callsite
    // level to avoid the module-load-time AUTH_ENABLED constant limitation.
    const req = mockRequest({}, "/api/events", "GET");
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toMatch(/Bearer realm="mcp-coordinator"/);
    }
  });
});
