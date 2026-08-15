import { describe, it, expect } from "vitest";
import { summarizeFkViolations } from "../../src/fk-violation-report.js";

/**
 * issue #285 — who the v0.9 abort message blames.
 */
describe("summarizeFkViolations", () => {
  const copied = new Set(["threads", "thread_messages"]);

  it("blames the migration for org_id -> orgs on a table it just copied", () => {
    const r = summarizeFkViolations(
      [{ table: "threads", parent: "orgs", columns: ["org_id"] }],
      copied,
    );
    expect(r.migrationCaused).toHaveLength(1);
    expect(r.preExisting).toHaveLength(0);
    expect(r.message).toContain("IS a bug in the migration");
    expect(r.message).toContain("threads.org_id -> orgs (1 row)");
  });

  it("does NOT blame the migration for a constraint it never touched", () => {
    // The case that sent operators hunting for a coordinator bug: a message
    // whose thread was deleted. Nothing to do with the org_id migration.
    const r = summarizeFkViolations(
      [{ table: "thread_messages", parent: "threads", columns: ["thread_id"] }],
      copied,
    );
    expect(r.migrationCaused).toHaveLength(0);
    expect(r.preExisting).toHaveLength(1);
    expect(r.message).toContain("did not");
    expect(r.message).toContain("data problem rather than a coordinator bug");
    expect(r.message).not.toContain("IS a bug in the migration");
  });

  it("does NOT blame the migration for org_id -> orgs on a table it skipped", () => {
    // Already carried the FK from an earlier partial run, so this migration
    // neither recreated it nor had a chance to repair its orphans.
    const r = summarizeFkViolations(
      [{ table: "events", parent: "orgs", columns: ["org_id"] }],
      copied,
    );
    expect(r.migrationCaused).toHaveLength(0);
    expect(r.preExisting).toHaveLength(1);
  });

  it("names the table, the columns and the row count for each constraint", () => {
    const r = summarizeFkViolations(
      [
        { table: "thread_messages", parent: "threads", columns: ["thread_id"] },
        { table: "thread_messages", parent: "threads", columns: ["thread_id"] },
        { table: "agent_activity_status", parent: "agents", columns: ["org_id", "agent_id"] },
      ],
      copied,
    );
    expect(r.message).toContain("thread_messages.thread_id -> threads (2 rows)");
    expect(r.message).toContain("agent_activity_status.org_id+agent_id -> agents (1 row)");
  });

  it("reports both classes when both are present, without conflating them", () => {
    const r = summarizeFkViolations(
      [
        { table: "threads", parent: "orgs", columns: ["org_id"] },
        { table: "thread_messages", parent: "threads", columns: ["thread_id"] },
      ],
      copied,
    );
    expect(r.migrationCaused).toHaveLength(1);
    expect(r.preExisting).toHaveLength(1);
    expect(r.message).toContain("IS a bug in the migration");
    expect(r.message).toContain("Additionally, the database has");
  });

  it("always says the database was left alone", () => {
    const r = summarizeFkViolations(
      [{ table: "threads", parent: "orgs", columns: ["org_id"] }],
      copied,
    );
    expect(r.message).toContain("Aborting; the database is left unchanged.");
  });

  it("tells the operator how to list the offending rows themselves", () => {
    const r = summarizeFkViolations(
      [{ table: "thread_messages", parent: "threads", columns: ["thread_id"] }],
      copied,
    );
    expect(r.message).toContain("PRAGMA foreign_key_check;");
  });
});
