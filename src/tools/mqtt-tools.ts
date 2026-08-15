import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";

import { missingClaimsError } from "./tool-errors.js";

/**
 * S1: MQTT listener MCP tools (3 tools).
 * wait_for_message, get_queued_messages, mqtt_publish.
 * Replaces what used to be a standalone mqtt-mcp-bridge sidecar.
 *
 * Task 22: the MqttBridge message-queue API is keyed by (org, agent_id) —
 * every call below threads claims.org through so a caller can never wait
 * for, drain, or publish into another tenant's queue/topic namespace.
 */

/**
 * protocole-mcp-14: wait_for_message has no upper bound on the caller-supplied
 * timeout_seconds, so a misbehaving/careless caller can request an
 * effectively unbounded block. Cap it so the tool always returns.
 */
export const MAX_WAIT_TIMEOUT_SECONDS = 300;

/**
 * protocole-mcp-06: in stdio transport no MQTT broker/bridge is ever started
 * (see src/index.ts — "no MQTT broker in stdio mode"), so `mqttBridge.isConnected()`
 * is false for the lifetime of the process. Without this guard the 3 MQTT tools
 * below silently no-op (mqttPublish), block for the full timeout then report a
 * bare `{ timeout: true }` (waitForMessage), or return an empty list
 * (getQueuedMessages) — all of which read as success to the caller even though
 * no broker is reachable. Return an explicit isError instead so an LLM/user
 * debugging a coordination that "isn't going through" gets a real signal.
 */
const MQTT_NOT_CONNECTED_MESSAGE =
  "MQTT broker not available — stdio mode runs without MQTT. Use the HTTP transport for push messaging (mqtt_publish / wait_for_message / get_queued_messages).";

function mqttNotConnectedResult() {
  return {
    isError: true,
    content: [{ type: "text" as const, text: MQTT_NOT_CONNECTED_MESSAGE }],
  };
}

export function registerMqttTools(
  server: McpServer,
  services: CoordinatorServices,
  _mcpLog: Logger,
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { mqttBridge } = services;

  server.registerTool(
    "wait_for_message",
    {
      description:
        "Block until an MQTT consultation message arrives, or time out. Best-effort push: nothing is buffered before this call registers a listener, so a message published earlier is already gone. Use get_thread_updates for delivery you can rely on.",
      inputSchema: z.object({
        agent_id: z.string().describe("ID of the agent waiting for a message."),
        timeout_seconds: z
          .number()
          .optional()
          .describe(
            `How long to block, in seconds. Defaults to 15, capped at ${MAX_WAIT_TIMEOUT_SECONDS}.`,
          ),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, title: "Wait for MQTT message" },
    },
    async ({ agent_id, timeout_seconds }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      const cappedSeconds = Math.min(timeout_seconds || 15, MAX_WAIT_TIMEOUT_SECONDS);
      const timeoutMs = cappedSeconds * 1000;
      const msg = await mqttBridge.waitForMessage(claims.org, agent_id, timeoutMs);
      if (msg) {
        return { content: [{ type: "text", text: JSON.stringify(msg) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
    },
  );

  server.registerTool(
    "get_queued_messages",
    {
      description:
        "Drain queued MQTT messages without blocking. DESTRUCTIVE: messages are removed as they are returned, so a second call gets nothing and a crash mid-processing loses them. Nothing is buffered while no listener is registered, and the queue drops oldest-first when full. For delivery you can rely on, use get_thread_updates instead.",
      inputSchema: z.object({
        agent_id: z.string().describe("ID of the agent whose queued messages to fetch."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        title: "Drain queued MQTT messages",
      },
    },
    async ({ agent_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      const messages = mqttBridge.getQueuedMessages(claims.org, agent_id);
      return { content: [{ type: "text", text: JSON.stringify(messages) }] };
    },
  );

  server.registerTool(
    "mqtt_publish",
    {
      description: "Publish a message to an MQTT topic",
      inputSchema: z.object({
        topic: z
          .string()
          .describe(
            "MQTT topic. Rewritten into your org namespace (coordinator/<your-org>/...) — you cannot publish outside your tenant. Only 'broadcast' and 'consultations/*' reach other agents' listeners; any other topic is published but consumed by nobody.",
          ),
        payload: z
          .string()
          .describe(
            "Message payload. Must be valid JSON to be delivered to listeners — a non-JSON payload on a broadcast/consultations topic is discarded on receipt.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        title: "Publish MQTT message",
      },
    },
    async ({ topic, payload }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      mqttBridge.mqttPublish(claims.org, topic, payload);
      return { content: [{ type: "text", text: "published" }] };
    },
  );
}
