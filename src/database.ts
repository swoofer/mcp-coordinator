import path from "path";
import { mkdirSync } from "fs";
import { createRequire } from "module";
import type { DatabaseAdapter } from "./db-adapter.js";

const require = createRequire(import.meta.url);

let db: DatabaseAdapter;

const CURRENT_USER_VERSION = 7;

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      modules TEXT DEFAULT '[]',
      status TEXT DEFAULT 'offline',
      registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS threads (
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
      FOREIGN KEY (initiator_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      context_snapshot TEXT,
      in_reply_to TEXT,
      round INTEGER NOT NULL,
      token_estimate INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS action_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      file_path TEXT,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dependency_map (
      module_id TEXT PRIMARY KEY,
      depends_on TEXT DEFAULT '[]',
      exports TEXT DEFAULT '[]',
      owners TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS file_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      tool_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      module TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
    CREATE INDEX IF NOT EXISTS idx_threads_initiator ON threads(initiator_id);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON thread_messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON thread_messages(agent_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_agent ON action_summaries(agent_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_session ON action_summaries(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_file_activity_agent ON file_activity(agent_id);
    CREATE INDEX IF NOT EXISTS idx_file_activity_path ON file_activity(file_path);

    CREATE TABLE IF NOT EXISTS introspections (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      score INTEGER NOT NULL,
      reasons TEXT,
      status TEXT DEFAULT 'pending',
      response TEXT,
      concerned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_introspections_agent ON introspections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_introspections_status ON introspections(status);

    CREATE TABLE IF NOT EXISTS agent_activity_status (
      agent_id TEXT PRIMARY KEY,
      activity_status TEXT DEFAULT 'idle',
      current_file TEXT,
      current_thread TEXT,
      last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS revoked_agents (
      agent_id TEXT PRIMARY KEY,
      revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS working_files (
      agent_id          TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      started_at        TEXT NOT NULL,
      last_activity_at  TEXT NOT NULL,
      claim_until       TEXT NOT NULL,
      PRIMARY KEY (agent_id, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_working_files_path  ON working_files(file_path);
    CREATE INDEX IF NOT EXISTS idx_working_files_until ON working_files(claim_until);

    CREATE TABLE IF NOT EXISTS git_cochange (
      file_a        TEXT NOT NULL,
      file_b        TEXT NOT NULL,
      count         INTEGER NOT NULL,
      total_commits INTEGER NOT NULL,
      computed_at   TEXT NOT NULL,
      PRIMARY KEY (file_a, file_b),
      CHECK (file_a < file_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cochange_a ON git_cochange(file_a);
    CREATE INDEX IF NOT EXISTS idx_cochange_b ON git_cochange(file_b);

    CREATE TABLE IF NOT EXISTS git_cochange_meta (
      k TEXT PRIMARY KEY,
      v TEXT
    );

    CREATE TABLE IF NOT EXISTS layer_firings (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      layer     TEXT NOT NULL,
      score     INTEGER NOT NULL,
      agent_id  TEXT,
      fired_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_firings_layer  ON layer_firings(layer, fired_at);
    CREATE INDEX IF NOT EXISTS idx_firings_thread ON layer_firings(thread_id);
`;

function createBetterSqlite3(dataDir: string): DatabaseAdapter {
  mkdirSync(dataDir, { recursive: true });
  const Database = require("better-sqlite3");
  const dbPath = path.join(dataDir, "coordinator.db");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");
  raw.pragma("foreign_keys = ON");
  return raw as DatabaseAdapter;
}

function createBunSqlite(dataDir: string): DatabaseAdapter {
  mkdirSync(dataDir, { recursive: true });
  const { Database } = require("bun:sqlite");
  const dbPath = path.join(dataDir, "coordinator.db");
  const raw = new Database(dbPath);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  return raw as DatabaseAdapter;
}

export function initDatabase(dataDir: string): void {
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    db = createBunSqlite(dataDir);
  } else {
    db = createBetterSqlite3(dataDir);
  }

  // Check for downgrade: refuse if DB was written by a newer binary
  let foundVersion = 0;
  try {
    const v = (db as unknown as { prepare: (sql: string) => { get: () => unknown } })
      .prepare("PRAGMA user_version")
      .get() as { user_version: number } | undefined;
    foundVersion = v?.user_version ?? 0;
  } catch { foundVersion = 0; }
  if (foundVersion > CURRENT_USER_VERSION) {
    throw new Error(
      `Database schema is from a newer version (${foundVersion}) than this binary supports (${CURRENT_USER_VERSION}). Downgrade not supported.`
    );
  }

  db.exec(SCHEMA);

  // Migrations for existing databases — columns may already exist
  try { db.exec("ALTER TABLE threads ADD COLUMN claimed_by TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE threads ADD COLUMN claimed_at TEXT"); } catch { /* already exists */ }
  // F4: track unclaim count to poison threads that no agent manages to complete.
  // Without this, an aborted task bounces back into the pool indefinitely and
  // gets re-claimed by the same (or next) agent in a tight failure loop.
  try { db.exec("ALTER TABLE threads ADD COLUMN unclaim_count INTEGER DEFAULT 0"); } catch { /* already exists */ }
  // Directed-dispatch: a thread with `assigned_to` set is claimable only by
  // that specific agent. NULL = anyone can claim (backwards compat with
  // existing work-stealing). Used by lead/worker presets and sequential
  // pipelines that need explicit hand-offs instead of first-come claims.
  try { db.exec("ALTER TABLE threads ADD COLUMN assigned_to TEXT"); } catch { /* already exists */ }

  // v0.6: per-edit symbol metadata on file_activity
  try { db.exec("ALTER TABLE file_activity ADD COLUMN symbols_touched TEXT"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE file_activity ADD COLUMN content_hash TEXT"); } catch { /* already exists */ }

  // v0.6: schema version marker. Used by cli/server/restore.ts to refuse downgrades.
  // PRAGMA user_version is set at end of Task 5 — after all migrations succeed.
}

export function getDb(): DatabaseAdapter {
  if (!db) throw new Error("Database not initialized. Call initDatabase first.");
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}
