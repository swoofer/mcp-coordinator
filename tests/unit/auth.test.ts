import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth, createToken, verifyToken, refreshToken, authenticateRequest, isRevoked, revokeAgent } from "../../src/auth.js";
import type { IncomingMessage } from "http";
import fs from "fs";

const TEST_DIR = "data-test-auth";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM revoked_agents");
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("JWT operations", () => {
  beforeAll(() => {
    initAuth("test-secret-at-least-32-characters-long!");
  });

  it("createToken returns a JWT string with 3 parts", async () => {
    const token = await createToken("agent-1", "agent");
    expect(token.split(".")).toHaveLength(3);
  });

  it("verifyToken accepts a valid token", async () => {
    const token = await createToken("agent-1", "agent");
    const claims = await verifyToken(token);
    expect(claims.sub).toBe("agent-1");
    expect(claims.role).toBe("agent");
  });

  it("verifyToken rejects an expired token", async () => {
    const token = await createToken("agent-1", "agent", "0s");
    await new Promise((r) => setTimeout(r, 1100));
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it("verifyToken rejects a token signed with wrong key", async () => {
    const token = await createToken("agent-1", "agent");
    initAuth("different-secret-at-least-32-characters!");
    await expect(verifyToken(token)).rejects.toThrow();
    initAuth("test-secret-at-least-32-characters-long!");
  });

  it("createToken distinguishes agent and admin roles", async () => {
    const agentToken = await createToken("a1", "agent");
    const adminToken = await createToken("a2", "admin");
    const agentClaims = await verifyToken(agentToken);
    const adminClaims = await verifyToken(adminToken);
    expect(agentClaims.role).toBe("agent");
    expect(adminClaims.role).toBe("admin");
  });

  it("refreshToken returns a new token with same sub and role", async () => {
    const original = await createToken("agent-1", "agent");
    const refreshed = await refreshToken(original);
    expect(refreshed).not.toBe(original);
    const claims = await verifyToken(refreshed);
    expect(claims.sub).toBe("agent-1");
    expect(claims.role).toBe("agent");
  });

  it("createToken includes user_id, org, jti claims", async () => {
    const token = await createToken("agent-1", "agent");
    const claims = await verifyToken(token);
    expect(claims.user_id).toBeDefined();
    expect(claims.org).toBe("default");
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
  });

  it("createToken accepts new optional user_id and org parameters", async () => {
    const token = await createToken("agent-1", "agent", undefined, {
      user_id: "user-abc",
      org: "acme-corp",
    });
    const claims = await verifyToken(token);
    expect(claims.user_id).toBe("user-abc");
    expect(claims.org).toBe("acme-corp");
  });

  it("verifyToken defaults missing user_id/org on legacy tokens (backward compat)", async () => {
    // Manually mint a v0.6-shaped token (no user_id, no org) using internal jose
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode("test-secret-at-least-32-characters-long!");
    const legacyToken = await new SignJWT({ role: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("legacy-agent")
      .setExpirationTime("1h")
      .sign(key);
    const claims = await verifyToken(legacyToken);
    expect(claims.user_id).toBe("legacy");
    expect(claims.org).toBe("default");
  });

  it("createToken supports the 'member' role", async () => {
    const token = await createToken("user-1", "member");
    const claims = await verifyToken(token);
    expect(claims.role).toBe("member");
  });
});

function mockRequest(headers: Record<string, string> = {}, url = "/api/register"): IncomingMessage {
  return { headers, url, method: "POST" } as unknown as IncomingMessage;
}

describe("authenticateRequest guard", () => {
  it("rejects request without Authorization header", async () => {
    const result = await authenticateRequest(mockRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects request with invalid token", async () => {
    const result = await authenticateRequest(mockRequest({ authorization: "Bearer invalid.token.here" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts request with valid agent token", async () => {
    const token = await createToken("agent-guard", "agent");
    const result = await authenticateRequest(mockRequest({ authorization: `Bearer ${token}` }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-guard");
      expect(result.claims.role).toBe("agent");
    }
  });

  it("rejects agent token on admin-only route", async () => {
    const token = await createToken("agent-no-admin", "agent");
    const result = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${token}` }, "/api/auth/revoke"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("accepts admin token on admin-only route", async () => {
    const token = await createToken("admin-1", "admin");
    const result = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${token}` }, "/api/auth/revoke"),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects revoked agent token", async () => {
    const token = await createToken("agent-revoked", "agent");
    revokeAgent("agent-revoked", "admin-1");
    const result = await authenticateRequest(mockRequest({ authorization: `Bearer ${token}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe("Revocation", () => {
  it("isRevoked returns false for non-revoked agent", () => {
    expect(isRevoked("agent-not-revoked")).toBe(false);
  });

  it("revokeAgent marks agent as revoked", () => {
    revokeAgent("agent-to-revoke", "admin-1");
    expect(isRevoked("agent-to-revoke")).toBe(true);
  });

  it("revokeAgent is idempotent", () => {
    revokeAgent("agent-idem", "admin-1");
    revokeAgent("agent-idem", "admin-1");
    expect(isRevoked("agent-idem")).toBe(true);
  });
});

describe("Auth endpoint flows", () => {
  it("full registration flow: register â†’ use token â†’ refresh", async () => {
    const agentId = "flow-agent-1";
    const token = await createToken(agentId, "agent");
    const claims = await verifyToken(token);
    expect(claims.sub).toBe(agentId);
    expect(claims.role).toBe("agent");

    const newToken = await refreshToken(token);
    const newClaims = await verifyToken(newToken);
    expect(newClaims.sub).toBe(agentId);
    expect(newClaims.role).toBe("agent");
    expect(newToken).not.toBe(token);
  });

  it("revocation flow: create token â†’ revoke â†’ guard rejects", async () => {
    const agentId = "revoke-flow-agent";
    const token = await createToken(agentId, "agent");

    const before = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${token}` }),
    );
    expect(before.ok).toBe(true);

    revokeAgent(agentId, "admin-test");

    const after = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${token}` }),
    );
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.status).toBe(403);
  });

  it("admin flow: admin token can access admin routes", async () => {
    const adminToken = await createToken("admin-flow", "admin");
    const result = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${adminToken}` }, "/api/reset"),
    );
    expect(result.ok).toBe(true);
  });

  it("refresh with expired token within grace period", async () => {
    const token = await createToken("grace-agent", "agent", "1s");
    await new Promise((r) => setTimeout(r, 1500));
    await expect(verifyToken(token)).rejects.toThrow();
    const newToken = await refreshToken(token);
    const claims = await verifyToken(newToken);
    expect(claims.sub).toBe("grace-agent");
  });
});

describe("Auth disabled pass-through", () => {
  it("authenticateRequest still works independently of COORDINATOR_AUTH_ENABLED", async () => {
    // authenticateRequest itself always validates â€” the COORDINATOR_AUTH_ENABLED flag
    // is checked in serve-http.ts before calling authenticateRequest.
    // This test verifies the guard works in isolation.
    const token = await createToken("pass-through-agent", "agent");
    const result = await authenticateRequest(mockRequest({ authorization: `Bearer ${token}` }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("pass-through-agent");
    }
  });
});

describe("BUG: ADMIN_ONLY_ROUTES bypass with query string", () => {
  it("agent token should be rejected on /api/reset?foo but exact match allows bypass", async () => {
    // ADMIN_ONLY_ROUTES uses `url === r` (exact match) but req.url includes query strings
    // So "/api/reset?foo=bar" !== "/api/reset" and the admin check is bypassed
    const agentToken = await createToken("agent-bypass", "agent");
    const result = await authenticateRequest(
      mockRequest({ authorization: `Bearer ${agentToken}` }, "/api/reset?foo=bar"),
    );
    // BUG: This should be rejected (status 403) because /api/reset is admin-only
    // but the exact match fails so it passes through as ok: true
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe("revoked_agents table", () => {
  it("exists and accepts inserts", () => {
    const db = getDb();
    db.prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)").run("a1", "admin1");
    const row = db.prepare("SELECT * FROM revoked_agents WHERE agent_id = ?").get("a1") as { agent_id: string; revoked_by: string; revoked_at: string };
    expect(row.agent_id).toBe("a1");
    expect(row.revoked_by).toBe("admin1");
    expect(row.revoked_at).toBeDefined();
  });

  it("enforces primary key uniqueness", () => {
    const db = getDb();
    db.prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)").run("a2", "admin1");
    expect(() => {
      db.prepare("INSERT INTO revoked_agents (agent_id, revoked_by) VALUES (?, ?)").run("a2", "admin1");
    }).toThrow();
  });
});


