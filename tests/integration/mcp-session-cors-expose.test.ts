/**
 * protocole-mcp-11 — `Access-Control-Expose-Headers: mcp-session-id` on
 * `/mcp` responses.
 *
 * Without this header, a browser-based MCP client cannot read the
 * `mcp-session-id` response header off the `initialize` response — only
 * "CORS-safelisted" response headers are exposed to page JavaScript by
 * default, and `mcp-session-id` is not one of them. The client can
 * therefore never learn the session id the server assigned it, and can't
 * send it back on subsequent requests, so session establishment silently
 * fails for any browser-based MCP client (curl / the MCP SDK's Node HTTP
 * client are unaffected — this is a browser-only CORS restriction).
 *
 * Covers both the OPTIONS preflight and the actual POST /mcp response
 * (initialize), mirroring the real-server-instance style of
 * tests/integration/origin-cors.test.ts rather than asserting against the
 * pure isAllowedOrigin helper.
 */
import { describe, it, expect, afterEach } from "vitest";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

describe("Access-Control-Expose-Headers: mcp-session-id on /mcp (protocole-mcp-11)", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  it("OPTIONS /mcp preflight exposes mcp-session-id", async () => {
    handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
    const port = handle.port;
    const origin = `http://localhost:${port}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: origin },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  });

  it("POST /mcp initialize (new session) exposes mcp-session-id alongside the actual header", async () => {
    handle = await startServer({ port: 0, mqttTcpPort: 0, mqttWsPath: "/mqtt" });
    const port = handle.port;
    const origin = `http://localhost:${port}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "cors-expose-test", version: "0.0.0-test" },
        },
      }),
    });
    // Sanity: the assertion below isn't vacuous — the server really did
    // hand back a session id for this request.
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    expect(res.headers.get("access-control-expose-headers")).toBe("mcp-session-id");
  });
});
