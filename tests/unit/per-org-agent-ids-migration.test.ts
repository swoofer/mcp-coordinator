import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import fs from "fs";

/**
 * issue #231 — agent ids are unique per org, not globally.
 *
 * The v11 migration repoints the five FKs that targeted `agents(id)` onto the
 * composite `(org_id, id)` and drops `idx_agents_id`. These tests exercise the
 * schema it produces and the guarantees it has to keep while doing so.
 */
const DIR = "data-test-per-org-ids";

interface Fk {
  table: string;
  from: string;
  to: string | null;
}

function fksTargetingAgents(table: string): Fk[] {
  return (getDb().prepare(`PRAGMA foreign_key_list(${table})`).all() as Fk[]).filter(
    (f) => f.table === "agents",
  );
}

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  seedTestOrgs(getDb(), ["org-a", "org-b"]);
});

afterEach(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("per-org agent ids (#231)", () => {
  it("runs the migration: schema is at v11", () => {
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
  });

  it("drops the global unique index that made ids global", () => {
    const idx = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agents_id'")
      .all();
    expect(idx).toHaveLength(0);
  });

  it("repoints every agents FK onto the composite key", () => {
    for (const table of [
      "threads",
      "thread_messages",
      "action_summaries",
      "introspections",
      "agent_activity_status",
    ]) {
      const fks = fksTargetingAgents(table);
      expect(fks.length, `${table} should still reference agents`).toBeGreaterThan(0);
      // SQLite reports a composite FK as one row PER COLUMN, sharing an `id`.
      // A single-column `REFERENCES agents(id)` would be one row targeting
      // `id`; the composite form adds the org_id -> org_id pairing.
      expect(
        fks.some((f) => f.from === "org_id" && f.to === "org_id"),
        `${table} should pair org_id with the agent id, not reference agents(id) alone`,
      ).toBe(true);
      expect(fks, `${table}'s agents FK should span two columns`).toHaveLength(2);
    }
  });

  it("THE POINT: the same agent id can now register in two orgs", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "Builder A", []);
    registry.register("org-b", "builder", "Builder B", []);

    expect(registry.get("org-a", "builder")?.name).toBe("Builder A");
    expect(registry.get("org-b", "builder")?.name).toBe("Builder B");
  });

  it("keeps the two rows independent — updating one does not touch the other", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "Builder A", ["src/a"]);
    registry.register("org-b", "builder", "Builder B", ["src/b"]);

    registry.setOffline("org-a", "builder");

    expect(registry.get("org-a", "builder")?.status).toBe("offline");
    expect(registry.get("org-b", "builder")?.status).toBe("online");
  });

  it("still rejects a duplicate id WITHIN one org by upserting, not duplicating", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "First", []);
    registry.register("org-a", "builder", "Second", []);

    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE org_id = ? AND id = ?")
      .get("org-a", "builder") as { n: number };
    expect(rows.n).toBe(1);
    expect(registry.get("org-a", "builder")?.name).toBe("Second");
  });

  it("enforces the composite FK: a thread cannot name an agent from another org", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "Builder A", []);

    // org-b has no 'builder', so this row is invalid under the composite FK.
    expect(() =>
      getDb()
        .prepare("INSERT INTO threads (id, initiator_id, subject, org_id) VALUES (?, ?, ?, ?)")
        .run("t1", "builder", "cross-org", "org-b"),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("leaves no foreign key violations behind", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "Builder A", []);
    getDb()
      .prepare("INSERT INTO threads (id, initiator_id, subject, org_id) VALUES (?, ?, ?, ?)")
      .run("t1", "builder", "ok", "org-a");

    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("is idempotent: a second initDatabase on the same dir is a no-op", () => {
    const registry = new AgentRegistry();
    registry.register("org-a", "builder", "Builder A", []);
    closeDb();

    initDatabase(DIR);
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    expect(new AgentRegistry().get("org-a", "builder")?.name).toBe("Builder A");
  });
});
