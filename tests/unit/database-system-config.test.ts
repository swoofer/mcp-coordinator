import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "node:fs";

/**
 * T01 (plan V2): system_config table.
 *
 * Schema:
 *   CREATE TABLE system_config (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 *   );
 *
 * The table backs Phase 3 encryption metadata (master-key id, KEK
 * fingerprint, last-rotation timestamp). Tests pin: (1) table is created
 * by initDatabase, (2) insert/select round-trips a value, (3) `key` is
 * the PRIMARY KEY so a duplicate insert without OR REPLACE raises.
 */

const TEST_DIR = "data-test-system-config";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  try { closeDb(); } catch { /* idempotent close */ }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
});

describe("system_config table", () => {
  it("is created by initDatabase", () => {
    const db = getDb();
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='system_config'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("system_config");
  });

  it("has the expected column shape (key, value, updated_at)", () => {
    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(system_config)")
      .all() as { name: string; pk: number; notnull: number }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has("key")).toBe(true);
    expect(byName.has("value")).toBe(true);
    expect(byName.has("updated_at")).toBe(true);
    // `key` is the PRIMARY KEY
    expect(byName.get("key")!.pk).toBe(1);
    // value + updated_at are NOT NULL
    expect(byName.get("value")!.notnull).toBe(1);
    expect(byName.get("updated_at")!.notnull).toBe(1);
  });

  it("round-trips an insert/select", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO system_config (key, value) VALUES (?, ?)",
    ).run("master_key_id", "kek-v1");
    const row = db
      .prepare("SELECT key, value FROM system_config WHERE key = ?")
      .get("master_key_id") as { key: string; value: string };
    expect(row.key).toBe("master_key_id");
    expect(row.value).toBe("kek-v1");
  });

  it("enforces PRIMARY KEY on `key` (duplicate insert without OR REPLACE throws)", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO system_config (key, value) VALUES (?, ?)",
    ).run("kek_fingerprint", "abc123");
    expect(() =>
      db
        .prepare("INSERT INTO system_config (key, value) VALUES (?, ?)")
        .run("kek_fingerprint", "different"),
    ).toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("defaults updated_at to CURRENT_TIMESTAMP when omitted", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO system_config (key, value) VALUES (?, ?)",
    ).run("rotation_timestamp", "2026-05-17T00:00:00Z");
    const row = db
      .prepare("SELECT updated_at FROM system_config WHERE key = ?")
      .get("rotation_timestamp") as { updated_at: string };
    expect(typeof row.updated_at).toBe("string");
    expect(row.updated_at.length).toBeGreaterThan(0);
  });
});
