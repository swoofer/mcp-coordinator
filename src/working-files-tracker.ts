import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";

/**
 * Tracks files an agent is currently editing (between PreToolUse and
 * PostToolUse hooks). Distinct from file_activity — that's an append-only
 * historical log; this is current state with TTL.
 *
 * Lifecycle:
 *   PreToolUse  → start(agent, file, ttlMin)  → UPSERT row
 *   PostToolUse → stop(agent, file)            → DELETE row
 *   Sweeper     → sweepExpired()               → DELETE rows past claim_until
 *   Agent LWT   → clearForAgent(agent)         → DELETE all rows for agent
 */
export class WorkingFilesTracker {
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;
  private log: Logger;

  constructor(logger?: Logger) {
    this.log = logger || silentLogger;
  }

  /**
   * Start (or refresh) a working-files claim. Idempotent: re-calling with
   * the same (agent_id, file_path) updates last_activity_at + claim_until
   * without erroring.
   */
  start(agentId: string, filePath: string, ttlMinutes: number): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO working_files (agent_id, file_path, started_at, last_activity_at, claim_until)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || CAST(? AS TEXT) || ' minutes'))
       ON CONFLICT(agent_id, file_path) DO UPDATE SET
         last_activity_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         claim_until      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || CAST(? AS TEXT) || ' minutes')`
    ).run(agentId, filePath, ttlMinutes, ttlMinutes);
  }

  /**
   * Stop a working-files claim. No-op when no row matches (PostToolUse can
   * arrive after a TTL eviction or before the matching PreToolUse on slow Pre).
   */
  stop(agentId: string, filePath: string): void {
    const db = getDb();
    db.prepare("DELETE FROM working_files WHERE agent_id = ? AND file_path = ?")
      .run(agentId, filePath);
  }

  /** Returns number of rows evicted. */
  sweepExpired(): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM working_files WHERE claim_until < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')").run();
    return Number(result.changes ?? 0);
  }

  /** Called when an agent goes offline (MQTT LWT). Returns rows deleted. */
  clearForAgent(agentId: string): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM working_files WHERE agent_id = ?").run(agentId);
    return Number(result.changes ?? 0);
  }

  /**
   * Background sweeper. unref() so it doesn't keep the loop alive at shutdown.
   * Idempotent — second call is a no-op until stopSweeper().
   */
  startSweeper(intervalMs = 60000): void {
    if (this.sweeperHandle) return;
    this.sweeperHandle = setInterval(() => {
      try {
        const evicted = this.sweepExpired();
        if (evicted > 0) this.log.info({ evicted }, "working_files sweep");
      } catch (err) {
        this.log.warn({ err }, "working_files sweep failed");
      }
    }, intervalMs);
    if (typeof this.sweeperHandle.unref === "function") this.sweeperHandle.unref();
  }

  stopSweeper(): void {
    if (this.sweeperHandle) {
      clearInterval(this.sweeperHandle);
      this.sweeperHandle = null;
    }
  }

  /** Read in-flight files map: file_path → set<agent_id>, excluding caller. */
  getIndex(filePaths: string[], excludeAgentId: string): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    if (filePaths.length === 0) return index;
    const db = getDb();
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT file_path, agent_id FROM working_files
       WHERE file_path IN (${placeholders})
         AND agent_id != ?
         AND claim_until > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).all(...filePaths, excludeAgentId) as { file_path: string; agent_id: string }[];
    for (const r of rows) {
      let set = index.get(r.file_path);
      if (!set) { set = new Set(); index.set(r.file_path, set); }
      set.add(r.agent_id);
    }
    return index;
  }
}
