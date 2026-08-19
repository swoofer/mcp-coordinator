import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import net from "node:net";
import http from "node:http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

/**
 * issue #280 — a busy MQTT port must not take the HTTP server down.
 *
 * wireMqtt was unguarded, and mqtt-broker.ts rejects on the TCP listener's
 * error event, so an occupied 1883 (a previous daemon still alive, or any
 * other broker on the box) killed the whole boot. Every other part of the tree
 * already treats the broker as optional.
 */
let handle: ServerHandle | undefined;
let squatter: net.Server | undefined;
let dataDir: string | undefined;

/** Bind a TCP port and keep it, so the broker cannot have it. */
function occupyPort(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({ port: addr.port, server });
    });
  });
}

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  delete process.env.COORDINATOR_MQTT_REQUIRED;
  await handle?.stop();
  handle = undefined;
  await new Promise<void>((r) => (squatter ? squatter.close(() => r()) : r()));
  squatter = undefined;
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Windows holds the SQLite handle a moment after close; teardown EBUSY
      // is treated as noise here, as elsewhere in the suite.
    }
    dataDir = undefined;
  }
}, 60000);

describe("MQTT is optional at startup (#280)", () => {
  it("starts and serves HTTP when the MQTT port is already taken", async () => {
    const taken = await occupyPort();
    squatter = taken.server;
    dataDir = mkdtempSync(path.join(tmpdir(), "mqtt-optional-"));

    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: taken.port,
      registerSignalHandlers: false,
    });

    // The point of the issue: the daemon is up, not that MQTT recovered.
    expect(await get(handle.port, "/healthz")).toBe(200);
  }, 60000);

  it("still fails the boot when COORDINATOR_MQTT_REQUIRED=true", async () => {
    const taken = await occupyPort();
    squatter = taken.server;
    dataDir = mkdtempSync(path.join(tmpdir(), "mqtt-required-"));
    process.env.COORDINATOR_MQTT_REQUIRED = "true";

    await expect(
      startServer({
        port: 0,
        dataDir,
        mqttTcpPort: taken.port,
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow();
  }, 60000);
});
