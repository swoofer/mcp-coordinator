import path from "path";
import { mkdirSync, chmodSync } from "fs";
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

    CREATE TABLE IF NOT EXISTS orgs (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      idp_provider  TEXT,
      idp_org_id    TEXT,
      created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES orgs(id),
      email           TEXT NOT NULL,
      name            TEXT,
      idp_provider    TEXT NOT NULL,
      idp_user_id     TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'member',
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at   TEXT,
      UNIQUE(idp_provider, idp_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id              TEXT PRIMARY KEY,
      org_id          TEXT NOT NULL REFERENCES orgs(id),
      user_id         TEXT NOT NULL REFERENCES users(id),
      jti             TEXT NOT NULL UNIQUE,
      device_label    TEXT,
      expires_at      TEXT NOT NULL,
      revoked_at      TEXT,
      last_used_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_org_user ON refresh_tokens(org_id, user_id, revoked_at);

    CREATE TABLE IF NOT EXISTS device_auth_requests (
      device_code      TEXT PRIMARY KEY,
      user_code        TEXT NOT NULL UNIQUE,
      nonce            TEXT NOT NULL UNIQUE,
      approved_user_id TEXT REFERENCES users(id),
      org_id           TEXT,
      expires_at       TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_device_user_code ON device_auth_requests(user_code);
    CREATE INDEX IF NOT EXISTS idx_device_nonce ON device_auth_requests(nonce);

    CREATE TABLE IF NOT EXISTS audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         TEXT,
      org_id          TEXT,
      action          TEXT NOT NULL,
      target          TEXT,
      ip              TEXT,
      user_agent      TEXT,
      metadata        TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log(org_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);

    INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Default Organization');
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

  // v0.7 security baseline: only owner can read/write the DB file.
  // Idempotent re-chmod on every boot so existing v0.6 DBs are tightened too.
  // POSIX-only: chmod is a no-op on Windows (NTFS permissions don't map).
  try {
    chmodSync(path.join(dataDir, "coordinator.db"), 0o600);
  } catch { /* non-POSIX or permission error — log-only would be too noisy */ }

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

  // v0.7: multi-tenant org_id column on every table that participates in scoping.
  // SQLite lacks online DDL — each ALTER briefly blocks writes. Migration is
  // idempotent (already-exists is caught silently).
  // SECURITY: `t` is from a compile-time constant array only — never user input.
  const TABLES_NEEDING_ORG = [
    "agents", "threads", "thread_messages", "action_summaries",
    "file_activity", "events", "dependency_map", "introspections",
    "agent_activity_status", "revoked_agents", "working_files",
    "git_cochange", "git_cochange_meta", "layer_firings",
  ] as const;
  for (const t of TABLES_NEEDING_ORG) {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'`);
    } catch { /* already exists */ }
  }

  // v0.7: scan index for events table — getEventsSince queries by (org_id, id)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id, id)");
  } catch { /* already exists */ }

  // v0.7.1: composite indexes for org-scoped hot queries (Tasks 15/17 reads).
  // Created AFTER the ALTER loop above — these indexes reference org_id which
  // doesn't exist on the legacy tables until the ALTER runs. file_activity is
  // append-only and grows fast in multi-org deployments; the single-column
  // path index alone forces a full scan of all-org rows before the WHERE
  // org_id filter applies.
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_file_activity_org_path_time ON file_activity(org_id, file_path, created_at)");
  } catch { /* already exists */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_threads_org_status ON threads(org_id, status)");
  } catch { /* already exists */ }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_summaries_org_agent ON action_summaries(org_id, agent_id)");
  } catch { /* already exists */ }

  // v0.7: SQLite lacks ALTER PRIMARY KEY. Pattern per table:
  //   1. Create new table with composite PK.
  //   2. Copy all rows from old to new.
  //   3. Drop old.
  //   4. Rename new to old.
  //   5. Recreate indexes.
  // Idempotent: skip if the table's PK already includes org_id.
  function migrateToCompositePK(
    targetDb: DatabaseAdapter,
    tableName: string,
    newCreateSql: string,
    columnList: string,
    indexCreateSqls: string[],
  ): void {
    // Check if migration already happened by inspecting PK columns
    const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all() as { name: string; pk: number }[];
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
    if (pkCols.includes("org_id")) return; // already migrated

    // SQLite: FK enforcement blocks DROP TABLE when other tables hold FK refs.
    // PRAGMA foreign_keys must be toggled OUTSIDE the transaction (it's a no-op
    // inside an open transaction). The finally block guarantees FKs are re-enabled
    // even on error to avoid permanent corruption.
    targetDb.exec("PRAGMA foreign_keys = OFF");
    try {
      targetDb.exec("BEGIN");
      try {
        targetDb.exec(newCreateSql.replace(tableName, `${tableName}_new`));
        targetDb.exec(`INSERT INTO ${tableName}_new (${columnList}) SELECT ${columnList} FROM ${tableName}`);
        targetDb.exec(`DROP TABLE ${tableName}`);
        targetDb.exec(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);
        for (const idxSql of indexCreateSqls) targetDb.exec(idxSql);
        targetDb.exec("COMMIT");
      } catch (e) {
        targetDb.exec("ROLLBACK");
        throw e;
      }
    } finally {
      targetDb.exec("PRAGMA foreign_keys = ON");
    }
  }

  migrateToCompositePK(db, "agents",
    `CREATE TABLE agents (
      id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      modules TEXT DEFAULT '[]',
      status TEXT DEFAULT 'offline',
      registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (org_id, id)
    )`,
    "id, org_id, name, modules, status, registered_at, last_seen_at",
    // LOAD-BEARING: this UNIQUE index is what makes the 5 FKs to agents(id)
    // (thread_messages, action_summaries, introspections, threads.initiator_id,
    // agent_activity_status) still enforceable after the composite-PK migration.
    // SQLite FKs require the referenced column to be UNIQUE or a single-column
    // PK; agents.id alone is now neither (PK is (org_id, id)). Dropping this
    // index silently breaks FK enforcement across those 5 tables. As a side
    // effect, same-id-different-org rows are rejected in `agents` (test pinned
    // in tests/unit/composite-pk-migration.test.ts).
    ["CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_id ON agents(id)"],
  );

  migrateToCompositePK(db, "agent_activity_status",
    `CREATE TABLE agent_activity_status (
      agent_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      activity_status TEXT DEFAULT 'idle',
      current_file TEXT,
      current_thread TEXT,
      last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agents(id),
      PRIMARY KEY (org_id, agent_id)
    )`,
    "agent_id, org_id, activity_status, current_file, current_thread, last_activity_at",
    [],
  );

  migrateToCompositePK(db, "revoked_agents",
    `CREATE TABLE revoked_agents (
      agent_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_by TEXT NOT NULL,
      PRIMARY KEY (org_id, agent_id)
    )`,
    "agent_id, org_id, revoked_at, revoked_by",
    [],
  );

  migrateToCompositePK(db, "working_files",
    `CREATE TABLE working_files (
      agent_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      claim_until TEXT NOT NULL,
      PRIMARY KEY (org_id, agent_id, file_path)
    )`,
    "agent_id, file_path, org_id, started_at, last_activity_at, claim_until",
    [
      "CREATE INDEX IF NOT EXISTS idx_working_files_path  ON working_files(file_path)",
      "CREATE INDEX IF NOT EXISTS idx_working_files_until ON working_files(claim_until)",
    ],
  );

  migrateToCompositePK(db, "dependency_map",
    `CREATE TABLE dependency_map (
      module_id TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      depends_on TEXT DEFAULT '[]',
      exports TEXT DEFAULT '[]',
      owners TEXT DEFAULT '[]',
      PRIMARY KEY (org_id, module_id)
    )`,
    "module_id, org_id, depends_on, exports, owners",
    [],
  );

  migrateToCompositePK(db, "git_cochange",
    `CREATE TABLE git_cochange (
      file_a TEXT NOT NULL,
      file_b TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      count INTEGER NOT NULL,
      total_commits INTEGER NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (org_id, file_a, file_b),
      CHECK (file_a < file_b)
    )`,
    "file_a, file_b, org_id, count, total_commits, computed_at",
    [
      "CREATE INDEX IF NOT EXISTS idx_cochange_a ON git_cochange(file_a)",
      "CREATE INDEX IF NOT EXISTS idx_cochange_b ON git_cochange(file_b)",
    ],
  );

  migrateToCompositePK(db, "git_cochange_meta",
    `CREATE TABLE git_cochange_meta (
      k TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      v TEXT,
      PRIMARY KEY (org_id, k)
    )`,
    "k, org_id, v",
    [],
  );

  // v0.7: bump version marker LAST — after every CREATE TABLE and ALTER above succeeded.
  // A crash before this line leaves user_version=6 and the next boot retries the migration
  // (idempotent). Bumping earlier would make a partial migration look complete.
  db.exec("PRAGMA user_version = 7");
}

export function getDb(): DatabaseAdapter {
  if (!db) throw new Error("Database not initialized. Call initDatabase first.");
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}
