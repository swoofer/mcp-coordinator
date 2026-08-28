/**
 * POST /api/threads-summary — thread counts by status for one run, scoped
 * by org.
 *
 * Why this exists: /api/threads-active only ever reports 'open' and
 * 'resolving' threads (see handleThreadsActive). A 'poisoned' thread (F4 —
 * unclaimed POISON_THRESHOLD times, see handleUnclaimTask) is a table
 * UPDATE with no matching SSE event, so a client reconstructing a run's
 * outcome from the event stream (essaim's orchestrator/metrics.ts) cannot
 * tell a genuinely abandoned thread from a resolved one — it can only bucket
 * both into "without consensus". This endpoint answers the DB truth
 * directly: counts per ThreadStatus for a given run_id.
 *
 * Deliberately NOT reusing consultation.listThreads({ run_id })'s
 * "run_id = ? OR run_id IS NULL" semantics: that OR exists so a live agent
 * doesn't miss a human session's threads while deciding what to work on.
 * A run's final report is the opposite question — "what did THIS run do" —
 * so un-scoped (run_id IS NULL) threads must NOT be folded in here, or a
 * concurrent human session would inflate another run's numbers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth } from "../../src/auth.js";
import { handleRest, type RestContext } from "../../src/http/handle-rest.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { AgentActivityTracker } from "../../src/agent-activity.js";
import { Consultation } from "../../src/consultation.js";
import { FileTracker } from "../../src/file-tracker.js";
import { IntrospectionManager } from "../../src/introspection.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import { MqttBridge } from "../../src/mqtt-bridge.js";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";
import { Metrics } from "../../src/metrics.js";
import { TreeSitterExtractor } from "../../src/tree-sitter-extractor.js";
import { silentLogger } from "../../src/logger.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import fs from "fs";

const DIR = "data-test-threads-summary";
const SECRET = "test-secret-at-least-32-characters-long!";
const CLAIMS_HR: AuthClaims = {
  sub: "agent-a",
  user_id: "user-a",
  org: "org-hr",
  role: "agent",
  jti: "j-hr",
};
const CLAIMS_OTHER: AuthClaims = {
  sub: "agent-b",
  user_id: "user-b",
  org: "org-other",
  role: "agent",
  jti: "j-other",
};

let services: CoordinatorServices;

function makeServices(): CoordinatorServices {
  const logger = silentLogger;
  const metrics = new Metrics();
  const registry = new AgentRegistry();
  const activityTracker = new AgentActivityTracker(registry);
  const consultation = new Consultation();
  const fileTracker = new FileTracker();
  const workingFiles = new WorkingFilesTracker(logger, metrics);
  const introspection = new IntrospectionManager();
  const sseEmitter = new SseEmitter();
  const mqttBridge = new MqttBridge("default", logger);
  const treeSitter = new TreeSitterExtractor(metrics);
  return {
    logger,
    registry,
    activityTracker,
    consultation,
    conflictDetector: undefined as never,
    depMap: undefined as never,
    fileTracker,
    impactScorer: undefined as never,
    workingFiles,
    introspection,
    contextProvider: undefined as never,
    sseEmitter,
    mqttBridge,
    quotaCache: undefined as never,
    metrics,
    treeSitter,
    gitCochange: null,
  };
}

function mockReq(body: object, url: string, method = "POST"): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  req.method = method;
  req.url = url;
  (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (chunk: unknown) => void }).push(null);
  return req;
}

function mockRes(): { res: ServerResponse; getStatus: () => number; getBody: () => unknown } {
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead(s: number) {
      status = s;
    },
    end(buf?: string) {
      if (buf) chunks.push(buf);
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => (chunks.length ? JSON.parse(chunks.join("")) : null),
  };
}

function makeCtx(overrides?: Partial<RestContext>): RestContext {
  return {
    services,
    httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    authEnabled: false,
    claims: CLAIMS_HR,
    ...overrides,
  };
}

async function postThreadsSummary(
  body: object,
  ctx: RestContext = makeCtx(),
): Promise<{ status: number; body: unknown }> {
  const { res, getStatus, getBody } = mockRes();
  await handleRest(mockReq(body, "/api/threads-summary"), res, ctx);
  return { status: getStatus(), body: getBody() };
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
  seedTestOrgs(getDb(), ["org-hr", "org-other"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM introspections");
  db.exec("DELETE FROM agents");
  services = makeServices();
  services.registry.register("org-hr", "agent-a", "Agent A", []);
  services.registry.register("org-other", "agent-b", "Agent B", []);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
  initAuth(SECRET);
});

describe("POST /api/threads-summary — validation", () => {
  it("400s when run_id is missing", async () => {
    const { status, body } = await postThreadsSummary({});
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toMatch(/run_id/);
  });

  it("400s on an empty run_id", async () => {
    const { status } = await postThreadsSummary({ run_id: "" });
    expect(status).toBe(400);
  });
});

describe("GET /api/threads-summary — read-only, not blocked by the method allowlist", () => {
  it("is not rejected with 405 on GET", async () => {
    const { res, getStatus } = mockRes();
    await handleRest(mockReq({ run_id: "run-1" }, "/api/threads-summary", "GET"), res, makeCtx());
    expect(getStatus()).not.toBe(405);
  });
});

describe("POST /api/threads-summary — counts by status, scoped to one run", () => {
  it("counts one thread of each status for the target run, ignoring other runs and un-scoped threads", async () => {
    const { consultation } = services;

    // open
    consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "open thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-1",
    });

    // resolving
    const resolving = consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "resolving thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-1",
    });
    consultation.proposeResolution("org-hr", resolving.id, "agent-a", "proposed");

    // resolved (no other expected respondents, so a single approval closes it)
    const resolved = consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "resolved thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-1",
    });
    consultation.proposeResolution("org-hr", resolved.id, "agent-a", "proposed");
    consultation.approveResolution("org-hr", resolved.id, "agent-a");

    // cancelled
    const cancelled = consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "cancelled thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-1",
    });
    consultation.cancelThread("org-hr", cancelled.id, "agent-a");

    // poisoned — same real path as production: claim then unclaim twice
    // (POISON_THRESHOLD=2), through the REST handler exactly like an
    // essaim worker would.
    const poisoned = consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "poisoned thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-1",
    });
    for (let i = 0; i < 2; i++) {
      await handleRest(
        mockReq({ thread_id: poisoned.id, agent_id: "agent-a" }, "/api/claim-task"),
        mockRes().res,
        makeCtx(),
      );
      await handleRest(
        mockReq({ thread_id: poisoned.id, agent_id: "agent-a" }, "/api/unclaim-task"),
        mockRes().res,
        makeCtx(),
      );
    }

    // Noise that must NOT be counted: a different run, and an un-scoped
    // (human session) thread.
    consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "other run",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "run-2",
    });
    consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "human session, no run_id",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });

    const { status, body } = await postThreadsSummary({ run_id: "run-1" });
    expect(status).toBe(200);
    expect(body).toEqual({
      run_id: "run-1",
      total: 5,
      counts: {
        open: 1,
        resolving: 1,
        resolved: 1,
        cancelled: 1,
        poisoned: 1,
      },
    });
  });

  it("returns all-zero counts for a run_id with no threads", async () => {
    const { status, body } = await postThreadsSummary({ run_id: "run-nothing-here" });
    expect(status).toBe(200);
    expect(body).toEqual({
      run_id: "run-nothing-here",
      total: 0,
      counts: { open: 0, resolving: 0, resolved: 0, cancelled: 0, poisoned: 0 },
    });
  });
});

describe("POST /api/threads-summary — cross-org isolation", () => {
  it("does not count another org's threads for the same run_id", async () => {
    services.consultation.announceWork("org-hr", {
      agent_id: "agent-a",
      subject: "org-hr thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "shared-run-id",
    });
    services.consultation.announceWork("org-other", {
      agent_id: "agent-b",
      subject: "org-other thread",
      target_modules: [],
      target_files: [],
      keep_open: true,
      run_id: "shared-run-id",
    });

    const hr = await postThreadsSummary({ run_id: "shared-run-id" }, makeCtx());
    expect(hr.status).toBe(200);
    expect((hr.body as { counts: { open: number } }).counts.open).toBe(1);

    const other = await postThreadsSummary(
      { run_id: "shared-run-id" },
      makeCtx({ claims: CLAIMS_OTHER }),
    );
    expect(other.status).toBe(200);
    expect((other.body as { counts: { open: number } }).counts.open).toBe(1);
  });
});
