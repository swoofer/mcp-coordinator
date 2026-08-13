/**
 * performance-07 / protocole-mcp-07 — idle MCP StreamableHTTP sessions must
 * be evicted (transport closed, sessions/sessionClaims maps cleared) after
 * COORDINATOR_MCP_SESSION_TTL_MS of inactivity, instead of leaking forever
 * while waiting for a clean client-initiated close.
 *
 * Before this fix, `sessions`/`sessionClaims` (src/serve-http.ts) were ONLY
 * evicted via `transport.onclose`, which assumes a well-behaved client sends
 * a clean DELETE/close. A client that vanishes (crash, network drop) leaked
 * its transport + McpServer + claims indefinitely — a zombie-session memory
 * leak. This test drives a REAL client through the SDK's initialize
 * handshake, never closes it, advances past a short test TTL, and triggers
 * a deterministic sweep pass (`handle.sweepMcpSessions()` — same pattern as
 * `handle.sweeper.runPass()` elsewhere: no reliance on the real interval
 * firing mid-test). Eviction is proven at the HTTP boundary: the server's
 * own /mcp route stops recognizing the old session id (404), which is only
 * possible if the transport was actually closed (not just Map.delete'd).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

async function openSession(port: number): Promise<{ client: Client; sessionId: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "ttl-test-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  if (!sessionId) throw new Error("session id not assigned after connect");
  return { client, sessionId };
}

/**
 * Probe whether the server still recognizes a session id, without going
 * through the SDK client (which would try to reconnect/reinitialize). A
 * live session routes into the transport (any status other than the
 * explicit "Session not found" 404 serve-http.ts writes for an unknown
 * mcp-session-id); an evicted one always gets that 404.
 */
async function sessionStillKnown(port: number, sessionId: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "ttl-probe" }),
  });
  await res.arrayBuffer().catch(() => undefined); // drain so the socket can be reused/closed
  return res.status !== 404;
}

let handle: ServerHandle | undefined;
let dataDir: string | undefined;
let prevTtl: string | undefined;
let ttlWasSet = false;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = undefined;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
  if (ttlWasSet) {
    if (prevTtl === undefined) delete process.env.COORDINATOR_MCP_SESSION_TTL_MS;
    else process.env.COORDINATOR_MCP_SESSION_TTL_MS = prevTtl;
    ttlWasSet = false;
  }
});

function setTestTtl(ms: string): void {
  prevTtl = process.env.COORDINATOR_MCP_SESSION_TTL_MS;
  process.env.COORDINATOR_MCP_SESSION_TTL_MS = ms;
  ttlWasSet = true;
}

describe("MCP HTTP idle session eviction (performance-07, protocole-mcp-07)", () => {
  it("a session left open (never DELETEd) is evicted after the TTL once the sweep runs", async () => {
    setTestTtl("20"); // 20ms — short TTL, exercised for real (not faked timers)
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-session-ttl-"));

    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const { client, sessionId } = await openSession(port);
    expect(await sessionStillKnown(port, sessionId)).toBe(true);

    await new Promise((r) => setTimeout(r, 40)); // cross the 20ms TTL
    const evicted = handle.sweepMcpSessions();
    expect(evicted).toBe(1);

    // R5(3): the transport was actually closed, not just deleted from the
    // Map — the server's own /mcp route no longer recognizes the session id.
    expect(await sessionStillKnown(port, sessionId)).toBe(false);

    await client.close().catch(() => undefined);
  });

  it("an active session (recent request) survives the sweep — no premature eviction", async () => {
    setTestTtl("5000"); // long enough to outlive this test's real-time duration
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-session-ttl-active-"));

    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const { client, sessionId } = await openSession(port);
    await client.listTools(); // real activity — refreshes sessionLastActivity

    const evicted = handle.sweepMcpSessions();
    expect(evicted).toBe(0);
    expect(await sessionStillKnown(port, sessionId)).toBe(true);

    await client.close().catch(() => undefined);
  });

  it("N zombie sessions are all evicted in one sweep pass (no lingering leaks)", async () => {
    setTestTtl("20");
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-session-ttl-n-"));

    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const port = handle.port;

    const N = 3;
    const opened = await Promise.all(Array.from({ length: N }, () => openSession(port)));

    await new Promise((r) => setTimeout(r, 40));
    const evicted = handle.sweepMcpSessions();
    expect(evicted).toBe(N);

    for (const { sessionId } of opened) {
      expect(await sessionStillKnown(port, sessionId)).toBe(false);
    }

    await Promise.all(opened.map(({ client }) => client.close().catch(() => undefined)));
  });
});
