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
