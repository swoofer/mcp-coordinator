import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";

const DIR = "data-test-orgs-migration";

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("orgs table", () => {
  it("exists after init", () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='orgs'"
    ).get();
    expect(row).toBeDefined();
  });

  it("seeds the default org on first boot", () => {
    const db = getDb();
    const row = db.prepare("SELECT id, name FROM orgs WHERE id = 'default'").get() as {
      id: string;
      name: string;
    };
    expect(row.id).toBe("default");
    expect(row.name).toBe("Default Organization");
  });

  it("has the expected columns", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(orgs)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(["created_at", "id", "idp_org_id", "idp_provider", "name"]);
  });
});

describe("users table", () => {
  it("exists with expected columns", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(users)").all() as { name: string; notnull: number }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "created_at", "email", "id", "idp_provider", "idp_user_id",
      "last_login_at", "name", "org_id", "role",
    ]);
  });

  it("enforces UNIQUE(idp_provider, idp_user_id)", () => {
    const db = getDb();
    db.prepare("INSERT INTO orgs (id, name) VALUES ('o1', 'Org 1')").run();
    db.prepare(
      "INSERT INTO users (id, org_id, email, idp_provider, idp_user_id) VALUES (?, ?, ?, ?, ?)"
    ).run("u1", "o1", "a@x", "github", "12345");
    expect(() =>
      db.prepare(
        "INSERT INTO users (id, org_id, email, idp_provider, idp_user_id) VALUES (?, ?, ?, ?, ?)"
      ).run("u2", "o1", "b@x", "github", "12345")
    ).toThrow(/UNIQUE/);
  });

  it("has idx_users_org index", () => {
    const db = getDb();
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_org'"
    ).get();
    expect(row).toBeDefined();
  });
});

describe("refresh_tokens table", () => {
  it("exists with expected columns", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(refresh_tokens)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "created_at", "device_label", "expires_at", "id", "jti",
      "last_used_at", "org_id", "revoked_at", "user_id",
    ]);
  });

  it("has both indexes", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='refresh_tokens'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name).sort();
    expect(names).toContain("idx_refresh_user");
    expect(names).toContain("idx_refresh_org_user");
  });
});

describe("device_auth_requests table", () => {
  it("exists with expected columns including nonce", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(device_auth_requests)").all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      "approved_user_id", "created_at", "device_code", "expires_at",
      "nonce", "org_id", "user_code",
    ]);
  });

  it("enforces user_code UNIQUE", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
    ).run("dc1", "UC1234", "n1", "2099-01-01", "default");
    expect(() =>
      db.prepare(
        "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
      ).run("dc2", "UC1234", "n2", "2099-01-01", "default")
    ).toThrow(/UNIQUE/);
  });

  it("enforces nonce UNIQUE", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
    ).run("dc3", "UC9999", "shared-nonce", "2099-01-01", "default");
    expect(() =>
      db.prepare(
        "INSERT INTO device_auth_requests (device_code, user_code, nonce, expires_at, org_id) VALUES (?, ?, ?, ?, ?)"
      ).run("dc4", "UC8888", "shared-nonce", "2099-01-01", "default")
    ).toThrow(/UNIQUE/);
  });
});

describe("audit_log table", () => {
  it("exists with expected columns", () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(audit_log)").all() as { name: string; notnull: number }[];
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.id).toBeDefined();
    expect(byName.action).toBeDefined();
    expect(byName.action.notnull).toBe(1);
    expect(byName.org_id.notnull).toBe(0); // nullable per spec amendment
    expect(byName.user_id.notnull).toBe(0);
  });

  it("has time-ordered indexes for org/user/action", () => {
    const db = getDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'"
    ).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_audit_org_time");
    expect(names).toContain("idx_audit_user");
    expect(names).toContain("idx_audit_action");
  });
});
