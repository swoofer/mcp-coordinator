import type { AgentRegistry } from "./agent-registry.js";
import type { FileTracker } from "./file-tracker.js";
import type { Consultation } from "./consultation.js";
import type { WorkingFilesTracker } from "./working-files-tracker.js";
import { getDb } from "./database.js";
import { safeJsonParse } from "./json-utils.js";

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
  org_id: string;
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
      .listOnline(params.org_id)
      .filter((a) => a.id !== params.agent_id);

    if (onlineAgents.length === 0) return [];

    // O1: cache parsed agent.modules JSON ONCE per scoring call.
    // Previously each agent's modules were JSON.parse'd inside the hot path
    // (Layer 3), which is O(A) parses for A agents. With Layer 0 also reading
    // thread.target_files / depends_on_files per agent, the original code
    // re-parsed agent state up to ~4·A times per call.
    const moduleCache = new Map<string, string[]>();
    for (const a of onlineAgents) {
      moduleCache.set(
        a.id,
        safeJsonParse<string[]>(a.modules, [], undefined, "impact-scorer.score:agent.modules"),
      );
    }

    // O3: pre-compute file → set<agent_id> for every file we'll inspect.
    // Replaces N `checkFileConflict` calls (each = 1 SQL round-trip) with a
    // single batched query, and turns the inner per-agent file check into
    // an O(1) Set.has() lookup.
    const filesToIndex = [...params.target_files, ...(params.depends_on_files || [])];
    const fileToAgents =
      filesToIndex.length > 0
        ? this.fileTracker.getFileToAgentsIndex(
            params.org_id,
            filesToIndex,
            params.agent_id,
            FILE_ACTIVITY_WINDOW_MINUTES,
          )
        : new Map<string, Set<string>>();

    const inFlightToAgents = this.workingFiles
      ? this.workingFiles.getIndex(params.org_id, filesToIndex, params.agent_id)
      : new Map<string, Set<string>>();

    // Pre-load symbols_touched for the target_files × online_agents matrix once,
    // keyed by (file_path, agent_id). Avoids N*M DB roundtrips inside the score loop.
    let symbolsByFileAgent: Map<string, string[]> | null = null;
    if (
      params.target_symbols &&
      params.target_symbols.length > 0 &&
      params.target_files.length > 0
    ) {
      symbolsByFileAgent = this._collectSymbolsTouched(params.org_id, params.target_files);
    }

    // O4 (performance-11): Layer 4 (git co-change) was previously queried
    // inside the per-agent .map() — for each agent AND each target_file, a
    // fresh `_layer4Score` DB round-trip. That's O(agents × target_files)
    // queries per announce, even though the git_cochange half of the lookup
    // does not depend on the agent at all.
    //
    // Fix: hoist the git_cochange lookup out of the agent loop and run it
    // ONCE per target_file (not once per agent × target_file) — same exact
    // SQL, same row order, just deduplicated across agents. The per-row
    // "did the OTHER agent touch the partner file recently" check DOES
    // depend on the agent, so that's batched separately into a single
    // query covering every (partner file × recent activity) pair, then
    // consulted as an O(1) Set lookup inside the agent loop.
    const layer4CandidatesByFile = this._layer4Candidates(params.org_id, params.target_files);
    const layer4PartnerActivity = this._layer4PartnerActivity(
      params.org_id,
      layer4CandidatesByFile,
    );

    // O2: bound the resolved-thread query to a recency window. Without this,
    // listThreads({status:'resolved'}) returns ALL historical resolved threads
    // (unbounded growth). The Layer 0 filter only keeps threads where the
    // initiator is the currently-evaluated agent, but the SQL still scanned
    // every row before the JS filter ran. Since-bound at the SQL layer.
    let activeThreadsByAgent: Map<string, ThreadLike[]> | null = null;
    if (this.consultation) {
      const allActive = [
        ...this.consultation.listThreads(params.org_id, { status: "open" }),
        ...this.consultation.listThreads(params.org_id, { status: "resolving" }),
        ...this.consultation.listThreads(params.org_id, {
          status: "resolved",
          since_minutes: LAYER_0_WINDOW_MINUTES,
        }),
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
            const threadFiles: string[] = safeJsonParse<string[]>(
              thread.target_files,
              [],
              undefined,
              "impact-scorer.score:thread.target_files",
            );
            const threadDeps: string[] = safeJsonParse<string[]>(
              thread.depends_on_files,
              [],
              undefined,
              "impact-scorer.score:thread.depends_on_files",
            );

            // 0a: My target_files ∩ their target_files → score 100
            const fileOverlap = params.target_files.filter((f) => threadFiles.includes(f));
            if (fileOverlap.length > 0) {
              maxScore = Math.max(maxScore, 100);
              reasons.push(
                `announced same file: ${fileOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`,
              );
            }

            // 0b: My depends_on ∩ their target_files → score 80 (they modify what I depend on)
            if (params.depends_on_files) {
              const depOverlap = params.depends_on_files.filter((f) => threadFiles.includes(f));
              if (depOverlap.length > 0) {
                maxScore = Math.max(maxScore, 80);
                reasons.push(
                  `modifies my dependency: ${depOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`,
                );
              }
            }

            // 0c: My target_files ∩ their depends_on → score 80 (I modify what they depend on)
            const reverseDepOverlap = params.target_files.filter((f) => threadDeps.includes(f));
            if (reverseDepOverlap.length > 0) {
              maxScore = Math.max(maxScore, 80);
              reasons.push(
                `they depend on my target: ${reverseDepOverlap.join(", ")} (thread ${thread.id.slice(0, 8)})`,
              );
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
              const overlap = [...mine].some((s) => theirs.has(s));
              if (!overlap) {
                reasons.push(
                  `same file: ${targetFile}; disjoint symbols: you=[${[...mine].join(",")}], them=[${[...theirs].join(",")}] — verify shared module state`,
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
          (tm) => am === tm || am.startsWith(tm + "/") || tm.startsWith(am + "/"),
        ),
      );
      if (overlapping.length > 0) {
        maxScore = Math.max(maxScore, 30);
        reasons.push(`module overlap: ${overlapping.join(", ")}`);
      }

      // Layer 4: git co-change. For each target_file F, find rows in git_cochange where
      // (LEAST(F,partner), GREATEST(F,partner)) match. If the OTHER agent recently
      // touched the partner file, apply the co-change score.
      // (performance-11: candidates pre-computed once per target_file above;
      // partner activity pre-computed once per (partner, agent) pair. The
      // per-agent work here is now pure in-memory lookup — no DB round-trip.)
      for (const targetFile of params.target_files) {
        const candidates = layer4CandidatesByFile.get(targetFile);
        if (!candidates) continue;
        for (const c of candidates) {
          if (layer4PartnerActivity.has(`${c.partner}|${agent.id}`)) {
            maxScore = Math.max(maxScore, c.score);
            reasons.push(`co-change: ${targetFile} ↔ ${c.partner} (ratio ${c.ratio.toFixed(2)})`);
          }
        }
      }

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

  private _collectSymbolsTouched(orgId: string, files: string[]): Map<string, string[]> {
    const db = getDb();
    const placeholders = files.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT agent_id, file_path, symbols_touched
       FROM file_activity
       WHERE org_id = ?
         AND file_path IN (${placeholders})
         AND symbols_touched IS NOT NULL
         AND id IN (
           SELECT MAX(id) FROM file_activity
           WHERE org_id = ?
             AND file_path IN (${placeholders})
             AND symbols_touched IS NOT NULL
           GROUP BY agent_id, file_path
         )`,
      )
      .all(orgId, ...files, orgId, ...files) as Array<{
      agent_id: string;
      file_path: string;
      symbols_touched: string;
    }>;

    const result = new Map<string, string[]>();
    for (const r of rows) {
      try {
        const arr = JSON.parse(r.symbols_touched) as string[];
        result.set(`${r.file_path}|${r.agent_id}`, arr);
      } catch {
        /* malformed JSON: ignore */
      }
    }
    return result;
  }

  /**
   * performance-11: batched replacement for the old per-(agent, targetFile)
   * `_layer4Score` DB round-trip. Fetches git_cochange rows ONCE per
   * target_file (not once per agent × target_file) using the exact same SQL
   * predicate/order as the original per-call query, so the resulting row
   * order — and therefore the `reasons` ordering derived from it — is
   * unchanged. The agent-independent scoring math (ratio, threshold,
   * partner file) is computed here; the agent-dependent "did they touch the
   * partner file recently" check is deliberately left OUT of this method
   * (see `_layer4PartnerActivity`) since that's the only part of the
   * original query that actually needs the agent id.
   */
  private _layer4Candidates(
    orgId: string,
    targetFiles: string[],
  ): Map<string, Array<{ partner: string; score: number; ratio: number }>> {
    const db = getDb();
    const result = new Map<string, Array<{ partner: string; score: number; ratio: number }>>();
    for (const targetFile of targetFiles) {
      const rows = db
        .prepare(
          `SELECT file_a, file_b, count, total_commits FROM git_cochange
         WHERE org_id = ? AND (file_a = ? OR file_b = ?)`,
        )
        .all(orgId, targetFile, targetFile) as Array<{
        file_a: string;
        file_b: string;
        count: number;
        total_commits: number;
      }>;

      const candidates: Array<{ partner: string; score: number; ratio: number }> = [];
      for (const r of rows) {
        const partner = r.file_a === targetFile ? r.file_b : r.file_a;
        const ratio = r.count / Math.max(r.total_commits, 1);
        let layer4Score = 0;
        if (ratio > 0.5) layer4Score = 60;
        else if (ratio > 0.2) layer4Score = 40;
        if (layer4Score === 0) continue;
        candidates.push({ partner, score: layer4Score, ratio });
      }
      result.set(targetFile, candidates);
    }
    return result;
  }

  /**
   * performance-11: batches the "did agent X touch partner file Y in the
   * last 60 minutes" check that the original `_layer4Score` ran as one
   * query PER (candidate row × agent). Collects the distinct set of
   * partner files across all target_files' candidates and fetches all
   * matching (file_path, agent_id) recent-activity pairs in a single query,
   * returning a Set keyed by `${file_path}|${agent_id}` for O(1) lookup.
   */
  private _layer4PartnerActivity(
    orgId: string,
    candidatesByFile: Map<string, Array<{ partner: string; score: number; ratio: number }>>,
  ): Set<string> {
    const partners = new Set<string>();
    for (const candidates of candidatesByFile.values()) {
      for (const c of candidates) partners.add(c.partner);
    }
    if (partners.size === 0) return new Set();

    const db = getDb();
    const partnerList = [...partners];
    const placeholders = partnerList.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT DISTINCT file_path, agent_id FROM file_activity
       WHERE org_id = ? AND file_path IN (${placeholders})
         AND created_at > datetime('now', '-60 minutes')`,
      )
      .all(orgId, ...partnerList) as Array<{ file_path: string; agent_id: string }>;

    const result = new Set<string>();
    for (const r of rows) result.add(`${r.file_path}|${r.agent_id}`);
    return result;
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
