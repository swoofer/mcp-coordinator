import { describe, it, expect, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { initDatabase, closeDb } from "../../src/database.js";

const require = createRequire(import.meta.url);
const DatabaseCtor = require("better-sqlite3") as new (path: string) => Database.Database;

/**
 * A replica booting next to one that is already serving (a RollingUpdate,
 * or any restart with replicas > 1) died on SQLITE_BUSY_SNAPSHOT inside
 * migrateOrgsFkV9 — production, 2026-09-11.
 *
 * Each migration transaction reads before it writes. Under a deferred BEGIN
 * the first read pins a WAL snapshot; if another process commits before the
 * first write, SQLite refuses the upgrade at once with SQLITE_BUSY_SNAPSHOT —
 * busy_timeout is never consulted, retrying inside the transaction cannot
 * succeed. The Redis boot lock does not cover this: it only orders boots
 * against each other, and the live replica never takes it.
 *
 * The test commits from a second connection right after the first read of
 * every migration transaction. BEGIN IMMEDIATE takes the write lock up front,
 * so that commit is the one that waits (here: is refused, busy_timeout 0).
 */

const DIR = "data-test-boot-migration-concurrent-writer";

describe("boot migrations vs a live process writing the same database", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("a commit landing mid-migration does not crash the boot with SQLITE_BUSY_SNAPSHOT", () => {
    initDatabase(DIR); // a fully migrated database, as on a running deployment

    const live = new DatabaseCtor(path.join(DIR, "coordinator.db"));
    live.pragma("busy_timeout = 0"); // single thread: it cannot wait for the boot to commit
    live.pragma("user_version = 8"); // v9+ pending, whatever the boot sequence does with it

    const proto = (DatabaseCtor as unknown as { prototype: Database.Database }).prototype;
    const realExec = proto.exec;
    const liveWrites: string[] = [];
    vi.spyOn(proto, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      const result = realExec.call(this, sql);
      if (this !== live && /^BEGIN\b/.test(sql)) {
        this.prepare("SELECT count(*) FROM sqlite_master").get(); // the transaction's first read
        try {
          live
            .prepare(
              "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES ('live-replica', 'x', 0)",
            )
            .run();
          liveWrites.push("committed");
        } catch (err) {
          liveWrites.push((err as { code?: string }).code ?? String(err));
        }
      }
      return result;
    });

    let bootError: unknown;
    try {
      initDatabase(DIR);
    } catch (err) {
      bootError = err;
    } finally {
      live.close();
    }
    // Before the fix: SqliteError, code SQLITE_BUSY_SNAPSHOT, out of migrateOrgsFkV9.
    expect((bootError as { code?: string } | undefined)?.code).toBeUndefined();
    expect(bootError).toBeUndefined();
    // The boot did open migration transactions, and held the write lock in each.
    expect(liveWrites.length).toBeGreaterThan(0);
    for (const outcome of liveWrites) expect(outcome).toBe("SQLITE_BUSY");
  });
});
