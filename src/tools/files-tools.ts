import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";

/**
 * S1: file tracking MCP tools (3 tools).
 * hot_files, get_session_files, check_file_conflict.
 */
export function registerFilesTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { fileTracker } = services;

  server.tool("hot_files", "List files modified by multiple agents", {
    since_minutes: z.number().optional(),
  }, async ({ since_minutes }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    const files = fileTracker.getHotFiles(claims.org, since_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("get_session_files", "Get files modified in a session", {
    session_id: z.string(),
  }, async ({ session_id }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    const files = fileTracker.getBySession(claims.org, session_id);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("check_file_conflict", "Check if another agent is editing a file", {
    file_path: z.string().describe("Repo-relative file path."),
    agent_id: z.string(),
    within_minutes: z.number().optional(),
  }, async ({ file_path, agent_id, within_minutes }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    const result = fileTracker.checkFileConflict(claims.org, file_path, agent_id, within_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}
