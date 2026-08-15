import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import type { CoordinatorServices } from "../../src/server-setup.js";
import type { AuthClaims } from "../../src/auth.js";
import fs from "fs";

import { createMcpServer } from "../../src/server-setup.js";
import { MCP_INSTRUCTIONS } from "../../src/mcp-instructions.js";

const TEST_DIR = "data-test-mcp-instructions";
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

/**
 * issue #271 — the server declares instructions, and every tool it names exists.
 *
 * Under tool-search-by-default a client materialises tool schemas on demand, so
 * at session start this text plus bare tool NAMES is the whole of what the
 * server contributes. That makes the text load-bearing in a way prose usually
 * is not: an agent resolves the tools by the literal strings written here.
 *
 * This repo has already shipped a documented-but-nonexistent tool once and a
 * wrong tool count (audit/09-protocole-mcp.md), and createMcpServer had no test
 * coverage at all before this file.
 */
const TOOL_NAME_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

describe("MCP server instructions (#271)", () => {
  beforeAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    initDatabase(TEST_DIR);
    seedTestOrgs(getDb(), ["default"]);
    initAuth(SECRET);
    services = makeServices();
  });

  afterAll(() => {
    try {
      closeDb();
    } catch {
      /* already closed */
    }
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function registeredToolNames(): string[] {
    const server = createMcpServer(services, () => null);
    const internals = server as unknown as { _registeredTools: Record<string, unknown> };
    return Object.keys(internals._registeredTools);
  }

  function citedToolNames(): string[] {
    return MCP_INSTRUCTIONS.match(TOOL_NAME_RE) ?? [];
  }

  it("declares instructions on the server, not just on the channel process", () => {
    const server = createMcpServer(services, () => null);
    const internals = server as unknown as {
      server: { _instructions?: string; instructions?: string };
    };
    const declared = internals.server._instructions ?? internals.server.instructions;
    expect(declared).toBe(MCP_INSTRUCTIONS);
  });

  it("fits in the 2 KB a client will actually read", () => {
    // Claude Code truncates instructions at 2 KB; past that is text nobody
    // reads, and the tail is where the tool names live.
    expect(Buffer.byteLength(MCP_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(2048);
  });

  it("names only tools that are actually registered", () => {
    // The guard the issue asks for: every snake_case token that reads like a
    // tool name must exist, or an agent searching for that literal string
    // finds nothing.
    const registered = new Set(registeredToolNames());
    const unknown = [...new Set(citedToolNames())].filter((n) => !registered.has(n));
    expect(unknown).toEqual([]);
  });

  it("cites real tools — otherwise the check above passes vacuously", () => {
    const registered = new Set(registeredToolNames());
    const hits = new Set(citedToolNames().filter((n) => registered.has(n)));
    expect(hits.size).toBeGreaterThanOrEqual(10);
  });

  it("tells the agent to announce before writing, which is the whole point", () => {
    expect(MCP_INSTRUCTIONS).toContain("announce_work");
    expect(MCP_INSTRUCTIONS).toMatch(/before you edit/i);
  });

  it("warns that reusing an agent id takes it over", () => {
    // Registering an id another agent holds is an ON CONFLICT upsert: a silent
    // takeover. This text makes MORE agents call register_agent, so the warning
    // ships alongside the amplifier.
    expect(MCP_INSTRUCTIONS).toContain("register_agent");
    expect(MCP_INSTRUCTIONS).toMatch(/takes it over/i);
  });

  it("registers the 26 tools the docs claim", () => {
    expect(registeredToolNames()).toHaveLength(26);
  });
});
