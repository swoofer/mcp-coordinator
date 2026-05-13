import { getDb } from "./database.js";
import type { FileActivity } from "./types.js";

export class FileTracker {
  log(params: {
    org_id: string;
    session_id: string;
    agent_id: string;
    agent_name?: string;
    tool_name: string;
    file_path: string;
    content_hash?: string | null;
    symbols_touched?: string[] | null;
  }): void {
    const db = getDb();
    const module = this.fileToModule(params.file_path);
    db.prepare(
      `INSERT INTO file_activity
       (org_id, session_id, agent_id, agent_name, tool_name, file_path, module, content_hash, symbols_touched)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.org_id,
      params.session_id,
      params.agent_id,
      params.agent_name || null,
      params.tool_name,
      params.file_path,
      module,
      params.content_hash || null,
      params.symbols_touched ? JSON.stringify(params.symbols_touched) : null,
    );
  }

  getBySession(orgId: string, sessionId: string): FileActivity[] {
    const db = getDb();
    return db.prepare(
      "SELECT * FROM file_activity WHERE org_id = ? AND session_id = ? ORDER BY created_at"
    ).all(orgId, sessionId) as FileActivity[];
  }

  getHotFiles(orgId: string, sinceMinutes: number = 30): { file_path: string; agent_count: number; agents: string[] }[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT file_path, COUNT(DISTINCT agent_id) as agent_count, GROUP_CONCAT(DISTINCT agent_id) as agents
       FROM file_activity
       WHERE org_id = ?
         AND created_at > datetime('now', '-' || ? || ' minutes')
       GROUP BY file_path
       HAVING COUNT(DISTINCT agent_id) > 1
       ORDER BY agent_count DESC`
    ).all(orgId, sinceMinutes) as { file_path: string; agent_count: number; agents: string }[];
    return rows.map((r) => ({
      file_path: r.file_path,
      agent_count: r.agent_count,
      agents: r.agents.split(","),
    }));
  }

  checkFileConflict(orgId: string, filePath: string, agentId: string, withinMinutes: number = 30): { conflict: boolean; agents: string[] } {
    const db = getDb();
    const rows = db.prepare(
      `SELECT DISTINCT agent_id FROM file_activity
       WHERE org_id = ? AND file_path = ? AND agent_id != ?
         AND created_at > datetime('now', '-' || ? || ' minutes')`
    ).all(orgId, filePath, agentId, withinMinutes) as { agent_id: string }[];
    return { conflict: rows.length > 0, agents: rows.map((r) => r.agent_id) };
  }

  /**
   * P2 perf: batch lookup of recent file→agents activity. Replaces N
   * `checkFileConflict` calls (one per file) with a single SQL query, then
   * builds an in-memory reverse index. The impact scorer uses this so its
   * per-file inner loop is O(1) Map.get() rather than O(F) SQL round-trips.
   *
   * Excludes the calling agent (so the scorer doesn't flag the announcer
   * against themselves). Returns Map<file_path, Set<agent_id>>.
   */
  getFileToAgentsIndex(orgId: string, filePaths: string[], excludeAgentId: string, withinMinutes: number = 30): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>();
    if (filePaths.length === 0) return index;
    const db = getDb();
    // Dynamic IN-list — better-sqlite3 binds each ? positionally. Cheap because
    // the impact scorer only passes target_files + depends_on_files (typically
    // a handful of files per announce_work call).
    const placeholders = filePaths.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT DISTINCT file_path, agent_id FROM file_activity
       WHERE org_id = ?
         AND file_path IN (${placeholders})
         AND agent_id != ?
         AND created_at > datetime('now', '-' || ? || ' minutes')`
    ).all(orgId, ...filePaths, excludeAgentId, withinMinutes) as { file_path: string; agent_id: string }[];
    for (const r of rows) {
      let set = index.get(r.file_path);
      if (!set) { set = new Set(); index.set(r.file_path, set); }
      set.add(r.agent_id);
    }
    return index;
  }

  fileToModule(filePath: string): string {
    // Strip leading / so "/server/src/x.ts" and "server/src/x.ts" produce the
    // same module name. Without this, split("/") on an absolute path yields
    // ["", "server", "src", ...] and slice(0,2) gives "/server" instead of "server/src".
    const normalized = filePath.replace(/^\/+/, "");
    const parts = normalized.split("/");
    if (parts.length < 2 || parts[0] === "") return "";
    return parts.slice(0, 2).join("/");
  }
}
