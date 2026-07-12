import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import net from "net";
import path from "path";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { closeDb } from "../../src/database.js";

/**
 * qualite-code-08: the global HTTP catch used to serialize `err.message`
 * straight into the 500 body (`{ error: (err as Error).message }`), leaking
 * SQLite driver internals / file paths to the client. It now returns the
 * generic `appError("INTERNAL_ERROR", "Internal server error")` envelope
 * (with `request_id`) while the real error detail stays server-side in the
 * log only.
 *
 * To force a real internal-error path (not a handled 4xx), this test closes
 * the coordinator's live DB connection out from under a running server —
 * closeDb() operates on database.ts's module-level singleton, which the
 * running server also uses — then hits an endpoint (/api/reset, allowed in
 * NODE_ENV=test) that calls getDb().exec(...). better-sqlite3 throws
 * "The database connection is not open" for that, which is exactly the kind
 * of internal detail this fix must not leak.
 */

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
  return 31400 + Math.floor(Math.random() * 200);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function httpRequest(opts: {
  port: number; method: string; path: string; body?: unknown;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request({
      host: "127.0.0.1", port: opts.port, path: opts.path, method: opts.method, timeout: 5000,
      headers: bodyStr ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {},
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("HTTP timeout")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe("qualite-code-08 - generic 500, no internal detail leak", () => {
  it("500 response body has no SQLite/db-internal detail and carries a request_id", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "s08-500-"));
    const port = getRandomPort();
    const mqttTcpPort = await getFreePort();
    handle = await startServer({ port, dataDir, mqttTcpPort, registerSignalHandlers: false });

    // Force the next DB access inside the server to throw.
    closeDb();

    const res = await httpRequest({ port, method: "POST", path: "/api/reset", body: {} });

    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.code).toBe("INTERNAL_ERROR");
    expect(parsed.message).toBe("Internal server error");
    expect(parsed.request_id).toBeTruthy();
    // Negative assertions (R5 adversarial): no leaked internal detail.
    expect(res.body).not.toContain("database connection");
    expect(res.body).not.toContain("SQLITE");
    expect(res.body.toLowerCase()).not.toContain(dataDir.toLowerCase());
    expect(res.body).not.toContain(process.cwd());
  });
});
