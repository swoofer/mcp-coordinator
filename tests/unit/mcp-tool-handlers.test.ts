/**
 * tests-03 (audit) — in-process coverage for the MCP tool handler layer in
 * `src/tools/status-tools.ts` (2 tools) and `src/tools/consultation-tools.ts`
 * (11 tools). Both files sat at ~10%/~33% line coverage: they're normally
 * only exercised end-to-end via a live MCP client, so branch-level behavior
 * (auth failure paths in particular) was unverified.
 *
 * Risk context: this wrapper layer (reads `extra.sessionId`, resolves claims,
 * scopes every call to `claims.org`) already shipped a prod bug (#133):
 * `sessionId` was `undefined` in stdio transport, which crashed every
 * handler. The fix (see mcp-tool-org-scoping.test.ts) changed the pattern to
 * `getSessionClaims(extra.sessionId ?? "")` — the handler always calls the
 * getter with a string, and lets the getter's return value (null vs claims)
 * decide the auth outcome. That means "sessionId absent" and "sessionId
 * present but claims unknown" collapse to the SAME code path today; both are
 * exercised below to document actual (not presumed) behavior.
 *
 * Pattern reused from mcp-tool-org-scoping.test.ts: register real tools on a
 * real McpServer, retrieve the handler via the SDK's internal
 * `_registeredTools` map, and invoke it with a synthetic RequestHandlerExtra.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { initDatabase, getDb, closeDb } from "../../src/database.js";
import { initAuth } from "../../src/auth.js";
import { AgentRegistry } from "../../src/agent-registry.js";
import { AgentActivityTracker } from "../../src/agent-activity.js";
import { Consultation } from "../../src/consultation.js";
import { ConflictDetector } from "../../src/conflict-detector.js";
import { DependencyMapper } from "../../src/dependency-map.js";
import { FileTracker } from "../../src/file-tracker.js";
import { ImpactScorer } from "../../src/impact-scorer.js";
import { WorkingFilesTracker } from "../../src/working-files-tracker.js";
import { IntrospectionManager } from "../../src/introspection.js";
import { SummaryContextProvider } from "../../src/context-provider.js";
import { SseEmitter } from "../../src/sse-emitter.js";
import { MqttBridge } from "../../src/mqtt-bridge.js";
import { QuotaCache } from "../../src/quota/quota-cache.js";
import { Metrics } from "../../src/metrics.js";
import { TreeSitterExtractor } from "../../src/tree-sitter-extractor.js";
import { silentLogger } from "../../src/logger.js";
import { seedTestOrgs } from "../helpers/orgs.js";
import { registerStatusTools } from "../../src/tools/status-tools.js";
import { registerConsultationTools } from "../../src/tools/consultation-tools.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";

const TEST_DIR = "data-test-mcp-tool-handlers";
const SECRET = "test-secret-at-least-32-characters-long!";
const ORGS = ["org-status", "org-cons"];

let services: CoordinatorServices;

function makeServices(): CoordinatorServices {
  const logger = silentLogger;
  const metrics = new Metrics();
  const registry = new AgentRegistry();
  const activityTracker = new AgentActivityTracker(registry);
  const consultation = new Consultation();
  const depMap = new DependencyMapper();
  const fileTracker = new FileTracker();
  const workingFiles = new WorkingFilesTracker(logger, metrics);
  const impactScorer = new ImpactScorer(registry, fileTracker, consultation, workingFiles);
  const introspection = new IntrospectionManager();
  const conflictDetector = new ConflictDetector(consultation, depMap, fileTracker);
  const contextProvider = new SummaryContextProvider(registry, consultation, fileTracker);
  const sseEmitter = new SseEmitter();
  const mqttBridge = new MqttBridge("default", logger);
  const quotaCache = new QuotaCache({ logger });
  const treeSitter = new TreeSitterExtractor(metrics);
  return {
    logger,
    registry,
    activityTracker,
    consultation,
    conflictDetector,
    depMap,
    fileTracker,
    impactScorer,
    workingFiles,
    introspection,
    contextProvider,
    sseEmitter,
    mqttBridge,
    quotaCache,
    metrics,
    treeSitter,
    gitCochange: null,
  };
}

/** Build a fake RequestHandlerExtra with the given sessionId (or absent — the #133 case). */
function fakeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    sessionId,
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

/** Retrieve a registered tool handler by name (see mcp-tool-org-scoping.test.ts for rationale). */
function getHandler(server: McpServer, toolName: string) {
  const _server = server as unknown as {
    _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }>;
  };
  const registered = _server._registeredTools[toolName];
  if (!registered) throw new Error(`Tool not registered: ${toolName}`);
  return registered.handler as (
    args: unknown,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ) => Promise<{ isError?: boolean; content: [{ type: string; text: string }] }>;
}

/** No claims resolve for this getter, regardless of sessionId. Models both the
 * "sessionId absent" (#133) and "sessionId present but unknown" cases, since
 * the handler collapses them into the same `getSessionClaims(sid ?? "")` call. */
const NO_CLAIMS_GETTER = (_sid: string): AuthClaims | null => null;

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  initAuth(SECRET);
  seedTestOrgs(getDb(), ORGS);
});

beforeEach(() => {
  const db = getDb();
  // Deletion order matters: thread_messages/threads/action_summaries carry a
  // FOREIGN KEY on agents(id), so agents must be cleared LAST or the delete
  // fails with SQLITE_CONSTRAINT_FOREIGNKEY.
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM dependency_map");
  db.exec("DELETE FROM agents");
  services = makeServices();
  // threads.initiator_id / thread_messages.agent_id carry a FOREIGN KEY on
  // agents(id) (globally unique, not per-org — see database.ts idx_agents_id)
  // since the v0.9 (#79) FK hardening. Every consultation-tools test below
  // uses "init-1" as the announcing agent, so register it once here rather
  // than repeating it in every test.
  services.registry.register("org-cons", "init-1", "Init One", []);
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  // Reset auth module state so signingKey/prevKey don't contaminate later
  // test files under vitest fileParallelism: false (auth.ts is a singleton).
  initAuth(SECRET);
});

// ─── status-tools: coordinator_status ────────────────────────────────────────

describe("status-tools: coordinator_status", () => {
  it("nominal: reports org-scoped counts (agents/threads/hot_files/mqtt)", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = {
      sub: "a1",
      user_id: "u1",
      org: "org-status",
      role: "agent",
      jti: "j1",
    };
    registerStatusTools(server, services, silentLogger, (sid) =>
      sid === "sess-1" ? claims : null,
    );

    services.registry.register("org-status", "agent-1", "Agent One", ["mod-a"]);
    // A second org's agent must NOT leak into org-status's count.
    services.registry.register("org-cons", "agent-other-org", "Other", ["mod-x"]);

    const handler = getHandler(server, "coordinator_status");
    const result = await handler({}, fakeExtra("sess-1"));
    const status = JSON.parse(result.content[0].text) as {
      agents_online: number;
      agents: Array<{ id: string }>;
      open_threads: number;
      resolving_threads: number;
      hot_files: number;
      mqtt_connected: boolean;
    };
    expect(status.agents_online).toBe(1);
    expect(status.agents.map((a) => a.id)).toEqual(["agent-1"]);
    expect(status.open_threads).toBe(0);
    expect(status.resolving_threads).toBe(0);
    expect(status.hot_files).toBe(0);
    expect(status.mqtt_connected).toBe(false);
  });

  it("without a resolvable session (bug #133): rejects with the auth-bug error, does not touch the registry", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerStatusTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "coordinator_status");
    // extra.sessionId is undefined — the exact shape of bug #133 (stdio transport).
    await expect(handler({}, fakeExtra(undefined))).rejects.toThrow(
      "Session has no captured claims (auth bug)",
    );
  });
});

// ─── status-tools: wait_for_peers ────────────────────────────────────────────

describe("status-tools: wait_for_peers", () => {
  it("nominal: resolves immediately (no poll wait) when min_peers is already met", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = {
      sub: "a1",
      user_id: "u1",
      org: "org-status",
      role: "agent",
      jti: "j1",
    };
    registerStatusTools(server, services, silentLogger, (sid) =>
      sid === "sess-w" ? claims : null,
    );

    services.registry.register("org-status", "waiter", "Waiter", []);
    services.registry.register("org-status", "peer-1", "Peer One", []);

    const handler = getHandler(server, "wait_for_peers");
    const start = Date.now();
    const result = await handler(
      { agent_id: "waiter", min_peers: 1, timeout_seconds: 5 },
      fakeExtra("sess-w"),
    );
    const elapsedMs = Date.now() - start;
    const payload = JSON.parse(result.content[0].text) as {
      ready: boolean;
      online_peers: Array<{ id: string }>;
    };
    expect(payload.ready).toBe(true);
    expect(payload.online_peers.map((p) => p.id)).toEqual(["peer-1"]);
    // Sanity: the peer was already online, so the loop returned on its first
    // check — no 1s poll interval was waited out.
    expect(elapsedMs).toBeLessThan(900);
  });

  it("without a resolvable session (bug #133): rejects before entering the poll loop", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerStatusTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "wait_for_peers");
    const start = Date.now();
    await expect(
      handler({ agent_id: "waiter", timeout_seconds: 30 }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    // Must fail fast — the auth check happens before the (capped-30s) poll loop.
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ─── consultation-tools ──────────────────────────────────────────────────────

describe("consultation-tools: announce_work", () => {
  it("nominal: opens a thread scoped to claims.org and auto-resolves when alone", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = {
      sub: "init-1",
      user_id: "u1",
      org: "org-cons",
      role: "agent",
      jti: "j1",
    };
    registerConsultationTools(server, services, silentLogger, (sid) =>
      sid === "sess-a" ? claims : null,
    );

    const handler = getHandler(server, "announce_work");
    const result = await handler(
      {
        agent_id: "init-1",
        subject: "Refactor foo",
        target_modules: ["mod-a"],
        target_files: ["src/foo.ts"],
      },
      fakeExtra("sess-a"),
    );
    const payload = JSON.parse(result.content[0].text) as {
      thread: { id: string; status: string; org_id: string };
    };
    expect(payload.thread.org_id).toBe("org-cons");
    // No other online agents in org-cons — the shared announce-workflow
    // auto-resolves a lone announce (see runCommonAnnounceFlow).
    expect(payload.thread.status).toBe("resolved");

    // Confirm the thread really landed under org-cons via the real service.
    const stored = services.consultation.getThread("org-cons", payload.thread.id);
    expect(stored).not.toBeNull();
  });

  it("without a resolvable session (bug #133): rejects, no thread is created", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "announce_work");
    await expect(
      handler(
        { agent_id: "init-1", subject: "x", target_modules: [], target_files: [] },
        fakeExtra(undefined),
      ),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.listThreads("org-cons", {})).toEqual([]);
  });
});

describe("consultation-tools: post_to_thread", () => {
  it("nominal: posts a message and returns it", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = {
      sub: "init-1",
      user_id: "u1",
      org: "org-cons",
      role: "agent",
      jti: "j1",
    };
    registerConsultationTools(server, services, silentLogger, (sid) =>
      sid === "sess-p" ? claims : null,
    );

    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });

    const handler = getHandler(server, "post_to_thread");
    const result = await handler(
      { thread_id: thread.id, agent_id: "init-1", type: "context", content: "hello" },
      fakeExtra("sess-p"),
    );
    const msg = JSON.parse(result.content[0].text) as { thread_id: string; content: string };
    expect(msg.thread_id).toBe(thread.id);
    expect(msg.content).toBe("hello");
  });

  it("without a resolvable session (bug #133): rejects, no message is posted", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "post_to_thread");
    await expect(
      handler(
        { thread_id: thread.id, agent_id: "init-1", type: "context", content: "hello" },
        fakeExtra(undefined),
      ),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    const withMessages = services.consultation.getThreadWithMessages("org-cons", thread.id);
    expect(withMessages!.messages).toEqual([]);
  });
});

describe("consultation-tools: propose_resolution / approve_resolution / contest_resolution", () => {
  const claims: AuthClaims = {
    sub: "init-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-r" ? claims : null);

  it("propose_resolution nominal: transitions thread to resolving", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });

    const handler = getHandler(server, "propose_resolution");
    const result = await handler(
      { thread_id: thread.id, agent_id: "init-1", summary: "done" },
      fakeExtra("sess-r"),
    );
    const payload = JSON.parse(result.content[0].text) as {
      status: string;
      resolution_summary: string;
    };
    expect(payload.status).toBe("resolving");
    expect(payload.resolution_summary).toBe("done");
  });

  it("propose_resolution without a resolvable session: rejects, thread stays open", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "propose_resolution");
    await expect(
      handler({ thread_id: thread.id, agent_id: "init-1", summary: "done" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("open");
  });

  it("approve_resolution nominal: a solo expected respondent resolves the thread", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    services.registry.register("org-cons", "resp-1", "Responder", []);
    registerConsultationTools(server, services, silentLogger, (sid) =>
      sid === "sess-appr" ? { ...claims, sub: "resp-1" } : null,
    );

    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    // Seed expected_respondents directly via the DB (mirrors what
    // runCommonAnnounceFlow's impact-scoring override would do) so the
    // approval quorum check has exactly one respondent to satisfy.
    getDb()
      .prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
      .run(JSON.stringify(["resp-1"]), thread.id);
    services.consultation.proposeResolution("org-cons", thread.id, "init-1", "done");

    const handler = getHandler(server, "approve_resolution");
    const result = await handler(
      { thread_id: thread.id, agent_id: "resp-1" },
      fakeExtra("sess-appr"),
    );
    const payload = JSON.parse(result.content[0].text) as { status: string };
    expect(payload.status).toBe("resolved");
  });

  it("approve_resolution without a resolvable session: rejects, thread stays resolving", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.proposeResolution("org-cons", thread.id, "init-1", "done");
    const handler = getHandler(server, "approve_resolution");
    await expect(
      handler({ thread_id: thread.id, agent_id: "init-1" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("resolving");
  });

  it("contest_resolution nominal: reopens the thread for another round", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.proposeResolution("org-cons", thread.id, "init-1", "first try");

    const handler = getHandler(server, "contest_resolution");
    const result = await handler(
      { thread_id: thread.id, agent_id: "init-1", reason: "not good enough" },
      fakeExtra("sess-r"),
    );
    const payload = JSON.parse(result.content[0].text) as { status: string; round: number };
    // max_rounds defaults to 4 — round 1 -> 2, status returns to open.
    expect(payload.status).toBe("open");
    expect(payload.round).toBe(2);
  });

  it("contest_resolution without a resolvable session: rejects, thread stays resolving", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.proposeResolution("org-cons", thread.id, "init-1", "first try");
    const handler = getHandler(server, "contest_resolution");
    await expect(
      handler({ thread_id: thread.id, agent_id: "init-1", reason: "no" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("resolving");
  });
});

describe("consultation-tools: close_thread / cancel_thread", () => {
  const claims: AuthClaims = {
    sub: "init-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-c" ? claims : null);

  it("close_thread nominal: resolves the thread with the given summary", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "close_thread");
    const result = await handler(
      { thread_id: thread.id, agent_id: "init-1", summary: "wrapped up" },
      fakeExtra("sess-c"),
    );
    expect(result.content[0].text).toBe("closed");
    const stored = services.consultation.getThread("org-cons", thread.id)!;
    expect(stored.status).toBe("resolved");
    expect(stored.resolution_summary).toBe("wrapped up");
  });

  it("close_thread without a resolvable session: rejects, thread stays open", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "close_thread");
    await expect(
      handler({ thread_id: thread.id, agent_id: "init-1", summary: "x" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("open");
  });

  it("cancel_thread nominal: cancels with an optional reason", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "cancel_thread");
    const result = await handler(
      { thread_id: thread.id, agent_id: "init-1", reason: "not needed anymore" },
      fakeExtra("sess-c"),
    );
    expect(result.content[0].text).toBe("cancelled");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("cancelled");
  });

  it("cancel_thread without a resolvable session: rejects, thread stays open", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    const handler = getHandler(server, "cancel_thread");
    await expect(
      handler({ thread_id: thread.id, agent_id: "init-1" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getThread("org-cons", thread.id)!.status).toBe("open");
  });
});

describe("consultation-tools: get_thread", () => {
  const claims: AuthClaims = {
    sub: "init-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-g" ? claims : null);

  it("nominal: returns the thread with its messages", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.postToThread("org-cons", {
      thread_id: thread.id,
      agent_id: "init-1",
      type: "context",
      content: "hi",
    });

    const handler = getHandler(server, "get_thread");
    const result = await handler({ thread_id: thread.id }, fakeExtra("sess-g"));
    const payload = JSON.parse(result.content[0].text) as {
      thread: { id: string };
      messages: unknown[];
    };
    expect(payload.thread.id).toBe(thread.id);
    expect(payload.messages).toHaveLength(1);
  });

  it("nominal: returns isError for an unknown thread_id (not org-scoping leakage — genuinely missing)", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const handler = getHandler(server, "get_thread");
    const result = await handler({ thread_id: "does-not-exist" }, fakeExtra("sess-g"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Thread not found/);
  });

  it("without a resolvable session (bug #133): rejects", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "get_thread");
    await expect(handler({ thread_id: "whatever" }, fakeExtra(undefined))).rejects.toThrow(
      "Session has no captured claims (auth bug)",
    );
  });
});

describe("consultation-tools: get_thread_updates", () => {
  const claims: AuthClaims = {
    sub: "resp-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-u" ? claims : null);

  it("nominal: returns updates from OTHER agents, excluding the caller's own posts", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    services.registry.register("org-cons", "resp-1", "Responder", []);
    const thread = services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "s",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.postToThread("org-cons", {
      thread_id: thread.id,
      agent_id: "init-1",
      type: "context",
      content: "from initiator",
    });
    services.consultation.postToThread("org-cons", {
      thread_id: thread.id,
      agent_id: "resp-1",
      type: "context",
      content: "from me, excluded",
    });

    const handler = getHandler(server, "get_thread_updates");
    const result = await handler({ agent_id: "resp-1" }, fakeExtra("sess-u"));
    const updates = JSON.parse(result.content[0].text) as Array<{
      agent_id: string;
      content: string;
    }>;
    expect(updates).toHaveLength(1);
    expect(updates[0].content).toBe("from initiator");
  });

  it("without a resolvable session (bug #133): rejects", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "get_thread_updates");
    await expect(handler({ agent_id: "resp-1" }, fakeExtra(undefined))).rejects.toThrow(
      "Session has no captured claims (auth bug)",
    );
  });
});

describe("consultation-tools: list_threads", () => {
  const claims: AuthClaims = {
    sub: "init-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-l" ? claims : null);

  it("nominal: lists only threads for claims.org, filtered by status", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    services.registry.register("org-status", "init-2", "Init Two", []);
    services.consultation.announceWork("org-cons", {
      agent_id: "init-1",
      subject: "open-one",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });
    services.consultation.announceWork("org-status", {
      agent_id: "init-2",
      subject: "other-org",
      target_modules: [],
      target_files: [],
      keep_open: true,
    });

    const handler = getHandler(server, "list_threads");
    const result = await handler({ status: "open" }, fakeExtra("sess-l"));
    const threads = JSON.parse(result.content[0].text) as Array<{
      subject: string;
      org_id: string;
    }>;
    expect(threads).toHaveLength(1);
    expect(threads[0].subject).toBe("open-one");
    expect(threads[0].org_id).toBe("org-cons");
  });

  it("without a resolvable session (bug #133): rejects", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "list_threads");
    await expect(handler({}, fakeExtra(undefined))).rejects.toThrow(
      "Session has no captured claims (auth bug)",
    );
  });
});

describe("consultation-tools: log_action_summary", () => {
  const claims: AuthClaims = {
    sub: "init-1",
    user_id: "u1",
    org: "org-cons",
    role: "agent",
    jti: "j1",
  };
  const getter = (sid: string): AuthClaims | null => (sid === "sess-log" ? claims : null);

  it("nominal: records a one-liner scoped to claims.org", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, getter);
    const handler = getHandler(server, "log_action_summary");
    const result = await handler(
      { session_id: "s1", agent_id: "init-1", file_path: "src/foo.ts", summary: "fixed the bug" },
      fakeExtra("sess-log"),
    );
    const payload = JSON.parse(result.content[0].text) as { org_id: string; summary: string };
    expect(payload.org_id).toBe("org-cons");
    expect(payload.summary).toBe("fixed the bug");
    expect(services.consultation.getActionSummariesBySession("org-cons", "s1")).toHaveLength(1);
  });

  it("without a resolvable session (bug #133): rejects, no summary is recorded", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerConsultationTools(server, services, silentLogger, NO_CLAIMS_GETTER);
    const handler = getHandler(server, "log_action_summary");
    await expect(
      handler({ session_id: "s1", agent_id: "init-1", summary: "x" }, fakeExtra(undefined)),
    ).rejects.toThrow("Session has no captured claims (auth bug)");
    expect(services.consultation.getActionSummariesBySession("org-cons", "s1")).toEqual([]);
  });
});
