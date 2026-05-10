import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";

/**
 * S1: agent registry MCP tools (4 tools).
 * register_agent, list_agents, heartbeat, agent_activity.
 */
export function registerAgentTools(
  server: McpServer,
  services: CoordinatorServices,
  mcpLog: Logger,
): void {
  const { registry, activityTracker, sseEmitter, mqttBridge } = services;

  server.tool("register_agent", "Register agent as online with module list", {
    agent_id: z.string(),
    name: z.string(),
    modules: z.array(z.string()),
  }, async ({ agent_id, name, modules }) => {
    mcpLog.info({ tool: "register_agent", agent_id, name, module_count: modules.length }, "Tool called");
    const agent = registry.register(agent_id, name, modules);
    sseEmitter.emit("agent_online", { agent_id, name, modules });
    mqttBridge.registerAgent(agent_id, name);
    return { content: [{ type: "text", text: JSON.stringify(agent) }] };
  });

  server.tool("list_agents", "List registered agents", {
    online_only: z.boolean().optional(),
  }, async ({ online_only }) => {
    const agents = online_only ? registry.listOnline() : registry.listAll();
    return { content: [{ type: "text", text: JSON.stringify(agents) }] };
  });

  server.tool("heartbeat", "Update agent activity status and last seen timestamp", {
    agent_id: z.string(),
    current_file: z.string().optional(),
    current_thread: z.string().optional(),
  }, async ({ agent_id, current_file, current_thread }) => {
    registry.heartbeat(agent_id);
    activityTracker.heartbeat(agent_id, {
      currentFile: current_file || null,
      currentThread: current_thread || null,
    });
    const activity = activityTracker.getActivity(agent_id);
    sseEmitter.emit("agent_activity", {
      agent_id, activity_status: activity.activity_status,
      current_file: activity.current_file, current_thread: activity.current_thread,
    });
    return { content: [{ type: "text", text: JSON.stringify(activity) }] };
  });

  server.tool("agent_activity", "Get activity status for all online agents", {}, async () => {
    const activities = activityTracker.listAll({ idleAfterMinutes: 5 });
    return { content: [{ type: "text", text: JSON.stringify(activities) }] };
  });
}
