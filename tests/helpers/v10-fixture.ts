import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/**
 * issue #231 — a populated v10 database, built by hand rather than by winding
 * `user_version` back on a real one (that makes the v9 migration fire first and
 * mask whatever v11 behaviour is under test).
 *
 * v10 shape = `agents` keyed `(org_id, id)` with a GLOBAL unique index on
 * `agents(id)`, and the dependent tables referencing `agents(id)` alone. Only
 * `orgs`, `agents` and `threads` are created: `initDatabase` runs its
 * `CREATE TABLE IF NOT EXISTS` schema before any migration, so the four other
 * agent-referencing tables come into existence empty and correctly shaped.
 */
export interface SeedV10Options {
  /**
   * Rows pointing at an agent id that exists in no org — the corruption the
   * v11 pre-flight refuses to guess about. Inserted with `foreign_keys = OFF`,
   * which is how such rows arise in the wild (every table-copy migration runs
   * with the pragma off).
   */
  dangling?: { threadId: string; agentId: string; orgId: string }[];
}

export function seedV10(dir: string, options: SeedV10Options = {}): void {
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

  db.prepare("INSERT INTO agents (id, org_id, name, status) VALUES (?, ?, ?, ?)").run(
    "alice",
    "org-a",
    "Alice",
    "online",
  );
  db.prepare("INSERT INTO agents (id, org_id, name, status) VALUES (?, ?, ?, ?)").run(
    "bob",
    "org-b",
    "Bob",
    "offline",
  );

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

  if (options.dangling?.length) {
    db.pragma("foreign_keys = OFF");
    const ins = db.prepare(
      "INSERT INTO threads (id, initiator_id, subject, org_id, target_files, round) VALUES (?,?,?,?,?,?)",
    );
    for (const d of options.dangling) {
      ins.run(d.threadId, d.agentId, "orphaned", d.orgId, "[]", 1);
    }
    db.pragma("foreign_keys = ON");
  }

  db.pragma("user_version = 10");
  db.close();
}
