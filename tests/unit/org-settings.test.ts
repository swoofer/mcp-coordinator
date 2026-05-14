import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  getOrgSetting,
  invalidateOrgsColumnCache,
} from "../../src/auth/org-settings.js";

// Full Phase 2 orgs schema (T01a baseline + B-NEW-4 allowlist column).
const ORGS_SCHEMA = `
  CREATE TABLE orgs (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    idp_provider          TEXT,
    idp_org_id            TEXT,
    created_at            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    allowlist_github_org  TEXT
  );
`;

let db: Database.Database;
const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(ORGS_SCHEMA);
  db.prepare(
    "INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
  ).run("o1", "Acme", "acme");
});

afterEach(() => {
  db.close();
  // Restore env snapshot to keep tests hermetic.
  for (const k of Object.keys(process.env)) {
    if (!(k in ENV_BACKUP)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(ENV_BACKUP)) {
    process.env[k] = v;
  }
});

describe("getOrgSetting", () => {
  it("throws on invalid key containing a semicolon", () => {
    expect(() => getOrgSetting(db, "o1", "foo;DROP TABLE orgs", "x")).toThrow(
      /invalid key/,
    );
  });

  it("throws on invalid key containing a dash-dash sequence", () => {
    expect(() => getOrgSetting(db, "o1", "foo--bar", "x")).toThrow(
      /invalid key/,
    );
  });

  it("throws on invalid key containing a space", () => {
    expect(() => getOrgSetting(db, "o1", "foo bar", "x")).toThrow(
      /invalid key/,
    );
  });

  it("skips DB path when orgId is null and returns env value", () => {
    process.env.COORDINATOR_ALLOWLIST_GITHUB_ORG = "from-env";
    expect(
      getOrgSetting(db, null, "allowlist_github_org", "default"),
    ).toBe("from-env");
  });

  it("skips DB path when orgId is undefined and returns env value", () => {
    process.env.COORDINATOR_ALLOWLIST_GITHUB_ORG = "from-env";
    expect(
      getOrgSetting(db, undefined, "allowlist_github_org", "default"),
    ).toBe("from-env");
  });

  it("falls back to env when the column does not exist on orgs", () => {
    delete process.env.COORDINATOR_JWT_ACCESS_TTL;
    process.env.COORDINATOR_JWT_ACCESS_TTL = "900";
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "300")).toBe("900");
  });

  it("returns the DB column value when row exists and value is non-null", () => {
    process.env.COORDINATOR_ALLOWLIST_GITHUB_ORG = "from-env";
    expect(
      getOrgSetting(db, "o1", "allowlist_github_org", "default"),
    ).toBe("acme");
  });

  it("falls back to env when the column exists but the org row is missing", () => {
    process.env.COORDINATOR_ALLOWLIST_GITHUB_ORG = "from-env";
    expect(
      getOrgSetting(db, "missing-org-id", "allowlist_github_org", "default"),
    ).toBe("from-env");
  });

  it("falls back to env when the column value is SQL NULL", () => {
    db.prepare(
      "INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)",
    ).run("o2", "NullCo", null);
    process.env.COORDINATOR_ALLOWLIST_GITHUB_ORG = "from-env";
    expect(
      getOrgSetting(db, "o2", "allowlist_github_org", "default"),
    ).toBe("from-env");
  });

  it("returns envDefault when neither DB column nor env is set", () => {
    delete process.env.COORDINATOR_JWT_ACCESS_TTL;
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "300")).toBe("300");
  });

  it("returns undefined when envDefault is undefined and no other source is set", () => {
    delete process.env.COORDINATOR_JWT_ACCESS_TTL;
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", undefined)).toBeUndefined();
  });

  it("sees a newly-added column after invalidateOrgsColumnCache", () => {
    // First call populates the cache without the new column.
    delete process.env.COORDINATOR_JWT_ACCESS_TTL;
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "default")).toBe("default");

    db.exec("ALTER TABLE orgs ADD COLUMN jwt_access_ttl TEXT");
    db.prepare("UPDATE orgs SET jwt_access_ttl = ? WHERE id = ?").run(
      "1800",
      "o1",
    );

    // Stale cache: column not yet visible.
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "default")).toBe("default");

    invalidateOrgsColumnCache(db);
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "default")).toBe("1800");
  });

  it("coerces numeric DB values to string", () => {
    db.exec("ALTER TABLE orgs ADD COLUMN jwt_access_ttl INTEGER");
    db.prepare("UPDATE orgs SET jwt_access_ttl = ? WHERE id = ?").run(
      3600,
      "o1",
    );
    invalidateOrgsColumnCache(db);
    const v = getOrgSetting(db, "o1", "jwt_access_ttl", "0");
    expect(v).toBe("3600");
    expect(typeof v).toBe("string");
  });

  it("uppercases the key when building the env var name", () => {
    delete process.env.COORDINATOR_JWT_ACCESS_TTL;
    process.env.COORDINATOR_JWT_ACCESS_TTL = "1234";
    // Column does not exist on orgs, so we exercise the env-name uppercasing.
    expect(getOrgSetting(db, "o1", "jwt_access_ttl", "default")).toBe("1234");
  });
});
