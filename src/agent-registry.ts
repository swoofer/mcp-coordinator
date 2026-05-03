import { getDb } from "./database.js";
import type { Agent } from "./types.js";

export class AgentRegistry {
  register(agentId: string, name: string, modules: string[]): Agent {
    const db = getDb();
    db.prepare(
      `INSERT INTO agents (id, name, modules, status, registered_at, last_seen_at)
       VALUES (?, ?, ?, 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         modules = excluded.modules,
         status = 'online',
         last_seen_at = CURRENT_TIMESTAMP`
    ).run(agentId, name, JSON.stringify(modules));
    return this.get(agentId)!;
  }

  get(agentId: string): Agent | undefined {
    const db = getDb();
    return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
  }

  listOnline(): Agent[] {
    const db = getDb();
    return db.prepare("SELECT * FROM agents WHERE status = 'online' ORDER BY name").all() as Agent[];
  }

  listAll(): Agent[] {
    const db = getDb();
    return db.prepare("SELECT * FROM agents ORDER BY last_seen_at DESC").all() as Agent[];
  }

  setOnline(agentId: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'online', last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(agentId);
  }

  setOffline(agentId: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET status = 'offline', last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(agentId);
  }

  heartbeat(agentId: string): void {
    const db = getDb();
    db.prepare("UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(agentId);
  }
}
