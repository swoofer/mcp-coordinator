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
