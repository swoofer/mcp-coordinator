import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";

/**
 * S1: dependency map MCP tools (3 tools).
 * set_dependency_map, get_blast_radius, get_module_info.
 */
export function registerDependenciesTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
): void {
  const { depMap } = services;

  server.tool("set_dependency_map", "Load module dependency graph", {
    modules: z.string(), // JSON DependencyMap
  }, async ({ modules }) => {
    const map = JSON.parse(modules);
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    depMap.setMap("default", map);
    return { content: [{ type: "text", text: "ok" }] };
  });

  server.tool("get_blast_radius", "Calculate impact of changes to a module", {
    module_id: z.string(),
  }, async ({ module_id }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const radius = depMap.getBlastRadius("default", module_id);
    return { content: [{ type: "text", text: JSON.stringify(radius) }] };
  });

  server.tool("get_module_info", "Get module dependency info", {
    module_id: z.string(),
  }, async ({ module_id }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const info = depMap.getModuleInfo("default", module_id);
    return { content: [{ type: "text", text: JSON.stringify(info) }] };
  });
}
