import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { resolveOrgFromMemberships, resolveOrgFromIdpOrgId } from "../../src/auth/allowlist.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE orgs (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      allowlist_github_org  TEXT,
      allowlist_idp_org_id  TEXT
    );
    CREATE INDEX idx_orgs_allowlist ON orgs(allowlist_github_org);
    CREATE INDEX idx_orgs_allowlist_idp ON orgs(allowlist_idp_org_id);
  `);
});

afterEach(() => {
  db.close();
});

function insertOrg(id: string, name: string, allowlist: string | null) {
  db.prepare("INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)").run(
    id,
    name,
    allowlist,
  );
}

function insertOrgWithIdpOrgId(id: string, name: string, allowlistIdpOrgId: string | null) {
  db.prepare("INSERT INTO orgs (id, name, allowlist_idp_org_id) VALUES (?, ?, ?)").run(
    id,
    name,
    allowlistIdpOrgId,
  );
}

describe("resolveOrgFromMemberships", () => {
  it("returns null on empty memberships array (short-circuits before SQL)", () => {
    insertOrg("o1", "Acme", "acme");
    expect(resolveOrgFromMemberships(db, [])).toBeNull();
  });

  it("returns the match when a single membership matches", () => {
    insertOrg("o1", "Acme", "acme");
    const result = resolveOrgFromMemberships(db, ["acme"]);
    expect(result).toEqual({
      org_id: "o1",
      org_name: "Acme",
      matched_org_login: "acme",
    });
  });

  it("returns null when no membership matches any allowlisted org", () => {
    insertOrg("o1", "Acme", "acme");
    expect(resolveOrgFromMemberships(db, ["personal"])).toBeNull();
  });

  it("returns the alphabetically first match when multiple memberships match (tie-break)", () => {
    insertOrg("o1", "Acme", "acme");
    insertOrg("o2", "Beta", "beta");
    const result = resolveOrgFromMemberships(db, ["acme", "beta"]);
    expect(result).not.toBeNull();
    expect(result!.matched_org_login).toBe("acme");
    expect(result!.org_id).toBe("o1");
  });

  it("matches case-insensitively when stored allowlist is upper case", () => {
    insertOrg("o1", "Acme", "ACME");
    const result = resolveOrgFromMemberships(db, ["acme"]);
    expect(result).not.toBeNull();
    expect(result!.org_id).toBe("o1");
  });

  it("returns the second alphabetically when user only matches the later org", () => {
    insertOrg("o1", "Acme", "acme");
    insertOrg("o2", "Beta", "beta");
    const result = resolveOrgFromMemberships(db, ["beta"]);
    expect(result).not.toBeNull();
    expect(result!.matched_org_login).toBe("beta");
    expect(result!.org_id).toBe("o2");
  });

  it("skips rows where allowlist_github_org is NULL (NULL IN (...) is unknown, not true)", () => {
    insertOrg("o1", "NoAllowlist", null);
    insertOrg("o2", "Acme", "acme");
    // Even if the user supplied a literally-null-ish empty string, NULL must not match.
    const result = resolveOrgFromMemberships(db, ["acme"]);
    expect(result).not.toBeNull();
    expect(result!.org_id).toBe("o2");

    // And with a membership that doesn't match anything, NULL row still not picked.
    expect(resolveOrgFromMemberships(db, ["other"])).toBeNull();
  });

  it("returns matched_org_login as STORED (preserves admin's casing)", () => {
    insertOrg("o1", "Acme", "ACME");
    const result = resolveOrgFromMemberships(db, ["acme"]);
    expect(result).not.toBeNull();
    expect(result!.matched_org_login).toBe("ACME");
  });

  it("is stable across repeated calls with same data (deterministic tie-break)", () => {
    insertOrg("o1", "Acme", "acme");
    insertOrg("o2", "Beta", "beta");
    insertOrg("o3", "Gamma", "gamma");
    const first = resolveOrgFromMemberships(db, ["gamma", "acme", "beta"]);
    const second = resolveOrgFromMemberships(db, ["gamma", "acme", "beta"]);
    expect(first).toEqual(second);
    expect(first!.matched_org_login).toBe("acme");
  });
});

describe("resolveOrgFromIdpOrgId (T56)", () => {
  it("returns the match when allowlist_idp_org_id equals the supplied value", () => {
    insertOrgWithIdpOrgId("o1", "Acme Workspace", "acme.com");
    const result = resolveOrgFromIdpOrgId(db, "acme.com");
    expect(result).toEqual({
      org_id: "o1",
      org_name: "Acme Workspace",
      matched_org_login: "acme.com",
    });
  });

  it("matches case-insensitively", () => {
    insertOrgWithIdpOrgId("o1", "Acme", "ACME.COM");
    const result = resolveOrgFromIdpOrgId(db, "acme.com");
    expect(result).not.toBeNull();
    expect(result!.org_id).toBe("o1");
  });

  it("returns null when no row matches", () => {
    insertOrgWithIdpOrgId("o1", "Acme", "acme.com");
    expect(resolveOrgFromIdpOrgId(db, "other.com")).toBeNull();
  });

  it("returns null when the orgs table is empty", () => {
    expect(resolveOrgFromIdpOrgId(db, "acme.com")).toBeNull();
  });

  it("preserves admin's stored casing in matched_org_login", () => {
    insertOrgWithIdpOrgId("o1", "Acme", "Acme.COM");
    const result = resolveOrgFromIdpOrgId(db, "acme.com");
    expect(result!.matched_org_login).toBe("Acme.COM");
  });

  it("does not bleed into allowlist_github_org space (orthogonal columns)", () => {
    // Same value in allowlist_github_org as the lookup value -- must NOT match.
    insertOrg("o1", "GhOnly", "acme.com");
    expect(resolveOrgFromIdpOrgId(db, "acme.com")).toBeNull();
    // And vice-versa.
    insertOrgWithIdpOrgId("o2", "HdOnly", "beta.com");
    expect(resolveOrgFromMemberships(db, ["beta.com"])).toBeNull();
  });
});
