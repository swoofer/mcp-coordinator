import { getDb } from "./database.js";
import { withTransaction } from "./db-adapter.js";
import { safeJsonParse } from "./json-utils.js";
import type { ModuleInfo, DependencyMap, BlastRadius, Thread } from "./types.js";

export class DependencyMapper {
  /**
   * Set a single module's dependencies, scoped by org_id.
   * After Task 5.5, dependency_map PK is (org_id, module_id). Composite conflict target.
   */
  setDependencies(orgId: string, moduleId: string, params: { depends_on: string[]; exports: string[]; owners: string[] }): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO dependency_map (org_id, module_id, depends_on, exports, owners) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, module_id) DO UPDATE SET
         depends_on = excluded.depends_on,
         exports = excluded.exports,
         owners = excluded.owners`
    ).run(orgId, moduleId, JSON.stringify(params.depends_on), JSON.stringify(params.exports), JSON.stringify(params.owners));
  }

  /**
   * Get a single module's dependencies, scoped by org_id.
   */
  getDependencies(orgId: string, moduleId: string): { depends_on: string[]; exports: string[]; owners: string[] } | null {
    const db = getDb();
    const row = db.prepare(
      "SELECT depends_on, exports, owners FROM dependency_map WHERE org_id = ? AND module_id = ?"
    ).get(orgId, moduleId) as { depends_on: string; exports: string; owners: string } | undefined;
    if (!row) return null;
    return {
      depends_on: safeJsonParse<string[]>(row.depends_on, [], undefined, "dependency-map.getDependencies:depends_on"),
      exports: safeJsonParse<string[]>(row.exports, [], undefined, "dependency-map.getDependencies:exports"),
      owners: safeJsonParse<string[]>(row.owners, [], undefined, "dependency-map.getDependencies:owners"),
    };
  }

  /**
   * List all owners in an org's dependency map.
   */
  listOwners(orgId: string): string[] {
    const db = getDb();
    const rows = db.prepare(
      "SELECT owners FROM dependency_map WHERE org_id = ?"
    ).all(orgId) as { owners: string }[];
    const all = new Set<string>();
    for (const r of rows) {
      safeJsonParse<string[]>(r.owners, [], undefined, "dependency-map.listOwners:owners").forEach((o) => all.add(o));
    }
    return Array.from(all);
  }

  // Bulk-shaped helpers (org-scoped)

  getMap(orgId: string): DependencyMap {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM dependency_map WHERE org_id = ?").all(orgId) as {
      org_id: string; module_id: string; depends_on: string; exports: string; owners: string;
    }[];
    const map: DependencyMap = {};
    for (const row of rows) {
      map[row.module_id] = {
        module_id: row.module_id,
        depends_on: safeJsonParse<string[]>(row.depends_on, [], undefined, "dependency-map.getMap:depends_on"),
        exports: safeJsonParse<string[]>(row.exports, [], undefined, "dependency-map.getMap:exports"),
        owners: safeJsonParse<string[]>(row.owners, [], undefined, "dependency-map.getMap:owners"),
      };
    }
    return map;
  }

  setMap(orgId: string, map: DependencyMap): void {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO dependency_map (org_id, module_id, depends_on, exports, owners)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, module_id) DO UPDATE SET
         depends_on = excluded.depends_on, exports = excluded.exports, owners = excluded.owners`
    );
    withTransaction(db, () => {
      for (const [id, info] of Object.entries(map)) {
        stmt.run(orgId, id, JSON.stringify(info.depends_on), JSON.stringify(info.exports), JSON.stringify(info.owners));
      }
    });
  }

  getModuleInfo(orgId: string, moduleId: string): ModuleInfo | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM dependency_map WHERE org_id = ? AND module_id = ?").get(orgId, moduleId) as {
      module_id: string; depends_on: string; exports: string; owners: string;
    } | undefined;
    if (!row) return null;
    return {
      module_id: row.module_id,
      depends_on: safeJsonParse<string[]>(row.depends_on, [], undefined, "dependency-map.getModuleInfo:depends_on"),
      exports: safeJsonParse<string[]>(row.exports, [], undefined, "dependency-map.getModuleInfo:exports"),
      owners: safeJsonParse<string[]>(row.owners, [], undefined, "dependency-map.getModuleInfo:owners"),
    };
  }

  getBlastRadius(orgId: string, moduleId: string): BlastRadius {
    const map = this.getMap(orgId);
    const direct: string[] = [];
    const indirect: string[] = [];
    const visited = new Set<string>();

    for (const [id, info] of Object.entries(map)) {
      if (info.depends_on.includes(moduleId)) direct.push(id);
    }

    const queue = [...direct];
    visited.add(moduleId);
    for (const d of direct) visited.add(d);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const [id, info] of Object.entries(map)) {
        if (!visited.has(id) && info.depends_on.includes(current)) {
          indirect.push(id);
          visited.add(id);
          queue.push(id);
        }
      }
    }

    const moduleInfo = map[moduleId];
    const affectedExports = moduleInfo ? moduleInfo.exports : [];
    const activeThreadsInRadius: Thread[] = [];

    return {
      module_id: moduleId,
      direct_dependents: direct,
      indirect_dependents: indirect,
      affected_exports: affectedExports,
      active_threads_in_radius: activeThreadsInRadius,
    };
  }
}
