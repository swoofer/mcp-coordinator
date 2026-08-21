import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

const TEST_DIR = "data-test-db";

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
});

afterAll(async () => {
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  // Windows can hold .db handles for many seconds after better-sqlite3 close()
  // (Defender / indexer / WAL teardown). Retry generously; the parent dir cleanup
  // will eventually win once the OS releases the file.
  await fs.promises.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 20, retryDelay: 750 });
}, 30000);

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
    try {
      fs.rmSync(DIR, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  });

  it("refuses to boot if user_version is from a newer binary", () => {
    expect(() => initDatabase(DIR)).toThrow(/newer version/);
    // ...and it closes the connection it opened. Otherwise the refused DB file
    // stays locked, this describe's afterAll rmSync fails, and data-test-downgrade/
    // is left behind on Windows.
    expect((getDb() as unknown as { open: boolean }).open).toBe(false);
  });
});

// The previous connection must be closed on re-init: better-sqlite3 keeps the
// file handle open, and on Windows an orphaned handle makes rmSync of the data
// dir fail with EBUSY -- which is what broke tests/unit/logger.test.ts (it calls
// createServices twice, so initDatabase ran twice). Asserted on `open` rather
// than on a filesystem delete so it fails on POSIX too, where unlink of an open
// file quietly succeeds.
describe("initDatabase re-initialisation", () => {
  it("closes the previous connection instead of leaking the handle", () => {
    // Own the starting state: whatever ran before may have left the singleton
    // pointing at an already-closed connection (see the downgrade test).
    initDatabase(TEST_DIR);
    const previous = getDb() as unknown as { open: boolean };
    expect(previous.open).toBe(true);

    initDatabase(TEST_DIR);

    expect(previous.open).toBe(false);
    expect((getDb() as unknown as { open: boolean }).open).toBe(true);
  });
});
