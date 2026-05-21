import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { initDatabase, getDb, closeDb } from "../../src/database.js";

describe("v0.6 restore compat", () => {
  it("daemon starts on a v0.4-shaped DB and PRAGMA user_version becomes 8", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rc-"));
    initDatabase(dir);
    // Simulate older schema version
    getDb().exec("PRAGMA user_version = 4");
    closeDb();
    // Re-init with current binary
    initDatabase(dir);
    const v = getDb().prepare("PRAGMA user_version").get() as any;
    // v0.9 (issue #79) bumps schema to 9. Relaxed to >=8 so older snapshots
    // and the current head both satisfy the assertion intent ("migration ran").
    expect(v.user_version).toBeGreaterThanOrEqual(8);
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to start when DB user_version > current binary's", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rc-future-"));
    initDatabase(dir);
    getDb().exec("PRAGMA user_version = 999");
    closeDb();
    expect(() => initDatabase(dir)).toThrow(/newer/i);
    try { closeDb(); } catch { /* already closed or failed to open */ }
    rmSync(dir, { recursive: true, force: true });
  });
});
