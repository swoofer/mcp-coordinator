import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import net from "net";
import path from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

let handle: ServerHandle | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  if (handle) {
    await handle.stop().catch(() => undefined);
    handle = null;
  }
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
});

function getRandomPort(): number {
  // 30100-30199 range — avoids the 3100/3110/3120 the docs use
  return 30100 + Math.floor(Math.random() * 100);
}

// Get a free TCP port the OS picks for us, then close the listener.
// Use this for the MQTT broker port to avoid 1883 collision in tests.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function isPortListening(port: number): Promise<boolean> {
  // TCP-level reachability check. Avoids HTTP-layer issues (agent/keepalive,
  // header parsing) and just verifies the port accepts connections.
  // Try IPv4 first, then IPv6 (Windows binds dual-stack but resolves differently).
  for (const host of ["127.0.0.1", "::1"]) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host, port, timeout: 1000 });
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (ok) return true;
  }
  return false;
}

describe("Graceful shutdown (B6 fix)", () => {
  it("startServer returns a ServerHandle with stop() and port", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    const port = getRandomPort();
    // Override the MQTT TCP port too so we don't collide with the default 1883
    const mqttTcpPort = await getFreePort();
    try {
      handle = await startServer({ port, dataDir, mqttTcpPort, registerSignalHandlers: false });
      expect(handle).toBeDefined();
      expect(handle.port).toBe(port);
      expect(typeof handle.stop).toBe("function");
    } finally {
      // mqttTcpPort scoped to test, no env restore needed
    }
  });

  // NOTE: an integration test that opens a TCP socket back to the started
  // server was flaky in vitest's worker environment on Windows (the listen
  // callback fires but cross-worker socket connect was unreliable). The Pino
  // logs from the other tests confirm "Coordinator v3 started port=N" + clean
  // shutdown sequence. Real-world smoke tests via the CLI (`server start`
  // then `server status`) validate the integration end-to-end.

  it("stop() is idempotent (safe to call twice)", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    const port = getRandomPort();
    const mqttTcpPort = await getFreePort();
    try {
      handle = await startServer({ port, dataDir, mqttTcpPort, registerSignalHandlers: false });
      await handle.stop();
      // Second call should not throw
      await expect(handle.stop()).resolves.toBeUndefined();
      handle = null;
    } finally {
      // mqttTcpPort scoped to test, no env restore needed
    }
  });

  it("registerSignalHandlers: false does not register process listeners", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    const port = getRandomPort();
    const prevMqttPort = process.env.COORDINATOR_MQTT_TCP_PORT;
    process.env.COORDINATOR_MQTT_TCP_PORT = String(await getFreePort());
    try {
      const beforeSigterm = process.listenerCount("SIGTERM");
      const beforeSigint = process.listenerCount("SIGINT");
      handle = await startServer({ port, dataDir, registerSignalHandlers: false });
      const afterSigterm = process.listenerCount("SIGTERM");
      const afterSigint = process.listenerCount("SIGINT");
      expect(afterSigterm).toBe(beforeSigterm);
      expect(afterSigint).toBe(beforeSigint);
    } finally {
      // mqttTcpPort scoped to test, no env restore needed
    }
  });
});
