/**
 * Ergonomie des outils MCP pour un agent LLM (protocole-mcp-05/08/10/14).
 *
 * Covers, with lightweight service mocks (no full DB harness needed):
 *  - protocole-mcp-05: set_dependency_map — describe()'d param + actionable
 *    isError on malformed/malshaped JSON instead of a raw throw.
 *  - protocole-mcp-08: get_thread — isError + explicit message on a missing
 *    thread instead of a bare "null" text payload.
 *  - protocole-mcp-10: tool annotations (readOnlyHint / destructiveHint) are
 *    present and correctly split between reads and mutations, and key
 *    params carry a .describe().
 *  - protocole-mcp-14: wait_for_peers / wait_for_message cap an excessive
 *    caller-supplied timeout instead of blocking indefinitely.
 */
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { registerDependenciesTools } from "../../src/tools/dependencies-tools.js";
import { registerConsultationTools } from "../../src/tools/consultation-tools.js";
import { registerAgentTools } from "../../src/tools/agents-tools.js";
import { registerFilesTools } from "../../src/tools/files-tools.js";
import {
  registerMqttTools,
  MAX_WAIT_TIMEOUT_SECONDS as MAX_MQTT_WAIT_SECONDS,
} from "../../src/tools/mqtt-tools.js";
import {
  registerStatusTools,
  MAX_WAIT_TIMEOUT_SECONDS as MAX_PEERS_WAIT_SECONDS,
} from "../../src/tools/status-tools.js";
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
  // `extra.sessionId`, so the rest is stubbed to the smallest shape that
  // is still recognisably a tools/call, and the cast goes through unknown
  // because this is deliberately a partial fake, not a real context.
  return {
    signal: new AbortController().signal,
    sessionId,
    mcpReq: { id: 1, method: "tools/call" },
  } as unknown as ServerContext;
}

interface RegisteredToolInternals {
  handler: (args: unknown, extra: ServerContext) => Promise<unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema?: { shape: Record<string, { description?: string }> };
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

// ─── protocole-mcp-05: set_dependency_map ────────────────────────────────────

describe("protocole-mcp-05: set_dependency_map ergonomics", () => {
  function makeServer() {
    const server = new McpServer({ name: "test", version: "0" });
    registerDependenciesTools(
      server,
      { depMap: { setMap: vi.fn() } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    return server;
  }

  it("describes the expected JSON shape of the 'modules' param", () => {
    const server = makeServer();
    const tool = getTool(server, "set_dependency_map");
    const description = tool.inputSchema?.shape.modules.description;
    expect(description).toBeTruthy();
    expect(description).toMatch(/depends_on/);
    expect(description).toMatch(/JSON/i);
  });

  it("returns an actionable isError (not a raw throw) on invalid JSON", async () => {
    const server = makeServer();
    const result = await callTool(server, "set_dependency_map", { modules: "{not valid json" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid json/i);
    expect(result.content[0].text).toMatch(/depends_on/);
  });

  it("returns an actionable isError when JSON is valid but not an object map", async () => {
    const server = makeServer();
    const result = await callTool(server, "set_dependency_map", { modules: "[1,2,3]" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/object/i);
  });

  it("still accepts well-formed input and calls depMap.setMap", async () => {
    const setMap = vi.fn();
    const server = new McpServer({ name: "test", version: "0" });
    registerDependenciesTools(
      server,
      { depMap: { setMap } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    const result = await callTool(server, "set_dependency_map", {
      modules: JSON.stringify({ "mod-a": { depends_on: [], exports: [], owners: [] } }),
    });
    expect(result.isError).toBeFalsy();
    expect(setMap).toHaveBeenCalledWith("org-1", {
      "mod-a": { depends_on: [], exports: [], owners: [] },
    });
  });
});

// ─── protocole-mcp-08: get_thread on a missing thread ────────────────────────

describe("protocole-mcp-08: get_thread on a missing resource", () => {
  it('returns isError + an explicit message instead of text "null"', async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(
      server,
      { consultation: { getThreadWithMessages: () => null } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    const result = await callTool(server, "get_thread", { thread_id: "does-not-exist" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toBe("null");
    expect(result.content[0].text).toMatch(/does-not-exist/);
    expect(result.content[0].text).toMatch(/not found/i);
  });

  it("returns the thread normally (no isError) when it exists", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const thread = { thread: { id: "t1" }, messages: [] };
    registerConsultationTools(
      server,
      { consultation: { getThreadWithMessages: () => thread } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    const result = await callTool(server, "get_thread", { thread_id: "t1" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(thread);
  });
});

// ─── protocole-mcp-10: annotations + param descriptions ──────────────────────

describe("protocole-mcp-10: tool annotations", () => {
  it("read tools are tagged readOnlyHint:true", () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerDependenciesTools(
      server,
      { depMap: {} } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    registerConsultationTools(
      server,
      {} as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    registerAgentTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);
    registerFilesTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);
    registerMqttTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);
    registerStatusTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);

    const reads = [
      "get_blast_radius",
      "get_module_info",
      "get_thread",
      "get_thread_updates",
      "list_threads",
      "list_agents",
      "agent_activity",
      "hot_files",
      "get_session_files",
      "check_file_conflict",
      "coordinator_status",
      "wait_for_peers",
    ];
    for (const name of reads) {
      expect(
        getTool(server, name).annotations?.readOnlyHint,
        `${name} should be readOnlyHint:true`,
      ).toBe(true);
    }
  });

  it("mutation tools are tagged readOnlyHint:false, with destructiveHint set on the truly destructive ones", () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerDependenciesTools(
      server,
      { depMap: {} } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    registerConsultationTools(
      server,
      {} as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    registerAgentTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);
    registerMqttTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);

    const mutations = [
      "set_dependency_map",
      "announce_work",
      "post_to_thread",
      "propose_resolution",
      "approve_resolution",
      "contest_resolution",
      "close_thread",
      "cancel_thread",
      "log_action_summary",
      "register_agent",
      "heartbeat",
      "mqtt_publish",
      // issue #269: both consume from the listener queue — waitForMessage
      // shifts one, getQueuedMessages empties it. They were listed as reads.
      "wait_for_message",
      "get_queued_messages",
    ];
    for (const name of mutations) {
      expect(
        getTool(server, name).annotations?.readOnlyHint,
        `${name} should be readOnlyHint:false`,
      ).toBe(false);
    }

    // get_queued_messages drains the entire queue in one call and the messages
    // have no other copy. wait_for_message is deliberately NOT here: it takes
    // exactly one message as its documented purpose, and flagging the main
    // receive loop destructive would make clients prompt on every poll.
    const destructive = [
      "set_dependency_map",
      "close_thread",
      "cancel_thread",
      "get_queued_messages",
    ];
    for (const name of destructive) {
      expect(
        getTool(server, name).annotations?.destructiveHint,
        `${name} should be destructiveHint:true`,
      ).toBe(true);
    }
  });

  it("key params carry a .describe()", () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(
      server,
      {} as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );
    registerAgentTools(server, {} as unknown as CoordinatorServices, silentLogger, GET_CLAIMS);

    expect(getTool(server, "announce_work").inputSchema?.shape.subject.description).toBeTruthy();
    expect(getTool(server, "post_to_thread").inputSchema?.shape.thread_id.description).toBeTruthy();
    expect(getTool(server, "register_agent").inputSchema?.shape.modules.description).toBeTruthy();
  });
});

// ─── protocole-mcp-14: timeout caps on wait_for_* ────────────────────────────

describe("protocole-mcp-14: wait_for_* timeout caps", () => {
  it("wait_for_message caps an excessive timeout_seconds before calling the bridge", async () => {
    const waitForMessage = vi.fn(
      async (_orgId: string, _agentId: string, _timeoutMs: number) => null,
    );
    const server = new McpServer({ name: "test", version: "0" });
    registerMqttTools(
      server,
      { mqttBridge: { isConnected: () => true, waitForMessage } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );

    await callTool(server, "wait_for_message", { agent_id: "a1", timeout_seconds: 10_000_000 });

    expect(waitForMessage).toHaveBeenCalledTimes(1);
    const [, , timeoutMsUsed] = waitForMessage.mock.calls[0];
    expect(timeoutMsUsed).toBe(MAX_MQTT_WAIT_SECONDS * 1000);
    expect(timeoutMsUsed).toBeLessThan(10_000_000 * 1000);
  });

  it("wait_for_message respects a timeout under the cap", async () => {
    const waitForMessage = vi.fn(
      async (_orgId: string, _agentId: string, _timeoutMs: number) => null,
    );
    const server = new McpServer({ name: "test", version: "0" });
    registerMqttTools(
      server,
      { mqttBridge: { isConnected: () => true, waitForMessage } } as unknown as CoordinatorServices,
      silentLogger,
      GET_CLAIMS,
    );

    await callTool(server, "wait_for_message", { agent_id: "a1", timeout_seconds: 5 });

    expect(waitForMessage.mock.calls[0][2]).toBe(5000);
  });

  it("wait_for_peers returns (does not hang) once the capped timeout elapses, even with an excessive requested timeout", async () => {
    vi.useFakeTimers();
    try {
      const server = new McpServer({ name: "test", version: "0" });
      registerStatusTools(
        server,
        { registry: { listOnline: () => [] } } as unknown as CoordinatorServices,
        silentLogger,
        GET_CLAIMS,
      );

      const resultPromise = callTool(server, "wait_for_peers", {
        agent_id: "solo",
        min_peers: 5,
        timeout_seconds: 10_000_000,
      });

      // Advance just past the cap — an uncapped implementation would still be
      // blocked here (it would need to advance 10,000,000s to resolve).
      await vi.advanceTimersByTimeAsync(MAX_PEERS_WAIT_SECONDS * 1000 + 2000);

      const result = await resultPromise;
      const body = JSON.parse(result.content[0].text) as {
        ready: boolean;
        timeout: boolean;
        waited_ms: number;
      };
      expect(body.ready).toBe(false);
      expect(body.timeout).toBe(true);
      expect(body.waited_ms).toBeLessThanOrEqual(MAX_PEERS_WAIT_SECONDS * 1000 + 2000);
    } finally {
      vi.useRealTimers();
    }
  });
});
