import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { Metrics, serveMetrics } from "../../src/metrics.js";
import { createServices } from "../../src/server-setup.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import fs from "fs";
import { Writable } from "stream";

const TEST_DIR = "data-test-metrics";
let metrics: Metrics;
let services: CoordinatorServices;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  // Build a real services bundle so gauge snapshots have something to read.
  // Built once because createServices() also wires SSE listeners; multiple
  // calls would stack listeners on the same DB-backed emitter.
  services = createServices({ dataDir: TEST_DIR });
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM agents");
  db.exec("DELETE FROM events");
  // Disable default Node metrics in tests â€” they spawn timers that keep
  // vitest's process alive on shutdown and add noise to text-format checks.
  metrics = new Metrics({ collectDefault: false });
});

afterAll(async () => {
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  // Windows holds the .db handle briefly after better-sqlite3 close() (Defender/indexer);
  // use the async API so retries give the event loop time to drain pending releases.
  await fs.promises.rm(TEST_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

describe("Metrics counters", () => {
  it("recordAnnounce increments by result label", async () => {
    metrics.recordAnnounce("thread_opened");
    metrics.recordAnnounce("thread_opened");
    metrics.recordAnnounce("auto_resolved");

    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_announces_total\{result="thread_opened"\}\s+2/);
    expect(text).toMatch(/mcp_coordinator_announces_total\{result="auto_resolved"\}\s+1/);
  });

  it("recordThreadResolved increments by type label", async () => {
    metrics.recordThreadResolved("consensus");
    metrics.recordThreadResolved("timeout");
    metrics.recordThreadResolved("consensus");
    metrics.recordThreadResolved("agent_departure");

    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_threads_resolved_total\{type="consensus"\}\s+2/);
    expect(text).toMatch(/mcp_coordinator_threads_resolved_total\{type="timeout"\}\s+1/);
    expect(text).toMatch(/mcp_coordinator_threads_resolved_total\{type="agent_departure"\}\s+1/);
  });

  it("recordMqttPublish accumulates", async () => {
    for (let i = 0; i < 5; i++) metrics.recordMqttPublish();
    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_mqtt_publishes_total\s+5/);
  });

  it("recordHttpRequest stores route + status as labels", async () => {
    metrics.recordHttpRequest("/api/agents", 200);
    metrics.recordHttpRequest("/api/agents", 200);
    metrics.recordHttpRequest("/api/agents", 500);
    metrics.recordHttpRequest("/health", 200);

    const text = (await metrics.render()).body;
    expect(text).toMatch(
      /mcp_coordinator_http_requests_total\{route="\/api\/agents",status="200"\}\s+2/,
    );
    expect(text).toMatch(
      /mcp_coordinator_http_requests_total\{route="\/api\/agents",status="500"\}\s+1/,
    );
    expect(text).toMatch(
      /mcp_coordinator_http_requests_total\{route="\/health",status="200"\}\s+1/,
    );
  });

  it("recordAuthRejected increments", async () => {
    metrics.recordAuthRejected();
    metrics.recordAuthRejected();
    metrics.recordAuthRejected();

    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_auth_rejected_total\s+3/);
  });
});

describe("Metrics gauges", () => {
  it("gaugeSnapshot reflects online agents from services.registry", async () => {
    services.registry.register("default", "a1", "Agent A", ["src/auth"]);
    services.registry.register("default", "a2", "Agent B", ["src/users"]);
    services.registry.register("default", "a3", "Agent C", ["src/api"]);
    services.registry.setOffline("default", "a3");

    metrics.gaugeSnapshot(services);
    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_agents_online\s+2/);
  });

  it("gaugeSnapshot counts open + resolving threads from DB", async () => {
    // FK on threads.initiator_id -> agents.id; register before inserting.
    services.registry.register("default", "a1", "Agent A", []);
    const db = getDb();
    // Insert minimal thread rows directly â€” avoids triggering the full
    // announce workflow which has side effects on quota / SSE / MQTT.
    const insert = db.prepare(`
      INSERT INTO threads (id, initiator_id, subject, target_modules, target_files, status, expected_respondents)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("t1", "a1", "subj1", "[]", "[]", "open", "[]");
    insert.run("t2", "a1", "subj2", "[]", "[]", "open", "[]");
    insert.run("t3", "a1", "subj3", "[]", "[]", "resolving", "[]");
    insert.run("t4", "a1", "subj4", "[]", "[]", "resolved", "[]");

    metrics.gaugeSnapshot(services);
    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_threads_open\s+2/);
    expect(text).toMatch(/mcp_coordinator_threads_resolving\s+1/);
  });

  it("setSseClients / inc / dec track an externally-maintained counter", async () => {
    metrics.setSseClients(0);
    metrics.incSseClients();
    metrics.incSseClients();
    metrics.incSseClients();
    metrics.decSseClients();

    const text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_sse_clients_active\s+2/);
  });

  it("setMqttListeners stores the latest value", async () => {
    metrics.setMqttListeners(7);
    let text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_mqtt_listeners_active\s+7/);

    metrics.setMqttListeners(3);
    text = (await metrics.render()).body;
    expect(text).toMatch(/mcp_coordinator_mqtt_listeners_active\s+3/);
  });
});

describe("Metrics text exposition format", () => {
  it("emits a Prometheus-parseable response with HELP + TYPE per metric", async () => {
    metrics.recordAnnounce("thread_opened");
    metrics.recordHttpRequest("/health", 200);
    metrics.recordMqttPublish();

    const { body, contentType } = await metrics.render();

    // Content-type follows OpenMetrics / Prometheus exposition convention.
    expect(contentType).toMatch(/text\/plain/);
    expect(contentType).toMatch(/version=/);

    // Every metric we declared must have a HELP and TYPE line â€” the minimum
    // a Prometheus scraper needs to parse.
    const expected = [
      "mcp_coordinator_announces_total",
      "mcp_coordinator_threads_resolved_total",
      "mcp_coordinator_mqtt_publishes_total",
      "mcp_coordinator_http_requests_total",
      "mcp_coordinator_auth_rejected_total",
      "mcp_coordinator_agents_online",
      "mcp_coordinator_threads_open",
      "mcp_coordinator_threads_resolving",
      "mcp_coordinator_mqtt_listeners_active",
      "mcp_coordinator_sse_clients_active",
    ];
    for (const name of expected) {
      expect(body).toContain(`# HELP ${name}`);
      expect(body).toContain(`# TYPE ${name}`);
    }

    // Every non-comment line must be either blank or `name{labels?} value`.
    // No null-character corruption, no trailing JSON â€” basic sanity.
    const lines = body.split("\n").filter((l) => l && !l.startsWith("#"));
    for (const line of lines) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+[\d.eE+\-]+(\s+\d+)?$/);
    }
  });

  it("serveMetrics writes body + content-type to ServerResponse", async () => {
    metrics.recordAnnounce("thread_opened");
    metrics.recordAuthRejected();

    let writtenBody = "";
    let writtenStatus = 0;
    let writtenHeaders: Record<string, string> = {};
    const fakeRes = new Writable({
      write(chunk, _enc, cb) {
        writtenBody += chunk.toString();
        cb();
      },
    }) as unknown as import("http").ServerResponse & { writtenStatus?: number };
    (
      fakeRes as unknown as { writeHead: (s: number, h: Record<string, string>) => void }
    ).writeHead = (s: number, h: Record<string, string>) => {
      writtenStatus = s;
      writtenHeaders = h;
    };

    const fakeReq = {} as import("http").IncomingMessage;
    await serveMetrics(
      fakeReq,
      fakeRes as unknown as import("http").ServerResponse,
      services,
      metrics,
    );

    expect(writtenStatus).toBe(200);
    expect(writtenHeaders["Content-Type"]).toMatch(/text\/plain/);
    expect(writtenBody).toMatch(/mcp_coordinator_announces_total\{result="thread_opened"\}\s+1/);
    expect(writtenBody).toMatch(/mcp_coordinator_auth_rejected_total\s+1/);
  });

  it("multiple Metrics instances are isolated (per-instance Registry)", async () => {
    const m1 = new Metrics({ collectDefault: false });
    const m2 = new Metrics({ collectDefault: false });
    m1.recordAnnounce("thread_opened");
    m1.recordAnnounce("thread_opened");
    m2.recordAnnounce("thread_opened");

    const t1 = (await m1.render()).body;
    const t2 = (await m2.render()).body;
    expect(t1).toMatch(/mcp_coordinator_announces_total\{result="thread_opened"\}\s+2/);
    expect(t2).toMatch(/mcp_coordinator_announces_total\{result="thread_opened"\}\s+1/);
  });
});
