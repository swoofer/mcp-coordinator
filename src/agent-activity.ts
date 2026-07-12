import { getDb } from "./database.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { AgentActivity, ActivityStatus } from "./types.js";

interface HeartbeatPayload {
  currentFile: string | null;
  currentThread: string | null;
}

interface GetActivityOptions {
  idleAfterMinutes?: number;
}

export class AgentActivityTracker {
  constructor(private registry: AgentRegistry) {}

  /** Report file edit activity -> status becomes "working" (org-scoped) */
  reportFileActivity(orgId: string, agentId: string, filePath: string): void {
    const db = getDb();
    // After Task 5.5, agent_activity_status PK is (org_id, agent_id). Composite conflict target.
    db.prepare(
      `INSERT INTO agent_activity_status (org_id, agent_id, activity_status, current_file, last_activity_at)
       VALUES (?, ?, 'working', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, agent_id) DO UPDATE SET
         activity_status = 'working',
         current_file = excluded.current_file,
         current_thread = NULL,
         last_activity_at = CURRENT_TIMESTAMP`,
    ).run(orgId, agentId, filePath);
  }

  /** Report agent is waiting on a consultation thread (org-scoped) */
  reportWaiting(orgId: string, agentId: string, threadId: string): void {
    this.upsert(orgId, agentId, "waiting", null, threadId);
  }

  /** Report agent went offline -> clear all activity (org-scoped) */
  reportOffline(orgId: string, agentId: string): void {
    const db = getDb();
    db.prepare(
      "UPDATE agent_activity_status SET activity_status = 'offline', current_file = NULL, current_thread = NULL WHERE org_id = ? AND agent_id = ?",
    ).run(orgId, agentId);
  }

  /** Enriched heartbeat -- derives status from current state (org-scoped) */
  heartbeat(orgId: string, agentId: string, payload: HeartbeatPayload): void {
    let status: ActivityStatus;
    if (payload.currentFile) {
      status = "working";
    } else if (payload.currentThread) {
      status = "waiting";
    } else {
      status = "idle";
    }
    this.upsert(orgId, agentId, status, payload.currentFile, payload.currentThread);
  }

  /** Get raw status row for a single agent (org-scoped) */
  getStatus(orgId: string, agentId: string): AgentActivity | null {
    const db = getDb();
    return db
      .prepare("SELECT * FROM agent_activity_status WHERE org_id = ? AND agent_id = ?")
      .get(orgId, agentId) as AgentActivity | null;
  }

  /** List all active agents in an org */
  listActive(orgId: string): AgentActivity[] {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM agent_activity_status WHERE org_id = ? AND activity_status = 'working' ORDER BY last_activity_at DESC",
      )
      .all(orgId) as AgentActivity[];
  }

  /** Get activity for a single agent, with optional idle timeout (org-scoped) */
  getActivity(orgId: string, agentId: string, options?: GetActivityOptions): AgentActivity {
    const agent = this.registry.get(orgId, agentId);
    if (!agent || agent.status === "offline") {
      return {
        agent_id: agentId,
        activity_status: "offline",
        current_file: null,
        current_thread: null,
        last_activity_at: new Date().toISOString(),
      };
    }

    const db = getDb();
    const row = db
      .prepare("SELECT * FROM agent_activity_status WHERE org_id = ? AND agent_id = ?")
      .get(orgId, agentId) as AgentActivity | undefined;

    if (!row) {
      return {
        agent_id: agentId,
        activity_status: "idle",
        current_file: null,
        current_thread: null,
        last_activity_at: new Date().toISOString(),
      };
    }

    // Check idle timeout: if working but no activity for X minutes -> idle
    if (row.activity_status === "working" && options?.idleAfterMinutes) {
      const lastActivity = new Date(row.last_activity_at.replace(" ", "T") + "Z").getTime();
      const threshold = options.idleAfterMinutes * 60 * 1000;
      if (Date.now() - lastActivity > threshold) {
        return { ...row, activity_status: "idle" };
      }
    }

    return row;
  }

  /** List activity for all online agents in an org */
  listAll(orgId: string, options?: GetActivityOptions): AgentActivity[] {
    const onlineAgents = this.registry.listOnline(orgId);
    return onlineAgents.map((agent) => this.getActivity(orgId, agent.id, options));
  }

  // -- Private --

  private upsert(
    orgId: string,
    agentId: string,
    status: ActivityStatus,
    file: string | null,
    thread: string | null,
  ): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_activity_status (org_id, agent_id, activity_status, current_file, current_thread, last_activity_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, agent_id) DO UPDATE SET
         activity_status = excluded.activity_status,
         current_file = excluded.current_file,
         current_thread = excluded.current_thread,
         last_activity_at = CURRENT_TIMESTAMP`,
    ).run(orgId, agentId, status, file, thread);
  }
}
