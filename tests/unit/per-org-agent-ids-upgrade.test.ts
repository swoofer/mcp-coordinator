import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

/**
 * issue #231 — the v11 migration running over a POPULATED v10 database.
 *
 * The tests in per-org-agent-ids-migration.test.ts exercise a fresh database,
 * where the migration has no rows to move. This file is the one that matters
 * for existing deployments: it builds a v10-shaped database with data, runs
 * the upgrade, and checks nothing was lost or shifted.
 *
 * v10 shape = agents keyed (org_id, id) with a GLOBAL unique index on
 * agents(id), and the five dependent tables referencing agents(id) alone.
 */
const DIR = "data-test-per-org-upgrade";

/** Build a populated v10 database by hand, bypassing initDatabase. */
function seedV10(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "coordinator.db"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO orgs (id, name) VALUES ('default','Default'),('org-a','A'),('org-b','B');

    CREATE TABLE agents (
      id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      modules TEXT DEFAULT '[]',
      status TEXT DEFAULT 'offline',
      registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id, id),
      FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX idx_agents_id ON agents(id);

    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      initiator_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      plan TEXT,
      target_modules TEXT DEFAULT '[]',
      target_files TEXT DEFAULT '[]',
      status TEXT DEFAULT 'open',
      resolution_summary TEXT,
      conflicts TEXT,
      round INTEGER DEFAULT 1,
      max_rounds INTEGER DEFAULT 4,
      timeout_seconds INTEGER DEFAULT 600,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      expected_respondents TEXT,
      depends_on_files TEXT,
      exports_affected TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      unclaim_count INTEGER DEFAULT 0,
      assigned_to TEXT,
      org_id TEXT NOT NULL DEFAULT 'default',
      run_id TEXT,
      FOREIGN KEY (initiator_id) REFERENCES agents(id),
      FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
    );
  `);

  db.prepare(
    "INSERT INTO agents (id, org_id, name, status) VALUES (?, ?, ?, ?)",
  ).run("alice", "org-a", "Alice", "online");
  db.prepare(
    "INSERT INTO agents (id, org_id, name, status) VALUES (?, ?, ?, ?)",
  ).run("bob", "org-b", "Bob", "offline");

  // A well-formed thread: org matches the agent's org.
  db.prepare(
    "INSERT INTO threads (id, initiator_id, subject, org_id, target_files, round) VALUES (?,?,?,?,?,?)",
  ).run("t-ok", "alice", "well formed", "org-a", '["src/a.ts"]', 3);

  // The row v0.7 could leave behind: org_id back-filled to 'default' while the
  // agent actually belongs to org-b. Legal under the old single-column FK,
  // illegal under the composite one — the migration must repair it.
  db.prepare(
    "INSERT INTO threads (id, initiator_id, subject, org_id, target_files, round) VALUES (?,?,?,?,?,?)",
  ).run("t-mismatched", "bob", "org drifted", "default", '["src/b.ts"]', 7);

  db.pragma("user_version = 10");
  db.close();
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

describe("v11 upgrade over a populated v10 database (#231)", () => {
  it("upgrades to v11 and drops the global index", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    expect(
      getDb().prepare("SELECT name FROM sqlite_master WHERE name='idx_agents_id'").all(),
    ).toHaveLength(0);
  });

  it("keeps every row, and does not shift column values", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT id, initiator_id, subject, target_files, round FROM threads ORDER BY id")
      .all() as { id: string; initiator_id: string; subject: string; target_files: string; round: number }[];

    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.id === "t-ok")!;
    // A column-order mistake in the copy would surface here as values landing
    // in the wrong fields.
    expect(ok.initiator_id).toBe("alice");
    expect(ok.subject).toBe("well formed");
    expect(ok.target_files).toBe('["src/a.ts"]');
    expect(ok.round).toBe(3);
  });

  it("re-parents a row whose org_id disagreed with its agent's org", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const row = getDb()
      .prepare("SELECT org_id FROM threads WHERE id = ?")
      .get("t-mismatched") as { org_id: string };
    // bob lives in org-b, so the row follows him rather than staying 'default'.
    expect(row.org_id).toBe("org-b");
  });

  it("leaves the upgraded database free of foreign key violations", () => {
    seedV10(DIR);
    initDatabase(DIR);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("records the repair in audit_log so the operator can see what moved", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT metadata_json FROM audit_log WHERE action = 'migration.agent_fk_reparent'")
      .all() as { metadata_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].metadata_json).counts.threads).toBe(1);
  });

  // NOT COVERED, deliberately: the pre-flight that ABORTS when a row points at
  // an agent id present nowhere in `agents`. Reproducing it needs a faithful
  // v10 fixture — winding user_version back on a real database makes the v9
  // migration fire first and mask the v11 guard, and hand-building the full
  // v10 schema means transcribing every table the earlier migrations touch.
  // Disproportionate for a branch that only fires on a database already
  // violating its current foreign keys. The guard itself is a COUNT + throw
  // with no branching; see migrateAgentIdPerOrgV11 pre-flight 1.
});
