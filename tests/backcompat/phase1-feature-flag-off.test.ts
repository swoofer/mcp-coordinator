import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import Database from "better-sqlite3";
import { bootPhase2 } from "../../src/boot.js";
import { FakeClock } from "../helpers/clock.js";
import {
  initDatabase as initGlobalDatabase,
  getDb as getGlobalDb,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import { auditLog, audit, resetAuditQueue } from "../../src/security/audit.js";
import {
  authenticateRequest,
  initAuth,
  resetPhase2Auth,
  createToken,
} from "../../src/auth.js";
import { dispatchAuthRoutes } from "../../src/http/auth-routes.js";
import type { AuthHandlerContext } from "../../src/auth/context.js";
import { deriveStateBindingKey } from "../../src/auth/crypto-keys.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { mintAccessJWT } from "../../src/auth/jwt-mint.js";

/**
 * T43 — Phase 1 backcompat: feature-flag-off path.
 *
 * Proves PR #27's claim that "Phase 1 deployments are byte-identical when
 * COORDINATOR_OAUTH_ENABLED is unset". When Phase 2 wiring is absent
 * (no initPhase2Auth, no initAuditQueue, no bootPhase2 returned), every
 * Phase 1 surface (auditLog, authenticateRequest, audit fallback,
 * dispatchAuthRoutes for non-auth URLs, T08b crypto helpers) must continue
 * to function as if Phase 2 didn't exist.
 *
 * Refs: V2 §B T43.
 */

const DIR = "data-test-backcompat-flag-off";

function mockRequest(
  headers: Record<string, string> = {},
  url = "/api/register",
  method = "POST",
): IncomingMessage {
  return { headers, url, method } as unknown as IncomingMessage;
}

const ENV_KEYS = ["COORDINATOR_OAUTH_ENABLED"];
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  // Ensure no prior test leaked Phase 2 wiring.
  resetPhase2Auth();
  resetAuditQueue();
  fs.mkdirSync(DIR, { recursive: true });
  initGlobalDatabase(DIR);
  initAuth("test-secret-at-least-32-characters-long!");
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPhase2Auth();
  resetAuditQueue();
  try { closeGlobalDb(); } catch { /* ignore */ }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {
    /* Windows EBUSY ignored — vitest re-runs handle file locks */
  }
});

describe("Phase 1 backcompat — COORDINATOR_OAUTH_ENABLED unset/false", () => {
  it("bootPhase2({ enabled: false }) returns null", () => {
    const clock = new FakeClock(1_700_000_000);
    const db = getGlobalDb() as unknown as Database.Database;
    const result = bootPhase2({ enabled: false, db, clock });
    expect(result).toBeNull();
  });

  it("bootPhase2({ enabled: false }) doesn't initialize the audit queue", () => {
    const clock = new FakeClock(1_700_000_000);
    const db = getGlobalDb() as unknown as Database.Database;
    bootPhase2({ enabled: false, db, clock });
    // No queue ever initialized — audit() must use the Tier 1 sync fallback.
    // Verify by calling audit() and confirming the row landed synchronously
    // (no queue means no enqueue path).
    audit("auth.login.success", { tier: 2, metadata: { phase1: true } });
    const row = getGlobalDb()
      .prepare("SELECT action, outcome FROM audit_log WHERE action = 'auth.login.success'")
      .get() as { action: string; outcome: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("success");
  });

  it("authenticateRequest with no initPhase2Auth: cookie path falls through", async () => {
    // Send a request with ONLY a session cookie — no Authorization header.
    // Without phase2Ctx wired, the cookie is ignored and Scenario (a) (no
    // Bearer + authEnabled=false) returns synthetic legacy claims.
    const req = mockRequest(
      { cookie: "__Host-coordinator_session=irrelevant.cookie.value" },
      "/api/register",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("legacy");
      expect(result.claims.org).toBe("default");
      expect(result.claims.role).toBe("admin");
    }
  });

  it("authenticateRequest with cookie + authEnabled=true: cookie ignored, 401 returned", async () => {
    const req = mockRequest(
      { cookie: "__Host-coordinator_session=irrelevant.cookie.value" },
      "/api/register",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    // No phase2Ctx → cookie path skipped → no Bearer header → Scenario (b) 401.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toMatch(/Bearer realm="mcp-coordinator"/);
    }
  });

  it("Phase 1 auditLog continues to work (writes to audit_log)", () => {
    auditLog({
      user_id: "phase1-user",
      org_id: "default",
      action: "thread.create",
      target: "thread-1",
      metadata: { phase: 1 },
    });
    const row = getGlobalDb()
      .prepare("SELECT action, actor_user_id, actor_org_id, metadata_json FROM audit_log WHERE action = 'thread.create'")
      .get() as { action: string; actor_user_id: string; actor_org_id: string; metadata_json: string };
    expect(row.actor_user_id).toBe("phase1-user");
    expect(row.actor_org_id).toBe("default");
    expect(JSON.parse(row.metadata_json)).toEqual({ phase: 1 });
  });

  it("audit() with no initAuditQueue falls back to sync direct INSERT", () => {
    // T11a interlude: when _auditQueue is null, every tier — including Tier 2 —
    // goes through the sync INSERT path. This guarantees correctness on Phase 1
    // deployments where the queue was never initialized.
    audit("auth.refresh.rotated", {
      tier: 2,
      target: "user-phase1",
      metadata: { reason: "phase1-test" },
    });
    const row = getGlobalDb()
      .prepare("SELECT action, target, outcome FROM audit_log WHERE action = 'auth.refresh.rotated'")
      .get() as { action: string; target: string; outcome: string };
    expect(row.action).toBe("auth.refresh.rotated");
    expect(row.target).toBe("user-phase1");
    expect(row.outcome).toBe("success");
  });

  it("dispatchAuthRoutes returns false for non-auth URLs even without bootstrap", async () => {
    // We can pass a minimal AuthHandlerContext — the dispatcher short-circuits
    // on URL match BEFORE touching ctx for non-auth URLs.
    const req = mockRequest({}, "/api/threads", "GET");
    let writeHeadCalled = false;
    const res = {
      writeHead: () => { writeHeadCalled = true; },
      end: () => {},
      setHeader: () => {},
    } as unknown as import("node:http").ServerResponse;
    const handled = await dispatchAuthRoutes(
      req,
      res,
      {} as unknown as AuthHandlerContext,
    );
    expect(handled).toBe(false);
    // No response written — caller (serve-http) falls through to handleRest.
    expect(writeHeadCalled).toBe(false);
  });

  it("T08b crypto helpers are pure functions callable without bootPhase2", async () => {
    // deriveStateBindingKey + buildJwtKeyRegistry + mintAccessJWT are pure;
    // they don't depend on any module-level state. Phase 1 callers (e.g.,
    // tests that need to mint a JWT for a unit test) must keep working
    // without going through bootPhase2.
    const secret = Buffer.from("a-32-byte-secret-for-test-only!!!", "utf8");
    const key = deriveStateBindingKey(secret);
    expect(key.length).toBe(32);

    const registry = buildJwtKeyRegistry(secret);
    expect(registry.current.kid).toBe("hs256-v1");

    const jwt = await mintAccessJWT({
      claims: {
        sub: "user-test",
        active_org_id: "default",
        family_id: "fam-1",
        role: "member",
      },
      registry,
      issuer: "http://localhost:3100",
      ttlSeconds: 900,
    });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("Phase 1 createToken still produces verifiable JWTs without bootPhase2", async () => {
    // Phase 1 createToken uses the module-level HS256 signing key seeded by
    // initAuth (NOT the Phase 2 registry). This must work standalone.
    const token = await createToken("agent-phase1", "agent", undefined, {
      user_id: "user-phase1",
      org: "default",
    });
    expect(token.split(".")).toHaveLength(3);
    // Use the token to authenticate.
    const req = mockRequest(
      { authorization: `Bearer ${token}` },
      "/api/threads",
      "GET",
    );
    const result = await authenticateRequest(req, { authEnabled: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.user_id).toBe("user-phase1");
      expect(result.claims.org).toBe("default");
      expect(result.claims.role).toBe("agent");
    }
  });
});
