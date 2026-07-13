import { getDb } from "./database.js";
import type { Agent } from "./types.js";

export class AgentRegistry {
  register(orgId: string, agentId: string, name: string, modules: string[]): Agent {
    const db = getDb();
    // After Task 5.5, agents PK is (org_id, id). Conflict target MUST be the composite key.
    db.prepare(
      `INSERT INTO agents (id, org_id, name, modules, status, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, id) DO UPDATE SET
         name = excluded.name,
         modules = excluded.modules,
         status = 'online',
         last_seen_at = CURRENT_TIMESTAMP`,
    ).run(agentId, orgId, name, JSON.stringify(modules));
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
