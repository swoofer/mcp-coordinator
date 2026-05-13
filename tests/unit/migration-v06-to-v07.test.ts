import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import path from "path";

const DIR = "data-test-v06-migration";

beforeAll(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  // Manually create a v0.6-shaped database (no org_id, user_version=6) using dynamic import
  // — `require` is not available in ESM. The dynamic import resolves to the same module
  // that `src/database.ts` uses via createRequire().
  const { default: Database } = await import("better-sqlite3");
  const dbPath = path.join(DIR, "coordinator.db");
  const raw = new Database(dbPath);
  // Seed every v0.6 table in TABLES_NEEDING_ORG so the migration's ALTER loop is exercised
  // end-to-end. The previous seed only covered agents/threads/file_activity and silently
  // skipped any ALTER failure on the others (because the table didn't exist to begin with).
  raw.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, modules TEXT, status TEXT, registered_at TEXT, last_seen_at TEXT);
    CREATE TABLE threads (id TEXT PRIMARY KEY, initiator_id TEXT, subject TEXT, status TEXT);
    CREATE TABLE thread_messages (id TEXT PRIMARY KEY, thread_id TEXT, agent_id TEXT, type TEXT, content TEXT, round INTEGER);
    CREATE TABLE action_summaries (id TEXT PRIMARY KEY, session_id TEXT, agent_id TEXT, summary TEXT);
    CREATE TABLE file_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, agent_id TEXT, tool_name TEXT, file_path TEXT, created_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE dependency_map (module_id TEXT PRIMARY KEY, depends_on TEXT, exports TEXT, owners TEXT);
    CREATE TABLE introspections (id TEXT PRIMARY KEY, thread_id TEXT, agent_id TEXT, score INTEGER, status TEXT);
    CREATE TABLE agent_activity_status (agent_id TEXT PRIMARY KEY, activity_status TEXT, current_file TEXT, current_thread TEXT, last_activity_at TEXT);
    CREATE TABLE revoked_agents (agent_id TEXT PRIMARY KEY, revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revoked_by TEXT NOT NULL);
    CREATE TABLE working_files (agent_id TEXT, file_path TEXT, started_at TEXT, last_activity_at TEXT, claim_until TEXT, PRIMARY KEY (agent_id, file_path));
    CREATE TABLE git_cochange (file_a TEXT, file_b TEXT, count INTEGER, total_commits INTEGER, computed_at TEXT, PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b));
    CREATE TABLE git_cochange_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE layer_firings (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, layer TEXT, score INTEGER, agent_id TEXT, fired_at TEXT);
    PRAGMA user_version = 6;
  `);
  raw.prepare("INSERT INTO agents (id, name) VALUES ('legacy-a', 'Legacy A')").run();
  raw.prepare("INSERT INTO threads (id, initiator_id, subject) VALUES ('legacy-t', 'legacy-a', 'subj')").run();
  raw.prepare("INSERT INTO file_activity (session_id, agent_id, tool_name, file_path) VALUES ('s1', 'legacy-a', 'Edit', 'x.ts')").run();
  raw.prepare("INSERT INTO layer_firings (thread_id, layer, score) VALUES ('legacy-t', 'l4', 5)").run();
  raw.prepare("INSERT INTO action_summaries (id, session_id, agent_id, summary) VALUES ('as1', 's1', 'legacy-a', 'did stuff')").run();
  raw.close();
  // Now run the v0.7 migration via the real initDatabase. Doing this in beforeAll
  // (not inside an `it` block) ensures the DB is initialized before any test runs,
  // regardless of test order.
  initDatabase(DIR);
});

afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

describe("v0.6 → v0.7 migration", () => {
  // No "boots without error" `it` — initDatabase already ran in beforeAll.
  // A boot failure would surface as a beforeAll error and fail all tests in this file.

  it("user_version bumped to 7", () => {
    const db = getDb();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBe(7);
  });

  it("existing agents row preserved", () => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM agents WHERE id = 'legacy-a'").get() as { name: string; org_id: string };
    expect(row.name).toBe("Legacy A");
    expect(row.org_id).toBe("default");
  });

  it("existing threads row preserved and gets org_id='default'", () => {
    const db = getDb();
    const row = db.prepare("SELECT org_id FROM threads WHERE id = 'legacy-t'").get() as { org_id: string };
    expect(row.org_id).toBe("default");
  });

  it("existing file_activity row preserved and gets org_id='default'", () => {
    const db = getDb();
    const row = db.prepare("SELECT org_id FROM file_activity WHERE session_id = 's1'").get() as { org_id: string };
    expect(row.org_id).toBe("default");
  });

  it("default org seeded", () => {
    const db = getDb();
    const row = db.prepare("SELECT * FROM orgs WHERE id = 'default'").get();
    expect(row).toBeDefined();
  });

  it("new tables (users, refresh_tokens, etc.) exist and are empty", () => {
    const db = getDb();
    for (const table of ["users", "refresh_tokens", "device_auth_requests", "audit_log"]) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n).toBe(0);
    }
  });

  it("all 14 ALTERed tables gained org_id", () => {
    const db = getDb();
    for (const table of [
      "agents", "threads", "thread_messages", "action_summaries",
      "file_activity", "events", "dependency_map", "introspections",
      "agent_activity_status", "revoked_agents", "working_files",
      "git_cochange", "git_cochange_meta", "layer_firings",
    ]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain(`org_id`);
    }
  });
});
