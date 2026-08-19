import { silentLogger, type Logger } from "./logger.js";
import { safeJsonParse } from "./json-utils.js";
import type { ConflictReport } from "./types.js";
import type { Consultation } from "./consultation.js";
import type { DependencyMapper } from "./dependency-map.js";
import type { FileTracker } from "./file-tracker.js";

/**
 * How far back a RESOLVED thread still counts as a conflict.
 *
 * issue #300: `detect()` claimed in a comment to include "open, resolving, and
 * recently resolved (auto-quorum) threads" while actually calling
 * `listThreads(org, {})` — an empty filter, i.e. `SELECT * FROM threads WHERE
 * org_id = ?` with no recency bound at all. The window in the comment did not
 * exist. Every `announce_work` loaded every non-cancelled thread the org had
 * ever produced, so the cost of announcing grew with total history rather than
 * with recent activity.
 *
 * `listThreads` has had the mechanism all along — `since_minutes`, added for
 * exactly this reason (see its doc comment: "the impact scorer would scan
 * all-time resolved threads on every announce_work call"). The conflict
 * detector runs on that same call and was simply never wired to it.
 *
 * Deliberately its own constant rather than shared with the scorer's
 * LAYER_0_WINDOW_MINUTES, which happens to hold the same value today: they
 * answer different questions (how long a resolution keeps influencing a SCORE
 * vs. how long it keeps raising a CONFLICT), and tying them together would
 * make tuning one silently move the other.
 */
const RESOLVED_THREAD_CONFLICT_WINDOW_MINUTES = 30;
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
    org_id: string;
    agent_id: string;
    target_modules: string[];
    target_files: string[];
  }): ConflictReport[] {
    const conflicts: ConflictReport[] = [];
    // Open, resolving, and recently resolved (auto-quorum) threads — which is
    // every status except cancelled. Asking for the three explicitly, rather
    // than fetching everything and filtering cancelled out in memory, is what
    // lets the resolved leg carry a recency bound; the previous shape could
    // not express one. Same three-query pattern the impact scorer uses on this
    // very call (src/impact-scorer.ts).
    const activeThreads = [
      ...this.consultation.listThreads(params.org_id, { status: "open" }),
      ...this.consultation.listThreads(params.org_id, { status: "resolving" }),
      ...this.consultation.listThreads(params.org_id, {
        status: "resolved",
        since_minutes: RESOLVED_THREAD_CONFLICT_WINDOW_MINUTES,
      }),
    ];

    // #366: getModuleInfo + getBlastRadius used to run inside the thread loop,
    // so a 30-thread, 5-module announce_work made ~150 calls, each re-reading
    // dependency_map in full. Neither result depends on the thread being
    // examined, so both are computed once per target module here. Measured on
    // a 200-module map, that alone is the difference between ~1.5 s and a few
    // milliseconds on the hot path of announce_work.
    const moduleDeps = new Map<string, string[]>();
    const moduleDependents = new Map<string, string[]>();
    for (const targetModule of params.target_modules) {
      const info = this.depMap.getModuleInfo(params.org_id, targetModule);
      if (!info) continue;
      moduleDeps.set(targetModule, info.depends_on);
      const radius = this.depMap.getBlastRadius(params.org_id, targetModule);
      this.log.debug(
        {
          module_id: targetModule,
          direct_dependents: radius.direct_dependents,
          indirect_dependents: radius.indirect_dependents,
        },
        "Blast radius calculated",
      );
      moduleDependents.set(targetModule, [
        ...radius.direct_dependents,
        ...radius.indirect_dependents,
      ]);
    }

    for (const thread of activeThreads) {
      if (thread.initiator_id === params.agent_id) continue;

      const threadModules: string[] = safeJsonParse<string[]>(
        thread.target_modules,
        [],
        this.log,
        "conflict-detector.detect:target_modules",
      );
      const threadFiles: string[] = safeJsonParse<string[]>(
        thread.target_files,
        [],
        this.log,
        "conflict-detector.detect:target_files",
      );

      // 1. Module overlap
      const moduleOverlap = params.target_modules.filter((m) => threadModules.includes(m));
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
      const fileOverlap = params.target_files.filter((f) => threadFiles.includes(f));
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

      // 3. Dependency chain (both directions, from the hoisted maps above)
      for (const targetModule of params.target_modules) {
        for (const dep of moduleDeps.get(targetModule) ?? []) {
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
        for (const dependent of moduleDependents.get(targetModule) ?? []) {
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
    //
    // #366: this was one SELECT per target file. file-tracker.ts already ships
    // the batched form and documents it -- "Replaces N checkFileConflict calls
    // (one per file) with a single SQL query" -- but only the impact scorer had
    // been migrated onto it. Same window (60 minutes), same exclusion of the
    // announcing agent, one round trip.
    const fileToAgents = this.fileTracker.getFileToAgentsIndex(
      params.org_id,
      params.target_files,
      params.agent_id,
      60,
    );
    for (const targetFile of params.target_files) {
      for (const otherAgent of fileToAgents.get(targetFile) ?? []) {
        // Avoid duplicating with file_overlap already detected
        if (!conflicts.some((c) => c.agent_id === otherAgent && c.type === "file_overlap")) {
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

    if (conflicts.length > 0) {
      this.log.warn(
        {
          agent_id: params.agent_id,
          conflict_count: conflicts.length,
          types: [...new Set(conflicts.map((c) => c.type))],
          modules: params.target_modules,
        },
        "Conflicts detected",
      );
    }

    return conflicts;
  }
}
