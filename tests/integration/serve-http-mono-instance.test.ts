/**
 * architecture-02: serve-http.ts holds module-level state (services, httpLog,
 * currentRunConfig) that every request handler closes over. A 2nd concurrent
 * startServer() in the same process would silently reassign that state out
 * from under the 1st instance's in-flight request handlers, corrupting it —
 * despite ServerOptions previously (incorrectly) documenting multi-instance
 * support. The fix is a fail-closed guard (serverRunning), NOT a rewrite to
 * per-instance closures (out of scope — see audit finding architecture-02).
 *
 * This suite pins:
 *   1. A 2nd startServer() without an intervening stop() throws immediately
 *      and does NOT disturb the 1st (still-running) instance.
 *   2. The legitimate sequential pattern — stop() then startServer() again —
 *      keeps working (this is NOT a "only ever call startServer() once"
 *      guard; it specifically targets *concurrent* instances).
 *   3. A startup failure (2nd start attempted while unrelated to an
 *      already-running instance) still leaves the guard in a state that
 *      allows a subsequent legitimate start once the blocking instance stops.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import http from "http";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function get(p: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: p, path: urlPath, method: "GET" },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const dataDirs: string[] = [];
const handles: ServerHandle[] = [];

function mkDataDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dataDirs.push(d);
  return d;
}

async function boot(prefix: string): Promise<ServerHandle> {
  const port = await getFreePort();
  const mqttTcpPort = await getFreePort();
  const handle = await startServer({
    port,
    dataDir: mkDataDir(prefix),
    mqttTcpPort,
    registerSignalHandlers: false,
  });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  // Best-effort teardown of anything a test left running.
  for (const h of handles.splice(0)) {
    try {
      await h.stop();
    } catch {
      // already stopped / never fully started — ignore
    }
  }
  for (const d of dataDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("architecture-02: mono-instance-per-process fail-closed guard", () => {
  it("a 2nd startServer() without an intervening stop() throws, and does not disturb the 1st instance", async () => {
    const first = await boot("arch02-first-");

    const secondPort = await getFreePort();
    const secondMqttPort = await getFreePort();
    await expect(
      startServer({
        port: secondPort,
        dataDir: mkDataDir("arch02-second-"),
        mqttTcpPort: secondMqttPort,
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow(/already running in this process/);

    // The 1st instance must still be alive and answering — the failed 2nd
    // attempt must not have reassigned the module-level services/httpLog
    // out from under it.
    const r = await get(first.port, "/livez");
    expect(r.status).toBe(200);
  });

  it("sequential startServer → stop → startServer keeps working (legitimate restart pattern)", async () => {
    const first = await boot("arch02-seq1-");
    const firstPort = first.port;
    let r1 = await get(firstPort, "/livez");
    expect(r1.status).toBe(200);

    await first.stop();
    // stop() must release the guard so a subsequent legitimate start succeeds.
    handles.splice(handles.indexOf(first), 1);

    const second = await boot("arch02-seq2-");
    const r2 = await get(second.port, "/livez");
    expect(r2.status).toBe(200);
  });

  it("after a rejected concurrent-start attempt, stopping the running instance unblocks a fresh start", async () => {
    const first = await boot("arch02-unblock1-");

    await expect(
      startServer({
        port: await getFreePort(),
        dataDir: mkDataDir("arch02-unblock2-"),
        mqttTcpPort: await getFreePort(),
        registerSignalHandlers: false,
      }),
    ).rejects.toThrow(/already running in this process/);

    await first.stop();
    handles.splice(handles.indexOf(first), 1);

    const third = await boot("arch02-unblock3-");
    const r = await get(third.port, "/livez");
    expect(r.status).toBe(200);
  });
});
