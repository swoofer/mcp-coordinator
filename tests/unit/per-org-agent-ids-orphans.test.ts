import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { canRepairMigrationOrphans } from "../../src/migration-guard.js";
import { seedV10 } from "../helpers/v10-fixture.js";
import fs from "fs";

/**
 * issue #231 — pre-flight 1 of the v11 migration: rows referencing an agent id
 * that exists in NO org.
 *
 * Two branches. By default the migration ABORTS: the org such a row belongs to
 * is unknowable from `agents`, and dropping coordination history to make a
 * schema change go through is not the migration's call. With
 * COORDINATOR_ALLOW_MIGRATION_REPAIR=true it instead recreates the missing
 * `agents` rows, each in the org its referencing rows already carry.
 */
const DIR = "data-test-per-org-orphans";

/** Restore whatever the ambient env had, so one test cannot leak into another. */
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR;
  delete process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR;
  fs.rmSync(DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR;
  else process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = savedFlag;
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("canRepairMigrationOrphans", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(canRepairMigrationOrphans({})).toBe(false);
    expect(canRepairMigrationOrphans({ COORDINATOR_ALLOW_MIGRATION_REPAIR: "1" })).toBe(false);
    expect(canRepairMigrationOrphans({ COORDINATOR_ALLOW_MIGRATION_REPAIR: "TRUE" })).toBe(false);
    expect(canRepairMigrationOrphans({ COORDINATOR_ALLOW_MIGRATION_REPAIR: "true" })).toBe(true);
  });

  it("is NOT granted by NODE_ENV=test, unlike canResetDb", () => {
    // The abort is the behaviour the suite must exercise by default; a
    // test-mode escape hatch would hide it.
    expect(canRepairMigrationOrphans({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("v11 pre-flight 1 — dangling agent references (#231)", () => {
  const GHOST = [{ threadId: "t-ghost", agentId: "ghost", orgId: "org-a" }];

  it("aborts by default rather than dropping the rows", () => {
    seedV10(DIR, { dangling: GHOST });
    expect(() => initDatabase(DIR)).toThrow(/reference agent ids that do not.*exist in/s);
  });

  it("names the tables and counts, and points at the escape hatch", () => {
    seedV10(DIR, { dangling: GHOST });
    let message = "";
    try {
      initDatabase(DIR);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"threads":1');
    expect(message).toContain("COORDINATOR_ALLOW_MIGRATION_REPAIR=true");
  });

  it("leaves the database at v10 when it aborts, so nothing is half-migrated", () => {
    seedV10(DIR, { dangling: GHOST });
    expect(() => initDatabase(DIR)).toThrow();
    closeDb();

    // Reopen with the flag on: the abort must not have advanced user_version
    // or dropped the global index on its way out.
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    initDatabase(DIR);
    const rows = getDb().prepare("SELECT id, org_id FROM threads ORDER BY id").all();
    expect(rows).toHaveLength(3); // t-ghost survived the aborted attempt
  });

  it("with the flag on, recreates the missing agent in the org the row carries", () => {
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, { dangling: GHOST });
    initDatabase(DIR);

    const agent = getDb()
      .prepare("SELECT org_id, name, status FROM agents WHERE id = 'ghost'")
      .get() as { org_id: string; name: string; status: string };
    expect(agent.org_id).toBe("org-a");
    expect(agent.status).toBe("offline");
    expect(agent.name).toContain("recovered");
  });

  it("deletes nothing — the orphaned row is still there afterwards", () => {
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, { dangling: GHOST });
    initDatabase(DIR);

    const row = getDb()
      .prepare("SELECT initiator_id, org_id FROM threads WHERE id = 't-ghost'")
      .get() as { initiator_id: string; org_id: string } | undefined;
    expect(row).toEqual({ initiator_id: "ghost", org_id: "org-a" });
  });

  it("reaches v11 with no foreign key violations", () => {
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, { dangling: GHOST });
    initDatabase(DIR);

    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("recreates ONE agent per dangling id, in the org most of its rows carry", () => {
    // Two orgs each hold an orphan named ghost, org-b holding more of them.
    // idx_agents_id is still load-bearing here (every pre-v11 REFERENCES
    // agents(id) needs it), so a second ghost row is not insertable — and ids
    // WERE globally unique, so one agent in one org is also the faithful
    // reading. The minority row follows it, exactly as a drifted row does.
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, {
      dangling: [
        { threadId: "t-g1", agentId: "ghost", orgId: "org-a" },
        { threadId: "t-g2", agentId: "ghost", orgId: "org-b" },
        { threadId: "t-g3", agentId: "ghost", orgId: "org-b" },
      ],
    });
    initDatabase(DIR);

    const agents = getDb().prepare("SELECT org_id FROM agents WHERE id = 'ghost'").all() as {
      org_id: string;
    }[];
    expect(agents).toEqual([{ org_id: "org-b" }]);

    const threads = (
      getDb()
        .prepare("SELECT org_id FROM threads WHERE initiator_id = 'ghost' ORDER BY id")
        .all() as { org_id: string }[]
    ).map((r) => r.org_id);
    expect(threads).toEqual(["org-b", "org-b", "org-b"]);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });
  it("still re-parents the cross-org row while recovering the orphan", () => {
    // Pre-flight 2 runs after the recovery; its subquery must not be confused
    // by the agents rows that just appeared, and must not NULL out org_id on
    // a row whose agent it cannot resolve.
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, { dangling: GHOST });
    initDatabase(DIR);

    const drifted = getDb()
      .prepare("SELECT org_id FROM threads WHERE id = 't-mismatched'")
      .get() as {
      org_id: string;
    };
    expect(drifted.org_id).toBe("org-b"); // followed bob, as before
  });

  it("records the recovery in audit_log", () => {
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR, { dangling: GHOST });
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT metadata_json FROM audit_log WHERE action = 'migration.agent_fk_recover'")
      .all() as { metadata_json: string }[];
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json);
    expect(meta.rows_affected.threads).toBe(1);
    expect(meta.agents_recreated).toBe(1);
    expect(meta.sample).toEqual([{ id: "ghost", orgId: "org-a", rows: 1 }]);
  });

  it("writes no recovery audit entry when there is nothing to recover", () => {
    process.env.COORDINATOR_ALLOW_MIGRATION_REPAIR = "true";
    seedV10(DIR); // clean fixture — the flag must be inert
    initDatabase(DIR);

    expect(
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'migration.agent_fk_recover'")
        .get(),
    ).toEqual({ n: 0 });
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM agents").get()).toEqual({ n: 2 });
  });
});
