import path from "path";
import { mkdirSync, chmodSync } from "fs";
import { createRequire } from "module";
import type { DatabaseAdapter } from "./db-adapter.js";
import { GENESIS_HASH, computeRowHash, type AuditChainFields } from "./security/audit-chain.js";
import { runOrgsUniquenessGuard, emitDuplicatesAcceptedAudit } from "./boot-orgs-uniqueness.js";

const require = createRequire(import.meta.url);

let db: DatabaseAdapter;

const CURRENT_USER_VERSION = 10;

/**
 * Narrow type alias for the migration code paths in this file. The
 * `DatabaseAdapter` interface is intentionally tiny (just `exec` +
 * `prepare(...).run/get/all`), so migrations that want to iterate over
 * a result set go through this cast rather than widening the adapter
 * for every call site.
 */
type MigrationDb = {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => { changes: number };
  };
};

interface AuditRowForBackfill extends AuditChainFields {
  id: number;
  prev_hash: string | null;
  row_hash: string | null;
}

/**
 * T50 (v0.9.1) backfill. Walk existing audit_log rows in id-order and
 * fill in prev_hash + row_hash for every row that doesn't have them yet.
 *
 * Idempotent: rows that already have a non-null row_hash are skipped so
 * a partial migration (interrupted boot) resumes cleanly. The first
 * unhashed row uses the LAST hashed row's row_hash as prev_hash (or
 * GENESIS_HASH if no rows have been hashed yet) -- this keeps the chain
 * unbroken across a partial backfill.
 *
 * Wrapped in a single transaction so a crash mid-backfill leaves
 * audit_log in a fully-hashed or fully-unhashed state.
 */
function backfillAuditChain(mdb: MigrationDb): void {
  const tailStmt = mdb.prepare(
    "SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1",
  );
  const tail = tailStmt.get() as { row_hash: string } | undefined;
  let prevHash = tail?.row_hash ?? GENESIS_HASH;

  const selectStmt = mdb.prepare(
    "SELECT id, actor_user_id, actor_org_id, action, target, " +
      "actor_ip, actor_user_agent, request_id, outcome, metadata_json, " +
      "prev_hash, row_hash FROM audit_log WHERE row_hash IS NULL ORDER BY id ASC",
  );
  const rows = selectStmt.all() as AuditRowForBackfill[];
  if (rows.length === 0) return;

  const updateStmt = mdb.prepare("UPDATE audit_log SET prev_hash = ?, row_hash = ? WHERE id = ?");

  // better-sqlite3 exposes db.transaction(...); via the adapter we drop
  // to a plain BEGIN/COMMIT pair, which works on every backend.
  mdb.prepare("BEGIN IMMEDIATE").run();
  try {
    for (const row of rows) {
      const rowHash = computeRowHash(prevHash, row);
      updateStmt.run(prevHash, rowHash, row.id);
      prevHash = rowHash;
    }
    mdb.prepare("COMMIT").run();
  } catch (err) {
    mdb.prepare("ROLLBACK").run();
    throw err;
  }
}

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
      run_id TEXT,
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
    -- v0.10.6 (T03): UNIQUE INDEX on orgs.name. Admin-UI POST /api/admin/orgs
    -- relies on this for the 409 ORG_NAME_TAKEN response (the SQLITE_CONSTRAINT
    -- error is what discriminates "name taken" from other write failures).
    -- A pre-flight boot guard in src/boot-orgs-uniqueness.ts runs BEFORE this
    -- index is created on each boot; if existing rows contain duplicate names
    -- the guard refuses boot (or audits via COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name ON orgs(name);

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

    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Default Organization');
`;

function createBetterSqlite3(dataDir: string): DatabaseAdapter {
  mkdirSync(dataDir, { recursive: true });
  const Database = require("better-sqlite3");
  const dbPath = path.join(dataDir, "coordinator.db");
  const raw = new Database(dbPath);
  raw.pragma("journal_mode = WAL");
  // performance-10: WAL makes synchronous=NORMAL safe (SQLite docs) — the
  // default FULL fsyncs on every write transaction, which is the dominant
  // cost on hot write paths (audit_log inserts, thread messages, etc). Under
  // WAL + NORMAL, SQLite only syncs at checkpoint boundaries; worst case on
  // an OS crash (not an app crash) is losing the last few uncheckpointed
  // transactions — no corruption risk. Acceptable for this workload.
  raw.pragma("synchronous = NORMAL");
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
  // performance-10: see synchronous=NORMAL rationale in createBetterSqlite3 above.
  raw.exec("PRAGMA synchronous = NORMAL");
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
  } catch {
    foundVersion = 0;
  }
  if (foundVersion > CURRENT_USER_VERSION) {
    throw new Error(
      `Database schema is from a newer version (${foundVersion}) than this binary supports (${CURRENT_USER_VERSION}). Downgrade not supported.`,
    );
  }

  // v0.10.6 T03: pre-flight UNIQUE INDEX guard. MUST run before SCHEMA so the
  // SCHEMA's `CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_name` doesn't abort
  // with a cryptic SQLITE_CONSTRAINT on upgrade DBs that happen to have
  // duplicate org names. See src/boot-orgs-uniqueness.ts for the branch matrix.
  // The returned payload, if non-null, is the override-accepted audit deferred
  // to AFTER the v0.8 migration block (audit_log column renames must be done
  // before we INSERT to actor_user_id / metadata_json / prev_hash / row_hash).
  const orgsUniquenessResult = runOrgsUniquenessGuard({
    db,
    env: process.env,
  });

  db.exec(SCHEMA);

  // v0.7 security baseline: only owner can read/write the DB file.
  // Idempotent re-chmod on every boot so existing v0.6 DBs are tightened too.
  // POSIX-only: chmod is a no-op on Windows (NTFS permissions don't map).
  try {
    chmodSync(path.join(dataDir, "coordinator.db"), 0o600);
  } catch {
    /* non-POSIX or permission error — log-only would be too noisy */
  }

  // Migrations for existing databases — columns may already exist
  try {
    db.exec("ALTER TABLE threads ADD COLUMN claimed_by TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE threads ADD COLUMN claimed_at TEXT");
  } catch {
    /* already exists */
  }
  // F4: track unclaim count to poison threads that no agent manages to complete.
  // Without this, an aborted task bounces back into the pool indefinitely and
  // gets re-claimed by the same (or next) agent in a tight failure loop.
  try {
    db.exec("ALTER TABLE threads ADD COLUMN unclaim_count INTEGER DEFAULT 0");
  } catch {
    /* already exists */
  }
  // Directed-dispatch: a thread with `assigned_to` set is claimable only by
  // that specific agent. NULL = anyone can claim (backwards compat with
  // existing work-stealing). Used by lead/worker presets and sequential
  // pipelines that need explicit hand-offs instead of first-come claims.
  try {
    db.exec("ALTER TABLE threads ADD COLUMN assigned_to TEXT");
  } catch {
    /* already exists */
  }
  // Per-run scoping: a shared, persistent coordinator (where /api/reset is
  // 403-forbidden by design) kept showing the threads of an ABORTED run to the
  // next run's agents. NULL = un-scoped (a human session, a laptop agent) and
  // stays visible to everyone — the point is to hide other RUNS, never other
  // SESSIONS, or agents would happily stomp on a human's files.
  try {
    db.exec("ALTER TABLE threads ADD COLUMN run_id TEXT");
  } catch {
    /* already exists */
  }

  // v0.6: per-edit symbol metadata on file_activity
  try {
    db.exec("ALTER TABLE file_activity ADD COLUMN symbols_touched TEXT");
  } catch {
    /* already exists */
  }
  try {
    db.exec("ALTER TABLE file_activity ADD COLUMN content_hash TEXT");
  } catch {
    /* already exists */
  }

  // v0.7: multi-tenant org_id column on every table that participates in scoping.
  // SQLite lacks online DDL — each ALTER briefly blocks writes. Migration is
  // idempotent (already-exists is caught silently).
  // SECURITY: `t` is from a compile-time constant array only — never user input.
  const TABLES_NEEDING_ORG = [
    "agents",
    "threads",
    "thread_messages",
    "action_summaries",
    "file_activity",
    "events",
    "dependency_map",
    "introspections",
    "agent_activity_status",
    "revoked_agents",
    "working_files",
    "git_cochange",
    "git_cochange_meta",
    "layer_firings",
  ] as const;
  for (const t of TABLES_NEEDING_ORG) {
    try {
      db.exec(`ALTER TABLE ${t} ADD COLUMN org_id TEXT NOT NULL DEFAULT 'default'`);
    } catch {
      /* already exists */
    }
  }

  // v0.7: scan index for events table — getEventsSince queries by (org_id, id)
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id, id)");
  } catch {
    /* already exists */
  }

  // v0.7.1: composite indexes for org-scoped hot queries (Tasks 15/17 reads).
  // Created AFTER the ALTER loop above — these indexes reference org_id which
  // doesn't exist on the legacy tables until the ALTER runs. file_activity is
  // append-only and grows fast in multi-org deployments; the single-column
  // path index alone forces a full scan of all-org rows before the WHERE
  // org_id filter applies.
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_file_activity_org_path_time ON file_activity(org_id, file_path, created_at)",
    );
  } catch {
    /* already exists */
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_threads_org_status ON threads(org_id, status)");
  } catch {
    /* already exists */
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_summaries_org_agent ON action_summaries(org_id, agent_id)",
    );
  } catch {
    /* already exists */
  }

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
    const cols = targetDb.prepare(`PRAGMA table_info(${tableName})`).all() as {
      name: string;
      pk: number;
    }[];
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
        targetDb.exec(
          `INSERT INTO ${tableName}_new (${columnList}) SELECT ${columnList} FROM ${tableName}`,
        );
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

  migrateToCompositePK(
    db,
    "agents",
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

  migrateToCompositePK(
    db,
    "agent_activity_status",
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

  migrateToCompositePK(
    db,
    "revoked_agents",
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

  migrateToCompositePK(
    db,
    "working_files",
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

  migrateToCompositePK(
    db,
    "dependency_map",
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

  migrateToCompositePK(
    db,
    "git_cochange",
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

  migrateToCompositePK(
    db,
    "git_cochange_meta",
    `CREATE TABLE git_cochange_meta (
      k TEXT NOT NULL,
      org_id TEXT NOT NULL DEFAULT 'default',
      v TEXT,
      PRIMARY KEY (org_id, k)
    )`,
    "k, org_id, v",
    [],
  );

  // v0.7: bump version marker BEFORE v0.8 migrations.
  // A crash before this line leaves user_version=6 and the next boot retries the v0.7 migration
  // (idempotent). Bumping earlier would make a partial migration look complete.
  db.exec("PRAGMA user_version = 7");

  // ============================================================================
  // v0.8 (Phase 2): OAuth + Device Flow + Audit Wiring schema migrations
  // ============================================================================
  // Refs:
  //   Spec:    docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design.md §4
  //   V4 fix:  docs/superpowers/specs/2026-05-13-auth-phase2-oauth-device-design-V4-patches.md
  //            (FIX 1 = audit_log renames, FIX 2 = PRAGMA foreign_keys toggle,
  //             FIX 3 = ON DELETE policy on user_orgs, FIX 4 = idp_access_token col,
  //             FIX 6 = parent_jti UNIQUE partial index, FIX 21 = failed_approval_attempts)
  //   Plan:    docs/superpowers/plans/2026-05-13-auth-phase2-oauth-device-plan-v2-patches.md §A.1
  //
  // All ALTERs are idempotent (try/catch already-exists or RENAME-no-such-column).
  // CREATE TABLE / CREATE INDEX use IF NOT EXISTS.
  // FK enforcement OFF during column renames (SQLite requirement for ALTER RENAME COLUMN
  // when other tables reference the table being altered).
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // --- audit_log column renames (V4 FIX 1) ----------------------------------
    try {
      db.exec("ALTER TABLE audit_log RENAME COLUMN user_id TO actor_user_id");
    } catch {
      /* already renamed */
    }
    try {
      db.exec("ALTER TABLE audit_log RENAME COLUMN org_id TO actor_org_id");
    } catch {
      /* already renamed */
    }
    try {
      db.exec("ALTER TABLE audit_log RENAME COLUMN ip TO actor_ip");
    } catch {
      /* already renamed */
    }
    try {
      db.exec("ALTER TABLE audit_log RENAME COLUMN user_agent TO actor_user_agent");
    } catch {
      /* already renamed */
    }
    try {
      db.exec("ALTER TABLE audit_log RENAME COLUMN metadata TO metadata_json");
    } catch {
      /* already renamed */
    }

    // --- audit_log: new columns + retention sweeper index ---------------------
    try {
      db.exec("ALTER TABLE audit_log ADD COLUMN request_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE audit_log ADD COLUMN outcome TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id)");
    } catch {
      /* already exists */
    }
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_outcome_time ON audit_log(outcome, created_at)",
      );
    } catch {
      /* already exists */
    }

    // --- audit_log: backfill Phase 1 rows with outcome='legacy_unknown' --------
    // Idempotent: only fills NULLs. Inserts a single migration audit row on first run.
    try {
      const updateResult = (
        db as unknown as {
          prepare: (sql: string) => { run: () => { changes: number } };
        }
      )
        .prepare("UPDATE audit_log SET outcome = 'legacy_unknown' WHERE outcome IS NULL")
        .run();
      if (updateResult.changes > 0) {
        // First-run only: emit migration provenance event
        (
          db as unknown as {
            prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
          }
        )
          .prepare(
            "INSERT INTO audit_log (action, outcome, metadata_json, created_at) " +
              "VALUES ('migration.audit_backfill', 'success', ?, CURRENT_TIMESTAMP)",
          )
          .run(
            JSON.stringify({
              rows_marked_legacy: updateResult.changes,
              from_version: 7,
              to_version: 8,
            }),
          );
      }
    } catch {
      /* defensive: any failure means migration already happened */
    }

    // --- audit_log: hash chain (T50 v0.9.1) -----------------------------------
    // Each row carries prev_hash (the previous row's row_hash) + row_hash
    // (SHA-256 over prev_hash || canonicalRowFields(this row)). Tampering with
    // any row's content breaks its row_hash; inserting a forged row in the
    // middle breaks the next row's prev_hash linkage.
    //
    // Backfill: existing audit_log rows are chained in id-order from
    // GENESIS_HASH so post-migration verification accepts the historical
    // tail. Pre-migration tampering is NOT detectable -- this is forward
    // evidence only. Operators wanting deletion + retroactive-tamper
    // detection must pair the chain with the external tip-attestation
    // workflow in docs/ops/audit-integrity.md.
    try {
      db.exec("ALTER TABLE audit_log ADD COLUMN prev_hash TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE audit_log ADD COLUMN row_hash TEXT");
    } catch {
      /* already exists */
    }
    try {
      backfillAuditChain(db as unknown as MigrationDb);
    } catch {
      /* defensive: any failure means backfill already happened */
    }

    // --- users: rename org_id → primary_org_id + new columns ------------------
    // NOTE: SQLite ALTER TABLE RENAME COLUMN automatically updates indexes that
    // reference the renamed column (since 3.25). idx_users_org (Phase 1) continues
    // to work as an index on primary_org_id under its old name — DO NOT drop +
    // recreate, because SCHEMA on subsequent boots tries to recreate idx_users_org
    // referencing the now-non-existent org_id column and would fail.
    try {
      db.exec("ALTER TABLE users RENAME COLUMN org_id TO primary_org_id");
    } catch {
      /* already renamed */
    }
    try {
      db.exec("ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    // idp_access_token: stores GitHub access token for refresh-time membership re-check.
    // Plaintext in v0.8; encrypted at-rest in v0.7.5 (SQLCipher whole-DB). NEVER in JWT/cookie/logs.
    try {
      db.exec("ALTER TABLE users ADD COLUMN idp_access_token TEXT");
    } catch {
      /* already exists */
    }
    // idp_refresh_token: T54 (v0.10.0) -- GitHub App user-to-server tokens
    // expire (8h), so the App provider stores the refresh token here.
    // OAuth App users keep this column NULL forever. Same plaintext +
    // never-in-logs posture as idp_access_token.
    try {
      db.exec("ALTER TABLE users ADD COLUMN idp_refresh_token TEXT");
    } catch {
      /* already exists */
    }

    // --- orgs: allowlist_github_org column (B-NEW-4 Phase 5 readiness) --------
    try {
      db.exec("ALTER TABLE orgs ADD COLUMN allowlist_github_org TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_orgs_allowlist ON orgs(allowlist_github_org)");
    } catch {
      /* already exists */
    }
    // --- orgs: allowlist_idp_org_id column (T56, v0.10.2) ---------------------
    // Generic IdP-supplied org identifier; matched against
    // IdpUserInfo.idp_org_id. GoogleProvider stores the Workspace hd
    // claim there. OAuth App / GitHub App stay on allowlist_github_org.
    try {
      db.exec("ALTER TABLE orgs ADD COLUMN allowlist_idp_org_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_orgs_allowlist_idp ON orgs(allowlist_idp_org_id)");
    } catch {
      /* already exists */
    }

    // --- user_orgs join table (Q1 V2 N:M-ready, 1:1 invariant app-layer) ------
    db.exec(`CREATE TABLE IF NOT EXISTS user_orgs (
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      org_id     TEXT NOT NULL REFERENCES orgs(id)  ON DELETE RESTRICT,
      role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','service')),
      joined_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, org_id)
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_user_orgs_org ON user_orgs(org_id)");
    // Backfill one row per existing user from users.primary_org_id.
    // Idempotent via WHERE NOT EXISTS (re-runs do nothing on already-backfilled DBs).
    db.exec(
      "INSERT INTO user_orgs (user_id, org_id, role, joined_at) " +
        "SELECT id, primary_org_id, role, COALESCE(created_at, CURRENT_TIMESTAMP) " +
        "FROM users " +
        "WHERE NOT EXISTS (SELECT 1 FROM user_orgs WHERE user_orgs.user_id = users.id)",
    );

    // --- oauth_state table (Q4 PKCE state storage; 10-min TTL + atomic CAS) ---
    db.exec(`CREATE TABLE IF NOT EXISTS oauth_state (
      state           TEXT PRIMARY KEY,
      code_verifier   TEXT NOT NULL,
      redirect_uri    TEXT NOT NULL,
      provider        TEXT NOT NULL,
      org_id          TEXT REFERENCES orgs(id),
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      consumed_at     INTEGER
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_oauth_state_expires ON oauth_state(expires_at)");
    // T55 (v0.10.1): OIDC nonce. Optional; only OIDCProvider stores a
    // value here. Nullable so existing rows + non-OIDC flows keep NULL.
    try {
      db.exec("ALTER TABLE oauth_state ADD COLUMN nonce TEXT");
    } catch {
      /* already exists */
    }

    // --- refresh_tokens: family lineage + reuse detection (Q7 V4 FIX 6) -------
    try {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN family_id TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN parent_jti TEXT");
    } catch {
      /* already exists */
    }
    // CHECK constraint on revoked_reason enforced at app layer + CI lint
    // (SQLite cannot ADD CHECK via ALTER post-creation). Allowed values:
    //   rotated|reuse_detected|suspicious_replay|logout|logout_all|admin|
    //   key_rotation|idle_expired|restore_invalidation
    try {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN revoked_reason TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN replay_count INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE refresh_tokens ADD COLUMN consumer_fingerprint TEXT");
    } catch {
      /* already exists */
    }
    // Backfill family_id for Phase 1 rows: each becomes its own family root.
    // randomblob(16) hex = 32 chars (~128 bits), unique per row.
    db.exec(
      "UPDATE refresh_tokens SET family_id = lower(hex(randomblob(16))) WHERE family_id IS NULL",
    );
    // Indexes per V4 FIX 6 (partial UNIQUE on parent_jti — multiple NULL parents allowed for roots,
    // but each non-NULL parent_jti has exactly one successor row).
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id, revoked_at)",
      );
    } catch {
      /* already exists */
    }
    try {
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_parent ON refresh_tokens(parent_jti) WHERE parent_jti IS NOT NULL",
      );
    } catch {
      /* already exists */
    }
    try {
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_refresh_user_active ON refresh_tokens(user_id, revoked_at)",
      );
    } catch {
      /* already exists */
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_refresh_expires ON refresh_tokens(expires_at)");
    } catch {
      /* already exists */
    }

    // --- device_auth_requests: requester forensics + brute-force defense ------
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN requester_ip TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN requester_user_agent TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN requester_country TEXT");
    } catch {
      /* already exists */
    }
    try {
      db.exec(
        "ALTER TABLE device_auth_requests ADD COLUMN failed_approval_attempts INTEGER NOT NULL DEFAULT 0",
      );
    } catch {
      /* already exists */
    }
    // V4 FIX 21: denial tracking. denied_at (unix seconds) set on rejection or
    // brute-force lockout; denied_reason ∈ {user_denied, too_many_failed_approvals,
    // brute_force_lockout}. Both nullable; existing rows get NULL.
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN denied_at INTEGER");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN denied_reason TEXT");
    } catch {
      /* already exists */
    }
    // T18 device-flow token endpoint (grant_type=device_code poll):
    //   last_polled_at INTEGER — last poll timestamp (unix seconds); enables V4 FIX 18
    //     atomic CAS for per-device slow_down enforcement. Nullable: existing rows + new
    //     pre-poll rows get NULL until the first /token poll.
    //   interval INTEGER NOT NULL DEFAULT 5 — current poll cadence per RFC 8628 §3.5
    //     (default 5s matches T17's verification_uri response). Server may bump on
    //     slow_down responses.
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN last_polled_at INTEGER");
    } catch {
      /* already exists */
    }
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN interval INTEGER NOT NULL DEFAULT 5");
    } catch {
      /* already exists */
    }
    // T20 POST /auth/device/approve: approved_at INTEGER — unix seconds when
    // the approving user submitted the form. Nullable: NULL until approve.
    try {
      db.exec("ALTER TABLE device_auth_requests ADD COLUMN approved_at INTEGER");
    } catch {
      /* already exists */
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_device_expires ON device_auth_requests(expires_at)");
    } catch {
      /* already exists */
    }

    // --- system_state table (NR12 restore detection + recovery markers) -------
    db.exec(`CREATE TABLE IF NOT EXISTS system_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    // --- Compat view for direct-DB readers during 0.7→0.8 transition (V4 FIX) -
    // Maps renamed users.primary_org_id back to users.org_id for one minor release.
    // Will be removed in v0.9.0 per CHANGELOG.
    try {
      db.exec(
        "CREATE VIEW IF NOT EXISTS users_legacy_v0_7 AS " +
          "SELECT id, primary_org_id AS org_id, email, name, idp_provider, idp_user_id, " +
          "role, created_at, last_login_at, token_epoch " +
          "FROM users",
      );
    } catch {
      /* idempotent; view recreation is no-op */
    }

    // v0.8: bump version marker LAST — after every CREATE/ALTER/UPDATE above succeeded.
    db.exec("PRAGMA user_version = 8");
  } finally {
    // ALWAYS re-enable FKs, even on error. SQLite migrations leave the connection
    // in PRAGMA foreign_keys = OFF state otherwise, silently disabling all FK
    // enforcement for the rest of this process's lifetime.
    db.exec("PRAGMA foreign_keys = ON");
  }

  // ============================================================================
  // v0.9 (issue #79): add FOREIGN KEY orgs(id) ON DELETE RESTRICT to coordinator tables
  // ============================================================================
  // v0.7 added `org_id TEXT NOT NULL DEFAULT 'default'` to 14 tables via plain
  // ALTER TABLE ADD COLUMN, which SQLite cannot use to declare a constraint.
  // The result: deleting an org silently leaves orphan rows in agents, threads,
  // messages, file_activity, etc. Only the Phase-2 auth tables (users,
  // refresh_tokens, user_orgs, oauth_state) had proper FK referential integrity.
  //
  // Fix: table-copy migration (SQLite has no ALTER constraint) — for each of
  // the 14 tables, CREATE NEW with `FOREIGN KEY (org_id) REFERENCES orgs(id)
  // ON DELETE RESTRICT`, copy rows, drop old, rename new, recreate indexes.
  //
  // ON DELETE RESTRICT chosen (NOT CASCADE) — safest default: operators must
  // explicitly clean an org's data before they can DELETE the org row. No
  // silent data loss. Reviewer can request CASCADE / SET DEFAULT instead.
  //
  // Orphan handling: any row whose org_id has no matching orgs.id is
  // re-parented to 'default' BEFORE the table-copy runs (otherwise the
  // post-copy `PRAGMA foreign_key_check` would fail). Counts are logged via
  // an audit_log row keyed `migration.org_fk_reparent`.
  migrateOrgsFkV9(db);

  // ============================================================================
  // v0.10 (performance-09): expression indexes on Sweeper scan predicates
  // ============================================================================
  // The Sweeper (src/sweeper/index.ts) ticks every 60s and deletes stale rows
  // via `WHERE strftime('%s', created_at) < ?` (or `fired_at` for
  // layer_firings) across 6 tables. strftime(...) is not indexable by a plain
  // column index, so every tick did a full table scan. SQLite DOES support
  // indexing an expression directly — the planner matches the same
  // expression text in a WHERE clause and uses the index instead of
  // scanning. This migration creates those 6 expression indexes.
  migrateSweepIndexesV10(db);

  // v0.10.6 T03: if the pre-flight guard accepted duplicate org names via
  // COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES=1, emit the Tier 1 audit row NOW —
  // SCHEMA has run (audit_log exists with id/created_at/prev_hash/row_hash)
  // and the v0.8 column renames are complete. Direct INSERT rather than
  // routing through `audit()` because `audit()` resolves `getDb()` against
  // the still-being-initialized module-level reference + the audit queue is
  // not initialized until bootPhase2.
  if (orgsUniquenessResult.pendingDuplicatesAcceptedAudit) {
    emitDuplicatesAcceptedAudit(db, orgsUniquenessResult.pendingDuplicatesAcceptedAudit);
  }
}

/**
 * v0.9 (issue #79): Add `FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE
 * RESTRICT` to the 14 coordinator tables that received `org_id` via plain
 * `ALTER TABLE ADD COLUMN` in v0.7.
 *
 * Idempotent via `PRAGMA user_version`: returns early if user_version >= 9.
 * Sets user_version = 9 LAST so a crash mid-migration re-runs cleanly on
 * the next boot.
 *
 * Wrapped in a single SQLite transaction inside `PRAGMA foreign_keys = OFF`.
 * Re-enables foreign_keys in `finally` even on error.
 *
 * Orphan repair: rows whose `org_id` does NOT match any `orgs.id` are
 * re-parented to 'default' before the table-copy (otherwise the post-copy
 * FK self-check would fail). Operators see the repair counts in audit_log.
 */
function migrateOrgsFkV9(targetDb: DatabaseAdapter): void {
  const v = (
    targetDb as unknown as {
      prepare: (sql: string) => { get: () => unknown };
    }
  )
    .prepare("PRAGMA user_version")
    .get() as { user_version: number } | undefined;
  if ((v?.user_version ?? 0) >= 9) return;

  // Table-copy specs. Each entry describes the post-migration shape of one
  // of the 14 tables. The CREATE TABLE statement is the EXACT schema we want
  // after the migration (current columns + composite-PK migration deltas +
  // new FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT). The
  // `columnList` is the column order used for INSERT INTO new SELECT FROM
  // old — it must match the source table's column order at this point in
  // boot (post-SCHEMA, post-ALTERs, post-composite-PK).
  type FkMigrationSpec = {
    table: string;
    createSql: string;
    columnList: string;
    indexCreateSqls: string[];
  };

  const SPECS: FkMigrationSpec[] = [
    // --- agents (composite-PK migrated to (org_id, id)) ---------------------
    // idx_agents_id UNIQUE is LOAD-BEARING for the 5 FKs that target
    // agents(id). DO NOT drop it. (see composite-pk-migration.test.ts)
    {
      table: "agents",
      createSql: `CREATE TABLE agents_new (
        id TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        modules TEXT DEFAULT '[]',
        status TEXT DEFAULT 'offline',
        registered_at TEXT DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (org_id, id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "id, org_id, name, modules, status, registered_at, last_seen_at",
      indexCreateSqls: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_id ON agents(id)"],
    },

    // --- threads (NOT composite-PK migrated; standalone PK on id) ----------
    {
      table: "threads",
      createSql: `CREATE TABLE threads_new (
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
      )`,
      // run_id MUST be listed here too: this migration recreates the table and
      // copies only the columns named below — omitting it would silently drop
      // the column (and every run's scoping with it) on an existing database.
      columnList:
        "id, initiator_id, subject, plan, target_modules, target_files, status, " +
        "resolution_summary, conflicts, round, max_rounds, timeout_seconds, " +
        "created_at, resolved_at, expected_respondents, depends_on_files, " +
        "exports_affected, claimed_by, claimed_at, unclaim_count, assigned_to, org_id, run_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status)",
        "CREATE INDEX IF NOT EXISTS idx_threads_initiator ON threads(initiator_id)",
        "CREATE INDEX IF NOT EXISTS idx_threads_org_status ON threads(org_id, status)",
      ],
    },

    // --- thread_messages ---------------------------------------------------
    {
      table: "thread_messages",
      createSql: `CREATE TABLE thread_messages_new (
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
        org_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList:
        "id, thread_id, agent_id, agent_name, type, content, context_snapshot, " +
        "in_reply_to, round, token_estimate, created_at, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_messages_thread ON thread_messages(thread_id)",
        "CREATE INDEX IF NOT EXISTS idx_messages_agent ON thread_messages(agent_id)",
      ],
    },

    // --- action_summaries --------------------------------------------------
    {
      table: "action_summaries",
      createSql: `CREATE TABLE action_summaries_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        file_path TEXT,
        summary TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        org_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "id, session_id, agent_id, file_path, summary, created_at, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_summaries_agent ON action_summaries(agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_summaries_session ON action_summaries(session_id)",
        "CREATE INDEX IF NOT EXISTS idx_summaries_org_agent ON action_summaries(org_id, agent_id)",
      ],
    },

    // --- file_activity (AUTOINCREMENT — sqlite_sequence updated on RENAME) -
    {
      table: "file_activity",
      createSql: `CREATE TABLE file_activity_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        tool_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        module TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        symbols_touched TEXT,
        content_hash TEXT,
        org_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList:
        "id, session_id, agent_id, agent_name, tool_name, file_path, module, " +
        "created_at, symbols_touched, content_hash, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_file_activity_agent ON file_activity(agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_file_activity_path ON file_activity(file_path)",
        "CREATE INDEX IF NOT EXISTS idx_file_activity_org_path_time ON file_activity(org_id, file_path, created_at)",
      ],
    },

    // --- events (AUTOINCREMENT) -------------------------------------------
    {
      table: "events",
      createSql: `CREATE TABLE events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        org_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "id, type, payload, created_at, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)",
        "CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id, id)",
      ],
    },

    // --- dependency_map (composite-PK (org_id, module_id)) -----------------
    {
      table: "dependency_map",
      createSql: `CREATE TABLE dependency_map_new (
        module_id TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        depends_on TEXT DEFAULT '[]',
        exports TEXT DEFAULT '[]',
        owners TEXT DEFAULT '[]',
        PRIMARY KEY (org_id, module_id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "module_id, org_id, depends_on, exports, owners",
      indexCreateSqls: [],
    },

    // --- introspections ----------------------------------------------------
    {
      table: "introspections",
      createSql: `CREATE TABLE introspections_new (
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
        org_id TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (thread_id) REFERENCES threads(id),
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList:
        "id, thread_id, agent_id, score, reasons, status, response, concerned, " +
        "created_at, responded_at, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_introspections_agent ON introspections(agent_id)",
        "CREATE INDEX IF NOT EXISTS idx_introspections_status ON introspections(status)",
      ],
    },

    // --- agent_activity_status (composite-PK (org_id, agent_id)) -----------
    {
      table: "agent_activity_status",
      createSql: `CREATE TABLE agent_activity_status_new (
        agent_id TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        activity_status TEXT DEFAULT 'idle',
        current_file TEXT,
        current_thread TEXT,
        last_activity_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (agent_id) REFERENCES agents(id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT,
        PRIMARY KEY (org_id, agent_id)
      )`,
      columnList:
        "agent_id, org_id, activity_status, current_file, current_thread, last_activity_at",
      indexCreateSqls: [],
    },

    // --- revoked_agents (composite-PK (org_id, agent_id)) ------------------
    {
      table: "revoked_agents",
      createSql: `CREATE TABLE revoked_agents_new (
        agent_id TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_by TEXT NOT NULL,
        PRIMARY KEY (org_id, agent_id),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "agent_id, org_id, revoked_at, revoked_by",
      indexCreateSqls: [],
    },

    // --- working_files (composite-PK (org_id, agent_id, file_path)) --------
    {
      table: "working_files",
      createSql: `CREATE TABLE working_files_new (
        agent_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        claim_until TEXT NOT NULL,
        PRIMARY KEY (org_id, agent_id, file_path),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "agent_id, file_path, org_id, started_at, last_activity_at, claim_until",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_working_files_path  ON working_files(file_path)",
        "CREATE INDEX IF NOT EXISTS idx_working_files_until ON working_files(claim_until)",
      ],
    },

    // --- git_cochange (composite-PK + CHECK constraint preserved) ----------
    {
      table: "git_cochange",
      createSql: `CREATE TABLE git_cochange_new (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        count INTEGER NOT NULL,
        total_commits INTEGER NOT NULL,
        computed_at TEXT NOT NULL,
        PRIMARY KEY (org_id, file_a, file_b),
        CHECK (file_a < file_b),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "file_a, file_b, org_id, count, total_commits, computed_at",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_cochange_a ON git_cochange(file_a)",
        "CREATE INDEX IF NOT EXISTS idx_cochange_b ON git_cochange(file_b)",
      ],
    },

    // --- git_cochange_meta (composite-PK (org_id, k)) ----------------------
    {
      table: "git_cochange_meta",
      createSql: `CREATE TABLE git_cochange_meta_new (
        k TEXT NOT NULL,
        org_id TEXT NOT NULL DEFAULT 'default',
        v TEXT,
        PRIMARY KEY (org_id, k),
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "k, org_id, v",
      indexCreateSqls: [],
    },

    // --- layer_firings (AUTOINCREMENT) -------------------------------------
    {
      table: "layer_firings",
      createSql: `CREATE TABLE layer_firings_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT,
        layer     TEXT NOT NULL,
        score     INTEGER NOT NULL,
        agent_id  TEXT,
        fired_at  TEXT DEFAULT CURRENT_TIMESTAMP,
        org_id    TEXT NOT NULL DEFAULT 'default',
        FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT
      )`,
      columnList: "id, thread_id, layer, score, agent_id, fired_at, org_id",
      indexCreateSqls: [
        "CREATE INDEX IF NOT EXISTS idx_firings_layer  ON layer_firings(layer, fired_at)",
        "CREATE INDEX IF NOT EXISTS idx_firings_thread ON layer_firings(thread_id)",
      ],
    },
  ];

  // Pre-flight: confirm 'default' org row exists. SCHEMA already inserts it
  // via `INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', ...)`, but
  // we re-assert here so a deployment that somehow lost the row gets it back
  // before we re-parent orphans onto it.
  targetDb.exec("INSERT OR IGNORE INTO orgs (id, name) VALUES ('default', 'Default Organization')");

  // Pre-flight: detect & re-parent orphans. For each table, count rows whose
  // org_id has no matching orgs.id row, then UPDATE them to 'default'. Emits
  // an audit row per table that had >0 orphans so operators can see what was
  // touched. Done BEFORE the table-copy because the post-copy FK self-check
  // would fail otherwise.
  const reparentCounts: Record<string, number> = {};
  for (const spec of SPECS) {
    const orphanRow = (
      targetDb as unknown as {
        prepare: (sql: string) => { get: () => unknown };
      }
    )
      .prepare(`SELECT COUNT(*) AS n FROM ${spec.table} WHERE org_id NOT IN (SELECT id FROM orgs)`)
      .get() as { n: number } | undefined;
    const n = orphanRow?.n ?? 0;
    if (n > 0) {
      (
        targetDb as unknown as {
          prepare: (sql: string) => { run: () => { changes: number } };
        }
      )
        .prepare(
          `UPDATE ${spec.table} SET org_id = 'default' WHERE org_id NOT IN (SELECT id FROM orgs)`,
        )
        .run();
      reparentCounts[spec.table] = n;
    }
  }
  if (Object.keys(reparentCounts).length > 0) {
    try {
      (
        targetDb as unknown as {
          prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
        }
      )
        .prepare(
          "INSERT INTO audit_log (action, outcome, metadata_json, created_at) " +
            "VALUES ('migration.org_fk_reparent', 'success', ?, CURRENT_TIMESTAMP)",
        )
        .run(
          JSON.stringify({
            reparented_to: "default",
            counts: reparentCounts,
            from_version: 8,
            to_version: 9,
          }),
        );
    } catch {
      /* audit_log shape mismatch; non-fatal */
    }
  }

  // Run the table-copy migration. PRAGMA foreign_keys must be OFF outside
  // the transaction (it's a no-op inside an open transaction). Wrapped in
  // try/finally so foreign_keys is ALWAYS re-enabled even on error.
  targetDb.exec("PRAGMA foreign_keys = OFF");
  try {
    targetDb.exec("BEGIN");
    try {
      for (const spec of SPECS) {
        // Idempotency check: skip tables that already have the FK. We detect
        // by parsing `PRAGMA foreign_key_list` for an entry pointing to
        // orgs(id). If found, this table was migrated in a prior partial run.
        const fkRows = (
          targetDb as unknown as {
            prepare: (sql: string) => { all: () => unknown[] };
          }
        )
          .prepare(`PRAGMA foreign_key_list(${spec.table})`)
          .all() as { table: string; from: string }[];
        const alreadyHasOrgFk = fkRows.some((r) => r.table === "orgs" && r.from === "org_id");
        if (alreadyHasOrgFk) continue;

        // Defensive column intersection: a partial-history DB (e.g. an old
        // v0.6 row never went through a v0.7 SCHEMA pass that added the
        // intervening columns) may lack columns the new table declares.
        // Copy only the intersection of (spec.columnList) ∩ (source.columns).
        // Missing columns get their declared DEFAULT on the new table, which
        // is the same outcome as if a plain `ALTER TABLE ADD COLUMN` had run
        // at boot. SECURITY: column names come from the compile-time
        // `columnList` string only — never user input.
        const sourceCols = (
          targetDb as unknown as {
            prepare: (sql: string) => { all: () => unknown[] };
          }
        )
          .prepare(`PRAGMA table_info(${spec.table})`)
          .all() as { name: string }[];
        const sourceColSet = new Set(sourceCols.map((c) => c.name));
        const copyCols = spec.columnList
          .split(",")
          .map((s) => s.trim())
          .filter((c) => sourceColSet.has(c))
          .join(", ");

        targetDb.exec(spec.createSql);
        targetDb.exec(
          `INSERT INTO ${spec.table}_new (${copyCols}) ` + `SELECT ${copyCols} FROM ${spec.table}`,
        );
        targetDb.exec(`DROP TABLE ${spec.table}`);
        targetDb.exec(`ALTER TABLE ${spec.table}_new RENAME TO ${spec.table}`);
        for (const idxSql of spec.indexCreateSqls) targetDb.exec(idxSql);
      }

      // Post-copy self-check: PRAGMA foreign_key_check returns rows for every
      // FK violation. Inside the transaction we still see all data so any
      // violation indicates a bug in the migration itself (NOT in the data —
      // orphans were repaired up-front). Abort + ROLLBACK so the operator
      // sees a clean failure and the DB stays at user_version=8.
      const fkCheck = (
        targetDb as unknown as {
          prepare: (sql: string) => { all: () => unknown[] };
        }
      )
        .prepare("PRAGMA foreign_key_check")
        .all() as unknown[];
      if (fkCheck.length > 0) {
        throw new Error(
          `v0.9 org_id FK migration: foreign_key_check returned ${fkCheck.length} violations after table-copy (this indicates a migration bug; orphan repair should have prevented this). Aborting.`,
        );
      }

      // Bump version LAST so a partial migration (crash before this line)
      // re-runs cleanly on the next boot. The idempotency check above means
      // already-migrated tables are skipped.
      targetDb.exec("PRAGMA user_version = 9");
      targetDb.exec("COMMIT");
    } catch (e) {
      targetDb.exec("ROLLBACK");
      throw e;
    }
  } finally {
    targetDb.exec("PRAGMA foreign_keys = ON");
  }
}

/**
 * v0.10 (performance-09): expression indexes for the Sweeper's scan
 * predicates. The Sweeper (src/sweeper/index.ts) deletes stale rows every
 * 60s via `WHERE strftime('%s', created_at) < ?` (and `fired_at` for
 * layer_firings) across 6 tables: audit_log, file_activity, events,
 * thread_messages, action_summaries, layer_firings. A plain column index
 * on `created_at` cannot satisfy that predicate because the comparison is
 * against the *result* of strftime(), not the column itself — SQLite falls
 * back to a full table SCAN. An index built directly on the expression
 * `strftime('%s', created_at)` lets the planner recognize the same
 * expression text in the WHERE clause and do a SEARCH instead.
 *
 * Idempotent two ways: `CREATE INDEX IF NOT EXISTS` is idempotent on its
 * own, and the `PRAGMA user_version` guard (mirroring the pattern used by
 * migrateOrgsFkV9 above) skips the whole function once already applied, so
 * boot doesn't re-issue 6 no-op statements on every start. Sets
 * user_version = 10 LAST so a crash mid-migration re-runs cleanly next boot
 * (CREATE INDEX IF NOT EXISTS makes a partial re-run harmless).
 */
function migrateSweepIndexesV10(targetDb: DatabaseAdapter): void {
  const v = (
    targetDb as unknown as {
      prepare: (sql: string) => { get: () => unknown };
    }
  )
    .prepare("PRAGMA user_version")
    .get() as { user_version: number } | undefined;
  if ((v?.user_version ?? 0) >= 10) return;

  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_audit_log_created_epoch ON audit_log(strftime('%s', created_at))",
  );
  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_file_activity_created_epoch ON file_activity(strftime('%s', created_at))",
  );
  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_events_created_epoch ON events(strftime('%s', created_at))",
  );
  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_thread_messages_created_epoch ON thread_messages(strftime('%s', created_at))",
  );
  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_action_summaries_created_epoch ON action_summaries(strftime('%s', created_at))",
  );
  // layer_firings uses `fired_at`, NOT `created_at` (see sweeper/index.ts note).
  targetDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_layer_firings_fired_epoch ON layer_firings(strftime('%s', fired_at))",
  );

  targetDb.exec("PRAGMA user_version = 10");
}

export function getDb(): DatabaseAdapter {
  if (!db) throw new Error("Database not initialized. Call initDatabase first.");
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}
