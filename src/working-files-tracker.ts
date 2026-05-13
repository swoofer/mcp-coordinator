import { getDb } from "./database.js";
import { silentLogger, type Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

/**
 * Tracks files an agent is currently editing (between PreToolUse and
 * PostToolUse hooks). Distinct from file_activity — that's an append-only
 * historical log; this is current state with TTL.
 *
 * Lifecycle:
 *   PreToolUse  → start(orgId, agent, file, ttlMin)  → UPSERT row
 *   PostToolUse → stop(orgId, agent, file)            → DELETE row
 *   Sweeper     → sweepExpired()                      → DELETE rows past claim_until (cross-org)
 *   Agent LWT   → clearForAgent(agent)                → DELETE all rows for agent (cross-org maintenance)
 */
export class WorkingFilesTracker {
  private sweeperHandle: ReturnType<typeof setInterval> | null = null;
  private log: Logger;
  private metrics?: Metrics;

  constructor(logger?: Logger, metrics?: Metrics) {
    this.log = logger || silentLogger;
    this.metrics = metrics;
  }

  /**
   * Start (or refresh) a working-files claim. Idempotent: re-calling with
   * the same (org_id, agent_id, file_path) updates last_activity_at + claim_until
   * without erroring.
   */
  start(orgId: string, agentId: string, filePath: string, ttlMinutes: number): void {
    const db = getDb();
    const existing = db.prepare("SELECT 1 FROM working_files WHERE org_id = ? AND agent_id = ? AND file_path = ?")
      .get(orgId, agentId, filePath);
    db.prepare(
      `INSERT INTO working_files (org_id, agent_id, file_path, started_at, last_activity_at, claim_until)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || CAST(? AS TEXT) || ' minutes'))
       ON CONFLICT(org_id, agent_id, file_path) DO UPDATE SET
         last_activity_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         claim_until      = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+' || CAST(? AS TEXT) || ' minutes')`
    ).run(orgId, agentId, filePath, ttlMinutes, ttlMinutes);
    this.metrics?.workingFilesStarts.inc({ result: existing ? "updated" : "inserted" });
  }

  /**
   * Stop a working-files claim. No-op when no row matches (PostToolUse can
   * arrive after a TTL eviction or before the matching PreToolUse on slow Pre).
   */
  stop(orgId: string, agentId: string, filePath: string): void {
    const db = getDb();
    db.prepare("DELETE FROM working_files WHERE org_id = ? AND agent_id = ? AND file_path = ?")
      .run(orgId, agentId, filePath);
  }

  /** Returns number of rows evicted.
   * cross-org maintenance — intentional: TTL expiry is a housekeeping concern,
   * not a data-visibility concern; sweeping only own-org would leave other orgs'
   * expired rows accumulating indefinitely.
   */
  sweepExpired(): number {
    const db = getDb();
    const result = db.prepare("DELETE FROM working_files WHERE claim_until < strftime('%Y-%m-%dT%H:%M:%SZ', 'now')").run();
    const evicted = Number(result.changes ?? 0);
    if (this.metrics) {
      const count = (db.prepare("SELECT COUNT(*) AS c FROM working_files").get() as any).c;
      this.metrics.workingFilesActive.set(count);
    }
    return evicted;
  }

  /** Called when an agent goes offline (MQTT LWT). Returns rows deleted.
   * cross-org maintenance — intentional: MQTT topics carry no org_id today
   * (see TODO(Task 22) in serve-http.ts); clearing by agent_id only is safe
   * in single-tenant Phase 1 and matches the cross-org setOffline("default", …) pattern.
   */
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

  /** Read in-flight files map: file_path → set<agent_id>, excluding caller.
   * Scoped to orgId so cross-org agent lists are not leaked.
   */
  getIndex(orgId: string, filePaths: string[], excludeAgentId: string): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    if (filePaths.length === 0) return index;
    const db = getDb();
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT file_path, agent_id FROM working_files
       WHERE org_id = ?
         AND file_path IN (${placeholders})
         AND agent_id != ?
         AND claim_until > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
    ).all(orgId, ...filePaths, excludeAgentId) as { file_path: string; agent_id: string }[];
    for (const r of rows) {
      let set = index.get(r.file_path);
      if (!set) { set = new Set(); index.set(r.file_path, set); }
      set.add(r.agent_id);
    }
    return index;
  }
}
