import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";
import { runRegisterFlow } from "../register-workflow.js";

import { missingClaimsError } from "./tool-errors.js";

/**
 * S1: agent registry MCP tools (4 tools).
 * register_agent, list_agents, heartbeat, agent_activity.
 */
export function registerAgentTools(
  server: McpServer,
  services: CoordinatorServices,
  mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { registry, activityTracker, sseEmitter } = services;

  server.tool(
    "register_agent",
    "Register agent as online with module list",
    {
      agent_id: z
        .string()
        .describe(
          "ID for this agent. Must be unique across ALL orgs, not just yours — re-registering an id another org already holds is rejected.",
        ),
      name: z.string().describe("Display name for this agent."),
      modules: z
        .array(z.string())
        .describe("Module IDs (as used in the dependency map) this agent owns/works on."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Register agent" },
    async ({ agent_id, name, modules }, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info(
        { tool: "register_agent", agent_id, name, module_count: modules.length },
        "Tool called",
      );
      // architecture-07: shared flow with REST /api/register (registry.register +
      // sseEmitter "agent_online" + mqttBridge.registerAgent retained-status publish).
      const agent = runRegisterFlow(services, claims.org, agent_id, name, modules);
      return { content: [{ type: "text", text: JSON.stringify(agent) }] };
    },
  );

  server.tool(
    "list_agents",
    "List registered agents",
    {
      online_only: z
        .boolean()
        .optional()
        .describe("If true, only return agents currently marked online."),
    },
    { readOnlyHint: true, title: "List agents" },
    async ({ online_only }, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const agents = online_only ? registry.listOnline(claims.org) : registry.listAll(claims.org);
      return { content: [{ type: "text", text: JSON.stringify(agents) }] };
    },
  );

  server.tool(
    "heartbeat",
    "Update agent activity status and last seen timestamp",
    {
      agent_id: z.string().describe("ID of the agent sending the heartbeat."),
      current_file: z
        .string()
        .optional()
        .describe("Repo-relative path of the file the agent is currently working on, if any."),
      current_thread: z
        .string()
        .optional()
        .describe("Thread ID the agent is currently engaged in, if any."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Heartbeat" },
    async ({ agent_id, current_file, current_thread }, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      registry.heartbeat(claims.org, agent_id);
      activityTracker.heartbeat(claims.org, agent_id, {
        currentFile: current_file || null,
        currentThread: current_thread || null,
      });
      const activity = activityTracker.getActivity(claims.org, agent_id);
      sseEmitter.emit(
        "agent_activity",
        {
          agent_id,
          activity_status: activity.activity_status,
          current_file: activity.current_file,
          current_thread: activity.current_thread,
        },
        { org_id: claims.org },
      );
      return { content: [{ type: "text", text: JSON.stringify(activity) }] };
    },
  );

  server.tool(
    "agent_activity",
    "Get activity status for all online agents",
    {},
    { readOnlyHint: true, title: "Get agent activity" },
    async (_args, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const activities = activityTracker.listAll(claims.org, { idleAfterMinutes: 5 });
      return { content: [{ type: "text", text: JSON.stringify(activities) }] };
    },
  );
}
