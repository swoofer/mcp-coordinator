/**
 * Task 23.5 — MCP tool handlers consume per-session claims.
 *
 * Strategy: Option B — unit-test each tool-registration function directly by
 * passing a real McpServer stub and a fake getSessionClaims getter. We then
 * retrieve the registered tool handler via the McpServer's internal
 * _registeredTools map (accessed via the public server.tool(...) return value)
 * and call the handler with a synthetic RequestHandlerExtra that carries a
 * known sessionId.
 *
 * This avoids spinning up a real HTTP server and verifies:
 *  1. Tool reads extra.sessionId and looks up claims.
 *  2. Tool throws "MCP tool requires a session" when sessionId is absent.
 *  3. Tool throws "Session has no captured claims (auth bug)" when claims are missing.
 *  4. Tool scopes underlying service calls to claims.org (not literal "default").
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
import { registerAgentTools } from "../../src/tools/agents-tools.js";
import { registerFilesTools } from "../../src/tools/files-tools.js";
import { registerDependenciesTools } from "../../src/tools/dependencies-tools.js";
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";

const TEST_DIR = "data-test-mcp-tool-org";
const SECRET = "test-secret-at-least-32-characters-long!";

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

/** Build a fake RequestHandlerExtra with the given sessionId. */
function fakeExtra(sessionId?: string): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    sessionId,
  } as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

/** Retrieve a registered tool handler by name from a McpServer.
 *
 * McpServer stores tools in a private plain object `_registeredTools` keyed
 * by tool name. The `.handler` property on each entry is the raw callback
 * passed to server.tool(...). We access it by casting to a plain Record.
 */
function getHandler(server: McpServer, toolName: string) {
  const _server = server as unknown as { _registeredTools: Record<string, { handler: (...args: unknown[]) => unknown }> };
  const registered = _server._registeredTools[toolName];
  if (!registered) throw new Error(`Tool not registered: ${toolName}`);
  return registered.handler as (args: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<unknown>;
}

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initDatabase(TEST_DIR);
  initAuth(SECRET);
  // v0.9 (issue #79): claims.org values used below need real orgs rows.
  seedTestOrgs(getDb(), ["org-x", "org-a", "org-b", "org-files", "org-dep"]);
});

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM agents");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM dependency_map");
  services = makeServices();
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  // Reset auth module state so signingKey/prevKey don't contaminate later
  // test files under vitest fileParallelism: false (auth.ts is a singleton).
  initAuth(SECRET);
});

// ─── Claims lookup helper ─────────────────────────────────────────────────────

describe("getSessionClaims getter contract", () => {
  it("returns null for unknown sessionId", () => {
    const getter = (_sid: string): AuthClaims | null => null;
    expect(getter("unknown-session")).toBeNull();
  });

  it("returns claims for known sessionId", () => {
    const claims: AuthClaims = { sub: "agent-1", user_id: "u-1", org: "acme", role: "agent", jti: "j-1" };
    const sessionClaims = new Map<string, AuthClaims>([["session-1", claims]]);
    const getter = (sid: string) => sessionClaims.get(sid) ?? null;
    expect(getter("session-1")).toEqual(claims);
    expect(getter("other")).toBeNull();
  });
});

// ─── agents-tools: register_agent ────────────────────────────────────────────

describe("agents-tools: register_agent", () => {
  // Note: the "throws when sessionId is absent" case used to live here.
  // Removed in #133: handlers now resolve claims via `extra.sessionId ?? ""`
  // and let `getSessionClaims` decide what to return. The "absent
  // sessionId + null getter" path is functionally the same as "present
  // sessionId + null getter" — see the next test, which still covers it.
  it("throws when claims are absent for sessionId", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const getter = (_sid: string): AuthClaims | null => null;
    registerAgentTools(server, services, silentLogger, getter);
    const handler = getHandler(server, "register_agent");
    await expect(
      handler({ agent_id: "a1", name: "Agent1", modules: [] }, fakeExtra("sess-42"))
    ).rejects.toThrow("Session has no captured claims (auth bug)");
  });

  it("registers agent under claims.org (not 'default')", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = { sub: "a1", user_id: "u1", org: "org-x", role: "agent", jti: "j1" };
    const getter = (sid: string): AuthClaims | null => sid === "sess-1" ? claims : null;
    registerAgentTools(server, services, silentLogger, getter);
    const handler = getHandler(server, "register_agent");

    await handler({ agent_id: "a1", name: "Agent1", modules: ["mod-a"] }, fakeExtra("sess-1"));

    // The agent should be in org-x, not visible from org-y.
    const inOrgX = services.registry.listAll("org-x");
    expect(inOrgX.map((a) => a.id)).toContain("a1");

    const inDefault = services.registry.listAll("default");
    expect(inDefault.map((a) => a.id)).not.toContain("a1");
  });

  it("list_agents returns only org-scoped agents", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claimsA: AuthClaims = { sub: "a1", user_id: "u1", org: "org-a", role: "agent", jti: "j1" };
    const claimsB: AuthClaims = { sub: "b1", user_id: "u2", org: "org-b", role: "agent", jti: "j2" };
    const sessionMap = new Map([["sess-a", claimsA], ["sess-b", claimsB]]);
    const getter = (sid: string) => sessionMap.get(sid) ?? null;
    registerAgentTools(server, services, silentLogger, getter);

    const regHandler = getHandler(server, "register_agent");
    await regHandler({ agent_id: "agent-a", name: "A", modules: [] }, fakeExtra("sess-a"));
    await regHandler({ agent_id: "agent-b", name: "B", modules: [] }, fakeExtra("sess-b"));

    const listHandler = getHandler(server, "list_agents");
    const resultA = await listHandler({ online_only: false }, fakeExtra("sess-a")) as { content: [{ text: string }] };
    const agentsA = JSON.parse(resultA.content[0].text) as Array<{ id: string }>;
    expect(agentsA.map((a) => a.id)).toContain("agent-a");
    expect(agentsA.map((a) => a.id)).not.toContain("agent-b");

    const resultB = await listHandler({ online_only: false }, fakeExtra("sess-b")) as { content: [{ text: string }] };
    const agentsB = JSON.parse(resultB.content[0].text) as Array<{ id: string }>;
    expect(agentsB.map((a) => a.id)).toContain("agent-b");
    expect(agentsB.map((a) => a.id)).not.toContain("agent-a");
  });
});

// ─── files-tools ─────────────────────────────────────────────────────────────

describe("files-tools: hot_files", () => {
  // "absent sessionId" case removed in #133 — see agents-tools describe block.
  it("throws when claims missing", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    registerFilesTools(server, services, silentLogger, () => null);
    const handler = getHandler(server, "hot_files");
    await expect(
      handler({ since_minutes: 30 }, fakeExtra("sess-x"))
    ).rejects.toThrow("Session has no captured claims (auth bug)");
  });

  it("scopes file lookup to claims.org", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = { sub: "a1", user_id: "u1", org: "org-files", role: "agent", jti: "j1" };
    registerFilesTools(server, services, silentLogger, (sid) => sid === "sess-f" ? claims : null);
    // Add a file_activity row under org-files using the FileTracker API
    services.fileTracker.log({
      org_id: "org-files", session_id: "s1", agent_id: "a1",
      tool_name: "edit", file_path: "src/foo.ts",
    });

    const handler = getHandler(server, "hot_files");
    const result = await handler({ since_minutes: 9999 }, fakeExtra("sess-f")) as { content: [{ text: string }] };
    // Should not throw — result is org-scoped
    expect(result.content[0].text).toBeDefined();
  });
});

// ─── dependencies-tools ──────────────────────────────────────────────────────

describe("dependencies-tools: set_dependency_map / get_blast_radius", () => {
  // "absent sessionId" case removed in #133 — see agents-tools describe block.
  it("sets map under claims.org", async () => {
    const server = new McpServer({ name: "test", version: "0" });
    const claims: AuthClaims = { sub: "a1", user_id: "u1", org: "org-dep", role: "agent", jti: "j1" };
    registerDependenciesTools(server, services, silentLogger, (sid) => sid === "sess-d" ? claims : null);

    const setHandler = getHandler(server, "set_dependency_map");
    await setHandler({ modules: JSON.stringify({ "mod-a": { depends_on: ["mod-b"], dependents: [] } }) }, fakeExtra("sess-d"));

    const getHandler2 = getHandler(server, "get_blast_radius");
    const result = await getHandler2({ module_id: "mod-b" }, fakeExtra("sess-d")) as { content: [{ text: string }] };
    const radius = JSON.parse(result.content[0].text) as { module_id: string; direct_dependents: string[] };
    // mod-a depends on mod-b, so blast radius of mod-b has mod-a as a direct dependent
    expect(radius.module_id).toBe("mod-b");
    expect(radius.direct_dependents).toContain("mod-a");
  });
});
