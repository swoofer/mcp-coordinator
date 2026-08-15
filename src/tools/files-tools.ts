import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";

import { missingClaimsError } from "./tool-errors.js";

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

  server.registerTool(
    "hot_files",
    {
      description: "List files modified by multiple agents",
      inputSchema: z.object({
        since_minutes: z
          .number()
          .optional()
          .describe("Look-back window in minutes. Defaults to 30."),
      }),
      annotations: { readOnlyHint: true, title: "List hot files" },
    },
    async ({ since_minutes }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const files = fileTracker.getHotFiles(claims.org, since_minutes || 30);
      return { content: [{ type: "text", text: JSON.stringify(files) }] };
    },
  );

  server.registerTool(
    "get_session_files",
    {
      description: "Get files modified in a session",
      inputSchema: z.object({
        session_id: z.string().describe("Session ID to look up file activity for."),
      }),
      annotations: { readOnlyHint: true, title: "Get session files" },
    },
    async ({ session_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const files = fileTracker.getBySession(claims.org, session_id);
      return { content: [{ type: "text", text: JSON.stringify(files) }] };
    },
  );

  server.registerTool(
    "check_file_conflict",
    {
      description: "Check if another agent is editing a file",
      inputSchema: z.object({
        file_path: z.string().describe("Repo-relative file path."),
        agent_id: z
          .string()
          .describe("ID of the agent checking for conflicts (excluded from the match)."),
        within_minutes: z
          .number()
          .optional()
          .describe("Look-back window in minutes. Defaults to 30."),
      }),
      annotations: { readOnlyHint: true, title: "Check file conflict" },
    },
    async ({ file_path, agent_id, within_minutes }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const result = fileTracker.checkFileConflict(
        claims.org,
        file_path,
        agent_id,
        within_minutes || 30,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
