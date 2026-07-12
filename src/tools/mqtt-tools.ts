import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";

/**
 * S1: MQTT listener MCP tools (3 tools).
 * wait_for_message, get_queued_messages, mqtt_publish.
 * Replaces what used to be a standalone mqtt-mcp-bridge sidecar.
 *
 * Note (Task 23.5): the MqttBridge message-queue API is keyed by agent_id,
 * not by org. MQTT topic scoping and per-org ACLs are deferred to Task 22.
 * We still require valid session claims here so callers are authenticated,
 * even though the underlying bridge calls don't yet filter by claims.org.
 */

/**
 * protocole-mcp-14: wait_for_message has no upper bound on the caller-supplied
 * timeout_seconds, so a misbehaving/careless caller can request an
 * effectively unbounded block. Cap it so the tool always returns.
 */
export const MAX_WAIT_TIMEOUT_SECONDS = 300;

export function registerMqttTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { mqttBridge } = services;

  server.tool("wait_for_message", "Block until an MQTT consultation message arrives or timeout", {
    agent_id: z.string().describe("ID of the agent waiting for a message."),
    timeout_seconds: z.number().optional()
      .describe(`How long to block, in seconds. Defaults to 15, capped at ${MAX_WAIT_TIMEOUT_SECONDS}.`),
  }, { readOnlyHint: true, title: "Wait for MQTT message" }, async ({ agent_id, timeout_seconds }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    const cappedSeconds = Math.min(timeout_seconds || 15, MAX_WAIT_TIMEOUT_SECONDS);
    const timeoutMs = cappedSeconds * 1000;
    const msg = await mqttBridge.waitForMessage(agent_id, timeoutMs);
    if (msg) {
      return { content: [{ type: "text", text: JSON.stringify(msg) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
  });

  server.tool("get_queued_messages", "Get all queued MQTT messages without blocking", {
    agent_id: z.string().describe("ID of the agent whose queued messages to fetch."),
  }, { readOnlyHint: true, title: "Get queued MQTT messages" }, async ({ agent_id }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    const messages = mqttBridge.getQueuedMessages(agent_id);
    return { content: [{ type: "text", text: JSON.stringify(messages) }] };
  });

  server.tool("mqtt_publish", "Publish a message to an MQTT topic", {
    topic: z.string().describe("MQTT topic to publish to."),
    payload: z.string().describe("Message payload to publish."),
  }, { readOnlyHint: false, destructiveHint: false, openWorldHint: true, title: "Publish MQTT message" }, async ({ topic, payload }, extra) => {
    const claims = getSessionClaims(extra.sessionId ?? "");
    if (!claims) throw new Error("Session has no captured claims (auth bug)");
    mqttBridge.mqttPublish(topic, payload);
    return { content: [{ type: "text", text: "published" }] };
  });
}
