import type { ActionSummary, AgentContext, ConsultationAnnounce } from "./types.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { Consultation } from "./consultation.js";
import type { FileTracker } from "./file-tracker.js";
import { safeJsonParse } from "./json-utils.js";

export interface ContextProvider {
  getRelevantContext(orgId: string, agentId: string, query: ConsultationAnnounce): AgentContext;
}

/**
 * log_action_summary documents `summary` as a one-liner and neither transport
 * constrains it, so an agent can put a page of text in one. Bounding it here
 * rather than at ingest is deliberate: the size problem is on the way *out*
 * (this value is copied to every concerned peer), and a `.max()` at the tool
 * boundary would newly reject payloads both transports accept today -- the
 * same rétro-compat reasoning as the architecture-15 note in rest-schemas.ts.
 */
const MAX_SUMMARY_CHARS = 300;

function truncateSummary(s: ActionSummary): ActionSummary {
  if (s.summary.length <= MAX_SUMMARY_CHARS) return s;
  return { ...s, summary: `${s.summary.slice(0, MAX_SUMMARY_CHARS)}…(truncated)` };
}

export class SummaryContextProvider implements ContextProvider {
  constructor(
    private registry: AgentRegistry,
    private consultation: Consultation,
    private fileTracker: FileTracker,
  ) {}

  getRelevantContext(orgId: string, agentId: string, query: ConsultationAnnounce): AgentContext {
    const agent = this.registry.get(orgId, agentId);
    if (!agent) {
      return { agent_id: agentId, modules: [], recent_files: [], action_summaries: [] };
    }

    const agentModules: string[] = safeJsonParse<string[]>(
      agent.modules,
      [],
      undefined,
      "context-provider.getRelevantContext:agent.modules",
    );

    // Filter to only overlapping modules
    const overlapping = agentModules.filter((am) =>
      query.target_modules.some(
        (tm) => am === tm || am.startsWith(tm + "/") || tm.startsWith(am + "/"),
      ),
    );

    if (overlapping.length === 0) {
      return { agent_id: agentId, modules: [], recent_files: [], action_summaries: [] };
    }

    // Bounded by getActionSummaries' own default (#361). This value goes into
    // the announce_work response once per concerned peer, so an unbounded read
    // here is multiplied by the number of peers.
    const summaries = this.consultation.getActionSummaries(orgId, agentId);

    // Get recent files from action summaries (agent writes these via MCP tool)
    const recentFiles = summaries.filter((s) => s.file_path).map((s) => s.file_path!);

    return {
      agent_id: agentId,
      modules: overlapping,
      recent_files: [...new Set(recentFiles)],
      action_summaries: summaries.map(truncateSummary),
    };
  }
}
