import type { AgentRegistry } from "./agent-registry.js";
import type { FileTracker } from "./file-tracker.js";
import type { Consultation } from "./consultation.js";
import type { WorkingFilesTracker } from "./working-files-tracker.js";
import { getDb } from "./database.js";

export interface ImpactScore {
  agent_id: string;
  agent_name: string;
  score: number;
  reasons: string[];
  reason: string; // primary (highest scoring)
}

export interface CategorizedImpact {
  concerned: ImpactScore[]; // score >= 90
  gray_zone: ImpactScore[]; // score 30-89
  pass: ImpactScore[]; // score < 30
}

interface AnnounceParams {
  agent_id: string;
  target_modules: string[];
  target_files: string[];
  depends_on_files?: string[];
  exports_affected?: string[];
  target_symbols?: string[];
}

// Layer 0 (announced-intent) recency window. Resolved threads older than this
// are excluded — yesterday's resolved work shouldn't trigger today's scoring.
// Aligned with file-tracker's default conflict window per the audit guidance.
const LAYER_0_WINDOW_MINUTES = 30;
// Layer 1 / 2 (file-activity) recency window. Preserved at 60 minutes to keep
// strict behavioral parity with the original scorer (the prior implementation
// hard-coded 60 in the checkFileConflict calls). Performance optimizations
// must not change scoring outcomes for existing callers.
const FILE_ACTIVITY_WINDOW_MINUTES = 60;

export class ImpactScorer {
  constructor(
    private registry: AgentRegistry,
    private fileTracker: FileTracker,
    private consultation?: Consultation,
    private workingFiles?: WorkingFilesTracker,
  ) {}

  score(params: AnnounceParams): ImpactScore[] {
    const onlineAgents = this.registry
      .listOnline()
      .filter((a) => a.id !== params.agent_id);

    if (onlineAgents.length === 0) return [];

    // O1: cache parsed agent.modules JSON ONCE per scoring call.
    // Previously each agent's modules were JSON.parse'd inside the hot path
    // (Layer 3), which is O(A) parses for A agents. With Layer 0 also reading
    // thread.target_files / depends_on_files per agent, the original code
    // re-parsed agent state up to ~4·A times per call.
    const moduleCache = new Map<string, string[]>();
    for (const a of onlineAgents) {
      moduleCache.set(a.id, JSON.parse(a.modules));
    }

    // O3: pre-compute file → set<agent_id> for every file we'll inspect.
    // Replaces N `checkFileConflict` calls (each = 1 SQL round-trip) with a
    // single batched query, and turns the inner per-agent file check into
    // an O(1) Set.has() lookup.
    const filesToIndex = [
      ...params.target_files,
      ...(params.depends_on_files || []),
    ];
    const fileToAgents = filesToIndex.length > 0
      ? this.fileTracker.getFileToAgentsIndex(filesToIndex, params.agent_id, FILE_ACTIVITY_WINDOW_MINUTES)
      : new Map<string, Set<string>>();

    const inFlightToAgents = this.workingFiles
      ? this.workingFiles.getIndex(filesToIndex, params.agent_id)
      : new Map<string, Set<string>>();

    // Pre-load symbols_touched for the target_files × online_agents matrix once,
    // keyed by (file_path, agent_id). Avoids N*M DB roundtrips inside the score loop.
    let symbolsByFileAgent: Map<string, string[]> | null = null;
    if (params.target_symbols && params.target_symbols.length > 0 && params.target_files.length > 0) {
      const db = getDb();
      const placeholders = params.target_files.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT agent_id, file_path, symbols_touched
         FROM file_activity
         WHERE file_path IN (${placeholders})
           AND symbols_touched IS NOT NULL
           AND id IN (
             SELECT MAX(id) FROM file_activity
             WHERE file_path IN (${placeholders})
               AND symbols_touched IS NOT NULL
             GROUP BY agent_id, file_path
           )`
      ).all(...params.target_files, ...params.target_files) as Array<{ agent_id: string; file_path: string; symbols_touched: string }>;

      symbolsByFileAgent = new Map();
      for (const r of rows) {
        try {
          const arr = JSON.parse(r.symbols_touched) as string[];
          symbolsByFileAgent.set(`${r.file_path}|${r.agent_id}`, arr);
        } catch { /* malformed JSON: ignore */ }
      }
    }

    // O2: bound the resolved-thread query to a recency window. Without this,
    // listThreads({status:'resolved'}) returns ALL historical resolved threads
    // (unbounded growth). The Layer 0 filter only keeps threads where the
    // initiator is the currently-evaluated agent, but the SQL still scanned
    // every row before the JS filter ran. Since-bound at the SQL layer.
    let activeThreadsByAgent: Map<string, ThreadLike[]> | null = null;
    if (this.consultation) {
      const allActive = [
        ...this.consultation.listThreads({ status: "open" }),
        ...this.consultation.listThreads({ status: "resolving" }),
        ...this.consultation.listThreads({ status: "resolved", since_minutes: LAYER_0_WINDOW_MINUTES }),
      ];
      // Group by initiator_id so the per-agent loop is O(threads-for-this-agent)
      // rather than O(all-active-threads). Avoids an outer-product scan over
      // (agents × threads) when both sets are large.
      activeThreadsByAgent = new Map();
      for (const t of allActive) {
        const list = activeThreadsByAgent.get(t.initiator_id);
        if (list) {
          list.push(t);
        } else {
          activeThreadsByAgent.set(t.initiator_id, [t]);
        }
      }
    }

    return onlineAgents.map((agent) => {
      const agentModules = moduleCache.get(agent.id)!;
      const reasons: string[] = [];
      let maxScore = 0;

      // Layer 0: Announced intent overlap (checks active threads from this agent).
      if (activeThreadsByAgent) {
        const agentThreads = activeThreadsByAgent.get(agent.id);
        if (agentThreads) {
          for (const thread of agentThreads) {
            const threadFiles: string[] = JSON.parse(thread.target_files || "[]");
            const threadDeps: string[] = JSON.parse(thread.depends_on_files || "[]");

            // 0a: My target_files ∩ their target_files → score 100
            const fileOverlap = params.target_files.filter((f) => threadFiles.includes(f));
            if (fileOverlap.length > 0) {
              maxScore = Math.max(maxScore, 100);
              reasons.push(`announced same file: ${fileOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`);
            }

            // 0b: My depends_on ∩ their target_files → score 80 (they modify what I depend on)
            if (params.depends_on_files) {
              const depOverlap = params.depends_on_files.filter((f) => threadFiles.includes(f));
              if (depOverlap.length > 0) {
                maxScore = Math.max(maxScore, 80);
                reasons.push(`modifies my dependency: ${depOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`);
              }
            }

            // 0c: My target_files ∩ their depends_on → score 80 (I modify what they depend on)
            const reverseDepOverlap = params.target_files.filter((f) => threadDeps.includes(f));
            if (reverseDepOverlap.length > 0) {
              maxScore = Math.max(maxScore, 80);
              reasons.push(`they depend on my target: ${reverseDepOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`);
            }
          }
        }
      }

      // Layer 1: Same file recently modified (file_activity) OR currently in flight (working_files).
      for (const targetFile of params.target_files) {
        const recentAgents = fileToAgents.get(targetFile);
        const inFlightAgents = inFlightToAgents.get(targetFile);
        if (recentAgents && recentAgents.has(agent.id)) {
          maxScore = Math.max(maxScore, 100);
          let annotated = false;
          if (params.target_symbols && params.target_symbols.length > 0) {
            const theirSymbols = symbolsByFileAgent?.get(`${targetFile}|${agent.id}`) || null;
            if (theirSymbols && theirSymbols.length > 0) {
              const mine = new Set(params.target_symbols);
              const theirs = new Set(theirSymbols);
              const overlap = [...mine].some(s => theirs.has(s));
              if (!overlap) {
                reasons.push(
                  `same file: ${targetFile}; disjoint symbols: you=[${[...mine].join(",")}], them=[${[...theirs].join(",")}] — verify shared module state`
                );
                annotated = true;
              }
            }
          }
          if (!annotated) {
            reasons.push(`same file (recent): ${targetFile}`);
          }
        }
        if (inFlightAgents && inFlightAgents.has(agent.id)) {
          maxScore = Math.max(maxScore, 100);
          reasons.push(`same file (in flight): ${targetFile}`);
        }
      }

      // Layer 2: Depends-on file recently modified (score 80)
      if (params.depends_on_files) {
        for (const depFile of params.depends_on_files) {
          const agentsForFile = fileToAgents.get(depFile);
          if (agentsForFile && agentsForFile.has(agent.id)) {
            maxScore = Math.max(maxScore, 80);
            reasons.push(`depends on: ${depFile}`);
          }
        }
      }

      // Layer 3: Module overlap (score 30)
      const overlapping = agentModules.filter((am) =>
        params.target_modules.some(
          (tm) => am === tm || am.startsWith(tm + "/") || tm.startsWith(am + "/")
        )
      );
      if (overlapping.length > 0) {
        maxScore = Math.max(maxScore, 30);
        reasons.push(`module overlap: ${overlapping.join(", ")}`);
      }

      // Layer 4 (future): Git co-change analysis
      // Score 60 for >50% co-change ratio, 40 for >20%
      // Requires git history analysis — not implemented in v3 prototype

      return {
        agent_id: agent.id,
        agent_name: agent.name,
        score: maxScore,
        reasons,
        reason: reasons[0] || "no link detected",
      };
    });
  }

  categorize(params: AnnounceParams): CategorizedImpact {
    const scores = this.score(params);
    return {
      concerned: scores.filter((s) => s.score >= 90),
      gray_zone: scores.filter((s) => s.score >= 30 && s.score < 90),
      pass: scores.filter((s) => s.score < 30),
    };
  }

  private getRecentSymbolsForFile(filePath: string, agentId: string): string[] | null {
    const db = getDb();
    const row = db.prepare(
      `SELECT symbols_touched FROM file_activity
       WHERE agent_id = ? AND file_path = ? AND symbols_touched IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    ).get(agentId, filePath) as { symbols_touched: string | null } | undefined;
    if (!row || !row.symbols_touched) return null;
    try { return JSON.parse(row.symbols_touched) as string[]; } catch { return null; }
  }
}

// Minimal structural type so the per-agent grouping doesn't depend on the
// Thread interface exported from types.ts (avoids import churn for a purely
// local helper).
interface ThreadLike {
  id: string;
  initiator_id: string;
  target_files: string | null;
  depends_on_files: string | null;
}
