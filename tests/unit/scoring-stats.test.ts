import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { startServer, type ServerHandle } from "../../src/serve-http.js";
import { getDb } from "../../src/database.js";
import http from "http";

let handle: ServerHandle, dataDir: string, port: number;

describe("/api/scoring-stats", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ss-"));
    handle = await startServer({
      port: 0,
      dataDir,
      mqttTcpPort: 0,
      registerSignalHandlers: false,
    });
    port = handle.port;
    // Seed a few firings
    const db = getDb();
    db.prepare(
      "INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?,?,?,?)",
    ).run("t1", "L1", 100, "alice");
    db.prepare(
      "INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?,?,?,?)",
    ).run("t1", "L4", 60, "bob");
  });
  afterAll(async () => {
    await handle?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns aggregated layer counts", async () => {
    const r = await new Promise<any>((resolve, reject) => {
      http
        .get(`http://localhost:${port}/api/scoring-stats?since=24h`, (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
        })
        .on("error", reject);
    });
    expect(r.status).toBe(200);
    expect(r.body.layers).toBeDefined();
    const l1 = r.body.layers.find((l: any) => l.layer === "L1");
    expect(l1?.fire_count).toBe(1);
  });

  it("aggregates outcomes from thread_resolved events", async () => {
    const db = getDb();
    // Add two auto_resolved events for thread t1 (already has an L1 firing)
    db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run(
      "thread_resolved",
      JSON.stringify({ thread_id: "t1", resolution_type: "auto_resolved" }),
    );
    db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run(
      "thread_resolved",
      JSON.stringify({ thread_id: "t1", resolution_type: "auto_resolved" }),
    );
    // Add a consensus event for a new thread + firing
    db.prepare(
      "INSERT INTO layer_firings (thread_id, layer, score, agent_id) VALUES (?,?,?,?)",
    ).run("t2", "L1", 80, "carol");
    db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)").run(
      "thread_resolved",
      JSON.stringify({ thread_id: "t2", resolution_type: "consensus" }),
    );

    const r = await new Promise<any>((resolve, reject) => {
      http
        .get(`http://localhost:${port}/api/scoring-stats?since=24h`, (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
        })
        .on("error", reject);
    });
    expect(r.status).toBe(200);
    const l1 = r.body.layers.find((l: any) => l.layer === "L1");
    expect(l1).toBeDefined();
    // L1 has firings for t1 (2 auto_resolved events) and t2 (1 consensus event)
    expect(l1.outcomes.auto_resolved).toBeGreaterThanOrEqual(2);
    expect(l1.outcomes.consensus).toBeGreaterThanOrEqual(1);
    expect(l1.outcomes.timeout).toBe(0);
    expect(l1.outcomes.cancelled).toBe(0);
  });
});
