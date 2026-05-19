import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { initDatabase, getDb, closeDb } from "../../src/database.js";

/**
 * T03 (v0.10.6) — UNIQUE INDEX on orgs(name).
 *
 * SCHEMA in src/database.ts adds `CREATE UNIQUE INDEX IF NOT EXISTS
 * idx_orgs_name ON orgs(name)` immediately after the orgs CREATE TABLE.
 * These tests pin:
 *   1. Fresh boot ⇒ index visible in sqlite_master.
 *   2. Duplicate INSERT ⇒ SQLITE_CONSTRAINT.
 *   3. Delete-then-recreate-with-same-name ⇒ allowed.
 */

const TEST_DIR = "data-test-orgs-unique-index";

beforeAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("orgs.name UNIQUE INDEX (T03)", () => {
  it("creates idx_orgs_name on a fresh DB", () => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_orgs_name'",
      )
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe("idx_orgs_name");
  });

  it("rejects a second INSERT with the same name", () => {
    const db = getDb();
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(
      "org-unique-a",
      "acme-unique-1",
    );
    expect(() =>
      db
        .prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
        .run("org-unique-b", "acme-unique-1"),
    ).toThrow(/UNIQUE constraint failed.*orgs\.name/);
  });

  it("allows re-inserting the same name only after deletion", () => {
    const db = getDb();
    db.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)").run(
      "org-recycle-a",
      "recycle-name",
    );
    expect(() =>
      db
        .prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
        .run("org-recycle-b", "recycle-name"),
    ).toThrow(/UNIQUE constraint failed/);

    db.prepare("DELETE FROM orgs WHERE id = ?").run("org-recycle-a");

    expect(() =>
      db
        .prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
        .run("org-recycle-b", "recycle-name"),
    ).not.toThrow();
  });

  it("idx_orgs_name is unique (sqlite_master reports unique=1)", () => {
    const db = getDb();
    // PRAGMA index_list returns one row per index on the table; `unique` column
    // is 1 for UNIQUE indexes, 0 for plain ones.
    const indexes = db
      .prepare("PRAGMA index_list(orgs)")
      .all() as Array<{ name: string; unique: number }>;
    const idx = indexes.find((i) => i.name === "idx_orgs_name");
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(1);
  });
});
