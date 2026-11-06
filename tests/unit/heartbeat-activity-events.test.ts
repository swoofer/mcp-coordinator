/**
 * A heartbeat publishes an `agent_activity` event only when the agent's
 * activity actually changes (status, current file or current thread).
 *
 * Every heartbeat used to emit one. In production, 15 task-runner agents
 * heartbeating every ~3 s produced ~5 identical "idle" events per second:
 * the dashboard timeline showed nothing else, and each event is also a row
 * in the `events` table (ids were past 22 million).
 *
 * Harness: the real `heartbeat` tool registered on a real McpServer and
 * invoked through the SDK's `_registeredTools` map, as in
 * mcp-tool-org-scoping.test.ts. registerAgentTools only reads `registry`,
 * `activityTracker` and `sseEmitter`, so only those are provided.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { AgentActivityTracker } from "../../src/agent-activity.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import { silentLogger } from "../../src/logger.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import { registerAgentTools } from "../../src/tools/agents-tools.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
import type { CoordinatorEvent } from "../../src/types.js";
import fs from "fs";

const TEST_DIR = "data-test-heartbeat-events";
const ORG = "org-heartbeat";
const CLAIMS: AuthClaims = { sub: "a1", user_id: "a1", org: ORG, role: "agent", jti: "j-hb" };

let tracker: AgentActivityTracker;
let registry: AgentRegistry;
let activityEvents: Array<{ activity_status: string; current_file: string | null }>;
let heartbeat: (args: Record<string, unknown>) => Promise<unknown>;

// SseEmitter fans out to listeners via setImmediate: let that tick run.
const flushFanOut = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  seedTestOrgs(getDb(), [ORG]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM agent_activity_status");
  db.exec("DELETE FROM agents");
  registry = new AgentRegistry();
  tracker = new AgentActivityTracker(registry);
  const sseEmitter = new SseEmitter();
  registry.register(ORG, "a1", "Agent One", ["mod"]);

  activityEvents = [];
  sseEmitter.addListener(ORG, (event: CoordinatorEvent) => {
    if (event.type === "agent_activity") activityEvents.push(JSON.parse(event.payload));
  });

  const server = new McpServer({ name: "test", version: "0" });
  const services = {
    registry,
    activityTracker: tracker,
    sseEmitter,
  } as unknown as CoordinatorServices;
  registerAgentTools(server, services, silentLogger, (sid) => (sid === "sess-hb" ? CLAIMS : null));
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown, e: ServerContext) => Promise<unknown> }
      >;
    }
  )._registeredTools.heartbeat;
  const extra = {
    signal: new AbortController().signal,
    sessionId: "sess-hb",
    mcpReq: { id: 1, method: "tools/call" },
  } as unknown as ServerContext;
  heartbeat = (args) => registered.handler(args, extra);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("heartbeat → agent_activity events", () => {
  it("emits once for a run of identical heartbeats", async () => {
    await heartbeat({ agent_id: "a1" });
    await heartbeat({ agent_id: "a1" });
    await heartbeat({ agent_id: "a1" });
    await flushFanOut();

    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0].activity_status).toBe("idle");
  });

  it("emits again whenever the current file changes", async () => {
    await heartbeat({ agent_id: "a1" });
    await heartbeat({ agent_id: "a1", current_file: "src/a.ts" });
    await heartbeat({ agent_id: "a1", current_file: "src/a.ts" });
    await heartbeat({ agent_id: "a1", current_file: "src/b.ts" });
    await heartbeat({ agent_id: "a1" });
    await flushFanOut();

    expect(activityEvents.map((e) => e.current_file)).toEqual([null, "src/a.ts", "src/b.ts", null]);
  });

  it("emits when the status was changed by something other than a heartbeat", async () => {
    await heartbeat({ agent_id: "a1" });
    // A file edit flips the stored status to "working" without an event of
    // its own on this path; the next idle heartbeat is a real change.
    tracker.reportFileActivity(ORG, "a1", "src/x.ts");
    await heartbeat({ agent_id: "a1" });
    await flushFanOut();

    expect(activityEvents.map((e) => e.activity_status)).toEqual(["idle", "idle"]);
  });

  it("emits when an agent announced offline beats again, activity unchanged", async () => {
    await heartbeat({ agent_id: "a1" });
    // The MQTT departure path marks the agent offline (and the dashboard
    // shows it so) without touching its activity row, which stays "idle".
    registry.setOffline(ORG, "a1");
    await heartbeat({ agent_id: "a1" });
    await flushFanOut();

    expect(activityEvents.map((e) => e.activity_status)).toEqual(["idle", "idle"]);
  });

  it("emits when an agent that aged out of the online list beats again", async () => {
    await heartbeat({ agent_id: "a1" });
    // Silent for longer than the online TTL: still status 'online', but
    // listOnline (and so the dashboard's agent list) leaves it out.
    getDb()
      .prepare(
        "UPDATE agents SET last_seen_at = datetime('now', '-1 day') WHERE org_id = ? AND id = ?",
      )
      .run(ORG, "a1");
    await heartbeat({ agent_id: "a1" });
    await flushFanOut();

    expect(activityEvents.map((e) => e.activity_status)).toEqual(["idle", "idle"]);
  });
});
