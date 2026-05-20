/**
 * v0.9 (issue #79): coordinator tables must declare a FOREIGN KEY on org_id
 * referencing orgs(id) ON DELETE RESTRICT.
 *
 * v0.7 added `org_id TEXT NOT NULL DEFAULT 'default'` via plain ALTER TABLE
 * ADD COLUMN, which SQLite cannot use to declare a constraint. The result
 * was silent orphan rows whenever an org was deleted. This suite pins the
 * post-migration shape: every one of the 14 affected tables exposes the FK
 * via PRAGMA foreign_key_list, INSERTs with unknown org_id are rejected,
 * and DELETE of an org with linked rows is blocked with a RESTRICT error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";

const TABLES = [
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

describe("v0.9 org_id FK migration (fresh DB)", () => {
  const DIR = "data-test-orgs-fk-fresh";

  beforeAll(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    initDatabase(DIR);
  });
  afterAll(() => {
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("PRAGMA user_version is at least 9 after init on a fresh DB", () => {
    const db = getDb();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(9);
  });

  it.each(TABLES)("table %s declares FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE RESTRICT", (t) => {
    const db = getDb();
    const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const orgFk = fks.find((f) => f.from === "org_id" && f.table === "orgs");
    expect(orgFk, `${t} is missing FK on org_id`).toBeDefined();
    expect(orgFk!.to).toBe("id");
    expect(orgFk!.on_delete.toUpperCase()).toBe("RESTRICT");
  });

  it("INSERT with non-existent org_id is rejected (FK constraint enforced)", () => {
    const db = getDb();
    // events table is the simplest target — no other FKs to satisfy first.
    expect(() =>
      db
        .prepare("INSERT INTO events (type, payload, org_id) VALUES (?, ?, ?)")
        .run("test", "{}", "no-such-org-xyz"),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("DELETE of an org that has linked rows is blocked by ON DELETE RESTRICT", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)").run("org-delete-test", "DeleteTest");
    db.prepare("INSERT INTO events (type, payload, org_id) VALUES (?, ?, ?)").run(
      "marker",
      "{}",
      "org-delete-test",
    );
    expect(() =>
      db.prepare("DELETE FROM orgs WHERE id = ?").run("org-delete-test"),
    ).toThrow(/FOREIGN KEY/i);
    // After cleaning the linked rows the DELETE succeeds (proves it was the
    // RESTRICT and not some unrelated error).
    db.prepare("DELETE FROM events WHERE org_id = ?").run("org-delete-test");
    expect(() =>
      db.prepare("DELETE FROM orgs WHERE id = ?").run("org-delete-test"),
    ).not.toThrow();
  });

  it("composite-PK invariants still hold (agents has UNIQUE idx_agents_id)", () => {
    // Regression guard: rebuilding `agents` for the FK must preserve the
    // UNIQUE INDEX on id that backs the 5 FKs targeting agents(id).
    const db = getDb();
    const list = db.prepare("PRAGMA index_list(agents)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const found = list.find((i) => i.name === "idx_agents_id");
    expect(found).toBeDefined();
    expect(found!.unique).toBe(1);
  });

  it("running initDatabase twice is idempotent (no-op on already-migrated DB)", () => {
    // Already-initialized via beforeAll. Close and re-open: the second boot
    // sees user_version=9 and skips the table-copy entirely.
    closeDb();
    initDatabase(DIR);
    const db = getDb();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(9);
    // FK still present after the no-op second boot:
    const fks = db.prepare("PRAGMA foreign_key_list(events)").all() as Array<{
      from: string;
      table: string;
    }>;
    expect(fks.find((f) => f.from === "org_id" && f.table === "orgs")).toBeDefined();
  });
});

/**
 * Simulate a v0.10.x database (post-v0.8 schema, user_version=8) by:
 *   1. boot once → SCHEMA + all migrations run, user_version reaches 9
 *   2. wind user_version BACK to 8 and DROP the FK constraint on every
 *      affected table by recreating each table WITHOUT the FK
 *   3. seed real data into a couple of tables
 *   4. boot again → migration re-runs from v8 → v9, FK appears, data preserved
 *
 * We can't checkout a real v0.10.x binary inside the test, so we reverse-engineer
 * the pre-fix state by doing the table-copy in REVERSE (drop the FK).
 */
describe("v0.9 org_id FK migration (simulated v0.10.x → v0.9 upgrade)", () => {
  const DIR = "data-test-orgs-fk-upgrade";

  beforeAll(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });

    // Phase 1: boot to populate SCHEMA + composite-PK migration.
    initDatabase(DIR);
    const db = getDb();

    // Seed: an org + sample rows in events, threads (with initiator agent),
    // and dependency_map. These rows MUST survive the v8→v9 migration.
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)").run(
      "tenant-a",
      "Tenant A",
    );
    db.prepare(
      "INSERT INTO agents (id, org_id, name) VALUES (?, ?, ?)",
    ).run("agent-seed-1", "tenant-a", "seed-agent");
    db.prepare(
      "INSERT INTO events (type, payload, org_id) VALUES (?, ?, ?)",
    ).run("seed.event", '{"k":"v"}', "tenant-a");
    db.prepare(
      "INSERT INTO dependency_map (org_id, module_id, depends_on) VALUES (?, ?, ?)",
    ).run("tenant-a", "src/seed-module", '["a","b"]');

    // Phase 2: simulate v0.10.x state by dropping the FK on events
    // (representative — the migration code iterates over all 14 tables so
    // restoring even one suffices to prove the re-migration path runs).
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    db.exec(`CREATE TABLE events_pre_v9 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      org_id TEXT NOT NULL DEFAULT 'default'
    )`);
    db.exec("INSERT INTO events_pre_v9 (id, type, payload, created_at, org_id) " +
      "SELECT id, type, payload, created_at, org_id FROM events");
    db.exec("DROP TABLE events");
    db.exec("ALTER TABLE events_pre_v9 RENAME TO events");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id, id)");
    // Wind user_version back so the v9 migration sees it as v8 and re-runs.
    db.exec("PRAGMA user_version = 8");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");

    // Sanity: confirm the FK is gone before we re-boot.
    const fksBefore = db.prepare("PRAGMA foreign_key_list(events)").all() as Array<{
      from: string;
    }>;
    if (fksBefore.some((f) => f.from === "org_id")) {
      throw new Error("test setup: expected events.org_id FK to be absent before re-boot");
    }

    // Phase 3: re-boot. The v9 migration should fire and restore the FK.
    closeDb();
    initDatabase(DIR);
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("user_version is bumped to 9 after the upgrade", () => {
    const db = getDb();
    const v = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(9);
  });

  it("FK on events.org_id is present after the v8→v9 migration", () => {
    const db = getDb();
    const fks = db.prepare("PRAGMA foreign_key_list(events)").all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    const orgFk = fks.find((f) => f.from === "org_id" && f.table === "orgs");
    expect(orgFk).toBeDefined();
    expect(orgFk!.on_delete.toUpperCase()).toBe("RESTRICT");
  });

  it("existing data is preserved through the migration (no data loss)", () => {
    const db = getDb();
    const ev = db
      .prepare("SELECT type, payload, org_id FROM events WHERE type = 'seed.event'")
      .get() as { type: string; payload: string; org_id: string } | undefined;
    expect(ev).toBeDefined();
    expect(ev!.org_id).toBe("tenant-a");
    expect(ev!.payload).toBe('{"k":"v"}');

    const dep = db
      .prepare(
        "SELECT depends_on FROM dependency_map WHERE org_id = 'tenant-a' AND module_id = 'src/seed-module'",
      )
      .get() as { depends_on: string } | undefined;
    expect(dep).toBeDefined();
    expect(dep!.depends_on).toBe('["a","b"]');

    const agent = db
      .prepare("SELECT name FROM agents WHERE id = 'agent-seed-1' AND org_id = 'tenant-a'")
      .get() as { name: string } | undefined;
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("seed-agent");
  });
});

/**
 * Orphan repair path: a pre-v9 DB may contain rows whose org_id has no
 * matching orgs.id (the bug this fix addresses). The migration must
 * re-parent those rows to 'default' before the FK is added, otherwise the
 * post-copy `PRAGMA foreign_key_check` would fail and the migration aborts.
 *
 * We can't construct this state inside initDatabase (FKs would already be
 * present from prior migrations), so we use a raw better-sqlite3 handle to
 * build a synthetic v8 DB with orphans, then call initDatabase on the same
 * file path so the v9 migration re-parents them.
 */
describe("v0.9 org_id FK migration (orphan repair on v8 fixture)", () => {
  const DIR = "data-test-orgs-fk-orphans";

  beforeAll(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });

    // First boot to populate SCHEMA, then knock the FK off events and wind
    // user_version back so the v9 migration sees orphans.
    initDatabase(DIR);
    const db = getDb();

    // Create an orphan row: insert an org, link a row, then delete the org
    // by-passing FK enforcement (we'll drop the FK first).
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES (?, ?)").run(
      "doomed-org",
      "Doomed",
    );

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    db.exec(`CREATE TABLE events_pre_v9 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      org_id TEXT NOT NULL DEFAULT 'default'
    )`);
    db.exec("INSERT INTO events_pre_v9 (id, type, payload, created_at, org_id) " +
      "SELECT id, type, payload, created_at, org_id FROM events");
    db.exec("DROP TABLE events");
    db.exec("ALTER TABLE events_pre_v9 RENAME TO events");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_events_org_id ON events(org_id, id)");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");

    // Now insert with the doomed org_id (no FK, so it'll work), then DELETE
    // the org row directly. Result: events row with org_id='doomed-org'
    // that has no corresponding orgs.id — the exact orphan scenario.
    db.prepare("INSERT INTO events (type, payload, org_id) VALUES (?, ?, ?)").run(
      "orphan.row",
      "{}",
      "doomed-org",
    );
    db.prepare("DELETE FROM orgs WHERE id = ?").run("doomed-org");

    // Wind user_version back and re-boot to trigger the migration.
    db.exec("PRAGMA user_version = 8");
    closeDb();
    initDatabase(DIR);
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it("orphan rows are re-parented to 'default' org during the migration", () => {
    const db = getDb();
    const row = db
      .prepare("SELECT org_id FROM events WHERE type = 'orphan.row'")
      .get() as { org_id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.org_id).toBe("default");
  });

  it("migration emits an audit_log row recording the orphan reparent", () => {
    const db = getDb();
    const auditRow = db
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = 'migration.org_fk_reparent' " +
          "ORDER BY id DESC LIMIT 1",
      )
      .get() as { metadata_json: string } | undefined;
    expect(auditRow).toBeDefined();
    const meta = JSON.parse(auditRow!.metadata_json) as {
      reparented_to: string;
      counts: Record<string, number>;
      from_version: number;
      to_version: number;
    };
    expect(meta.reparented_to).toBe("default");
    expect(meta.from_version).toBe(8);
    expect(meta.to_version).toBe(9);
    expect(meta.counts.events).toBeGreaterThanOrEqual(1);
  });

  it("FK is present on events after the orphan repair completes", () => {
    const db = getDb();
    const fks = db.prepare("PRAGMA foreign_key_list(events)").all() as Array<{
      from: string;
      table: string;
    }>;
    expect(fks.some((f) => f.from === "org_id" && f.table === "orgs")).toBe(true);
  });
});
