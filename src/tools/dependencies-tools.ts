import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";
import type { DependencyMap } from "../types.js";

import { missingClaimsError } from "./tool-errors.js";

/**
 * S1: dependency map MCP tools (3 tools).
 * set_dependency_map, get_blast_radius, get_module_info.
 */
export function registerDependenciesTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { depMap } = services;

  server.registerTool(
    "set_dependency_map",
    {
      description: "Load module dependency graph",
      inputSchema: z.object({
        modules: z
          .string()
          .describe(
            "JSON-encoded DependencyMap: a JSON object string mapping module_id -> " +
              "{ depends_on: string[], exports: string[], owners: string[] }. " +
              'Example: \'{"src/foo.ts":{"depends_on":[],"exports":["Foo"],"owners":["alice"]}}\'.',
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, title: "Set dependency map" },
    },
    async ({ modules }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError(ctx.sessionId);

      let parsed: unknown;
      try {
        parsed = JSON.parse(modules);
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `Invalid JSON in "modules" param (${err instanceof Error ? err.message : String(err)}). ` +
                `Expected a JSON-encoded object mapping module_id -> { depends_on: string[], exports: string[], owners: string[] }, ` +
                `e.g. '{"src/foo.ts":{"depends_on":[],"exports":["Foo"],"owners":["alice"]}}'.`,
            },
          ],
        };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `"modules" must decode to a JSON object mapping module_id -> module info, got ${Array.isArray(parsed) ? "an array" : typeof parsed}. ` +
                `Expected shape: { depends_on: string[], exports: string[], owners: string[] } per module_id.`,
            },
          ],
        };
      }

      depMap.setMap(claims.org, parsed as DependencyMap);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "get_blast_radius",
    {
      description: "Calculate impact of changes to a module",
      inputSchema: z.object({
        module_id: z
          .string()
          .describe("Module ID to compute the blast radius for (as used in the dependency map)."),
      }),
      annotations: { readOnlyHint: true, title: "Get blast radius" },
    },
    async ({ module_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError(ctx.sessionId);
      const radius = depMap.getBlastRadius(claims.org, module_id);
      return { content: [{ type: "text", text: JSON.stringify(radius) }] };
    },
  );

  server.registerTool(
    "get_module_info",
    {
      description: "Get module dependency info",
      inputSchema: z.object({
        module_id: z.string().describe("Module ID to look up (as used in the dependency map)."),
      }),
      annotations: { readOnlyHint: true, title: "Get module info" },
    },
    async ({ module_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError(ctx.sessionId);
      const info = depMap.getModuleInfo(claims.org, module_id);
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  );
}
