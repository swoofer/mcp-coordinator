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
