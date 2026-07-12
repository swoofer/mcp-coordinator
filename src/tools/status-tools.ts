import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";
import { safeJsonParse } from "../json-utils.js";

/**
 * S1: status + coordination helper MCP tools (2 tools).
 * coordinator_status, wait_for_peers.
 *
 * Note (Task 23.5): both tools are org-scoped — coordinator_status reports
 * agents/threads/files for the caller's org, and wait_for_peers polls the
 * same org's registry. Neither surfaces system-global (cross-org) data, so
 * both require valid claims and use claims.org throughout.
 */
/**
 * protocole-mcp-14: wait_for_peers has no upper bound on the caller-supplied
 * timeout_seconds, so a misbehaving/careless caller can request an
 * effectively unbounded block. Cap it so the tool always returns.
 */
export const MAX_WAIT_TIMEOUT_SECONDS = 300;

export function registerStatusTools(
  server: McpServer,
  services: CoordinatorServices,
  mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { registry, consultation, fileTracker, mqttBridge } = services;

  server.tool(
    "coordinator_status",
    "Full system status",
    {},
    { readOnlyHint: true, title: "Coordinator status" },
    async (_args, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw new Error("Session has no captured claims (auth bug)");
      const online = registry.listOnline(claims.org);
      const openThreads = consultation.listThreads(claims.org, { status: "open" });
      const resolvingThreads = consultation.listThreads(claims.org, { status: "resolving" });
      const hotFiles = fileTracker.getHotFiles(claims.org, 30);
      const status = {
        agents_online: online.length,
        agents: online.map((a) => ({
          id: a.id,
          name: a.name,
          modules: safeJsonParse<string[]>(
            a.modules,
            [],
            mcpLog,
            "status-tools.coordinator_status:agent.modules",
          ),
        })),
        open_threads: openThreads.length,
        resolving_threads: resolvingThreads.length,
        hot_files: hotFiles.length,
        mqtt_connected: mqttBridge.isConnected(),
      };
      mcpLog.debug(
        {
          tool: "coordinator_status",
          agents_online: online.length,
          open_threads: openThreads.length,
        },
        "Tool called",
      );
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    },
  );

  server.tool(
    "wait_for_peers",
    "Block until at least N other online agents are registered, or timeout. Use before the first announce_work to avoid the race where one agent announces before peers have booted.",
    {
      agent_id: z
        .string()
        .describe("ID of the agent waiting for peers (excluded from the peer count)."),
      min_peers: z
        .number()
        .optional()
        .describe("Minimum number of other online agents to wait for. Defaults to 1."),
      timeout_seconds: z
        .number()
        .optional()
        .describe(
          `How long to block, in seconds. Defaults to 30, capped at ${MAX_WAIT_TIMEOUT_SECONDS}.`,
        ),
    },
    { readOnlyHint: true, title: "Wait for peers" },
    async ({ agent_id, min_peers, timeout_seconds }, extra) => {
      const claims = getSessionClaims(extra.sessionId ?? "");
      if (!claims) throw new Error("Session has no captured claims (auth bug)");
      const targetPeers = min_peers ?? 1;
      const cappedSeconds = Math.min(timeout_seconds ?? 30, MAX_WAIT_TIMEOUT_SECONDS);
      const timeoutMs = cappedSeconds * 1000;
      const pollIntervalMs = 1000;
      const startedAt = Date.now();
      mcpLog.info(
        {
          tool: "wait_for_peers",
          agent_id,
          min_peers: targetPeers,
          timeout_seconds: timeoutMs / 1000,
        },
        "Tool called",
      );

      while (Date.now() - startedAt < timeoutMs) {
        const peers = registry.listOnline(claims.org).filter((a) => a.id !== agent_id);
        if (peers.length >= targetPeers) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ready: true,
                  online_peers: peers.map((p) => ({ id: p.id, name: p.name })),
                  waited_ms: Date.now() - startedAt,
                }),
              },
            ],
          };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const finalPeers = registry.listOnline(claims.org).filter((a) => a.id !== agent_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ready: false,
              timeout: true,
              online_peers: finalPeers.map((p) => ({ id: p.id, name: p.name })),
              waited_ms: Date.now() - startedAt,
            }),
          },
        ],
      };
    },
  );
}
