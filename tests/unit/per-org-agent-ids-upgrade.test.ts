import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import fs from "fs";
import { seedV10 } from "../helpers/v10-fixture.js";

/**
 * issue #231 — the v11 migration running over a POPULATED v10 database.
 *
 * The tests in per-org-agent-ids-migration.test.ts exercise a fresh database,
 * where the migration has no rows to move. This file is the one that matters
 * for existing deployments: it builds a v10-shaped database with data, runs
 * the upgrade, and checks nothing was lost or shifted.
 *
 * v10 shape = agents keyed (org_id, id) with a GLOBAL unique index on
 * agents(id), and the five dependent tables referencing agents(id) alone.
 */
const DIR = "data-test-per-org-upgrade";

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

afterEach(() => {
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("v11 upgrade over a populated v10 database (#231)", () => {
  it("upgrades to v11 and drops the global index", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    expect(
      getDb().prepare("SELECT name FROM sqlite_master WHERE name='idx_agents_id'").all(),
    ).toHaveLength(0);
  });

  it("keeps every row, and does not shift column values", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT id, initiator_id, subject, target_files, round FROM threads ORDER BY id")
      .all() as {
      id: string;
      initiator_id: string;
      subject: string;
      target_files: string;
      round: number;
    }[];

    expect(rows).toHaveLength(2);
    const ok = rows.find((r) => r.id === "t-ok")!;
    // A column-order mistake in the copy would surface here as values landing
    // in the wrong fields.
    expect(ok.initiator_id).toBe("alice");
    expect(ok.subject).toBe("well formed");
    expect(ok.target_files).toBe('["src/a.ts"]');
    expect(ok.round).toBe(3);
  });

  it("re-parents a row whose org_id disagreed with its agent's org", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const row = getDb().prepare("SELECT org_id FROM threads WHERE id = ?").get("t-mismatched") as {
      org_id: string;
    };
    // bob lives in org-b, so the row follows him rather than staying 'default'.
    expect(row.org_id).toBe("org-b");
  });

  it("leaves the upgraded database free of foreign key violations", () => {
    seedV10(DIR);
    initDatabase(DIR);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("records the repair in audit_log so the operator can see what moved", () => {
    seedV10(DIR);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT metadata_json FROM audit_log WHERE action = 'migration.agent_fk_reparent'")
      .all() as { metadata_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows[0].metadata_json).counts.threads).toBe(1);
  });

  // The other pre-flight — the one that refuses to guess when a row points at
  // an agent id present in no org, plus the COORDINATOR_ALLOW_MIGRATION_REPAIR
  // escape hatch — lives in per-org-agent-ids-orphans.test.ts, on the same
  // fixture (tests/helpers/v10-fixture.ts) with `dangling` rows added.
});
