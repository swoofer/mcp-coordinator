import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";

const DIR = "data-test-composite-pk";

beforeAll(() => { fs.mkdirSync(DIR, { recursive: true }); initDatabase(DIR); });
afterAll(() => { closeDb(); fs.rmSync(DIR, { recursive: true, force: true }); });

const TABLES_WITH_COMPOSITE_PK: Array<[string, string[]]> = [
  ["agents", ["org_id", "id"]],
  ["agent_activity_status", ["org_id", "agent_id"]],
  ["dependency_map", ["org_id", "module_id"]],
  ["git_cochange", ["org_id", "file_a", "file_b"]],
  ["git_cochange_meta", ["org_id", "k"]],
  ["revoked_agents", ["org_id", "agent_id"]],
  ["working_files", ["org_id", "agent_id", "file_path"]],
];

describe("composite PK migration", () => {
  it.each(TABLES_WITH_COMPOSITE_PK)("table %s has composite PK including org_id", (table, expectedCols) => {
    const db = getDb();
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
    const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pkCols).toEqual(expectedCols);
  });

  it("revoked_agents: org-A revocation does NOT block org-B agent registration", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-a', 'A')").run();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-b', 'B')").run();
    db.prepare("INSERT INTO revoked_agents (org_id, agent_id, revoked_by) VALUES (?, ?, ?)").run("org-a", "claude-1", "admin-a");
    expect(() =>
      db.prepare("INSERT INTO revoked_agents (org_id, agent_id, revoked_by) VALUES (?, ?, ?)").run("org-b", "claude-1", "admin-b")
    ).not.toThrow();
  });

  it("dependency_map: same module_id in two orgs coexists", () => {
    const db = getDb();
    db.prepare("INSERT INTO dependency_map (org_id, module_id, depends_on) VALUES (?, ?, ?)").run("org-a", "src/auth", '["a"]');
    db.prepare("INSERT INTO dependency_map (org_id, module_id, depends_on) VALUES (?, ?, ?)").run("org-b", "src/auth", '["b"]');
    const rows = db.prepare("SELECT depends_on FROM dependency_map WHERE module_id = 'src/auth' ORDER BY org_id").all() as { depends_on: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].depends_on).toBe('["a"]');
    expect(rows[1].depends_on).toBe('["b"]');
  });

  it("idx_agents_id UNIQUE INDEX exists (load-bearing for FK to agents(id))", () => {
    const db = getDb();
    // After the composite-PK migration, agents.id alone is no longer a PK.
    // SQLite FKs require the referenced column to be UNIQUE or PK, so
    // idx_agents_id UNIQUE is created to preserve enforcement of the 5 FKs
    // that target agents(id) (thread_messages, action_summaries, introspections,
    // threads.initiator_id, agent_activity_status). If this index is ever
    // dropped, FK enforcement silently breaks across those 5 tables.
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agents_id'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe("idx_agents_id");
    // Verify it's UNIQUE (PRAGMA index_list returns the unique flag).
    const list = db.prepare("PRAGMA index_list(agents)").all() as { name: string; unique: number }[];
    const found = list.find((i) => i.name === "idx_agents_id");
    expect(found?.unique).toBe(1);
  });

  it("agents: same agent_id in two orgs is REJECTED by idx_agents_id UNIQUE", () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-x', 'X')").run();
    db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-y', 'Y')").run();
    db.prepare("INSERT INTO agents (id, org_id, name) VALUES (?, ?, ?)").run("shared-id", "org-x", "X-agent");
    // The composite PK (org_id, id) WOULD allow this, but the UNIQUE index on
    // id alone blocks it. This is a documented Phase 1 constraint (see the
    // composite-pk-fk-constraint memory note) — cross-org tests must use
    // distinct agent IDs.
    expect(() =>
      db.prepare("INSERT INTO agents (id, org_id, name) VALUES (?, ?, ?)").run("shared-id", "org-y", "Y-agent")
    ).toThrow(/UNIQUE/i);
  });

  it("agent_activity_status: FK to agents(id) is enforced post-migration", () => {
    const db = getDb();
    // Insert a valid agent first
    db.prepare("INSERT OR IGNORE INTO agents (id, org_id, name) VALUES (?, ?, ?)")
      .run("a-fk-test", "default", "fk-test-agent");
    // Inserting agent_activity_status with the valid agent should succeed
    expect(() =>
      db.prepare("INSERT INTO agent_activity_status (agent_id, org_id, activity_status) VALUES (?, ?, ?)")
        .run("a-fk-test", "default", "idle")
    ).not.toThrow();
    // Inserting agent_activity_status with an unknown agent_id should throw FK violation
    expect(() =>
      db.prepare("INSERT INTO agent_activity_status (agent_id, org_id, activity_status) VALUES (?, ?, ?)")
        .run("nonexistent-agent", "default", "idle")
    ).toThrow(/FOREIGN KEY/i);
  });
});
