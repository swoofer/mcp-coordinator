import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import http from "http";

let handle: ServerHandle;
let dataDir: string;
let port: number;

function getRandomPort(): number {
  return 4000 + Math.floor(Math.random() * 1000);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });
}

function postJson(p: number, urlPath: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: "localhost", port: p, path: urlPath, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode!, body: buf ? JSON.parse(buf) : {} }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("working-files HTTP", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "wf-http-"));
    port = await getFreePort();
    const mqttTcpPort = await getFreePort();
    handle = await startServer({ port, dataDir, mqttTcpPort, registerSignalHandlers: false });
  });
  afterAll(async () => { await handle?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it("POST /api/working-files/start → 200", async () => {
    const r = await postJson(port, "/api/working-files/start", { agent_id: "alice", file_path: "src/foo.ts" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("POST /api/working-files/stop is idempotent", async () => {
    await postJson(port, "/api/working-files/start", { agent_id: "bob", file_path: "src/bar.ts" });
    const r1 = await postJson(port, "/api/working-files/stop", { agent_id: "bob", file_path: "src/bar.ts" });
    const r2 = await postJson(port, "/api/working-files/stop", { agent_id: "bob", file_path: "src/bar.ts" });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  it("rejects missing agent_id", async () => {
    const r = await postJson(port, "/api/working-files/start", { file_path: "x" });
    expect(r.status).toBe(400);
  });
});
