import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";

/**
 * S1: MQTT listener MCP tools (3 tools).
 * wait_for_message, get_queued_messages, mqtt_publish.
 * Replaces what used to be a standalone mqtt-mcp-bridge sidecar.
 */
export function registerMqttTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
): void {
  const { mqttBridge } = services;

  server.tool("wait_for_message", "Block until an MQTT consultation message arrives or timeout", {
    agent_id: z.string(),
    timeout_seconds: z.number().optional(),
  }, async ({ agent_id, timeout_seconds }) => {
    const timeoutMs = (timeout_seconds || 15) * 1000;
    const msg = await mqttBridge.waitForMessage(agent_id, timeoutMs);
    if (msg) {
      return { content: [{ type: "text", text: JSON.stringify(msg) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
  });

  server.tool("get_queued_messages", "Get all queued MQTT messages without blocking", {
    agent_id: z.string(),
  }, async ({ agent_id }) => {
    const messages = mqttBridge.getQueuedMessages(agent_id);
    return { content: [{ type: "text", text: JSON.stringify(messages) }] };
  });

  server.tool("mqtt_publish", "Publish a message to an MQTT topic", {
    topic: z.string(),
    payload: z.string(),
  }, async ({ topic, payload }) => {
    mqttBridge.mqttPublish(topic, payload);
    return { content: [{ type: "text", text: "published" }] };
  });
}
