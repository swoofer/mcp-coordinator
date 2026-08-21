import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";

import { missingClaimsError } from "./tool-errors.js";
import { requireScope } from "./tool-scopes.js";

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
  "MQTT broker not available — no broker is connected in this session. stdio mode never starts one, and since #280 an HTTP daemon also keeps running when its broker cannot bind. Use get_thread_updates for delivery that does not depend on the bus (mqtt_publish / wait_for_message / get_queued_messages).";

/**
 * issue #383: the guard above only speaks AFTER the call. A model reading
 * tools/list has no way to know these three tools may be inert in its
 * session, so it spends a round trip to find out.
 *
 * Phrased around the broker rather than the transport on purpose. The
 * issue proposed "HTTP transport only -- unavailable in stdio mode", which
 * stopped being true with #280: a busy MQTT port now degrades the HTTP boot
 * instead of killing it, so an HTTP daemon can be running with no broker at
 * all. stdio is one way to have no broker, not the only one.
 */
const MQTT_AVAILABILITY_CAVEAT =
  " Needs a live MQTT broker: returns an error when none is connected, which is the case in stdio mode and on an HTTP daemon whose broker failed to start.";

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
        "Block until an MQTT consultation message arrives, or time out. Best-effort push: nothing is buffered before this call registers a listener, so a message published earlier is already gone. Use get_thread_updates for delivery you can rely on." +
        MQTT_AVAILABILITY_CAVEAT,
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
      if (!claims) throw missingClaimsError(ctx.sessionId);
      requireScope(claims, "wait_for_message");
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      const cappedSeconds = Math.min(timeout_seconds || 15, MAX_WAIT_TIMEOUT_SECONDS);
      const timeoutMs = cappedSeconds * 1000;
      const msg = await mqttBridge.waitForMessage(claims.org, agent_id, timeoutMs);
      if (msg) {
        // issue #357: waitForMessage shifts ONE message and leaves the rest
        // queued. Without this the model has no reason to suspect a backlog,
        // so it loops on wait_for_message -- one billed turn per message --
        // instead of draining the remainder in a single get_queued_messages.
        const queued_remaining = mqttBridge.queueDepth(claims.org, agent_id);
        return {
          content: [{ type: "text", text: JSON.stringify({ ...msg, queued_remaining }) }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
    },
  );

  server.registerTool(
    "get_queued_messages",
    {
      description:
        "Drain queued MQTT messages without blocking. DESTRUCTIVE by default: messages are removed as they are returned, so a second call gets nothing and a crash mid-processing loses them. Pass require_ack:true to hold the batch instead — the result becomes {messages, batch_id}, and the next call redelivers that batch unless you hand the id back as ack. Nothing is buffered while no listener is registered, and the queue drops oldest-first when full. A coordinator restart still drops the queue either way; for delivery you can rely on, use get_thread_updates." +
        MQTT_AVAILABILITY_CAVEAT,
      inputSchema: z.object({
        agent_id: z.string().describe("ID of the agent whose queued messages to fetch."),
        require_ack: z
          .boolean()
          .optional()
          .describe(
            "Hold this batch until it is acknowledged, and return {messages, batch_id} instead of a bare array. Once set for an agent it stays set, so every later unacknowledged batch is redelivered rather than dropped — set it on the FIRST call, while there is still nothing to lose.",
          ),
        ack: z
          .string()
          .optional()
          .describe(
            "The batch_id from your previous call, sent once you have durably handled that batch. Omit it and that batch comes back on this call.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        title: "Drain queued MQTT messages",
      },
    },
    async ({ agent_id, require_ack, ack }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError(ctx.sessionId);
      requireScope(claims, "get_queued_messages");
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      const result = mqttBridge.getQueuedMessages(claims.org, agent_id, {
        requireAck: require_ack,
        ack,
      });
      // issue #236: the wire shape follows the opt-in. A caller that never
      // asked for acks still gets the bare array it has always parsed —
      // changing that for everyone would break every deployed consumer to fix
      // a hazard only some of them have.
      const body = require_ack ? result : result.messages;
      return { content: [{ type: "text", text: JSON.stringify(body) }] };
    },
  );

  server.registerTool(
    "mqtt_publish",
    {
      description: "Publish a message to an MQTT topic." + MQTT_AVAILABILITY_CAVEAT,
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
      if (!claims) throw missingClaimsError(ctx.sessionId);
      requireScope(claims, "mqtt_publish");
      if (!mqttBridge.isConnected()) return mqttNotConnectedResult();
      // #330: hold the caller to its own identity on agent-status topics. A
      // Phase 1 agent token is minted with the agent id as subject
      // (auth.ts:99); anything else has no agent identity to enforce and stays
      // unrestricted, as it was.
      const callerAgentId = claims.role === "agent" ? claims.sub : undefined;
      const published = mqttBridge.mqttPublish(claims.org, topic, payload, callerAgentId);
      if (!published) {
        throw new Error(
          `Refused: ${topic} is another agent's status topic. Publishing "offline" there runs that ` +
            `agent's departure — its threads are unclaimed, a consultation it was the last ` +
            `respondent on can be force-resolved, and its working-file claims are cleared. ` +
            `Publish your own status (coordinator/${claims.org}/agents/${claims.sub}/status), or ` +
            `use broadcast / consultations/* to reach other agents.`,
        );
      }
      return { content: [{ type: "text", text: "published" }] };
    },
  );
}
