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

  /** Report file edit activity → status becomes "working" */
  reportFileActivity(agentId: string, filePath: string): void {
    this.upsert(agentId, "working", filePath, null);
  }

  /** Report agent is waiting on a consultation thread */
  reportWaiting(agentId: string, threadId: string): void {
    this.upsert(agentId, "waiting", null, threadId);
  }

  /** Report agent went offline → clear all activity */
  reportOffline(agentId: string): void {
    this.upsert(agentId, "offline", null, null);
  }

  /** Enriched heartbeat — derives status from current state */
  heartbeat(agentId: string, payload: HeartbeatPayload): void {
    let status: ActivityStatus;
    if (payload.currentFile) {
      status = "working";
    } else if (payload.currentThread) {
      status = "waiting";
    } else {
      status = "idle";
    }
    this.upsert(agentId, status, payload.currentFile, payload.currentThread);
  }

  /** Get activity for a single agent, with optional idle timeout */
  getActivity(agentId: string, options?: GetActivityOptions): AgentActivity {
    const agent = this.registry.get(agentId);
    if (!agent || agent.status === "offline") {
      return { agent_id: agentId, activity_status: "offline", current_file: null, current_thread: null, last_activity_at: new Date().toISOString() };
    }

    const db = getDb();
    const row = db.prepare("SELECT * FROM agent_activity_status WHERE agent_id = ?").get(agentId) as AgentActivity | undefined;

    if (!row) {
      return { agent_id: agentId, activity_status: "idle", current_file: null, current_thread: null, last_activity_at: new Date().toISOString() };
    }

    // Check idle timeout: if working but no activity for X minutes → idle
    if (row.activity_status === "working" && options?.idleAfterMinutes) {
      const lastActivity = new Date(row.last_activity_at.replace(" ", "T") + "Z").getTime();
      const threshold = options.idleAfterMinutes * 60 * 1000;
      if (Date.now() - lastActivity > threshold) {
        return { ...row, activity_status: "idle" };
      }
    }

    return row;
  }

  /** List activity for all online agents */
  listAll(options?: GetActivityOptions): AgentActivity[] {
    const onlineAgents = this.registry.listOnline();
    return onlineAgents.map((agent) => this.getActivity(agent.id, options));
  }

  // ── Private ──

  private upsert(agentId: string, status: ActivityStatus, file: string | null, thread: string | null): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO agent_activity_status (agent_id, activity_status, current_file, current_thread, last_activity_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, agent_id) DO UPDATE SET
         activity_status = excluded.activity_status,
         current_file = excluded.current_file,
         current_thread = excluded.current_thread,
         last_activity_at = CURRENT_TIMESTAMP`
    ).run(agentId, status, file, thread);
  }
}
