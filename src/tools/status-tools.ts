import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";

/**
 * S1: status + coordination helper MCP tools (2 tools).
 * coordinator_status, wait_for_peers.
 */
export function registerStatusTools(
  server: McpServer,
  services: CoordinatorServices,
  mcpLog: Logger,
): void {
  const { registry, consultation, fileTracker, mqttBridge } = services;

  server.tool("coordinator_status", "Full system status", {}, async () => {
    const online = registry.listOnline();
    const openThreads = consultation.listThreads({ status: "open" });
    const resolvingThreads = consultation.listThreads({ status: "resolving" });
    const hotFiles = fileTracker.getHotFiles(30);
    const status = {
      agents_online: online.length,
      agents: online.map((a) => ({ id: a.id, name: a.name, modules: JSON.parse(a.modules) })),
      open_threads: openThreads.length,
      resolving_threads: resolvingThreads.length,
      hot_files: hotFiles.length,
      mqtt_connected: mqttBridge.isConnected(),
    };
    mcpLog.debug({ tool: "coordinator_status", agents_online: online.length, open_threads: openThreads.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(status) }] };
  });

  server.tool("wait_for_peers", "Block until at least N other online agents are registered, or timeout. Use before the first announce_work to avoid the race where one agent announces before peers have booted.", {
    agent_id: z.string(),
    min_peers: z.number().optional(),
    timeout_seconds: z.number().optional(),
  }, async ({ agent_id, min_peers, timeout_seconds }) => {
    const targetPeers = min_peers ?? 1;
    const timeoutMs = (timeout_seconds ?? 30) * 1000;
    const pollIntervalMs = 1000;
    const startedAt = Date.now();
    mcpLog.info({ tool: "wait_for_peers", agent_id, min_peers: targetPeers, timeout_seconds: timeoutMs / 1000 }, "Tool called");

    while (Date.now() - startedAt < timeoutMs) {
      const peers = registry.listOnline().filter((a) => a.id !== agent_id);
      if (peers.length >= targetPeers) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ready: true,
              online_peers: peers.map((p) => ({ id: p.id, name: p.name })),
              waited_ms: Date.now() - startedAt,
            }),
          }],
        };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const finalPeers = registry.listOnline().filter((a) => a.id !== agent_id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ready: false,
          timeout: true,
          online_peers: finalPeers.map((p) => ({ id: p.id, name: p.name })),
          waited_ms: Date.now() - startedAt,
        }),
      }],
    };
  });
}
