/**
 * protocole-mcp-02 (MCP spec MUST: validate Origin) + securite-surface-06
 * (CORS hardening / DNS-rebinding). Before this fix, `OPTIONS /mcp`
 * unconditionally reflected `Access-Control-Allow-Origin: *`, and the
 * transport never validated `Origin` on the actual request either.
 *
 * These tests exercise the real HTTP server (not just the pure
 * `isAllowedOrigin` unit — see tests for src/http/origin.ts), so a
 * regression in serve-http.ts's wiring is caught even if the helper itself
 * stays correct.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { createHttpHarness } from "../helpers/mcp-client-harness.js";
import { isAllowedOrigin } from "../../src/http/origin.js";

describe("isAllowedOrigin (pure helper — 100% branch coverage)", () => {
  it("allows a missing Origin header (non-browser clients: curl, MCP SDK)", () => {
    expect(isAllowedOrigin(undefined, undefined)).toBe(true);
  });

  it("allows http://localhost:<port>", () => {
    expect(isAllowedOrigin("http://localhost:3100", undefined)).toBe(true);
  });

  it("allows http://127.0.0.1:<port>", () => {
    expect(isAllowedOrigin("http://127.0.0.1:3100", undefined)).toBe(true);
  });

  it("allows the IPv6 loopback (URL.hostname normalizes '[::1]' to '::1')", () => {
    expect(isAllowedOrigin("http://[::1]:3100", undefined)).toBe(true);
  });

  it("rejects an arbitrary cross-site origin when no publicUrl is configured", () => {
    expect(isAllowedOrigin("https://evil.example", undefined)).toBe(false);
  });

  it("allows an Origin that matches COORDINATOR_PUBLIC_URL's origin exactly", () => {
    expect(
      isAllowedOrigin(
        "https://coordinator.example.com",
        "https://coordinator.example.com/some/path",
      ),
    ).toBe(true);
  });

  it("rejects an Origin that does not match the configured publicUrl", () => {
    expect(isAllowedOrigin("https://evil.example", "https://coordinator.example.com")).toBe(false);
  });

  it("rejects a malformed Origin header (URL parse failure hits the catch branch)", () => {
    expect(isAllowedOrigin("not-a-url", undefined)).toBe(false);
  });

  it("rejects when publicUrl itself is malformed (nested URL parse failure)", () => {
    expect(isAllowedOrigin("https://evil.example", "not-a-valid-url")).toBe(false);
  });
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        s.close();
        reject(new Error("getFreePort: could not resolve port"));
        return;
      }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

describe("Origin validation + CORS restriction on /mcp", () => {
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  it("rejects cross-site Origin on /mcp preflight (never reflects '*')", async () => {
    const port = await getFreePort();
    handle = await startServer({ port, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
    expect(res.status).toBe(403);
  });

  it("allows a same-host localhost Origin on preflight, reflecting it (not '*')", async () => {
    const port = await getFreePort();
    handle = await startServer({ port, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
    const origin = `http://localhost:${port}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: origin },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("preflight with no Origin header at all still succeeds (non-browser callers)", async () => {
    const port = await getFreePort();
    handle = await startServer({ port, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("rejects a cross-site Origin on an actual /mcp request (not just preflight)", async () => {
    const port = await getFreePort();
    handle = await startServer({ port, mqttTcpPort: await getFreePort(), mqttWsPath: "/mqtt" });
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("a request with no Origin header (MCP SDK client) still passes end-to-end", async () => {
    // The MCP SDK's HTTP client transport never sets an Origin header (that's
    // a browser-only concept). This is the exact regression this task must
    // not introduce: real tool round-trips over the SDK client must keep
    // working with the Origin check in place.
    const harness = await createHttpHarness();
    try {
      const tools = await harness.client.listTools();
      expect(tools.tools.length).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});
