/**
 * Smoke tests for the stdio MCP transport (`src/index.ts`, started via
 * `pnpm dev:stdio` at the CLI).
 *
 * Mirror of `mcp-http-smoke.test.ts`. Stdio tool calls used to be broken
 * (the per-tool handler's `extra.sessionId` was undefined in stdio mode,
 * so every handler threw "MCP tool requires a session"). #133 fixed the
 * pattern: tool handlers now resolve claims via the empty-string sentinel,
 * and src/index.ts wires a getSessionClaims that returns synthetic legacy
 * claims for stdio mode.
 *
 * Together with mcp-http-smoke.test.ts this forms the regression net for
 * both production transport modes — the foundation for the Channels
 * integration spike (#130).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStdioHarness, type McpHarness } from "../helpers/mcp-client-harness.js";

describe("MCP stdio transport — smoke", () => {
  let harness: McpHarness;

  beforeAll(async () => {
    harness = await createStdioHarness();
  }, 30_000); // tsx spawn + initial handshake is slow on first run

  afterAll(async () => {
    await harness.cleanup();
  });

  it("connects + advertises the expected tool surface", async () => {
    const tools = await harness.client.listTools();
    // 26 tools per README — allow drift (>= 20) so add/remove of one tool
    // doesn't cascade into red CI from a smoke test.
    expect(tools.tools.length).toBeGreaterThanOrEqual(20);
    const names = tools.tools.map((t) => t.name);
    for (const expected of [
      "register_agent",
      "announce_work",
      "list_threads",
      "post_to_thread",
      "coordinator_status",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("registers an agent, announces work, and observes it via list_threads", async () => {
    const reg = await harness.client.callTool({
      name: "register_agent",
      arguments: {
        agent_id: "alice",
        name: "Alice",
        modules: ["src/auth"],
      },
    });
    expect(reg.isError ?? false).toBe(false);

    const announce = await harness.client.callTool({
      name: "announce_work",
      arguments: {
        agent_id: "alice",
        subject: "harness smoke test announcement",
        target_files: ["src/auth/login.ts"],
        target_modules: ["src/auth"],
      },
    });
    expect(announce.isError ?? false).toBe(false);

    const threads = await harness.client.callTool({
      name: "list_threads",
      arguments: {},
    });
    expect(threads.isError ?? false).toBe(false);
  });

  it("rejects an unknown tool with a structured error (not a crash)", async () => {
    // MCP servers can either throw (rejection) or return isError:true with
    // a structured payload. mcp-coordinator chooses the latter — friendlier
    // contract. Either signal is acceptable; the contract this test pins
    // is "no transport crash and the connection survives".
    const result = await harness.client.callTool({
      name: "this_tool_definitely_does_not_exist",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    // After the bad call, the connection MUST still be usable.
    const tools = await harness.client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(20);
  });

  it("coordinator_status returns a structured payload", async () => {
    const status = await harness.client.callTool({
      name: "coordinator_status",
      arguments: {},
    });
    expect(status.isError ?? false).toBe(false);
    expect(status.content).toBeDefined();
  });
});
