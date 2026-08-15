import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { isRevoked } from "../../src/auth.js";
import fs from "fs";
import path from "path";

/**
 * issue #287 — the v12 migration that moves `revoked_agents` rows onto the org
 * that owns the agent.
 *
 * `revokeAgent` never wrote an org, and `org_id` arrived by
 * `ALTER TABLE ... DEFAULT 'default'`, so every pre-existing row sits under
 * 'default' whatever org its agent belongs to. Scoping `isRevoked` to the org
 * without moving them first would silently un-revoke every agent outside
 * 'default' — a tenant-isolation fix that re-opens revoked access.
 */
const DIR = "data-test-revoked-per-org";

/**
 * A v11 database with `revoked_agents` rows carrying the wrong org, built by
 * hand. `initDatabase` is run first so the schema is real, then the rows are
 * rewritten and user_version wound back to 11 so only v12 fires on reopen.
 */
function seedV11(rows: { agentId: string; orgId: string }[], agents: [string, string][]): void {
  fs.rmSync(DIR, { recursive: true, force: true });
  initDatabase(DIR);
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-a','A')").run();
  db.prepare("INSERT OR IGNORE INTO orgs (id, name) VALUES ('org-b','B')").run();
  for (const [id, org] of agents) {
    db.prepare("INSERT INTO agents (id, org_id, name, status) VALUES (?, ?, ?, 'offline')").run(
      id,
      org,
      id,
    );
  }
  db.exec("DELETE FROM revoked_agents");
  for (const r of rows) {
    db.prepare(
      "INSERT INTO revoked_agents (agent_id, org_id, revoked_at, revoked_by) VALUES (?, ?, ?, ?)",
    ).run(r.agentId, r.orgId, "2026-01-01T00:00:00Z", "admin-legacy");
  }
  closeDb();

  const raw = new Database(path.join(DIR, "coordinator.db"));
  raw.pragma("user_version = 11");
  raw.close();
}

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

describe("v12 — revoked_agents re-scoped onto the agent's org (#287)", () => {
  it("moves a legacy 'default' row onto the org that owns the agent", () => {
    seedV11([{ agentId: "alice", orgId: "default" }], [["alice", "org-a"]]);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT org_id FROM revoked_agents WHERE agent_id = 'alice'")
      .all() as { org_id: string }[];
    expect(rows).toEqual([{ org_id: "org-a" }]);
  });

  it("keeps the agent revoked across the move — the whole point", () => {
    seedV11([{ agentId: "alice", orgId: "default" }], [["alice", "org-a"]]);
    initDatabase(DIR);

    // Before v12 this returned false: the row said 'default', the agent is in org-a.
    expect(isRevoked("org-a", "alice")).toBe(true);
  });

  it("leaves a row alone when no agent carries that id", () => {
    // Agent deleted since the revocation. Nothing can be inferred, and
    // dropping the row would weaken a revocation.
    seedV11([{ agentId: "ghost", orgId: "default" }], []);
    initDatabase(DIR);

    const rows = getDb()
      .prepare("SELECT org_id FROM revoked_agents WHERE agent_id = 'ghost'")
      .all() as { org_id: string }[];
    expect(rows).toEqual([{ org_id: "default" }]);
  });

  it("revokes in EVERY org holding the id when the id is ambiguous", () => {
    // Possible only after v11 dropped the global unique index. Which agent the
    // admin meant is unknowable, so over-revoke: an admin can undo that, a
    // missed revocation is a hole.
    seedV11(
      [{ agentId: "builder", orgId: "default" }],
      [
        ["builder", "org-a"],
        ["builder", "org-b"],
      ],
    );
    initDatabase(DIR);

    const orgs = (
      getDb()
        .prepare("SELECT org_id FROM revoked_agents WHERE agent_id = 'builder' ORDER BY org_id")
        .all() as { org_id: string }[]
    ).map((r) => r.org_id);
    expect(orgs).toEqual(["org-a", "org-b"]);
    expect(isRevoked("org-a", "builder")).toBe(true);
    expect(isRevoked("org-b", "builder")).toBe(true);
  });

  it("carries revoked_at and revoked_by from the earliest revocation", () => {
    seedV11([{ agentId: "alice", orgId: "default" }], [["alice", "org-a"]]);
    // Add a later, different row for the same id under another stale org.
    initDatabase(DIR);
    closeDb();

    initDatabase(DIR);
    const row = getDb()
      .prepare("SELECT revoked_at, revoked_by FROM revoked_agents WHERE agent_id = 'alice'")
      .get() as { revoked_at: string; revoked_by: string };
    expect(row.revoked_by).toBe("admin-legacy");
    expect(row.revoked_at).toBe("2026-01-01T00:00:00Z");
  });

  it("reaches v12 and does not re-run on the next boot", () => {
    seedV11([{ agentId: "alice", orgId: "default" }], [["alice", "org-a"]]);
    initDatabase(DIR);
    const v = getDb().prepare("PRAGMA user_version").get() as { user_version: number };
    expect(v.user_version).toBeGreaterThanOrEqual(12);

    // A later, deliberate single-org revocation must NOT get spread around by a
    // second run of the migration — that is why it is gated on user_version.
    getDb()
      .prepare(
        "INSERT INTO agents (id, org_id, name, status) VALUES ('bob','org-a','bob','offline')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO agents (id, org_id, name, status) VALUES ('bob','org-b','bob','offline')",
      )
      .run();
    getDb()
      .prepare(
        "INSERT INTO revoked_agents (agent_id, org_id, revoked_by) VALUES ('bob','org-a','admin')",
      )
      .run();
    closeDb();

    initDatabase(DIR);
    expect(isRevoked("org-a", "bob")).toBe(true);
    expect(isRevoked("org-b", "bob")).toBe(false);
  });

  it("records the re-scope in audit_log", () => {
    seedV11([{ agentId: "alice", orgId: "default" }], [["alice", "org-a"]]);
    initDatabase(DIR);

    const rows = getDb()
      .prepare(
        "SELECT metadata_json FROM audit_log WHERE action = 'migration.revoked_agents_rescope'",
      )
      .all() as { metadata_json: string }[];
    expect(rows).toHaveLength(1);
    const meta = JSON.parse(rows[0].metadata_json);
    expect(meta.agents_rescoped).toBe(1);
    expect(meta.sample).toEqual([{ agent_id: "alice", orgs: ["org-a"] }]);
  });

  it("writes no audit row when every row is already correctly scoped", () => {
    seedV11([{ agentId: "alice", orgId: "org-a" }], [["alice", "org-a"]]);
    initDatabase(DIR);

    const n = getDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'migration.revoked_agents_rescope'",
      )
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});
