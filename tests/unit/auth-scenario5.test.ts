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
import { findAuditRows } from "../helpers/audit.js";
import type Database from "better-sqlite3";

/**
 * T27 — authenticateRequest Scenario 5 (cookie-based JWT auth).
 *
 * Verifies the Phase 2 __Host-coordinator_session path added to the
 * top-level authenticateRequest dispatcher in src/auth.ts, plus the
 * precedence rules from spec §9.5: Bearer header wins over cookie;
 * cookie wins over no-auth; Phase 2 not wired falls through silently.
 */

const DIR = "data-test-auth-scenario5";
const SIGNING_SECRET = Buffer.alloc(32, 0x42);
const WRONG_SECRET = Buffer.alloc(32, 0x43);
const ISSUER = "http://localhost:3000";
const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars!";

const registry = buildJwtKeyRegistry(SIGNING_SECRET);

interface MintOpts {
  sub?: string;
  active_org_id?: string;
  family_id?: string;
  role?: string;
  jti?: string;
  iat?: number;
  ttlSeconds?: number;
  issuer?: string;
  secret?: Buffer;
  kid?: string;
  serviceAccount?: boolean;
  omitIat?: boolean;
  omitSub?: boolean;
}

async function mintSessionJWT(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    active_org_id: opts.active_org_id ?? "org-acme",
    family_id: opts.family_id ?? "fam-1",
    role: opts.role ?? "member",
  };
  if (opts.serviceAccount) claims.service_account = true;

  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? 900;
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid: opts.kid ?? "hs256-v1" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setJti(opts.jti ?? "session-jti-1");
  if (!opts.omitSub) builder.setSubject(opts.sub ?? "u-alice");
  if (!opts.omitIat) {
    builder.setIssuedAt(iat);
    builder.setExpirationTime(iat + ttl);
  }
  return builder.sign(new Uint8Array(opts.secret ?? SIGNING_SECRET));
}

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
    url: opts.url ?? "/api/something",
    method: opts.method ?? "POST",
  } as unknown as IncomingMessage;
}

function sessionCookie(token: string): string {
  return `__Host-coordinator_session=${token}`;
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

function seedOrg(orgId = "org-acme"): void {
  getDb()
    .prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)")
    .run(orgId, "Acme", "acme");
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

beforeEach(() => {
  getDb().exec("DELETE FROM audit_log");
  // T25: scenario-5 test now inserts refresh_tokens rows for the
  // service-account branch; clear them first to avoid FK violations on
  // DELETE FROM users.
  getDb().exec("DELETE FROM refresh_tokens");
  getDb().exec("DELETE FROM users");
  getDb().exec("DELETE FROM orgs");
  getDb().exec("DELETE FROM revoked_agents");
  resetPhase2Auth();
  // Default wiring for the bulk of cases. Cases that need "not wired"
  // semantics explicitly call resetPhase2Auth() AFTER the beforeEach.
  initPhase2Auth({
    db: getDb() as unknown as Database.Database,
    signingKeys: registry,
    publicUrl: ISSUER,
  });
});

afterAll(() => {
  resetPhase2Auth();
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Cookie auth happy path
// ---------------------------------------------------------------------------
describe("Scenario 5 — cookie auth happy path", () => {
  it("valid cookie + no Authorization header → claims returned", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT();
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("u-alice");
      expect(result.claims.user_id).toBe("u-alice");
      expect(result.claims.org).toBe("org-acme");
      expect(result.claims.role).toBe("member");
      expect(result.claims.active_org_id).toBe("org-acme");
      expect(result.claims.family_id).toBe("fam-1");
      expect(result.claims.jti).toBe("session-jti-1");
    }
  });

  it("cookie absent + Authorization header (Phase 1) → Bearer path used", async () => {
    // Phase 1 Bearer token still works alongside Phase 2 wiring.
    const phase1Token = await createToken("agent-bearer", "agent");
    const result = await authenticateRequest(
      mockReq({ authorization: `Bearer ${phase1Token}` }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-bearer");
      expect(result.claims.role).toBe("agent");
      // Phase 1 tokens don't carry Phase 2 extras.
      expect(result.claims.active_org_id).toBeUndefined();
      expect(result.claims.family_id).toBeUndefined();
    }
  });

  it("both cookie + Authorization → Authorization wins (Bearer precedence)", async () => {
    // The cookie JWT identifies u-alice; the Bearer token identifies
    // agent-bearer. Authorization MUST win per spec §9.5.
    seedOrg();
    seedUser();
    const cookieToken = await mintSessionJWT();
    const bearerToken = await createToken("agent-bearer", "agent");
    const result = await authenticateRequest(
      mockReq({
        authorization: `Bearer ${bearerToken}`,
        cookie: sessionCookie(cookieToken),
      }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("agent-bearer");
      expect(result.claims.role).toBe("agent");
    }
  });
});

// ---------------------------------------------------------------------------
// Cookie validation failures
// ---------------------------------------------------------------------------
describe("Scenario 5 — cookie validation", () => {
  it("malformed JWT → 401 + WWW-Authenticate + Tier 2 audit auth.invalid_token", async () => {
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie("not.a.jwt") }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toMatch(/Bearer/);
      expect(result.wwwAuthenticate).toMatch(/error="invalid_token"/);
    }
    const audits = findAuditRows("auth.invalid_token");
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  it("JWT signed with wrong key → 401 + Tier 2 audit", async () => {
    const token = await mintSessionJWT({ secret: WRONG_SECRET });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    expect(findAuditRows("auth.invalid_token").length).toBeGreaterThanOrEqual(1);
  });

  it("expired JWT (beyond ±30s clock tolerance) → 401 + Tier 2 audit", async () => {
    const past = Math.floor(Date.now() / 1000) - 200;
    const token = await mintSessionJWT({ iat: past, ttlSeconds: 60 });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    expect(findAuditRows("auth.invalid_token").length).toBeGreaterThanOrEqual(1);
  });

  it("unknown kid → 401 + Tier 2 audit (reason mentions kid)", async () => {
    const token = await mintSessionJWT({ kid: "hs256-v999" });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(String(meta.reason)).toMatch(/unknown_kid/);
  });

  it("issuer mismatch → 401 + Tier 2 audit", async () => {
    const token = await mintSessionJWT({ issuer: "http://evil.example.com" });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    expect(findAuditRows("auth.invalid_token").length).toBeGreaterThanOrEqual(1);
  });

  it("missing sub claim → 401 + Tier 2 audit (reason=missing_sub)", async () => {
    const token = await mintSessionJWT({ omitSub: true });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(String(meta.reason)).toBe("missing_sub");
  });
});

// ---------------------------------------------------------------------------
// token_epoch (T03) checks
// ---------------------------------------------------------------------------
describe("Scenario 5 — token_epoch", () => {
  it("claims.iat < user.token_epoch → 401 + Tier 2 audit (reason=token_epoch_exceeded)", async () => {
    seedOrg();
    // Set token_epoch to "now + 10000" so any iat clamped within the JWT's
    // exp window will be < epoch.
    const future = Math.floor(Date.now() / 1000) + 10_000;
    seedUser("u-alice", future);
    // iat at "now - 5s" is still within exp window but < epoch.
    const iat = Math.floor(Date.now() / 1000) - 5;
    const token = await mintSessionJWT({ iat });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/Session invalidated/);
    }
    const audits = findAuditRows("auth.invalid_token");
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata_json as string);
    expect(String(meta.reason)).toBe("token_epoch_exceeded");
  });

  it("claims.iat >= user.token_epoch → 200 (returns claims)", async () => {
    seedOrg();
    // Epoch = "now - 100" so a fresh iat=now is >= epoch.
    seedUser("u-alice", Math.floor(Date.now() / 1000) - 100);
    const token = await mintSessionJWT();
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("u-alice");
  });
});

// ---------------------------------------------------------------------------
// Phase 2 not wired
// ---------------------------------------------------------------------------
describe("Scenario 5 — Phase 2 not wired", () => {
  it("cookie present but initPhase2Auth never called → Scenario (b) 401, no audit", async () => {
    // Override the beforeEach's wiring.
    resetPhase2Auth();
    const token = await mintSessionJWT();
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Falls through to Scenario (b) — missing Authorization header.
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/Missing or invalid Authorization/);
    }
    // No invalid_token audit because the cookie was never even inspected.
    expect(findAuditRows("auth.invalid_token")).toHaveLength(0);
  });

  it("cookie present but Phase 2 not wired + authEnabled=false → Scenario (a) synthetic admin", async () => {
    resetPhase2Auth();
    const token = await mintSessionJWT();
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("legacy");
      expect(result.claims.role).toBe("admin");
    }
  });
});

// ---------------------------------------------------------------------------
// Service account passthrough + role variations
// ---------------------------------------------------------------------------
describe("Scenario 5 — claim shape variations", () => {
  it("service_account=true is preserved on returned claims", async () => {
    seedOrg();
    seedUser();
    // T25: service-account JWTs are DB-validated via verifyServiceTokenJti.
    // Seed a matching refresh_tokens row so the override passes.
    getDb()
      .prepare(
        `INSERT INTO refresh_tokens
           (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
            expires_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        "row-svc-1",
        "u-alice",
        "org-acme",
        "session-jti-1",
        "service:00000000-0000-0000-0000-000000000001",
        String(Math.floor(Date.now() / 1000) + 3600),
        String(Math.floor(Date.now() / 1000)),
      );
    const token = await mintSessionJWT({ role: "service", serviceAccount: true });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token) }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.role).toBe("service");
      expect(result.claims.service_account).toBe(true);
    }
  });

  it("admin role + admin-only route → request allowed", async () => {
    seedOrg();
    seedUser();
    const token = await mintSessionJWT({ role: "admin" });
    const result = await authenticateRequest(
      mockReq({ cookie: sessionCookie(token), url: "/api/reset", method: "POST" }),
      { authEnabled: true },
    );
    // Note: the cookie path returns claims directly and bypasses the
    // ADMIN_ONLY_ROUTES check (which lives on the Bearer branch). T20
    // /device/approve handlers do their own role guard. Verify success.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backward compat — Phase 1 Scenarios a/b/c/d unchanged when Phase 2 wired
// ---------------------------------------------------------------------------
describe("Scenario 5 — backward compatibility", () => {
  it("authEnabled=false + no credentials → synthetic legacy admin claims", async () => {
    const result = await authenticateRequest(mockReq(), { authEnabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe("legacy");
      expect(result.claims.role).toBe("admin");
    }
  });

  it("authEnabled=true + no credentials → 401 invalid_token", async () => {
    const result = await authenticateRequest(mockReq(), { authEnabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toMatch(/Bearer realm="mcp-coordinator"/);
    }
  });

  it("invalid Bearer token + no cookie → Phase 1 Scenario (d) 401 invalid_token", async () => {
    const result = await authenticateRequest(
      mockReq({ authorization: "Bearer not.a.jwt" }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.wwwAuthenticate).toMatch(/error="invalid_token"/);
    }
  });

  it("GET ?token= fallback still works with Phase 2 wired (cookie path skipped)", async () => {
    const phase1Token = await createToken("agent-q", "agent");
    const result = await authenticateRequest(
      mockReq({
        url: `/api/events?token=${encodeURIComponent(phase1Token)}`,
        method: "GET",
      }),
      { authEnabled: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("agent-q");
  });
});
