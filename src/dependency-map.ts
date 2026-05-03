import { getDb } from "./database.js";
import type { ModuleInfo, DependencyMap, BlastRadius, Thread } from "./types.js";

export class DependencyMapper {
  getMap(): DependencyMap {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM dependency_map").all() as {
      module_id: string; depends_on: string; exports: string; owners: string;
    }[];
    const map: DependencyMap = {};
    for (const row of rows) {
      map[row.module_id] = {
        module_id: row.module_id,
        depends_on: JSON.parse(row.depends_on),
        exports: JSON.parse(row.exports),
        owners: JSON.parse(row.owners),
      };
    }
    return map;
  }

  setMap(map: DependencyMap): void {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO dependency_map (module_id, depends_on, exports, owners)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(module_id) DO UPDATE SET
         depends_on = excluded.depends_on, exports = excluded.exports, owners = excluded.owners`
    );
    const tx = db.transaction(() => {
      for (const [id, info] of Object.entries(map)) {
        stmt.run(id, JSON.stringify(info.depends_on), JSON.stringify(info.exports), JSON.stringify(info.owners));
      }
    });
    tx();
  }

  getModuleInfo(moduleId: string): ModuleInfo | null {
    const db = getDb();
    const row = db.prepare("SELECT * FROM dependency_map WHERE module_id = ?").get(moduleId) as {
      module_id: string; depends_on: string; exports: string; owners: string;
    } | undefined;
    if (!row) return null;
    return {
      module_id: row.module_id,
      depends_on: JSON.parse(row.depends_on),
      exports: JSON.parse(row.exports),
      owners: JSON.parse(row.owners),
    };
  }

  getBlastRadius(moduleId: string): BlastRadius {
    const map = this.getMap();
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
