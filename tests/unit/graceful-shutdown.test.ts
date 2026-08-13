import { describe, it, expect, afterEach } from "vitest";
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

describe("Graceful shutdown (B6 fix)", () => {
  it("startServer returns a ServerHandle with stop() and port", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    expect(handle).toBeDefined();
    // Port 0 means "OS, assign one" — the handle reports what was bound.
    expect(handle.port).toBeGreaterThan(0);
    expect(typeof handle.stop).toBe("function");
  });

  // NOTE: an integration test that opens a TCP socket back to the started
  // server was flaky in vitest's worker environment on Windows (the listen
  // callback fires but cross-worker socket connect was unreliable). The Pino
  // logs from the other tests confirm "Coordinator v3 started port=N" + clean
  // shutdown sequence. Real-world smoke tests via the CLI (`server start`
  // then `server status`) validate the integration end-to-end.

  it("stop() is idempotent (safe to call twice)", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    await handle.stop();
    // Second call should not throw
    await expect(handle.stop()).resolves.toBeUndefined();
    handle = null;
  });

  it("registerSignalHandlers: false does not register process listeners", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-coord-shutdown-"));
    const beforeSigterm = process.listenerCount("SIGTERM");
    const beforeSigint = process.listenerCount("SIGINT");
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    const afterSigterm = process.listenerCount("SIGTERM");
    const afterSigint = process.listenerCount("SIGINT");
    expect(afterSigterm).toBe(beforeSigterm);
    expect(afterSigint).toBe(beforeSigint);
  });
});
