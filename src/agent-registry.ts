import { getDb } from "./database.js";
import type { Agent } from "./types.js";

/**
 * How long an agent stays "online" without being seen (issue #233).
 *
 * Generous on purpose. Liveness is refreshed by real work — announce_work and
 * post_to_thread, not just the explicit `heartbeat` tool — but an agent that is
 * simply thinking for a while must not be culled mid-task. Read per call so a
 * deployment can tune it without a restart.
 */
const DEFAULT_ONLINE_TTL_SECONDS = 900;

function onlineTtlSeconds(): number {
  const raw = process.env.COORDINATOR_AGENT_ONLINE_TTL_SECONDS;
  if (!raw) return DEFAULT_ONLINE_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ONLINE_TTL_SECONDS;
}

export class AgentRegistry {
  register(orgId: string, agentId: string, name: string, modules: string[]): Agent {
    const db = getDb();
    // agents PK is (org_id, id), and since the v11 migration (issue #231) that
    // is the ONLY uniqueness constraint — the global UNIQUE index on agents(id)
    // is gone, so the same id in a second org is a different agent.
    //
    // The stage-1 error handler that used to sit here is deleted rather than
    // kept as a safety net: it told the caller "agent ids are globally unique
    // in this release", which is now false, and its trigger (a UNIQUE violation
    // on agents.id) can no longer fire.
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

  /**
   * Agents that are both flagged online AND have been seen recently.
   *
   * issue #233: filtering on `status` alone made this lie. `status` only
   * becomes 'offline' through an opt-in REST call or an MQTT last-will that
   * real agents do not register, so a crashed or disconnected agent stayed
   * "online" indefinitely — and `wait_for_peers` reported readiness against it.
   *
   * This is a read-time filter, not a sweeper: no background job, no leader
   * election needed in the multi-instance profile, and nothing is mutated. The
   * row is still there — `listAll` and `get` are deliberately unfiltered, so
   * history and diagnostics keep the agent.
   */
  listOnline(orgId: string): Agent[] {
    const db = getDb();
    return db
      .prepare(
        `SELECT * FROM agents
         WHERE org_id = ?
           AND status = 'online'
           AND strftime('%s', 'now') - strftime('%s', last_seen_at) <= ?
         ORDER BY name`,
      )
      .all(orgId, onlineTtlSeconds()) as Agent[];
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
