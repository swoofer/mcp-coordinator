import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { startEmbeddedMqttBroker, type EmbeddedMqttBroker } from "../../src/mqtt-broker.js";
import { silentLogger } from "../../src/logger.js";

/**
 * issue #330 — the MQTT broker's two legs are exposed differently. The TCP leg
 * is pinned to `127.0.0.1`; the WebSocket leg rides the HTTP server and so
 * follows `COORDINATOR_BIND`. It used to gate on the request path and nothing
 * else, which meant a page on ANY origin could open an MQTT connection through
 * a visitor's browser.
 *
 * The check added is the same helper `/mcp` already uses, and that choice is
 * load-bearing: `isAllowedOrigin` returns true for a MISSING Origin header,
 * because the browser same-origin model is what it defends against. Every
 * non-browser MQTT client is therefore untouched — the difference between
 * closing a vector and breaking every deployment.
 *
 * What this does NOT close is the LAN exposure: a non-browser client on the
 * network still connects. That needs broker authentication, tracked separately.
 */

let httpServer: Server | null = null;
let broker: EmbeddedMqttBroker | null = null;

afterEach(async () => {
  if (broker) await broker.close();
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  broker = null;
  httpServer = null;
  delete process.env.COORDINATOR_PUBLIC_URL;
});

/** Start the broker on an ephemeral HTTP port and return that port. */
async function start(): Promise<number> {
  httpServer = createServer();
  await new Promise<void>((r) => httpServer!.listen(0, "127.0.0.1", () => r()));
  broker = await startEmbeddedMqttBroker({
    tcpPort: 0,
    httpServer,
    wsPath: "/mqtt",
    logger: silentLogger,
  });
  const addr = httpServer.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

/**
 * Send a raw WebSocket upgrade and report the first response line, or
 * "SWITCHING" when the server accepted it.
 */
function upgrade(port: number, origin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(port, "127.0.0.1", () => {
      const lines = [
        "GET /mqtt HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (origin !== undefined) lines.push(`Origin: ${origin}`);
      sock.write(lines.join("\r\n") + "\r\n\r\n");
    });
    sock.setTimeout(5000, () => {
      sock.destroy();
      reject(new Error("upgrade timed out"));
    });
    sock.once("data", (buf: Buffer) => {
      const first = buf.toString("utf8").split("\r\n")[0];
      sock.destroy();
      resolve(first.includes("101") ? "SWITCHING" : first);
    });
    sock.once("error", reject);
  });
}

describe("the WebSocket leg checks the origin (#330)", () => {
  it("refuses a browser page from a foreign origin", async () => {
    const port = await start();
    expect(await upgrade(port, "https://evil.example")).toContain("403");
  });

  it("accepts a client that sends no Origin at all — every non-browser client", async () => {
    // The load-bearing case. mqtt.js in Node, the channel sidecar and
    // mosquitto_sub all connect without an Origin header; refusing them would
    // break every existing deployment to close a browser-only vector.
    const port = await start();
    expect(await upgrade(port)).toBe("SWITCHING");
  });

  it("accepts localhost, which is the normal dashboard case", async () => {
    const port = await start();
    expect(await upgrade(port, "http://localhost:3100")).toBe("SWITCHING");
    expect(await upgrade(port, "http://127.0.0.1:3100")).toBe("SWITCHING");
  });

  it("accepts the configured public origin", async () => {
    process.env.COORDINATOR_PUBLIC_URL = "https://coordinator.example.com";
    const port = await start();
    expect(await upgrade(port, "https://coordinator.example.com")).toBe("SWITCHING");
  });

  it("and still refuses a foreign origin once a public URL is configured", async () => {
    process.env.COORDINATOR_PUBLIC_URL = "https://coordinator.example.com";
    const port = await start();
    expect(await upgrade(port, "https://evil.example")).toContain("403");
  });
});
