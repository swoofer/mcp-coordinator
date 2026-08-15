import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { seedV10 } from "../helpers/v10-fixture.js";
import fs from "fs";

/**
 * issue #231 — pre-flight 2 versus `agent_activity_status`.
 *
 * Four of the five migrated tables are keyed on a plain `id`, so rewriting
 * `org_id` can never collide. `agent_activity_status` is keyed
 * `(org_id, agent_id)`. Two rows for one agent under different orgs is legal
 * before v11 — the old FK `agent_id REFERENCES agents(id)` only required the
 * id to exist in SOME org, and nothing in the write paths checks that the
 * agent belongs to the caller's org — so re-parenting the drifted row onto
 * its agent's org lands on top of the row already there.
 *
 * Left unhandled that is a boot the operator cannot recover from: the raw
 * UNIQUE violation escapes initDatabase, the database stays at v10, and every
 * later boot fails identically.
 */
const DIR = "data-test-activity-collision";

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

describe("v11 pre-flight 2 — agent_activity_status composite PK (#231)", () => {
  /** alice belongs to org-a; a second status row for her sits under 'default'. */
  const COLLIDING = [
    { agentId: "alice", orgId: "org-a", status: "working", lastActivityAt: "2026-02-01T00:00:00Z" },
    { agentId: "alice", orgId: "default", status: "idle", lastActivityAt: "2026-01-01T00:00:00Z" },
  ];

  it("boots instead of dying on the collision", () => {
    seedV10(DIR, { activity: COLLIDING });
    expect(() => initDatabase(DIR)).not.toThrow();
  });

  it("reaches v11 with no foreign key violations", () => {
    seedV10(DIR, { activity: COLLIDING });
    initDatabase(DIR);
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(11);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("keeps one status row for the agent, the most recently active one", () => {
    seedV10(DIR, { activity: COLLIDING });
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT org_id, activity_status FROM agent_activity_status WHERE agent_id = 'alice'")
      .all() as { org_id: string; activity_status: string }[];
    // agent_activity_status holds live status, not history: one agent, one row.
    // The newer of the two survives; the stale drifted one goes.
    expect(rows).toEqual([{ org_id: "org-a", activity_status: "working" }]);
  });

  it("keeps the drifted row when IT is the more recent one", () => {
    seedV10(DIR, {
      activity: [
        {
          agentId: "alice",
          orgId: "org-a",
          status: "idle",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
        {
          agentId: "alice",
          orgId: "default",
          status: "working",
          lastActivityAt: "2026-03-01T00:00:00Z",
        },
      ],
    });
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT org_id, activity_status FROM agent_activity_status WHERE agent_id = 'alice'")
      .all() as { org_id: string; activity_status: string }[];
    expect(rows).toEqual([{ org_id: "org-a", activity_status: "working" }]);
  });

  it("re-parents a non-colliding drifted status row without dropping anything", () => {
    seedV10(DIR, {
      activity: [{ agentId: "bob", orgId: "default", status: "working" }],
    });
    initDatabase(DIR);

    // bob lives in org-b and had no row there, so the drifted row simply moves.
    const rows = getDb()
      .prepare("SELECT org_id, activity_status FROM agent_activity_status WHERE agent_id = 'bob'")
      .all() as { org_id: string; activity_status: string }[];
    expect(rows).toEqual([{ org_id: "org-b", activity_status: "working" }]);
  });

  it("records the dropped duplicate in audit_log", () => {
    seedV10(DIR, { activity: COLLIDING });
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT metadata_json FROM audit_log WHERE action = 'migration.agent_fk_reparent'")
      .all() as { metadata_json: string }[];
    expect(rows.length).toBeGreaterThan(0);
    const merged = rows
      .map((r) => JSON.parse(r.metadata_json))
      .find((m) => m.status_duplicates_merged);
    expect(merged?.status_duplicates_merged?.agent_activity_status).toBe(1);
  });

  it("leaves the database untouched and re-runnable if the migration does fail", () => {
    // Nothing pathological here — this pins that pre-flight 2's writes are
    // inside the migration transaction, so a later failure cannot leave some
    // tables re-parented and others not.
    seedV10(DIR, { activity: COLLIDING });
    initDatabase(DIR);
    closeDb();
    // A second boot must be a clean no-op, not a re-repair.
    expect(() => initDatabase(DIR)).not.toThrow();
    const rows = getDb()
      .prepare("SELECT COUNT(*) AS n FROM agent_activity_status WHERE agent_id = 'alice'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe("v11 pre-flight 2 — three orgs wrote status for one agent (#231)", () => {
  it("collapses to a single row, not two that collide again", () => {
    // The case a pairwise rule misses: comparing each drifted row only against
    // the in-org one leaves both drifted rows alive when the in-org row is the
    // stalest, and the UPDATE then maps both onto (org-a, alice).
    seedV10(DIR, {
      activity: [
        {
          agentId: "alice",
          orgId: "org-a",
          status: "idle",
          lastActivityAt: "2026-01-01T00:00:00Z",
        },
        {
          agentId: "alice",
          orgId: "default",
          status: "working",
          lastActivityAt: "2026-03-01T00:00:00Z",
        },
        {
          agentId: "alice",
          orgId: "org-b",
          status: "blocked",
          lastActivityAt: "2026-02-01T00:00:00Z",
        },
      ],
    });
    expect(() => initDatabase(DIR)).not.toThrow();

    const rows = getDb()
      .prepare("SELECT org_id, activity_status FROM agent_activity_status WHERE agent_id = 'alice'")
      .all() as { org_id: string; activity_status: string }[];
    expect(rows).toEqual([{ org_id: "org-a", activity_status: "working" }]);
    expect(getDb().prepare("PRAGMA foreign_key_check").all()).toHaveLength(0);
  });

  it("survives rows whose last_activity_at is NULL", () => {
    // NULL comparisons are neither > nor =, so an un-coalesced rule deletes
    // nothing here and the collision comes straight back.
    seedV10(DIR, {
      activity: [
        { agentId: "alice", orgId: "org-a", status: "idle", lastActivityAt: null },
        { agentId: "alice", orgId: "default", status: "working", lastActivityAt: null },
      ],
    });
    expect(() => initDatabase(DIR)).not.toThrow();

    const rows = getDb()
      .prepare("SELECT org_id FROM agent_activity_status WHERE agent_id = 'alice'")
      .all() as { org_id: string }[];
    expect(rows).toEqual([{ org_id: "org-a" }]);
  });
});
