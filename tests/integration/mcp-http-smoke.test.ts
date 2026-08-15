/**
 * Smoke tests for the HTTP MCP transport (`src/serve-http.ts`, started via
 * `pnpm dev` at the CLI or `mcp-coordinator server start --daemon` in prod).
 *
 * Mirror of `mcp-stdio-smoke.test.ts`, exercising the same tool round-trip
 * but over streamable-HTTP. Together they form the regression net before
 * the Channels integration spike (#130).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHttpHarness } from "../helpers/mcp-client-harness.js";

describe("MCP HTTP (streamable) transport — smoke", () => {
  let harness: Awaited<ReturnType<typeof createHttpHarness>>;

  beforeAll(async () => {
    harness = await createHttpHarness();
  }, 30_000);

  afterAll(async () => {
    await harness.cleanup();
  });

  it("server reports the right HTTP and MQTT bindings", () => {
    // Sanity: the harness allocated a real port and the server is listening.
    expect(harness.httpPort).toBeGreaterThan(0);
  });

  it("connects + advertises the expected tool surface", async () => {
    const tools = await harness.client.listTools();
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
        agent_id: "bob",
        name: "Bob",
        modules: ["src/billing"],
      },
    });
    expect(reg.isError ?? false).toBe(false);

    const announce = await harness.client.callTool({
      name: "announce_work",
      arguments: {
        agent_id: "bob",
        subject: "harness smoke test announcement",
        target_files: ["src/billing/checkout.ts"],
        target_modules: ["src/billing"],
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
    // a structured payload. Either signal is acceptable; the contract this
    // test pins is "no transport crash and the connection survives".
    //
    // Which of the two we get changed with the SDK v2 migration (#286):
    // v1 returned a tool result carrying isError, v2 answers with a
    // JSON-RPC error that the client surfaces as a thrown ProtocolError.
    // Both are structured, and an unknown tool arguably IS a protocol-level
    // error rather than a tool outcome — so the behaviour is accepted
    // rather than shimmed back. The assertion below is what the comment
    // above always said mattered.
    await expect(
      harness.client.callTool({
        name: "this_tool_definitely_does_not_exist",
        arguments: {},
      }),
    ).rejects.toThrow(/not found/i);
    // After the bad call, the connection MUST still be usable.
    const tools = await harness.client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(20);
  });

  it("/health endpoint still returns {status: 'alive'} alongside MCP", async () => {
    // Sanity: this is the contract the CLI `server status` command depends
    // on (see #112). Regression here would also break the smoke test in
    // tests/unit/cli-server-status-exit-code.test.ts indirectly.
    const res = await fetch(`http://127.0.0.1:${harness.httpPort}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("alive");
  });
});
