import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

/**
 * /mcp requests that neither carry a known mcp-session-id nor open a session
 * (POST without mcp-session-id) used to share one branch answering
 * 404 "Session not found" — including a bare GET that never sent a session id.
 *
 * MCP Streamable HTTP: a GET to the endpoint MUST get either an SSE stream or
 * 405; 404 is for an unknown/expired session id. HTTP health probes that
 * accept 405 but not 404 were reading a live coordinator as down.
 */

let handle: ServerHandle;
let dataDir: string;
let mcpUrl: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "mcp-no-session-"));
  handle = await startServer({ port: 0, dataDir, mqttTcpPort: 0, registerSignalHandlers: false });
  mcpUrl = `http://127.0.0.1:${handle.port}/mcp`;
});

afterAll(async () => {
  await handle?.stop().catch(() => undefined);
  rmSync(dataDir, { recursive: true, force: true });
});

describe("/mcp without a known session", () => {
  it("GET without mcp-session-id → 405 + Allow: POST", async () => {
    const res = await fetch(mcpUrl, { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/POST/);
    expect(body.error).not.toMatch(/Session not found/);
  });

  it.each(["DELETE", "PUT"])("%s without mcp-session-id → 400", async (method) => {
    const res = await fetch(mcpUrl, { method });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mcp-session-id/);
  });

  it.each(["GET", "POST", "DELETE"])(
    "%s with an unknown mcp-session-id → still 404",
    async (method) => {
      const res = await fetch(mcpUrl, {
        method,
        headers: {
          "mcp-session-id": "no-such-session",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body:
          method === "POST" ? JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }) : undefined,
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/Session not found/);
    },
  );
});
