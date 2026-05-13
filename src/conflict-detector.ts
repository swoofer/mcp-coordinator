import { silentLogger, type Logger } from "./logger.js";
import type { ConflictReport } from "./types.js";
import type { Consultation } from "./consultation.js";
import type { DependencyMapper } from "./dependency-map.js";
import type { FileTracker } from "./file-tracker.js";

export class ConflictDetector {
  private log: Logger;

  constructor(
    private consultation: Consultation,
    private depMap: DependencyMapper,
    private fileTracker: FileTracker,
    logger?: Logger,
  ) {
    this.log = logger || silentLogger;
  }

  detect(params: {
    org_id?: string;
    agent_id: string;
    target_modules: string[];
    target_files: string[];
  }): ConflictReport[] {
    const conflicts: ConflictReport[] = [];
    // Include open, resolving, and recently resolved (auto-quorum) threads — exclude only cancelled
    const allThreads = this.consultation.listThreads({});
    const activeThreads = allThreads.filter((t) => t.status !== "cancelled");

    for (const thread of activeThreads) {
      if (thread.initiator_id === params.agent_id) continue;

      const threadModules: string[] = JSON.parse(thread.target_modules);
      const threadFiles: string[] = JSON.parse(thread.target_files);

      // 1. Module overlap
      const moduleOverlap = params.target_modules.filter((m) =>
        threadModules.includes(m)
      );
      if (moduleOverlap.length > 0) {
        conflicts.push({
          type: "module_overlap",
          severity: "warning",
          agent_id: thread.initiator_id,
          agent_name: thread.subject,
          description: `Module overlap on: ${moduleOverlap.join(", ")}`,
          details: `Thread "${thread.subject}" (${thread.initiator_id}) targets same modules`,
        });
      }

      // 2. File overlap
      const fileOverlap = params.target_files.filter((f) =>
        threadFiles.includes(f)
      );
      if (fileOverlap.length > 0) {
        conflicts.push({
          type: "file_overlap",
          severity: "warning",
          agent_id: thread.initiator_id,
          agent_name: thread.subject,
          description: `File overlap on: ${fileOverlap.join(", ")}`,
          details: `Thread "${thread.subject}" (${thread.initiator_id}) targets same files`,
        });
      }

      // 3. Dependency chain
      for (const targetModule of params.target_modules) {
        const info = this.depMap.getModuleInfo(targetModule);
        if (!info) continue;
        for (const dep of info.depends_on) {
          if (threadModules.includes(dep)) {
            conflicts.push({
              type: "dependency_chain",
              severity: "info",
              agent_id: thread.initiator_id,
              agent_name: thread.subject,
              description: `${targetModule} depends on ${dep} which is being modified`,
              details: `Thread "${thread.subject}" modifies ${dep}, a dependency of ${targetModule}`,
            });
          }
        }
        // Reverse: someone depends on what we're modifying
        const radius = this.depMap.getBlastRadius(targetModule);
        this.log.debug({
          module_id: targetModule,
          direct_dependents: radius.direct_dependents,
          indirect_dependents: radius.indirect_dependents,
        }, "Blast radius calculated");
        for (const dependent of [...radius.direct_dependents, ...radius.indirect_dependents]) {
          if (threadModules.includes(dependent)) {
            conflicts.push({
              type: "dependency_chain",
              severity: "info",
              agent_id: thread.initiator_id,
              agent_name: thread.subject,
              description: `${dependent} depends on ${targetModule} which you are modifying`,
              details: `Thread "${thread.subject}" works on ${dependent}, which depends on ${targetModule}`,
            });
          }
        }
      }
    }

    // 4. Hot file overlap (from actual file activity, not just declared files)
    // TODO(Task 19d): org_id defaults to 'default' for conflict-detector callers that don't yet pass it
    const orgId = params.org_id ?? "default";
    for (const targetFile of params.target_files) {
      const activity = this.fileTracker.checkFileConflict(orgId, targetFile, params.agent_id, 60);
      if (activity.conflict) {
        for (const otherAgent of activity.agents) {
          // Avoid duplicating with file_overlap already detected
          if (!conflicts.some(c => c.agent_id === otherAgent && c.type === "file_overlap")) {
            conflicts.push({
              type: "file_overlap",
              severity: "warning",
              agent_id: otherAgent,
              agent_name: otherAgent,
              description: `Hot file: ${targetFile} recently edited by ${otherAgent}`,
              details: `File activity shows ${targetFile} was recently modified by ${otherAgent}`,
            });
          }
        }
      }
    }

    if (conflicts.length > 0) {
      this.log.warn({
        agent_id: params.agent_id,
        conflict_count: conflicts.length,
        types: [...new Set(conflicts.map(c => c.type))],
        modules: params.target_modules,
      }, "Conflicts detected");
    }

    return conflicts;
  }
}
