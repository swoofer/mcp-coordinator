import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import { SignJWT } from "jose";
import {
  initAuth,
  createToken,
  authenticateRequest,
  initPhase2Auth,
  resetPhase2Auth,
} from "../../src/auth.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import { mintAccessJWT } from "../../src/auth/jwt-mint.js";
import { resetEpochFloorForTest } from "../../src/auth/token-epoch.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import type Database from "better-sqlite3";

/**
 * Regression: Phase 2 access JWTs presented as `Authorization: Bearer` must
 * authenticate under PRODUCTION key wiring.
 *
 * The bug (v0.13.x): authenticateRequest only tried the Phase 2 verifier when
 * the Phase 1 `verifyTokenStrict` THREW. In production both key materials are
 * derived from the same COORDINATOR_JWT_SECRET —
 *
 *   Phase 1: serve-http.ts `initAuth(JWT_SECRET)`      -> TextEncoder().encode(s)
 *   Phase 2: boot.ts `buildJwtKeyRegistry(Buffer.from(s, "utf8"))`
 *
 * — so the two keys are byte-identical and Phase 1 verification SUCCEEDS on a
 * Phase 2 token. It then reported `wasLegacy: true` (Phase 2 tokens carry
 * `sub`/`active_org_id`, never the Phase 1 `user_id`/`org` pair), and every
 * Bearer request 401'd with "v0.6 token rejected". Only cookie-bearing browser
 * clients worked; the SDK device flow and the CLI service-token path did not.
 *
 * The pre-existing Phase 2 suites all missed this because their benches sign
 * the two phases with DIFFERENT secrets, which makes Phase 1 verification
 * throw and routes into the fallback that production never reaches. This file
 * therefore derives BOTH keys from ONE secret, mirroring boot wiring exactly,
 * and asserts that fact up front so the bench can never silently drift back.
 */

const DIR = "data-test-auth-bearer-prod-wiring";

// The single operator-supplied secret. Both phases derive from this, as in prod.
const COORDINATOR_JWT_SECRET = "prod-wiring-secret-at-least-32-chars-long!";
const ISSUER = "http://localhost:3000";

// Mirrors src/boot.ts:229 + :277.
const registry = buildJwtKeyRegistry(Buffer.from(COORDINATOR_JWT_SECRET, "utf8"));

interface MockReqOpts {
  authorization?: string;
  cookie?: string;
  url?: string;
  method?: string;
}

function mockReq(opts: MockReqOpts = {}): IncomingMessage {
  const headers: Record<string, string> = {};
  if (opts.authorization) headers.authorization = opts.authorization;
  if (opts.cookie) headers.cookie = opts.cookie;
  return {
    headers,
    url: opts.url ?? "/api/threads",
    method: opts.method ?? "GET",
  } as unknown as IncomingMessage;
}

function sessionCookie(token: string): string {
  return `__Host-coordinator_session=${token}`;
}

function seedOrg(orgId = "org-acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", "acme");
}

function seedUser(id = "u-alice", tokenEpoch = 0): void {
  getDb()
    .prepare(
      `INSERT INTO users
         (id, primary_org_id, email, idp_provider, idp_user_id, role, token_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, "org-acme", `${id}@example.com`, "github", `gh-${id}`, "member", tokenEpoch);
}

/** Mint through the REAL production mint path (oauth-finalize / refresh-rotation
 *  / service-tokens all funnel through this). */
function mintProdAccessJWT(
  claims: Partial<Parameters<typeof mintAccessJWT>[0]["claims"]> = {},
): Promise<string> {
  return mintAccessJWT({
    claims: {
      sub: "u-alice",
      active_org_id: "org-acme",
      family_id: "fam-1",
      role: "member",
      ...claims,
    },
    registry,
    issuer: ISSUER,
    ttlSeconds: 900,
  });
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  // Mirrors src/serve-http.ts:1257 — same secret string as the registry above.
  initAuth(COORDINATOR_JWT_SECRET);
});

beforeEach(() => {
  resetEpochFloorForTest();
  resetAuditQueue();
  getDb().exec("DELETE FROM audit_log");
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM revoked_agents");
  getDb().exec("DELETE FROM orgs");
  resetPhase2Auth();
  initPhase2Auth({
    db: getDb() as unknown as Database.Database,
    signingKeys: registry,
    publicUrl: ISSUER,
  });
  seedOrg();
  seedUser();
});

afterAll(() => {
  resetPhase2Auth();
  resetAuditQueue();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("bench fidelity — Phase 1 and Phase 2 keys are byte-identical", () => {
  it("initAuth's TextEncoder key equals buildJwtKeyRegistry's Buffer key", () => {
    // This is the production invariant that the older Phase 2 benches broke by
    // using two different secrets. If this ever fails, every Bearer assertion
    // in this file is testing the wrong code path.
    const phase1Key = new TextEncoder().encode(COORDINATOR_JWT_SECRET);
    expect(Buffer.from(registry.current.key)).toEqual(Buffer.from(phase1Key));
  });

  it("a Phase 2 access JWT verifies against the Phase 1 key (so Phase 1 does NOT throw)", async () => {
    // Documents the precise reason the old on-throw fallback never fired in
    // production: jwtVerify with the Phase 1 key succeeds on a Phase 2 token.
    const { jwtVerify } = await import("jose");
    const token = await mintProdAccessJWT();
    const { payload } = await jwtVerify(token, new TextEncoder().encode(COORDINATOR_JWT_SECRET), {
      algorithms: ["HS256"],
    });
    expect(payload.sub).toBe("u-alice");
    // ...and it has none of the Phase 1 v0.7 markers, which is what made the
    // dispatcher classify it as a legacy v0.6 token.
    expect(payload.user_id).toBeUndefined();
    expect(payload.org).toBeUndefined();
  });
});

describe("Phase 2 access JWT via Authorization: Bearer (production wiring)", () => {
  it("is accepted and returns Phase 2 claims", async () => {
    const token = await mintProdAccessJWT();
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.claims.sub).toBe("u-alice");
      expect(result.claims.user_id).toBe("u-alice");
      expect(result.claims.org).toBe("org-acme");
      expect(result.claims.active_org_id).toBe("org-acme");
      expect(result.claims.family_id).toBe("fam-1");
      expect(result.claims.role).toBe("member");
    }
  });

  it("yields the same claims as the __Host-coordinator_session cookie path", async () => {
    const token = await mintProdAccessJWT();
    const viaBearer = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    const viaCookie = await authenticateRequest(mockReq({ cookie: sessionCookie(token) }), {
      authEnabled: true,
    });
    expect(viaBearer.ok).toBe(true);
    expect(viaCookie.ok).toBe(true);
    if (viaBearer.ok && viaCookie.ok) {
      expect(viaBearer.claims).toEqual(viaCookie.claims);
    }
  });

  it("accepts an admin-role token on an admin-only route", async () => {
    getDb().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run("u-alice");
    const token = await mintProdAccessJWT({ role: "admin" });
    const result = await authenticateRequest(
      mockReq({ authorization: `Bearer ${token}`, url: "/api/reset", method: "POST" }),
      { authEnabled: true },
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe("Bearer path still runs the Phase 2 security checks", () => {
  it("rejects when the user's token_epoch was bumped after the token was issued", async () => {
    const token = await mintProdAccessJWT();
    // Admin force-revoke: bump the epoch past the token's iat.
    getDb()
      .prepare("UPDATE users SET token_epoch = ? WHERE id = ?")
      .run(Math.floor(Date.now() / 1000) + 60, "u-alice");
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a refresh token presented as a Bearer credential (typ confusion)", async () => {
    const refresh = await new SignJWT({
      sub: "u-alice",
      active_org_id: "org-acme",
      family_id: "fam-1",
      typ: "refresh",
    })
      .setProtectedHeader({ alg: "HS256", kid: registry.current.kid })
      .setIssuer(ISSUER)
      .setJti("refresh-as-bearer")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(registry.current.key);
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${refresh}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a service-account token whose jti is not in refresh_tokens", async () => {
    // T25/V4 §5.5: service tokens DB-validate their jti on every request. The
    // Bearer path must enforce this too, not just the cookie path.
    const token = await mintAccessJWT({
      claims: {
        sub: "u-alice",
        active_org_id: "org-acme",
        family_id: "service:not-issued",
        role: "service",
        service_account: true,
        scope: "read",
      },
      registry,
      issuer: ISSUER,
      ttlSeconds: 900,
    });
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a token minted for a different issuer", async () => {
    const token = await mintAccessJWT({
      claims: {
        sub: "u-alice",
        active_org_id: "org-acme",
        family_id: "fam-1",
        role: "member",
      },
      registry,
      issuer: "https://evil.example",
      ttlSeconds: 900,
    });
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("rejects a kid-bearing token signed with the wrong key", async () => {
    const token = await new SignJWT({
      active_org_id: "org-acme",
      family_id: "fam-1",
      role: "member",
      typ: "access",
    })
      .setProtectedHeader({ alg: "HS256", kid: "hs256-v1" })
      .setIssuer(ISSUER)
      .setSubject("u-alice")
      .setJti("forged")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(new Uint8Array(Buffer.alloc(32, 0x99)));
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("Phase 1 Bearer backcompat is preserved", () => {
  it("a kid-less Phase 1 v0.7 token still authenticates alongside Phase 2 wiring", async () => {
    const token = await createToken("agent-phase1", "admin", undefined, {
      user_id: "agent-phase1",
      org: "default",
    });
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${token}` }), {
      authEnabled: true,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-phase1");
      expect(result.claims.org).toBe("default");
      expect(result.claims.active_org_id).toBeUndefined();
    }
  });

  it("a kid-less v0.6 legacy token is still rejected under AUTH_ENABLED=true", async () => {
    const legacy = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("agent-v06")
      .setJti("legacy-jti")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(COORDINATOR_JWT_SECRET));
    const result = await authenticateRequest(mockReq({ authorization: `Bearer ${legacy}` }), {
      authEnabled: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toContain("v0.6 token rejected");
    }
  });
});
