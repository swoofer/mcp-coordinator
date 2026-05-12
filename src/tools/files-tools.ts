import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";

/**
 * S1: file tracking MCP tools (3 tools).
 * hot_files, get_session_files, check_file_conflict.
 */
export function registerFilesTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
): void {
  const { fileTracker } = services;

  server.tool("hot_files", "List files modified by multiple agents", {
    since_minutes: z.number().optional(),
  }, async ({ since_minutes }) => {
    const files = fileTracker.getHotFiles(since_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("get_session_files", "Get files modified in a session", {
    session_id: z.string(),
  }, async ({ session_id }) => {
    const files = fileTracker.getBySession(session_id);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("check_file_conflict", "Check if another agent is editing a file", {
    file_path: z.string().describe("Repo-relative file path."),
    agent_id: z.string(),
    within_minutes: z.number().optional(),
  }, async ({ file_path, agent_id, within_minutes }) => {
    const result = fileTracker.checkFileConflict(file_path, agent_id, within_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}
