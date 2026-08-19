/**
 * protocole-mcp-06 — MQTT tools must not report false success when no
 * broker/bridge is connected (e.g. stdio transport, where src/index.ts never
 * starts an MqttBridge). Before the fix:
 *  - mqtt_publish returned { text: "published" } even though mqttPublish()
 *    is a silent no-op when the underlying client isn't connected.
 *  - wait_for_message would block for the full (capped) timeout and then
 *    return { timeout: true } with no indication a broker was ever missing.
 *  - get_queued_messages returned [] silently.
 * All three must now return an explicit `isError: true` with an actionable
 * message when `mqttBridge.isConnected()` is false, and must be unaffected
 * (nominal path, no isError) when it's true.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { registerMqttTools } from "../../src/tools/mqtt-tools.js";
import { silentLogger } from "../../src/logger.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
const CLAIMS: AuthClaims = {
  sub: "agent-1",
  user_id: "u-1",
  org: "org-1",
  role: "agent",
  jti: "j-1",
};
const GET_CLAIMS = (_sid: string): AuthClaims | null => CLAIMS;

function fakeExtra(sessionId = "sess-1"): ServerContext {
  // v2's ServerContext requires `mcpReq` (the JSON-RPC id + method of the
  // request being handled). The tools under test read only
  // `extra.sessionId`, so the rest is stubbed to the smallest shape that is
  // still recognisably a tools/call, and the cast goes through unknown
  // because this is deliberately a partial fake, not a real context.
  return {
    signal: new AbortController().signal,
    sessionId,
    mcpReq: { id: 1, method: "tools/call" },
  } as unknown as ServerContext;
}

interface RegisteredToolInternals {
  handler: (args: unknown, extra: ServerContext) => Promise<unknown>;
  /** #383: the description a model reads in tools/list, before calling. */
  description?: string;
}

function getTool(server: McpServer, toolName: string): RegisteredToolInternals {
  const _server = server as unknown as {
    _registeredTools: Record<string, RegisteredToolInternals>;
  };
  const registered = _server._registeredTools[toolName];
  if (!registered) throw new Error(`Tool not registered: ${toolName}`);
  return registered;
}

async function callTool(server: McpServer, toolName: string, args: unknown) {
  const tool = getTool(server, toolName);
  return tool.handler(args, fakeExtra()) as Promise<{
    isError?: boolean;
    content: [{ type: string; text: string }];
  }>;
}

function makeServer(mqttBridge: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: "test", version: "0" });
  registerMqttTools(
    server,
    { mqttBridge } as unknown as CoordinatorServices,
    silentLogger,
    GET_CLAIMS,
  );
  return server;
}

describe("protocole-mcp-06: MQTT tools when the bridge is not connected (e.g. stdio mode)", () => {
  function makeDisconnectedBridge() {
    return {
      isConnected: () => false,
      mqttPublish: vi.fn(),
      waitForMessage: vi.fn(async () => null),
      getQueuedMessages: vi.fn(() => []),
    };
  }

  it("mqtt_publish returns isError with an actionable message, and does NOT call the bridge's publish", async () => {
    const bridge = makeDisconnectedBridge();
    const server = makeServer(bridge);
    const result = await callTool(server, "mqtt_publish", { topic: "t", payload: "p" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MQTT broker not available/);
    expect(bridge.mqttPublish).not.toHaveBeenCalled();
  });

  it("wait_for_message returns isError immediately — does NOT wait out the timeout", async () => {
    const bridge = makeDisconnectedBridge();
    const server = makeServer(bridge);
    const start = Date.now();
    const result = await callTool(server, "wait_for_message", {
      agent_id: "a1",
      timeout_seconds: 15,
    });
    const elapsedMs = Date.now() - start;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MQTT broker not available/);
    expect(bridge.waitForMessage).not.toHaveBeenCalled();
    // Sanity: didn't block for anywhere close to the 15s timeout.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("get_queued_messages returns isError instead of a silent empty list", async () => {
    const bridge = makeDisconnectedBridge();
    const server = makeServer(bridge);
    const result = await callTool(server, "get_queued_messages", { agent_id: "a1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/MQTT broker not available/);
    expect(bridge.getQueuedMessages).not.toHaveBeenCalled();
  });
});

describe("protocole-mcp-06: MQTT tools when the bridge IS connected — nominal path unchanged", () => {
  function makeConnectedBridge() {
    return {
      isConnected: () => true,
      mqttPublish: vi.fn(),
      waitForMessage: vi.fn(async () => ({
        topic: "coordinator/default/broadcast",
        payload: { hi: true },
        timestamp: 123,
      })),
      getQueuedMessages: vi.fn(() => [{ topic: "t", payload: { a: 1 }, timestamp: 1 }]),
      // #357: the real bridge reports how many messages are still queued;
      // a double that omits it no longer models the interface.
      queueDepth: vi.fn(() => 0),
    };
  }

  it("mqtt_publish calls the bridge and reports success, no isError", async () => {
    const bridge = makeConnectedBridge();
    const server = makeServer(bridge);
    const result = await callTool(server, "mqtt_publish", { topic: "t", payload: "p" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("published");
    expect(bridge.mqttPublish).toHaveBeenCalledWith("org-1", "t", "p");
  });

  it("wait_for_message resolves with the message, no isError", async () => {
    const bridge = makeConnectedBridge();
    const server = makeServer(bridge);
    const result = await callTool(server, "wait_for_message", { agent_id: "a1" });
    expect(result.isError).toBeFalsy();
    // #357 adds queued_remaining to this payload. Additive: topic, payload and
    // timestamp are untouched, so an existing consumer keeps parsing.
    expect(JSON.parse(result.content[0].text)).toEqual({
      topic: "coordinator/default/broadcast",
      payload: { hi: true },
      timestamp: 123,
      queued_remaining: 0,
    });
    expect(bridge.waitForMessage).toHaveBeenCalledTimes(1);
  });

  it("wait_for_message reports { timeout: true } (not isError) when the bridge itself times out", async () => {
    const bridge = {
      isConnected: () => true,
      mqttPublish: vi.fn(),
      waitForMessage: vi.fn(async () => null),
      getQueuedMessages: vi.fn(() => []),
    };
    const server = makeServer(bridge);
    const result = await callTool(server, "wait_for_message", { agent_id: "a1" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ timeout: true });
  });

  it("get_queued_messages returns the queued messages, no isError", async () => {
    const bridge = makeConnectedBridge();
    const server = makeServer(bridge);
    const result = await callTool(server, "get_queued_messages", { agent_id: "a1" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual([
      { topic: "t", payload: { a: 1 }, timestamp: 1 },
    ]);
    expect(bridge.getQueuedMessages).toHaveBeenCalledWith("org-1", "a1");
  });
});

// -- #383 / #357 -------------------------------------------------------------

describe("MQTT tools announce their broker dependency in tools/list (#383)", () => {
  // The runtime guard only speaks after the call. A model choosing tools has
  // nothing but the description, so the caveat has to live there.
  it.each(["wait_for_message", "get_queued_messages", "mqtt_publish"])(
    "%s says it needs a live broker",
    (name) => {
      const server = makeServer({ isConnected: () => true });
      const description = getTool(server, name).description ?? "";
      expect(description).toMatch(/live MQTT broker/);
      expect(description).toMatch(/stdio/);
    },
  );

  // #280 made a busy MQTT port degrade the HTTP boot instead of killing it, so
  // an HTTP daemon can run with no broker. A description that blamed the
  // transport would now be wrong.
  it("does not claim the transport is what decides availability", () => {
    const server = makeServer({ isConnected: () => true });
    const description = getTool(server, "mqtt_publish").description ?? "";
    expect(description).not.toMatch(/HTTP transport only/i);
  });
});

describe("wait_for_message reports the remaining queue depth (#357)", () => {
  // waitForMessage shifts one message and leaves the rest. Without the count a
  // model loops -- one billed turn per message -- instead of draining once.
  it("returns queued_remaining alongside the message", async () => {
    const server = makeServer({
      isConnected: () => true,
      waitForMessage: async () => ({ topic: "t", payload: "p", timestamp: 1 }),
      queueDepth: () => 4,
    });
    const result = await callTool(server, "wait_for_message", { agent_id: "a1" });
    const body = JSON.parse(result.content[0].text);
    expect(body.queued_remaining).toBe(4);
    expect(body.topic).toBe("t");
  });

  it("reports zero when the queue is drained", async () => {
    const server = makeServer({
      isConnected: () => true,
      waitForMessage: async () => ({ topic: "t", payload: "p", timestamp: 1 }),
      queueDepth: () => 0,
    });
    const result = await callTool(server, "wait_for_message", { agent_id: "a1" });
    expect(JSON.parse(result.content[0].text).queued_remaining).toBe(0);
  });
});
