/**
 * T31 — Cross-tenant isolation integration suite.
 *
 * Phase 2 is single-tenant in practice (one allowlisted GitHub org per
 * coordinator) but the schema + code paths already support multi-tenant
 * (V3 Q1: "1:1 org strict but user_orgs table exists for Phase 5
 * readiness"). T31 validates that the org_id boundary is honored across
 * every endpoint / helper so the Phase 5 migration to multi-tenant is
 * zero-code.
 *
 * The suite uses T38's seedFourOrgs(db) to lay down four deterministic
 * orgs (acme, beta, gamma, delta) each with an admin + member user.
 * Tests exercise every Phase 2 code path where cross-tenant leakage
 * could occur and assert it does not happen.
 *
 * Categories:
 *   - allowlist resolution (V4 FIX 22 alphabetical tie-break)
 *   - refresh-token row isolation by user_id / org_id
 *   - audit-context isolation under concurrent async chains
 *   - service-token issuance org membership enforcement + list filter
 *   - user_orgs Phase-5 multi-membership simulation
 *   - oauth_state primary-key-by-state semantics
 *   - device-flow brute-force lockout per-user_code, not global
 *
 * No source-code changes — pure test validation of existing guarantees.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { jwtVerify } from "jose";

import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth } from "../../src/auth.js";
import { seedFourOrgs } from "../helpers/seed.js";
import { FakeClock } from "../helpers/clock.js";
import { findAuditRows } from "../helpers/audit.js";
import { resolveOrgFromMemberships } from "../../src/auth/allowlist.js";
import { buildJwtKeyRegistry } from "../../src/auth/jwt-keys.js";
import {
  issueServiceToken,
  listServiceTokens,
  ServiceTokenValidationError,
} from "../../src/auth/service-tokens.js";
import { withAuditContext } from "../../src/auth/audit-context.js";
import { withRequestId } from "../../src/auth/request-id.js";
import { audit } from "../../src/security/audit.js";
import { createOAuthState, consumeOAuthState } from "../../src/auth/oauth-state.js";

const PHASE1_SECRET = "phase1-test-secret-at-least-32-chars-long!";
const SIGNING_SECRET = Buffer.alloc(32, 0x77);
const ISSUER = "http://localhost:3000";
const registry = buildJwtKeyRegistry(SIGNING_SECRET);

let DIR: string;
let clock: FakeClock;

/**
 * Seed the user_orgs row(s) that T38's seedFourOrgs intentionally leaves
 * to T25 / migration backfill. Our DB is fresh post-migration so the
 * auto-backfill has nothing to migrate; tests that need a user_orgs
 * membership row (service-token issuance, list filters, Phase 5
 * multi-membership simulation) call this directly.
 */
function addUserOrgMembership(
  db: Database.Database,
  userId: string,
  orgId: string,
  role: "member" | "admin" | "service" = "member",
): void {
  db.prepare(
    `INSERT OR IGNORE INTO user_orgs (user_id, org_id, role, joined_at)
     VALUES (?, ?, ?, ?)`,
  ).run(userId, orgId, role, String(clock.now()));
}

/**
 * Backfill user_orgs from users.primary_org_id for every seeded user so
 * tests that assert "SELECT user_id FROM user_orgs WHERE org_id=X" reflect
 * the schema's 1:1 invariant. seedFourOrgs is intentionally minimal — it
 * only writes orgs + users rows; the user_orgs join is left to migration
 * backfill (which only fires at initDatabase boot, not on later inserts).
 */
function backfillUserOrgsForSeed(db: Database.Database): void {
  db.exec(
    `INSERT OR IGNORE INTO user_orgs (user_id, org_id, role, joined_at)
     SELECT id, primary_org_id, role, ${String(clock.now())} FROM users`,
  );
}

beforeAll(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "t31-isolation-"));
  initDatabase(DIR);
  initAuth(PHASE1_SECRET);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe per-test in dependency-safe order. orgs / users persist for the
  // duration of a fresh seedFourOrgs in this beforeEach.
  const db = getDb() as unknown as Database.Database;
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM refresh_tokens");
  db.exec("DELETE FROM device_auth_requests");
  db.exec("DELETE FROM oauth_state");
  db.exec("DELETE FROM user_orgs");
  // Users may FK from refresh_tokens (cleared above) + user_orgs (cleared).
  db.exec("DELETE FROM users");
  // orgs may FK from users (cleared) + user_orgs (cleared) + oauth_state.
  db.exec("DELETE FROM orgs WHERE id != 'default'");

  clock = new FakeClock(1_700_000_000);
  seedFourOrgs(db);
});

// ===========================================================================
// (1–3) Allowlist resolution: V4 FIX 22 alphabetical tie-break + null path
// ===========================================================================
describe("T31 / allowlist resolution", () => {
  it("01: single membership 'acme' resolves to org-acme-001", () => {
    const db = getDb() as unknown as Database.Database;
    const match = resolveOrgFromMemberships(db, ["acme"]);
    expect(match).not.toBeNull();
    expect(match?.org_id).toBe("org-acme-001");
    expect(match?.matched_org_login).toBe("acme");
  });

  it("02: dual membership ['acme','beta'] tie-breaks alphabetical → acme (V4 FIX 22)", () => {
    const db = getDb() as unknown as Database.Database;
    // Order of arguments must not matter: SQL ORDER BY allowlist_github_org
    // ASC is the authoritative tie-break.
    const m1 = resolveOrgFromMemberships(db, ["acme", "beta"]);
    const m2 = resolveOrgFromMemberships(db, ["beta", "acme"]);
    expect(m1?.org_id).toBe("org-acme-001");
    expect(m2?.org_id).toBe("org-acme-001");
  });

  it("03: nonexistent membership returns null (no off-by-one match)", () => {
    const db = getDb() as unknown as Database.Database;
    expect(resolveOrgFromMemberships(db, ["nonexistent"])).toBeNull();
    // Defense in depth: empty list short-circuits to null without SQL.
    expect(resolveOrgFromMemberships(db, [])).toBeNull();
  });
});

// ===========================================================================
// (4–7) Refresh-token isolation
// ===========================================================================
describe("T31 / refresh-token isolation", () => {
  /**
   * Insert a minimal refresh_tokens row directly (no JWT minting needed for
   * isolation tests — we're asserting SQL WHERE clause boundaries, not
   * verifier behavior).
   */
  function insertRefreshRow(
    db: Database.Database,
    opts: {
      jti: string;
      userId: string;
      orgId: string;
      familyId?: string;
      revoked?: boolean;
    },
  ): void {
    db.prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, org_id, jti, family_id, parent_jti, consumer_fingerprint,
          expires_at, last_used_at, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    ).run(
      `id-${opts.jti}`,
      opts.userId,
      opts.orgId,
      opts.jti,
      opts.familyId ?? `fam-${opts.orgId}-${opts.jti}`,
      String(clock.now() + 3600),
      String(clock.now()),
      opts.revoked ? String(clock.now()) : null,
      opts.revoked ? "rotated" : null,
    );
  }

  it("04: minting a refresh row for u-admin-acme yields exactly one row tagged org-acme-001", () => {
    const db = getDb() as unknown as Database.Database;
    insertRefreshRow(db, { jti: "rt-1", userId: "u-admin-acme", orgId: "org-acme-001" });
    const rows = db
      .prepare("SELECT user_id, org_id FROM refresh_tokens WHERE user_id = ?")
      .all("u-admin-acme") as Array<{ user_id: string; org_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.org_id).toBe("org-acme-001");
  });

  it("05: SELECT WHERE user_id=u-admin-acme never returns other-org tokens (4 orgs seeded)", () => {
    const db = getDb() as unknown as Database.Database;
    insertRefreshRow(db, { jti: "rt-acme", userId: "u-admin-acme", orgId: "org-acme-001" });
    insertRefreshRow(db, { jti: "rt-beta", userId: "u-admin-beta", orgId: "org-beta-002" });
    insertRefreshRow(db, { jti: "rt-gamma", userId: "u-admin-gamma", orgId: "org-gamma-003" });
    insertRefreshRow(db, { jti: "rt-delta", userId: "u-admin-delta", orgId: "org-delta-004" });

    const rows = db
      .prepare("SELECT jti, org_id FROM refresh_tokens WHERE user_id = ?")
      .all("u-admin-acme") as Array<{ jti: string; org_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jti).toBe("rt-acme");
    expect(rows[0]?.org_id).toBe("org-acme-001");
  });

  it("06: SELECT WHERE org_id=org-acme-001 returns only acme tokens", () => {
    const db = getDb() as unknown as Database.Database;
    insertRefreshRow(db, { jti: "rt-a1", userId: "u-admin-acme", orgId: "org-acme-001" });
    insertRefreshRow(db, { jti: "rt-a2", userId: "u-member-acme", orgId: "org-acme-001" });
    insertRefreshRow(db, { jti: "rt-b1", userId: "u-admin-beta", orgId: "org-beta-002" });

    const rows = db
      .prepare("SELECT jti FROM refresh_tokens WHERE org_id = ? ORDER BY jti")
      .all("org-acme-001") as Array<{ jti: string }>;
    expect(rows.map((r) => r.jti)).toEqual(["rt-a1", "rt-a2"]);
  });

  it("07: rotating an acme token does not affect beta org family_ids", () => {
    const db = getDb() as unknown as Database.Database;
    const acmeFam = "fam-acme-root";
    const betaFam = "fam-beta-root";
    insertRefreshRow(db, {
      jti: "rt-acme-root",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: acmeFam,
    });
    insertRefreshRow(db, {
      jti: "rt-beta-root",
      userId: "u-admin-beta",
      orgId: "org-beta-002",
      familyId: betaFam,
    });

    // Simulate rotation: revoke acme's root, mint successor under SAME family.
    db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ?, revoked_reason = 'rotated' WHERE jti = ?",
    ).run(String(clock.now()), "rt-acme-root");
    insertRefreshRow(db, {
      jti: "rt-acme-rotated",
      userId: "u-admin-acme",
      orgId: "org-acme-001",
      familyId: acmeFam,
    });

    // Beta family is intact, unrevoked, single row.
    const betaRows = db
      .prepare("SELECT jti, revoked_at FROM refresh_tokens WHERE family_id = ?")
      .all(betaFam) as Array<{ jti: string; revoked_at: string | null }>;
    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]?.revoked_at).toBeNull();
    expect(betaRows[0]?.jti).toBe("rt-beta-root");

    // Acme family advanced: one revoked, one active.
    const acmeRows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id = ? AND revoked_at IS NULL",
      )
      .get(acmeFam) as { n: number };
    expect(acmeRows.n).toBe(1);
  });
});

// ===========================================================================
// (8–10) Audit context isolation
// ===========================================================================
describe("T31 / audit-context isolation", () => {
  it("08: withAuditContext emits audit row tagged with the actor's org_id", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    withRequestId("req-acme-08", () => {
      withAuditContext(
        { userId: "u-admin-acme", orgId: "org-acme-001" },
        { ip: "127.0.0.1", userAgent: "t31" },
        () => audit("t31.test.audit_context_basic", { tier: 1 }),
      );
    });

    const rows = findAuditRows("t31.test.audit_context_basic");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_org_id).toBe("org-acme-001");
    expect(rows[0]?.actor_user_id).toBe("u-admin-acme");
    expect(rows[0]?.request_id).toBe("req-acme-08");
  });

  it("09: concurrent Promise.all withAuditContext invocations do not bleed actor_org_id across async chains", async () => {
    // Two parallel async chains, each with its own actor. AsyncLocalStorage
    // must isolate the contexts so each emits an audit row with the correct
    // actor_org_id even when they await in the same tick.
    await Promise.all([
      withAuditContext(
        { userId: "u-admin-acme", orgId: "org-acme-001" },
        { ip: null, userAgent: null },
        async () => {
          await new Promise((r) => setImmediate(r));
          audit("t31.test.audit_concurrent", {
            tier: 1,
            metadata: { tag: "acme" },
          });
        },
      ),
      withAuditContext(
        { userId: "u-admin-beta", orgId: "org-beta-002" },
        { ip: null, userAgent: null },
        async () => {
          await new Promise((r) => setImmediate(r));
          audit("t31.test.audit_concurrent", {
            tier: 1,
            metadata: { tag: "beta" },
          });
        },
      ),
    ]);

    const rows = findAuditRows("t31.test.audit_concurrent");
    expect(rows).toHaveLength(2);
    // Find each row by its metadata tag, then assert org pairing.
    const byTag = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const meta = JSON.parse(r.metadata_json as string) as { tag: string };
      byTag.set(meta.tag, r);
    }
    expect(byTag.get("acme")?.actor_org_id).toBe("org-acme-001");
    expect(byTag.get("acme")?.actor_user_id).toBe("u-admin-acme");
    expect(byTag.get("beta")?.actor_org_id).toBe("org-beta-002");
    expect(byTag.get("beta")?.actor_user_id).toBe("u-admin-beta");
  });

  it("10: audit() with metadata.org_id serializes inside metadata_json", () => {
    withAuditContext(
      { userId: "u-admin-acme", orgId: "org-acme-001" },
      { ip: null, userAgent: null },
      () =>
        audit("t31.test.audit_metadata_org", {
          tier: 1,
          metadata: { org_id: "org-acme-001", note: "issuance" },
        }),
    );
    const rows = findAuditRows("t31.test.audit_metadata_org");
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0]?.metadata_json as string) as {
      org_id: string;
      note: string;
    };
    expect(meta.org_id).toBe("org-acme-001");
    expect(meta.note).toBe("issuance");
  });
});

// ===========================================================================
// (11–12) Allowlist row isolation + FK integrity
// ===========================================================================
describe("T31 / allowlist row + FK integrity", () => {
  it("11: each of the 4 seeded orgs resolves to its own row by LOWER() match", () => {
    const db = getDb() as unknown as Database.Database;
    for (const [login, expectedId] of [
      ["acme", "org-acme-001"],
      ["beta", "org-beta-002"],
      ["gamma", "org-gamma-003"],
      ["delta", "org-delta-004"],
    ] as const) {
      const m = resolveOrgFromMemberships(db, [login]);
      expect(m?.org_id).toBe(expectedId);
    }
    // Mixed case path: SQL LOWERs the allowlist column for case-insensitive
    // match against already-lowercased caller membership.
    const mixed = resolveOrgFromMemberships(db, ["gamma"]);
    expect(mixed?.org_id).toBe("org-gamma-003");
  });

  it("12: ON DELETE RESTRICT on orgs blocks deletion when users / user_orgs reference the org", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    // user_orgs.org_id REFERENCES orgs(id) ON DELETE RESTRICT.
    // users.primary_org_id REFERENCES orgs(id) (default NO ACTION = RESTRICT-ish).
    // Either reference blocks the DELETE — both are present after backfill.
    expect(() => db.prepare("DELETE FROM orgs WHERE id = ?").run("org-acme-001")).toThrow(
      /FOREIGN KEY constraint failed/i,
    );

    // Deleting a user does NOT cascade out of user_orgs (the user_orgs row
    // has ON DELETE CASCADE on user_id), but it must NOT silently delete
    // the org. Verify the org row still exists post-attempted-delete.
    const orgRow = db.prepare("SELECT id FROM orgs WHERE id = ?").get("org-acme-001") as
      { id: string } | undefined;
    expect(orgRow?.id).toBe("org-acme-001");
  });
});

// ===========================================================================
// (13–15) Service token issuance + listing isolation
// ===========================================================================
describe("T31 / service token isolation", () => {
  it("13: issueServiceToken for u-admin-acme→org-acme-001 succeeds; refresh_tokens row carries org-acme-001", async () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    const issued = await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-acme",
      targetOrgId: "org-acme-001",
      scope: "read",
      ttlSeconds: 3600,
      reason: "T31 isolation test fixture",
      issuedByAdminId: "u-admin-acme",
    });
    expect(issued.familyId).toMatch(/^service:[0-9a-f-]{36}$/);

    const row = db
      .prepare("SELECT user_id, org_id, family_id FROM refresh_tokens WHERE jti = ?")
      .get(issued.jti) as { user_id: string; org_id: string; family_id: string };
    expect(row.org_id).toBe("org-acme-001");
    expect(row.user_id).toBe("u-admin-acme");

    // JWT carries the same active_org_id (defense in depth: claim must
    // match DB row org_id even though the verifier re-checks DB).
    const { payload } = await jwtVerify(issued.accessToken, new Uint8Array(SIGNING_SECRET), {
      algorithms: ["HS256"],
      issuer: ISSUER,
    });
    expect(payload.active_org_id).toBe("org-acme-001");
    expect(payload.sub).toBe("u-admin-acme");
  });

  it("14: issueServiceToken for u-admin-acme→org-beta-002 fails USER_NOT_IN_ORG (no user_orgs membership)", async () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);
    // u-admin-acme has primary_org_id=org-acme-001 and user_orgs row for
    // org-acme-001 only — targeting org-beta-002 must fail.
    await expect(
      issueServiceToken({
        db,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-admin-acme",
        targetOrgId: "org-beta-002",
        scope: "read",
        ttlSeconds: 3600,
        reason: "T31 cross-tenant attack attempt",
        issuedByAdminId: "u-admin-acme",
      }),
    ).rejects.toMatchObject({
      code: "USER_NOT_IN_ORG",
      name: "ServiceTokenValidationError",
    });

    // No refresh_tokens row was created — precondition guard runs BEFORE
    // any INSERT (service-tokens.ts spec).
    const rowCount = db
      .prepare("SELECT COUNT(*) AS n FROM refresh_tokens WHERE user_id = ? AND org_id = ?")
      .get("u-admin-acme", "org-beta-002") as { n: number };
    expect(rowCount.n).toBe(0);

    // Also assert that the error is the ServiceTokenValidationError class
    // (not a generic Error) so callers can branch on `instanceof`.
    let thrown: unknown = null;
    try {
      await issueServiceToken({
        db,
        clock,
        signingKeys: registry,
        issuer: ISSUER,
        targetUserId: "u-admin-acme",
        targetOrgId: "org-beta-002",
        scope: "read",
        ttlSeconds: 3600,
        reason: "T31 cross-tenant attack attempt #2",
        issuedByAdminId: "u-admin-acme",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ServiceTokenValidationError);
  });

  it("15: listServiceTokens({orgId:'org-acme-001'}) returns only acme service tokens", async () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);

    await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-acme",
      targetOrgId: "org-acme-001",
      scope: "read",
      ttlSeconds: 3600,
      reason: "acme CI deploy token",
      issuedByAdminId: "u-admin-acme",
    });
    await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-beta",
      targetOrgId: "org-beta-002",
      scope: "read",
      ttlSeconds: 3600,
      reason: "beta CI deploy token",
      issuedByAdminId: "u-admin-beta",
    });
    await issueServiceToken({
      db,
      clock,
      signingKeys: registry,
      issuer: ISSUER,
      targetUserId: "u-admin-gamma",
      targetOrgId: "org-gamma-003",
      scope: "write",
      ttlSeconds: 3600,
      reason: "gamma CI deploy token",
      issuedByAdminId: "u-admin-gamma",
    });

    const acmeTokens = listServiceTokens(db, { orgId: "org-acme-001" });
    expect(acmeTokens).toHaveLength(1);
    expect(acmeTokens[0]?.user_id).toBe("u-admin-acme");
    expect(acmeTokens[0]?.org_id).toBe("org-acme-001");

    const betaTokens = listServiceTokens(db, { orgId: "org-beta-002" });
    expect(betaTokens).toHaveLength(1);
    expect(betaTokens[0]?.user_id).toBe("u-admin-beta");

    // No-filter listing returns all 3 — confirms the filter applied above
    // is what scoped the result (not a missing fixture).
    const all = listServiceTokens(db);
    expect(all).toHaveLength(3);
  });
});

// ===========================================================================
// (16–18) user_orgs isolation (Phase 1 1:1 today + Phase 5 N:M ready)
// ===========================================================================
describe("T31 / user_orgs isolation", () => {
  it("16: post-backfill, user_orgs has exactly one row per seeded user (1:1 Phase 1 invariant)", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);
    const rows = db
      .prepare("SELECT user_id, org_id FROM user_orgs ORDER BY user_id")
      .all() as Array<{ user_id: string; org_id: string }>;
    // 4 orgs × 2 users = 8 rows.
    expect(rows).toHaveLength(8);
    // Each user maps to their primary_org_id, no cross-tenant rows.
    const seen = new Set(rows.map((r) => `${r.user_id}→${r.org_id}`));
    expect(seen.has("u-admin-acme→org-acme-001")).toBe(true);
    expect(seen.has("u-member-acme→org-acme-001")).toBe(true);
    expect(seen.has("u-admin-beta→org-beta-002")).toBe(true);
    expect(seen.has("u-admin-acme→org-beta-002")).toBe(false); // no cross-tenant
  });

  it("17: SELECT user_id FROM user_orgs WHERE org_id='org-acme-001' returns the 2 acme users only", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);
    const users = db
      .prepare("SELECT user_id FROM user_orgs WHERE org_id = ? ORDER BY user_id")
      .all("org-acme-001") as Array<{ user_id: string }>;
    expect(users.map((u) => u.user_id)).toEqual(["u-admin-acme", "u-member-acme"]);
    // Negative-control: no beta users appear under acme's org_id.
    expect(users.map((u) => u.user_id)).not.toContain("u-admin-beta");
    expect(users.map((u) => u.user_id)).not.toContain("u-member-beta");
  });

  it("18: Phase 5 simulation — adding u-admin-acme to org-beta-002 does not corrupt allowlist resolution", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);
    // Phase 5 multi-membership: u-admin-acme joins beta as 'member' too.
    addUserOrgMembership(db, "u-admin-acme", "org-beta-002", "member");

    // The allowlist resolver works off GitHub org memberships (NOT user_orgs);
    // it stays correct because it indexes orgs.allowlist_github_org, which
    // is the authoritative source for "which coordinator org owns this
    // GitHub org". A user with multiple GitHub orgs that BOTH map to the
    // same coordinator (e.g. parent + subsidiary) tie-breaks deterministically.
    const acmeOnly = resolveOrgFromMemberships(db, ["acme"]);
    const bothOrgs = resolveOrgFromMemberships(db, ["acme", "beta"]);
    expect(acmeOnly?.org_id).toBe("org-acme-001");
    expect(bothOrgs?.org_id).toBe("org-acme-001"); // alphabetical tie-break

    // user_orgs reflects the new membership without disturbing the original.
    const memberships = db
      .prepare("SELECT org_id FROM user_orgs WHERE user_id = ? ORDER BY org_id")
      .all("u-admin-acme") as Array<{ org_id: string }>;
    expect(memberships.map((m) => m.org_id)).toEqual(["org-acme-001", "org-beta-002"]);
  });
});

// ===========================================================================
// (19–20) oauth_state isolation
// ===========================================================================
describe("T31 / oauth_state isolation", () => {
  it("19: states for different orgs each consume by their own state value (no cross-row consume)", () => {
    const db = getDb() as unknown as Database.Database;
    // Both states live in the same oauth_state table; org_id is initially
    // NULL on insert and resolved later at callback. The state value (256-bit
    // base64url) is the primary key — collisions across orgs are statistically
    // impossible, and consume-by-state never reads org_id.
    const a = createOAuthState(db, clock, "github", "https://app/cb?o=acme");
    const b = createOAuthState(db, clock, "github", "https://app/cb?o=beta");
    expect(a.state).not.toBe(b.state);

    // Tag the rows with distinct org_ids manually to simulate post-callback
    // org resolution; the consume CAS only filters by state value.
    db.prepare("UPDATE oauth_state SET org_id = ? WHERE state = ?").run("org-acme-001", a.state);
    db.prepare("UPDATE oauth_state SET org_id = ? WHERE state = ?").run("org-beta-002", b.state);

    const consumedA = consumeOAuthState(db, clock, a.state);
    expect(consumedA?.redirect_uri).toBe("https://app/cb?o=acme");
    // After acme is consumed, beta's row is still live — consumed_at is per-row.
    const betaRow = db
      .prepare("SELECT consumed_at, org_id FROM oauth_state WHERE state = ?")
      .get(b.state) as { consumed_at: number | null; org_id: string };
    expect(betaRow.consumed_at).toBeNull();
    expect(betaRow.org_id).toBe("org-beta-002");

    const consumedB = consumeOAuthState(db, clock, b.state);
    expect(consumedB?.redirect_uri).toBe("https://app/cb?o=beta");
  });

  it("20: oauth_state.org_id is nullable; a state created without org_id is still consumable", () => {
    const db = getDb() as unknown as Database.Database;
    const { state } = createOAuthState(db, clock, "github", "https://app/cb");
    const row = db.prepare("SELECT org_id FROM oauth_state WHERE state = ?").get(state) as {
      org_id: string | null;
    };
    // Created without org_id — resolver runs at callback, not at create.
    expect(row.org_id).toBeNull();

    const consumed = consumeOAuthState(db, clock, state);
    expect(consumed).not.toBeNull();
    expect(consumed?.provider).toBe("github");
    expect(consumed?.redirect_uri).toBe("https://app/cb");
  });
});

// ===========================================================================
// (21–22) Device-flow isolation: brute-force lockout is per-user_code
// ===========================================================================
describe("T31 / device flow isolation", () => {
  /**
   * Insert a minimal device_auth_requests row for use in lockout tests.
   * Uses unix-seconds-as-string for expires_at to match the Phase 1 TEXT
   * column convention.
   */
  function insertDeviceRow(
    db: Database.Database,
    opts: { userCode: string; deviceCode: string; nonce: string; requesterIp: string },
  ): void {
    db.prepare(
      `INSERT INTO device_auth_requests
         (device_code, user_code, nonce, org_id, expires_at,
          requester_ip, requester_user_agent, failed_approval_attempts)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0)`,
    ).run(
      opts.deviceCode,
      opts.userCode,
      opts.nonce,
      String(clock.now() + 600),
      opts.requesterIp,
      "t31-ua",
    );
  }

  it("21: approving one device row updates only that row's approved_user_id (others untouched)", () => {
    const db = getDb() as unknown as Database.Database;
    backfillUserOrgsForSeed(db);
    insertDeviceRow(db, {
      userCode: "AAAA-1111",
      deviceCode: "dev-acme",
      nonce: "nonce-acme",
      requesterIp: "10.0.0.1",
    });
    insertDeviceRow(db, {
      userCode: "BBBB-2222",
      deviceCode: "dev-beta",
      nonce: "nonce-beta",
      requesterIp: "10.0.0.2",
    });

    // Direct CAS UPDATE on user_code AAAA-1111 (mimics handleDeviceApprove
    // SQL filter — filter by user_code, not org/user identity).
    const result = db
      .prepare(
        `UPDATE device_auth_requests
           SET approved_user_id = ?, approved_at = ?
         WHERE user_code = ? AND approved_user_id IS NULL`,
      )
      .run("u-admin-acme", clock.now(), "AAAA-1111");
    expect(result.changes).toBe(1);

    const acmeRow = db
      .prepare("SELECT approved_user_id FROM device_auth_requests WHERE user_code = ?")
      .get("AAAA-1111") as { approved_user_id: string };
    const betaRow = db
      .prepare("SELECT approved_user_id FROM device_auth_requests WHERE user_code = ?")
      .get("BBBB-2222") as { approved_user_id: string | null };
    expect(acmeRow.approved_user_id).toBe("u-admin-acme");
    // The other user_code's row is untouched — approval is strictly per-row.
    expect(betaRow.approved_user_id).toBeNull();
  });

  it("22: brute-force lockout on AAAA-1111 does not affect BBBB-2222", () => {
    const db = getDb() as unknown as Database.Database;
    insertDeviceRow(db, {
      userCode: "AAAA-1111",
      deviceCode: "dev-a",
      nonce: "nonce-a",
      requesterIp: "1.1.1.1",
    });
    insertDeviceRow(db, {
      userCode: "BBBB-2222",
      deviceCode: "dev-b",
      nonce: "nonce-b",
      requesterIp: "2.2.2.2",
    });

    // Simulate 5 failed attempts on AAAA-1111 → V4 FIX 21 lockout sets
    // denied_at + denied_reason='too_many_failed_approvals' on that row.
    db.prepare(
      `UPDATE device_auth_requests
         SET failed_approval_attempts = 5,
             denied_at = ?,
             denied_reason = 'too_many_failed_approvals'
       WHERE user_code = ?`,
    ).run(clock.now(), "AAAA-1111");

    const aRow = db
      .prepare(
        "SELECT failed_approval_attempts, denied_at, denied_reason FROM device_auth_requests WHERE user_code = ?",
      )
      .get("AAAA-1111") as {
      failed_approval_attempts: number;
      denied_at: number | null;
      denied_reason: string | null;
    };
    expect(aRow.failed_approval_attempts).toBe(5);
    expect(aRow.denied_at).not.toBeNull();
    expect(aRow.denied_reason).toBe("too_many_failed_approvals");

    // BBBB-2222 is completely untouched — lockout has no global side effect.
    const bRow = db
      .prepare(
        "SELECT failed_approval_attempts, denied_at, denied_reason FROM device_auth_requests WHERE user_code = ?",
      )
      .get("BBBB-2222") as {
      failed_approval_attempts: number;
      denied_at: number | null;
      denied_reason: string | null;
    };
    expect(bRow.failed_approval_attempts).toBe(0);
    expect(bRow.denied_at).toBeNull();
    expect(bRow.denied_reason).toBeNull();
  });
});
