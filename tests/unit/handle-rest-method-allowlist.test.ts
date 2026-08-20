/**
 * State-changing /api/* endpoints must reject any method other than POST.
 * Before this fix, serve-http.ts's routing accepted both GET and POST for
 * every /api/* path, and handleRest's dispatch table only keyed on the URL
 * (ignoring req.method) for its exact-match routes — so a GET to a mutating
 * endpoint like /api/register or /api/reset was dispatched exactly like a
 * POST, with no CSRF-relevant method check anywhere in the chain.
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

const DIR = "data-test-handle-rest-method-allowlist";
const SECRET = "test-secret-at-least-32-characters-long!";
const CLAIMS: AuthClaims = {
  sub: "agent-a",
  user_id: "user-a",
  org: "org-hr",
  role: "agent",
  jti: "j-hr",
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
    quotaCache: {
      get: async () => ({ fiveHour: 1, sevenDay: 2, sevenDaySonnet: 3, fetchedAt: "now" }),
      refresh: async () => ({ fiveHour: 1, sevenDay: 2, sevenDaySonnet: 3, fetchedAt: "now" }),
      snapshot: () => ({ lastError: null, cooldownUntil: null }),
    } as unknown as CoordinatorServices["quotaCache"],
    metrics,
    treeSitter,
    gitCochange: null,
  };
}

function mockReq(body: object, url: string, method: string): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.headers = { "content-type": "application/json" };
  req.method = method;
  req.url = url;
  (req as unknown as { push: (chunk: unknown) => void }).push(JSON.stringify(body));
  (req as unknown as { push: (chunk: unknown) => void }).push(null);
  return req;
}

function mockRes(): {
  res: ServerResponse;
  getStatus: () => number;
  getBody: () => unknown;
  getHeaders: () => Record<string, string>;
} {
  let status = 200;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
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
    getHeaders: () => headers,
  };
}

function makeCtx(overrides?: Partial<RestContext>): RestContext {
  return {
    services,
    httpLog: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as never,
    authEnabled: false,
    claims: CLAIMS,
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
  process.env.NODE_ENV = "test";
  services = makeServices();
  services.registry.register("org-hr", "agent-a", "Agent A", []);
});

afterAll(() => {
  closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
  initAuth(SECRET);
});

describe("handleRest — mutating endpoints reject non-POST methods (405)", () => {
  const MUTATING_CASES: Array<{ url: string; body: object }> = [
    { url: "/api/register", body: { agent_id: "agent-x", name: "X", modules: [] } },
    { url: "/api/session-stop", body: { agent_id: "agent-a" } },
    {
      url: "/api/announce",
      body: { agent_id: "agent-a", subject: "s", target_modules: [], target_files: [] },
    },
    { url: "/api/claim-task", body: { thread_id: "t1", agent_id: "agent-a" } },
    { url: "/api/reset", body: {} },
    {
      url: "/api/log-file",
      body: { session_id: "s", agent_id: "agent-a", tool_name: "Edit", file: "x.ts" },
    },
    { url: "/api/unclaim-task", body: { thread_id: "t1", agent_id: "agent-a" } },
    {
      url: "/api/propose-resolution",
      body: { thread_id: "t1", agent_id: "agent-a", summary: "s" },
    },
    { url: "/api/approve-resolution", body: { thread_id: "t1", agent_id: "agent-a" } },
    { url: "/api/quota/refresh", body: {} },
    { url: "/api/introspection-response", body: { introspection_id: "i1", concerned: false } },
    {
      url: "/api/post-to-thread",
      body: { thread_id: "t1", agent_id: "agent-a", type: "context", content: "hi" },
    },
  ];

  for (const { url, body } of MUTATING_CASES) {
    it(`GET ${url} → 405 method not allowed (state is never mutated)`, async () => {
      const { res, getStatus, getBody, getHeaders } = mockRes();
      await handleRest(mockReq(body, url, "GET"), res, makeCtx());
      expect(getStatus()).toBe(405);
      expect((getBody() as { error: string }).error).toMatch(/method not allowed/i);
      expect(getHeaders().Allow).toBe("POST");
    });
  }

  it("POST /api/register still works normally (200) — the allowlist doesn't block the correct method", async () => {
    const { res, getStatus, getBody } = mockRes();
    await handleRest(
      mockReq({ agent_id: "agent-x", name: "X", modules: [] }, "/api/register", "POST"),
      res,
      makeCtx(),
    );
    expect(getStatus()).toBe(200);
    expect(getBody()).toBeTruthy();
  });
});

describe("handleRest — read-only endpoints remain accessible via GET", () => {
  const READ_CASES: Array<{ url: string; body: object }> = [
    { url: "/api/status", body: {} },
    { url: "/api/quota", body: {} },
    { url: "/api/threads-active", body: {} },
    { url: "/api/hot-files", body: {} },
    { url: "/api/check-interrupt", body: { agent_id: "agent-a" } },
    { url: "/api/check-conflict", body: { file: "x.ts", agent_id: "agent-a" } },
  ];

  for (const { url, body } of READ_CASES) {
    it(`GET ${url} → not blocked by the method allowlist (no 405)`, async () => {
      const { res, getStatus } = mockRes();
      await handleRest(mockReq(body, url, "GET"), res, makeCtx());
      expect(getStatus()).not.toBe(405);
    });
  }
});
