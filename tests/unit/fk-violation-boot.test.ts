import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

/**
 * issue #285 — end to end: a database whose corruption has nothing to do with
 * the org_id migration must not be reported as a migration bug.
 *
 * Worth knowing while reading this: the boot sequence rewinds `user_version`
 * to 8 before the migrations run, so v9 is re-entered on every start. Its
 * whole-database `PRAGMA foreign_key_check` is therefore the coordinator's de
 * facto startup integrity gate, and every violation in the file lands on it —
 * including ones no migration created.
 */
const DIR = "data-test-fk-violation-boot";

/** Boot once to get a real, current schema, then break one row behind SQLite's back. */
function bootThenCorrupt(sql: string): void {
  fs.rmSync(DIR, { recursive: true, force: true });
  initDatabase(DIR);
  closeDb();
  const raw = new Database(path.join(DIR, "coordinator.db"));
  raw.pragma("foreign_keys = OFF");
  raw.exec(sql);
  raw.close();
}

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

afterEach(() => {
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("boot on a database with a pre-existing FK violation (#285)", () => {
  /** A message whose thread was deleted. Nothing to do with org_id -> orgs. */
  const ORPHAN_MESSAGE = `
    INSERT INTO orgs (id, name) VALUES ('org-a','A');
    INSERT INTO agents (id, org_id, name, status)
      VALUES ('alice','org-a','Alice','offline');
    INSERT INTO thread_messages (id, thread_id, agent_id, type, content, round, org_id)
      VALUES ('m-1','t-gone','alice','comment','orphan',1,'org-a');
  `;

  it("names the offending table, columns and row count", () => {
    bootThenCorrupt(ORPHAN_MESSAGE);
    let message = "";
    try {
      initDatabase(DIR);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("thread_messages.thread_id -> threads (1 row)");
  });

  it("says it is a data problem, not a coordinator bug", () => {
    bootThenCorrupt(ORPHAN_MESSAGE);
    let message = "";
    try {
      initDatabase(DIR);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("data problem rather than a coordinator bug");
    // The old message sent operators hunting through the coordinator's source.
    expect(message).not.toContain("this indicates a migration bug");
  });

  it("tells the operator how to list the rows and that nothing was changed", () => {
    bootThenCorrupt(ORPHAN_MESSAGE);
    let message = "";
    try {
      initDatabase(DIR);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("PRAGMA foreign_key_check;");
    expect(message).toContain("Aborting; the database is left unchanged.");
  });

  it("still boots a database with no violations", () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    expect(() => initDatabase(DIR)).not.toThrow();
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
});
