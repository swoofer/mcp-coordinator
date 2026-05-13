import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SignJWT } from "jose";
import { initDatabase, closeDb } from "../../src/database.js";
import { initAuth, createToken, authenticateRequest, refreshToken, verifyTokenStrict } from "../../src/auth.js";
import type { IncomingMessage } from "http";
import fs from "fs";

const DIR = "data-test-bc";
const SECRET = "test-secret-at-least-32-characters-long!";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
});
afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

// CRITICAL: reset auth state so prevKey doesn't contaminate later test files
// under vitest's fileParallelism: false. See "Module-state hygiene" in Conventions.
afterAll(() => { initAuth(SECRET); });

function mockRequest(headers: Record<string, string> = {}, url = "/api/log-file"): IncomingMessage {
  return { headers, url, method: "POST" } as unknown as IncomingMessage;
}

async function mintV06Token(role: "agent" | "admin"): Promise<string> {
  // v0.6 token: no user_id, no org claims, no jti
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("legacy-agent-1")
    .setExpirationTime("1h")
    .sign(key);
}

describe("authenticateRequest backward-compat", () => {
  describe("AUTH_ENABLED=false", () => {
    it("scenario (a): no Auth header → synthetic legacy claims", async () => {
      const result = await authenticateRequest(mockRequest(), { authEnabled: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.user_id).toBe("legacy");
        expect(result.claims.org).toBe("default");
        expect(result.claims.role).toBe("admin");
      }
    });

    it("scenario (c): v0.6 JWT → accepted with injected legacy claims", async () => {
      const token = await mintV06Token("agent");
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: false },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.user_id).toBe("legacy");
        expect(result.claims.org).toBe("default");
        expect(result.claims.sub).toBe("legacy-agent-1");
      }
    });

    it("scenario (d): v0.7 JWT → standard verify, real claims preserved", async () => {
      const token = await createToken("agent-x", "agent", undefined, {
        user_id: "user-real", org: "real-org",
      });
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: false },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.user_id).toBe("user-real");
        expect(result.claims.org).toBe("real-org");
      }
    });
  });

  describe("AUTH_ENABLED=true", () => {
    it("scenario (b): no Auth header → 401 with WWW-Authenticate", async () => {
      const result = await authenticateRequest(mockRequest(), { authEnabled: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.wwwAuthenticate).toMatch(/Bearer realm="mcp-coordinator"/);
      }
    });

    it("rejects v0.6 JWTs (no user_id/org claims) → 401", async () => {
      const token = await mintV06Token("agent");
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: true },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("scenario (d): v0.7 JWT → accepted", async () => {
      const token = await createToken("agent-y", "agent", undefined, {
        user_id: "user-y", org: "default",
      });
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: true },
      );
      expect(result.ok).toBe(true);
    });

    it("rejects partial v0.7 token (user_id present, org missing)", async () => {
      const { SignJWT } = await import("jose");
      const key = new TextEncoder().encode(SECRET);
      const token = await new SignJWT({ role: "agent", user_id: "u-partial" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("agent-partial")
        .setExpirationTime("1h")
        .sign(key);
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: true },
      );
      expect(result.ok).toBe(false);
    });

    it("accepts v0.6 token with NO role claim under AUTH_ENABLED=false (scenario c+ edge)", async () => {
      const { SignJWT } = await import("jose");
      const key = new TextEncoder().encode(SECRET);
      const token = await new SignJWT({})
        .setProtectedHeader({ alg: "HS256" })
        .setSubject("ancient-agent")
        .setExpirationTime("1h")
        .sign(key);
      const result = await authenticateRequest(
        mockRequest({ authorization: `Bearer ${token}` }),
        { authEnabled: false },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // No-role token defaults to 'member' (LEAST PRIVILEGE), not 'admin'.
        expect(result.claims.role).toBe("member");
        expect(result.claims.sub).toBe("ancient-agent");
      }
    });
  });
});

describe("refreshToken backward-compat gate", () => {
  // mintV06Token reused from above

  it("rejects v0.6 token under AUTH_ENABLED=true", async () => {
    const token = await mintV06Token("agent");
    await expect(refreshToken(token, { authEnabled: true })).rejects.toThrow(/v0\.6 token/i);
  });

  it("accepts v0.6 token under AUTH_ENABLED=false AND rotates to v0.7 shape", async () => {
    const token = await mintV06Token("agent");
    const newToken = await refreshToken(token, { authEnabled: false });
    expect(newToken.split(".")).toHaveLength(3);
    // CRITICAL: rotated token MUST be v0.7-shape (the entire point of rotation)
    const { claims, wasLegacy } = await verifyTokenStrict(newToken);
    expect(wasLegacy).toBe(false);
    expect(claims.user_id).toBe("legacy");
    expect(claims.org).toBe("default");
    expect(claims.sub).toBe("legacy-agent-1");
  });
});
