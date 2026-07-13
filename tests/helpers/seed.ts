import type Database from "better-sqlite3";

export interface SeededOrg {
  orgId: string;
  adminUserId: string;
  memberUserId: string;
  serviceTokenJti: string;
}

/**
 * Create 4 orgs with deterministic IDs:
 *   org-acme-001:  admin=u-admin-acme,  member=u-member-acme,  service=jti-svc-acme
 *   org-beta-002:  admin=u-admin-beta,  member=u-member-beta,  service=jti-svc-beta
 *   org-gamma-003: admin=u-admin-gamma, member=u-member-gamma, service=jti-svc-gamma
 *   org-delta-004: admin=u-admin-delta, member=u-member-delta, service=jti-svc-delta
 *
 * Used by T31 cross-tenant suite + T32 D1-D10 matrix. Idempotent via
 * INSERT OR IGNORE — calling twice yields the same row set.
 *
 * Service-token rows in refresh_tokens are intentionally NOT inserted here
 * (T25 handles minting + family bookkeeping). The serviceTokenJti string
 * is a documented placeholder that future T25 helpers can populate when
 * they extend this seed.
 */
export function seedFourOrgs(db: Database.Database): SeededOrg[] {
  const orgs: SeededOrg[] = [
    {
      orgId: "org-acme-001",
      adminUserId: "u-admin-acme",
      memberUserId: "u-member-acme",
      serviceTokenJti: "jti-svc-acme",
    },
    {
      orgId: "org-beta-002",
      adminUserId: "u-admin-beta",
      memberUserId: "u-member-beta",
      serviceTokenJti: "jti-svc-beta",
    },
    {
      orgId: "org-gamma-003",
      adminUserId: "u-admin-gamma",
      memberUserId: "u-member-gamma",
      serviceTokenJti: "jti-svc-gamma",
    },
    {
      orgId: "org-delta-004",
      adminUserId: "u-admin-delta",
      memberUserId: "u-member-delta",
      serviceTokenJti: "jti-svc-delta",
    },
  ];

  const orgInsert = db.prepare(`
    INSERT OR IGNORE INTO orgs (id, name, idp_provider, idp_org_id, allowlist_github_org)
    VALUES (?, ?, 'github', ?, ?)
  `);
  // Column is primary_org_id post-v0.8 migration (was org_id in Phase 1).
  const userInsert = db.prepare(`
    INSERT OR IGNORE INTO users (id, primary_org_id, email, name, idp_provider, idp_user_id, role)
    VALUES (?, ?, ?, ?, 'github', ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const o of orgs) {
      // org-acme-001 → "acme"
      const name = o.orgId.split("-")[1];
      orgInsert.run(o.orgId, name, name, name);
      userInsert.run(
        o.adminUserId,
        o.orgId,
        `${name}-admin@test`,
        `${name}-admin`,
        `${name}-admin`,
        "admin",
      );
      userInsert.run(
        o.memberUserId,
        o.orgId,
        `${name}-member@test`,
        `${name}-member`,
        `${name}-member`,
        "member",
      );
      // Service-token rows added by T25; seed leaves serviceTokenJti as a
      // documented placeholder for now.
      void o.serviceTokenJti;
    }
  });
  tx();
  return orgs;
}
