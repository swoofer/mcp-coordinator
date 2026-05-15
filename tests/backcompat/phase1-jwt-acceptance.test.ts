import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import { SignJWT } from "jose";
import {
  initDatabase as initGlobalDatabase,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import {
  initAuth,
  createToken,
  authenticateRequest,
  initPhase2Auth,
  resetPhase2Auth,
} from "../../src/auth.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { TIER2_EVENTS } from "../../src/security/audit-events.js";
import { getDb } from "../../src/database.js";
import Database from "better-sqlite3";

/**
 * T43 — Phase 1 backcompat: JWT acceptance.
 *
 * Proves Phase 1-shaped JWTs (org="default", no family_id, no
 * active_org_id, signed with the legacy HS256 secret via createToken)
 * continue to verify under v0.8.0 auth.ts even when AUTH_ENABLED=true.
 * Also confirms that Phase 2 cookie-scenario verification (Scenario 5)
 * rejects Phase 1-shaped JWTs presented as the __Host-coordinator_session
 * cookie — these must NOT silently succeed with the wrong claims.
 *
 * Refs: V2 §B T43, V4 §14.3 deprecation telemetry.
 */

const DIR = "data-test-backcompat-jwt";
const PHASE1_SECRET = "test-secret-at-least-32-characters-long!";

function mockRequest(
  headers: Record<string, string> = {},
  url = "/api/register",
  method = "POST",
): IncomingMessage {
  return { headers, url, method } as unknown as IncomingMessage;
}

beforeEach(() => {
  resetPhase2Auth();
  resetAuditQueue();
  fs.mkdirSync(DIR, { recursive: true });
  initGlobalDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

afterEach(() => {
  resetPhase2Auth();
  resetAuditQueue();
  try { closeGlobalDb(); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* EBUSY ignored */ }
});

describe("Phase 1 JWT acceptance under v0.8.0 auth.ts", () => {
  it("createToken mints a Phase 1-shaped JWT with org='default', role, user_id", async () => {
    const token = await createToken("agent-1", "admin", undefined, {
      user_id: "agent-1",
      org: "default",
    });
    expect(token.split(".")).toHaveLength(3);
    // Inspect the claims by decoding the middle segment (base64url JSON).
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    expect(payload.role).toBe("admin");
    expect(payload.org).toBe("default");
    expect(payload.user_id).toBe("agent-1");
    expect(payload.sub).toBe("agent-1");
    // Phase 1 JWTs do NOT carry family_id, active_org_id, service_account.
    expect(payload.family_id).toBeUndefined();
    expect(payload.active_org_id).toBeUndefined();
    expect(payload.service_account).toBeUndefined();
  });

  it("authenticateRequest accepts a Phase 1 JWT under AUTH_ENABLED=true", async () => {
    const token = await createToken("agent-phase1", "admin", undefined, {
      user_id: "agent-phase1",
      org: "default",
    });
    const req = mockRequest(
      { authorization: `Bearer ${token}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-phase1");
      expect(result.claims.user_id).toBe("agent-phase1");
      expect(result.claims.org).toBe("default");
      expect(result.claims.role).toBe("admin");
      // Phase 1 path does NOT populate Phase 2-only claims.
      expect(result.claims.active_org_id).toBeUndefined();
      expect(result.claims.family_id).toBeUndefined();
    }
  });

  it("Phase 1 Bearer path still works when Phase 2 cookie wiring is ALSO active", async () => {
    // Wire Phase 2 deps so Scenario 5 (cookie path) is active, but present
    // a Bearer header instead of a cookie. Bearer wins per spec §9.5
    // precedence — and the Phase 1-signed token must still verify via the
    // Phase 1 HS256 secret (verifyTokenStrict), NOT via the Phase 2 key
    // registry. This protects the upgrade-in-place path.
    const db = getDb() as unknown as Database.Database;
    const phase2Secret = Buffer.from("a-different-32-byte-secret-for-test!!", "utf8");
    initPhase2Auth({
      db,
      signingKeys: buildJwtKeyRegistry(phase2Secret),
      publicUrl: "http://localhost:3100",
    });
    const token = await createToken("agent-phase1", "admin", undefined, {
      user_id: "agent-phase1",
      org: "default",
    });
    const req = mockRequest(
      { authorization: `Bearer ${token}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-phase1");
      expect(result.claims.org).toBe("default");
    }
  });

  it("auth.legacy_token.accepted is listed in TIER2_EVENTS for V4 §14.3 telemetry", () => {
    // Documents the deprecation-telemetry contract per V4 §14.3. The actual
    // emission of the event is not yet wired into the Phase 1 acceptance
    // path — T43 just validates the upgrade path doesn't break. Once the
    // emission ships in a follow-up task, this assertion remains stable
    // (the event name and tier classification are the contract).
    const events: readonly string[] = TIER2_EVENTS;
    expect(events).toContain("auth.legacy_token.accepted");
  });

  it("Phase 1 JWT presented as __Host-coordinator_session cookie is rejected", async () => {
    // Scenario 5 (Phase 2 cookie path) requires:
    //   1. kid header on JWT (Phase 1 mints WITHOUT kid)
    //   2. issuer claim matching ctx.publicUrl
    //   3. signature verifiable via Phase 2 signingKeys (different secret)
    // Phase 1 JWTs miss all three. Reject path must be 401 — NEVER silent
    // acceptance with wrong claims.
    const db = getDb() as unknown as Database.Database;
    const phase2Secret = Buffer.from("a-different-32-byte-secret-for-test!!", "utf8");
    initPhase2Auth({
      db,
      signingKeys: buildJwtKeyRegistry(phase2Secret),
      publicUrl: "http://localhost:3100",
    });
    const phase1Token = await createToken("agent-phase1", "admin", undefined, {
      user_id: "agent-phase1",
      org: "default",
    });
    const req = mockRequest(
      { cookie: `__Host-coordinator_session=${phase1Token}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      // Must explicitly NOT carry Phase 1 claims through to a 200.
      expect(result.error).toMatch(/Invalid session/);
    }
  });

  it("Phase 1 JWT signed with WRONG secret is rejected (defense vs forgery)", async () => {
    // Mint a Phase 1-shaped token using a different signing key — must NOT
    // verify against the current secret. Confirms the v0.8 upgrade didn't
    // accidentally widen the acceptable signer set.
    const wrongKey = new TextEncoder().encode(
      "a-completely-different-secret-32-chars!",
    );
    const forgedToken = await new SignJWT({
      role: "admin",
      user_id: "evil",
      org: "default",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("evil")
      .setExpirationTime("1h")
      .sign(wrongKey);
    const req = mockRequest(
      { authorization: `Bearer ${forgedToken}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  it("Phase 1 JWT with no org/user_id (v0.6-shaped) is rejected under AUTH_ENABLED=true", async () => {
    // Pre-Phase-1 (v0.6) tokens lacked org + user_id. Scenario (c) under
    // AUTH_ENABLED=true must reject these with 401 "upgrade required" —
    // confirming the v0.6→v0.7 boundary set by Phase 1 is still enforced
    // in v0.8.
    const key = new TextEncoder().encode(PHASE1_SECRET);
    const v06Token = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("v06-agent")
      .setExpirationTime("1h")
      .sign(key);
    const req = mockRequest(
      { authorization: `Bearer ${v06Token}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/v0\.6 token rejected/);
    }
  });
});
