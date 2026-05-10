import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import http from "http";

let handle: ServerHandle, dataDir: string, port: number;

async function getFreePort(): Promise<number> {
  return new Promise(r => {
    const s = http.createServer().listen(0, () => {
      const p = (s.address() as any).port;
      s.close(() => r(p));
    });
  });
}

describe("/api/scoring-stats", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ss-"));
    port = await getFreePort();
    handle = await startServer({ port, dataDir, mqttTcpPort: await getFreePort(), registerSignalHandlers: false });
    // Seed a few firings
    const db = getDb();
    db.prepare("INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?,?,?,?)").run("t1", "L1", 100, "alice");
    db.prepare("INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?,?,?,?)").run("t1", "L4", 60, "bob");
  });
  afterAll(async () => { await handle?.stop(); rmSync(dataDir, { recursive: true, force: true }); });

  it("returns aggregated layer counts", async () => {
    const r = await new Promise<any>((resolve, reject) => {
      http.get(`http://localhost:${port}/api/scoring-stats?since=24h`, (res) => {
        let buf = "";
        res.on("data", c => buf += c);
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
      }).on("error", reject);
    });
    expect(r.status).toBe(200);
    expect(r.body.layers).toBeDefined();
    const l1 = r.body.layers.find((l: any) => l.layer === "L1");
    expect(l1?.fire_count).toBe(1);
  });
});
