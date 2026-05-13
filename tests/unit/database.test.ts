import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

const TEST_DIR = "data-test-db";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Database", () => {
  it("creates all required tables", () => {
    const db = getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("agents");
    expect(names).toContain("threads");
    expect(names).toContain("thread_messages");
    expect(names).toContain("action_summaries");
    expect(names).toContain("events");
    expect(names).toContain("dependency_map");
    expect(names).toContain("file_activity");
    expect(names).toContain("introspections");
    expect(names).toContain("revoked_agents");
  });

  it("getDb() throws before initDatabase is called", async () => {
    vi.resetModules();
    const { getDb: freshGetDb } = await import("../../src/database.js");
    expect(() => freshGetDb()).toThrow("Database not initialized");
  });
});

describe("downgrade refusal", () => {
  const DIR = "data-test-downgrade";

  beforeAll(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    // Use dynamic import to stay ESM-compatible
    const { default: Database } = await import("better-sqlite3");
    const dbPath = path.join(DIR, "coordinator.db");
    const raw = new Database(dbPath);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
  });

  afterAll(() => {
    // Idempotent cleanup — runs regardless of test outcome
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* already gone */ }
  });

  it("refuses to boot if user_version is from a newer binary", () => {
    expect(() => initDatabase(DIR)).toThrow(/newer version/);
  });
});

