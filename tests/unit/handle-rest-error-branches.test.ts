/**
 * tests-06 (audit) — targeted coverage for handle-rest.ts branches that
 * survived the recent REST hardening (zod validation — see
 * rest-schemas-validation.test.ts) and the cross-tenant isolation sweep
 * (auth-cross-tenant-isolation.test.ts) without a direct exercise: 404/410
 * "not found"/"gone" branches, the claim/unclaim state-machine detail
 * fields, the quota 503 fail-open path, and the /api/reset guard branch
 * (both forbidden and success).
 *
 * Not a push for 100% — endpoints already covered elsewhere (validation
 * 400s, cross-tenant scoping, scoring-stats, working-files) are
 * intentionally NOT repeated here.
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

const DIR = "data-test-handle-rest-errors";
const SECRET = "test-secret-at-least-32-characters-long!";
const CLAIMS: AuthClaims = { sub: "agent-a", user_id: "user-a", org: "org-hr", role: "agent", jti: "j-hr" };

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
    // Not exercised by the endpoints under test here — undefined is fine,
    // handleRest destructures but never calls these for our target routes.
    conflictDetector: undefined as never,
    depMap: undefined as never,
    fileTracker,
    impactScorer: undefined as never,
    workingFiles,
    introspection,
    contextProvider: undefined as never,
    sseEmitter,
    mqttBridge,
    // Overridden per-test where quota semantics matter.
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
    writeHead(s: number) { status = s; },
    end(buf?: string) { if (buf) chunks.push(buf); },
  } as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => (chunks.length ? JSON.parse(chunks.join("")) : null) };
}

function makeCtx(overrides?: Partial<RestContext>): RestContext {
  return {
    services,
    httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    authEnabled: false,
    claims: CLAIMS,
    getRunConfig: () => null,
    setRunConfig: () => {},
    ...overrides,
  };
}

beforeAll(() => {
  fs.mkdirSync(DIR, { recursive: true });
  initDatabase(DIR);
  initAuth(SECRET);
  seedTestOrgs(getDb(), ["org-hr"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM introspections");
  db.exec("DELETE FROM agents");
  services = makeServices();
  services.registry.register("org-hr", "agent-a", "Agent A", []);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
  initAuth(SECRET);
});

describe("POST /api/post-to-thread — 404/410 branches", () => {
  it("404 thread_not_found for an unknown thread_id", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ thread_id: "nope", agent_id: "agent-a", type: "context", content: "hi" }, "/api/post-to-thread"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: "thread_not_found", thread_id: "nope" });
  });

  it("410 thread_cancelled for a cancelled thread", async () => {
    const thread = services.consultation.announceWork("org-hr", {
      agent_id: "agent-a", subject: "s", target_modules: [], target_files: [], keep_open: true,
    });
    services.consultation.cancelThread("org-hr", thread.id, "agent-a");

    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ thread_id: thread.id, agent_id: "agent-a", type: "context", content: "too late" }, "/api/post-to-thread"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(410);
    expect(getBody()).toEqual({ error: "thread_cancelled", thread_id: thread.id });
  });
});

describe("GET /api/consultation/:id/status — 404 branch", () => {
  it("404 for an unknown thread id", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({}, "/api/consultation/does-not-exist/status", "GET"), res, makeCtx());
    expect(getStatus()).toBe(404);
    expect(getBody()).toEqual({ error: "not found" });
  });
});

describe("POST /api/claim-task — already-claimed / assigned_to detail branches", () => {
  it("success:false with claimed_by populated when the thread is already claimed", async () => {
    const thread = services.consultation.announceWork("org-hr", {
      agent_id: "agent-a", subject: "s", target_modules: [], target_files: [], keep_open: true,
    });
    services.registry.register("org-hr", "agent-b", "Agent B", []);
    // First claim succeeds.
    const first = mockRes();
    await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-a" }, "/api/claim-task"), first.res, makeCtx());
    expect((first.getBody() as { success: boolean }).success).toBe(true);

    // Second claim by a different agent must report WHY it failed.
    const second = mockRes();
    await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-b" }, "/api/claim-task"), second.res, makeCtx());
    const body = second.getBody() as { success: boolean; claimed_by: string | null; assigned_to: string | null; status: string };
    expect(body.success).toBe(false);
    expect(body.claimed_by).toBe("agent-a");
    expect(body.status).toBe("open");
  });

  it("success:false with assigned_to populated when the thread is directed to a different agent", async () => {
    services.registry.register("org-hr", "agent-target", "Target", []);
    const thread = services.consultation.announceWork("org-hr", {
      agent_id: "agent-a", subject: "directed", target_modules: [], target_files: [],
      keep_open: true, assigned_to: "agent-target",
    });
    const { res, getBody } = mockRes();
    await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-a" }, "/api/claim-task"), res, makeCtx());
    const body = getBody() as { success: boolean; assigned_to: string | null };
    expect(body.success).toBe(false);
    expect(body.assigned_to).toBe("agent-target");
  });
});

describe("POST /api/unclaim-task — poison-after-threshold branch", () => {
  it("flips the thread to poisoned after repeated unclaims (POISON_THRESHOLD=2)", async () => {
    const thread = services.consultation.announceWork("org-hr", {
      agent_id: "agent-a", subject: "s", target_modules: [], target_files: [], keep_open: true,
    });

    async function claimThenUnclaim(): Promise<{ success: boolean; poisoned: boolean }> {
      await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-a" }, "/api/claim-task"), mockRes().res, makeCtx());
      const { res, getBody } = mockRes();
      await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-a" }, "/api/unclaim-task"), res, makeCtx());
      return getBody() as { success: boolean; poisoned: boolean };
    }

    const r1 = await claimThenUnclaim();
    // 1st unclaim: unclaim_count -> 1, below POISON_THRESHOLD (2).
    expect(r1).toEqual({ success: true, poisoned: false });
    const r2 = await claimThenUnclaim();
    // 2nd unclaim: unclaim_count -> 2, hits POISON_THRESHOLD (>=2) -> poisoned:true.
    expect(r2).toEqual({ success: true, poisoned: true });

    // A poisoned thread can no longer be claimed (status != 'open').
    const { res, getBody } = mockRes();
    await handleRest(mockReq({ thread_id: thread.id, agent_id: "agent-a" }, "/api/claim-task"), res, makeCtx());
    const claimAttempt = getBody() as { success: boolean; status: string };
    expect(claimAttempt.success).toBe(false);
    expect(claimAttempt.status).toBe("poisoned");
  });
});

describe("GET/POST /api/quota, /api/quota/refresh — 503 fail-open branch", () => {
  function fakeUnavailableQuotaCache() {
    return {
      get: async () => null,
      refresh: async () => null,
      snapshot: () => ({ lastError: "Claude OAuth credential reader not implemented", cooldownUntil: null }),
    };
  }
  function fakeAvailableQuotaCache() {
    return {
      get: async () => ({ fiveHour: 12, sevenDay: 34, sevenDaySonnet: 56, fetchedAt: "2026-01-01T00:00:00.000Z" }),
      refresh: async () => ({ fiveHour: 12, sevenDay: 34, sevenDaySonnet: 56, fetchedAt: "2026-01-01T00:00:00.000Z" }),
      snapshot: () => ({ lastError: null, cooldownUntil: null }),
    };
  }

  it("GET /api/quota returns 503 with the cached error reason when unavailable", async () => {
    services.quotaCache = fakeUnavailableQuotaCache() as unknown as CoordinatorServices["quotaCache"];
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({}, "/api/quota", "GET"), res, makeCtx());
    expect(getStatus()).toBe(503);
    expect(getBody()).toMatchObject({ error: "quota unavailable", reason: "Claude OAuth credential reader not implemented" });
  });

  it("GET /api/quota returns 200 with quota fields when available", async () => {
    services.quotaCache = fakeAvailableQuotaCache() as unknown as CoordinatorServices["quotaCache"];
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({}, "/api/quota", "GET"), res, makeCtx());
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ five_hour: 12, seven_day: 34, seven_day_sonnet: 56, fetched_at: "2026-01-01T00:00:00.000Z" });
  });

  it("POST /api/quota/refresh returns 503 when the forced refresh still fails", async () => {
    services.quotaCache = fakeUnavailableQuotaCache() as unknown as CoordinatorServices["quotaCache"];
    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({}, "/api/quota/refresh"), res, makeCtx());
    expect(getStatus()).toBe(503);
    expect(getBody()).toMatchObject({ error: "quota unavailable" });
  });

  it("POST /api/quota/refresh returns 200 when the forced refresh succeeds", async () => {
    services.quotaCache = fakeAvailableQuotaCache() as unknown as CoordinatorServices["quotaCache"];
    const { res, getStatus } = mockRes();
    await handleRest(mockReq({}, "/api/quota/refresh"), res, makeCtx());
    expect(getStatus()).toBe(200);
  });
});

describe("POST /api/reset — guard branches", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_ALLOW_RESET = process.env.COORDINATOR_ALLOW_RESET;

  afterAll(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_ALLOW_RESET === undefined) delete process.env.COORDINATOR_ALLOW_RESET;
    else process.env.COORDINATOR_ALLOW_RESET = ORIGINAL_ALLOW_RESET;
  });

  it("403 Forbidden when NODE_ENV != test, no override, and auth is off", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.COORDINATOR_ALLOW_RESET;
    try {
      const { res, getStatus, getBody } = mockRes();
      await handleRest(mockReq({}, "/api/reset"), res, makeCtx({ authEnabled: false }));
      expect(getStatus()).toBe(403);
      expect((getBody() as { error: string }).error).toMatch(/Forbidden: \/api\/reset/);
    } finally {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it("200 and wipes coordination tables when allowed (NODE_ENV=test)", async () => {
    process.env.NODE_ENV = "test";
    const thread = services.consultation.announceWork("org-hr", {
      agent_id: "agent-a", subject: "will be wiped", target_modules: [], target_files: [], keep_open: true,
    });
    expect(services.consultation.getThread("org-hr", thread.id)).not.toBeNull();

    const { res, getStatus, getBody } = mockRes();
    await handleRest(mockReq({}, "/api/reset"), res, makeCtx({ authEnabled: false }));
    expect(getStatus()).toBe(200);
    expect(getBody()).toEqual({ ok: true });
    expect(services.consultation.getThread("org-hr", thread.id)).toBeNull();
    expect(services.registry.get("org-hr", "agent-a")).toBeUndefined();
  });
});
