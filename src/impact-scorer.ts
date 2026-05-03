import type { AgentRegistry } from "./agent-registry.js";
import type { FileTracker } from "./file-tracker.js";
import type { Consultation } from "./consultation.js";

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
}

export class ImpactScorer {
  constructor(
    private registry: AgentRegistry,
    private fileTracker: FileTracker,
    private consultation?: Consultation
  ) {}

  score(params: AnnounceParams): ImpactScore[] {
    const onlineAgents = this.registry
      .listOnline()
      .filter((a) => a.id !== params.agent_id);

    return onlineAgents.map((agent) => {
      const agentModules: string[] = JSON.parse(agent.modules);
      const reasons: string[] = [];
      let maxScore = 0;

      // Layer 0: Announced intent overlap (checks active threads from this agent).
      // Resolved threads older than LAYER_0_RESOLVED_WINDOW_MS are excluded —
      // yesterday's resolved work shouldn't trigger today's scoring.
      if (this.consultation) {
        const LAYER_0_RESOLVED_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
        const now = Date.now();
        // SQLite datetime('now') returns UTC without a TZ suffix. new Date(str)
        // parses it as local time by default — causing a local-offset skew.
        // Normalize by treating the space as T and appending Z.
        const parseSqliteUtc = (s: string): number => {
          const iso = /[Tt]/.test(s) ? s : s.replace(" ", "T");
          return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + "Z").getTime();
        };
        const activeThreads = [
          ...this.consultation.listThreads({ status: "open" }),
          ...this.consultation.listThreads({ status: "resolving" }),
          ...this.consultation
            .listThreads({ status: "resolved" })
            .filter((t) => {
              if (!t.resolved_at) return true;
              const resolvedAt = parseSqliteUtc(t.resolved_at);
              return !isNaN(resolvedAt) && now - resolvedAt <= LAYER_0_RESOLVED_WINDOW_MS;
            }),
        ].filter((t) => t.initiator_id === agent.id);

        for (const thread of activeThreads) {
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

      // Layer 1: Same file recently modified (score 100)
      for (const targetFile of params.target_files) {
        const conflict = this.fileTracker.checkFileConflict(
          targetFile,
          params.agent_id,
          60
        );
        if (conflict.agents.includes(agent.id)) {
          maxScore = Math.max(maxScore, 100);
          reasons.push(`same file: ${targetFile}`);
        }
      }

      // Layer 2: Depends-on file recently modified (score 80)
      if (params.depends_on_files) {
        for (const depFile of params.depends_on_files) {
          const conflict = this.fileTracker.checkFileConflict(
            depFile,
            params.agent_id,
            60
          );
          if (conflict.agents.includes(agent.id)) {
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
}
