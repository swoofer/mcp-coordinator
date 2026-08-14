import { getDb } from "./database.js";
import type { Agent } from "./types.js";

/**
 * Narrow to the one constraint we can explain: the global UNIQUE index on
 * agents(id). Deliberately matches the column too — any other UNIQUE violation
 * is someone else's bug and must keep its original error.
 */
function isGlobalAgentIdConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" && /agents\.id/.test(err.message);
}

export class AgentRegistry {
  register(orgId: string, agentId: string, name: string, modules: string[]): Agent {
    const db = getDb();
    // After Task 5.5, agents PK is (org_id, id). Conflict target MUST be the composite key.
    try {
      db.prepare(
        `INSERT INTO agents (id, org_id, name, modules, status, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(org_id, id) DO UPDATE SET
           name = excluded.name,
           modules = excluded.modules,
           status = 'online',
           last_seen_at = CURRENT_TIMESTAMP`,
      ).run(agentId, orgId, name, JSON.stringify(modules));
    } catch (err) {
      // issue #231: the PK is (org_id, id), but `idx_agents_id` is a GLOBAL
      // UNIQUE index on agents(id) and is load-bearing for the FKs that still
      // reference agents(id) (see the SPECS comment in database.ts — dropping
      // it needs a schema migration, not a one-line change). So the same id in
      // a second org is genuinely rejected, and the ON CONFLICT above never
      // sees it because the conflict is on the index, not the composite key.
      //
      // The driver's own message is "UNIQUE constraint failed: agents.id",
      // which names neither the id nor the org already holding it. Until the
      // migration lands, at least fail legibly.
      if (isGlobalAgentIdConflict(err)) {
        const owner = db.prepare("SELECT org_id FROM agents WHERE id = ?").get(agentId) as
          { org_id: string } | undefined;
        const where = owner ? `org '${owner.org_id}'` : "another org";
        throw new Error(
          `agent id '${agentId}' is already registered in ${where}. ` +
            `Agent ids are globally unique in this release, not per-org — choose a different id. ` +
            `See https://github.com/swoofer/mcp-coordinator/issues/231`,
        );
      }
      throw err;
    }
    return this.get(orgId, agentId)!;
  }

  get(orgId: string, agentId: string): Agent | undefined {
    const db = getDb();
    return db.prepare("SELECT * FROM agents WHERE org_id = ? AND id = ?").get(orgId, agentId) as
      Agent | undefined;
  }

  listOnline(orgId: string): Agent[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM agents WHERE org_id = ? AND status = 'online' ORDER BY name")
      .all(orgId) as Agent[];
  }

  listAll(orgId: string): Agent[] {
    const db = getDb();
    return db
      .prepare("SELECT * FROM agents WHERE org_id = ? ORDER BY last_seen_at DESC")
      .all(orgId) as Agent[];
  }

  setOnline(orgId: string, agentId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE agents SET status = 'online', last_seen_at = CURRENT_TIMESTAMP WHERE org_id = ? AND id = ?",
    ).run(orgId, agentId);
  }

  setOffline(orgId: string, agentId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE agents SET status = 'offline', last_seen_at = CURRENT_TIMESTAMP WHERE org_id = ? AND id = ?",
    ).run(orgId, agentId);
  }

  heartbeat(orgId: string, agentId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP WHERE org_id = ? AND id = ?",
    ).run(orgId, agentId);
  }
}
