import type { AgentContext, ConsultationAnnounce } from "./types.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { Consultation } from "./consultation.js";
import type { FileTracker } from "./file-tracker.js";

export interface ContextProvider {
  getRelevantContext(
    orgId: string,
    agentId: string,
    query: ConsultationAnnounce
  ): AgentContext;
}

export class SummaryContextProvider implements ContextProvider {
  constructor(
    private registry: AgentRegistry,
    private consultation: Consultation,
    private fileTracker: FileTracker
  ) {}

  getRelevantContext(
    orgId: string,
    agentId: string,
    query: ConsultationAnnounce
  ): AgentContext {
    const agent = this.registry.get(orgId, agentId);
    if (!agent) {
      return { agent_id: agentId, modules: [], recent_files: [], action_summaries: [] };
    }

    const agentModules: string[] = JSON.parse(agent.modules);

    // Filter to only overlapping modules
    const overlapping = agentModules.filter((am) =>
      query.target_modules.some(
        (tm) => am === tm || am.startsWith(tm + "/") || tm.startsWith(am + "/")
      )
    );

    if (overlapping.length === 0) {
      return { agent_id: agentId, modules: [], recent_files: [], action_summaries: [] };
    }

    const summaries = this.consultation.getActionSummaries(orgId, agentId);

    // Get recent files from action summaries (agent writes these via MCP tool)
    const recentFiles = summaries
      .filter((s) => s.file_path)
      .map((s) => s.file_path!);

    return {
      agent_id: agentId,
      modules: overlapping,
      recent_files: [...new Set(recentFiles)],
      action_summaries: summaries,
    };
  }
}
