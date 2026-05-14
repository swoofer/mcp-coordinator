import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { resolveOrgFromMemberships } from "../../src/auth/allowlist.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE orgs (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      allowlist_github_org  TEXT
    );
    CREATE INDEX idx_orgs_allowlist ON orgs(allowlist_github_org);
  `);
});

afterEach(() => {
  db.close();
});

function insertOrg(id: string, name: string, allowlist: string | null) {
  db.prepare(
    "INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
  ).run(id, name, allowlist);
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
