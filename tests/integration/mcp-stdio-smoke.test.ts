/**
 * Smoke tests for the stdio MCP transport (`src/index.ts`, started via
 * `pnpm dev:stdio` at the CLI).
 *
 * Scope is intentionally narrow: connection + tool discovery. Tool *calls*
 * via stdio are currently broken because the per-tool handler's
 * `extra.sessionId` is undefined in stdio mode (the SDK doesn't synthesize
 * one), so every handler throws "MCP tool requires a session" before
 * reaching the claims check. The harness surfaced this latent bug — see
 * the tracking issue for the proper fix (either inject a synthetic
 * sessionId at the SDK boundary or guard every handler).
 *
 * Until that lands, these tests pin the contract that:
 *   1. The stdio entry point (src/index.ts) boots cleanly
 *   2. The MCP handshake completes and advertises the documented tool set
 *
 * Anything beyond that is exercised in mcp-http-smoke.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createStdioHarness, type McpHarness } from "../helpers/mcp-client-harness.js";

describe("MCP stdio transport — smoke (connection + discovery only)", () => {
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

  it("known stdio bug — tool calls fail with 'MCP tool requires a session' (regression sentinel)", async () => {
    // Documents the current "MCP tool requires a session" behavior so that
    // the day someone fixes stdio mode for real, this test starts passing
    // the assertion in the opposite direction and the maintainer knows to
    // promote the broader stdio smoke checks (mirroring mcp-http-smoke).
    const result = await harness.client.callTool({
      name: "coordinator_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text =
      Array.isArray(result.content) && result.content[0]?.type === "text"
        ? (result.content[0] as { text: string }).text
        : "";
    expect(text).toMatch(/MCP tool requires a session|Session has no captured claims/);
  });
});
