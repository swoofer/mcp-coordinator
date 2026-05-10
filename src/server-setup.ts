import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initDatabase, getDb } from "./database.js";
import { runCommonAnnounceFlow } from "./announce-workflow.js";
import { registerConsultationTools } from "./tools/consultation-tools.js";
import { registerAgentTools } from "./tools/agents-tools.js";
import { registerFilesTools } from "./tools/files-tools.js";
import { registerDependenciesTools } from "./tools/dependencies-tools.js";
import { registerStatusTools } from "./tools/status-tools.js";
import { registerMqttTools } from "./tools/mqtt-tools.js";
import { AgentRegistry } from "./agent-registry.js";
import { Consultation } from "./consultation.js";
import { ConflictDetector } from "./conflict-detector.js";
import { DependencyMapper } from "./dependency-map.js";
import { FileTracker } from "./file-tracker.js";
import { ImpactScorer } from "./impact-scorer.js";
import { SummaryContextProvider } from "./context-provider.js";
import { IntrospectionManager } from "./introspection.js";
import { SseEmitter } from "./sse-emitter.js";
import { MqttBridge } from "./mqtt-bridge.js";
import { assessPlanQuality } from "./plan-quality.js";
import { AgentActivityTracker } from "./agent-activity.js";
import { QuotaCache } from "./quota/quota-cache.js";
import { WorkingFilesTracker } from "./working-files-tracker.js";
import { Metrics } from "./metrics.js";
import { TreeSitterExtractor } from "./tree-sitter-extractor.js";
import { GitCochangeBuilder } from "./git-cochange-builder.js";
import type { CoordinatorConfig, AgentContext } from "./types.js";
import { createLogger, type Logger } from "./logger.js";
import { getVersion } from "../cli/version.js";
const VERSION = getVersion();

export interface CoordinatorServices {
  logger: Logger;
  registry: AgentRegistry;
  activityTracker: AgentActivityTracker;
  consultation: Consultation;
  conflictDetector: ConflictDetector;
  depMap: DependencyMapper;
  fileTracker: FileTracker;
  impactScorer: ImpactScorer;
  workingFiles: WorkingFilesTracker;
  introspection: IntrospectionManager;
  contextProvider: SummaryContextProvider;
  sseEmitter: SseEmitter;
  mqttBridge: MqttBridge;
  quotaCache: QuotaCache;
  metrics: Metrics;
  treeSitter: TreeSitterExtractor;
  gitCochange: GitCochangeBuilder | null;
}

/** Create shared services (once at startup). */
export function createServices(config: CoordinatorConfig): CoordinatorServices {
  initDatabase(config.dataDir);

  const logger = createLogger();

  const registry = new AgentRegistry();
  const activityTracker = new AgentActivityTracker(registry);
  const consultation = new Consultation(logger.child({ component: "consultation" }));
  const depMap = new DependencyMapper();
  const fileTracker = new FileTracker();
  const workingFiles = new WorkingFilesTracker(logger.child({ component: "working-files" }));
  workingFiles.startSweeper(parseInt(process.env.COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS || "60000", 10));
  const impactScorer = new ImpactScorer(registry, fileTracker, consultation, workingFiles);
  const introspection = new IntrospectionManager();
  const conflictDetector = new ConflictDetector(consultation, depMap, fileTracker, logger.child({ component: "conflict" }));
  const contextProvider = new SummaryContextProvider(registry, consultation, fileTracker);
  const sseEmitter = new SseEmitter();
  const mqttBridge = new MqttBridge(logger.child({ component: "mqtt" }));
  const metrics = new Metrics();

  const treeSitter = new TreeSitterExtractor();
  treeSitter.load().catch(() => { /* errors are logged inside; status() reflects state */ });

  const repoRoot = process.env.COORDINATOR_REPO_ROOT;
  const gitCochange = repoRoot
    ? new GitCochangeBuilder({ repoRoot, logger: logger.child({ component: "gitcc" }) })
    : null;
  gitCochange?.startScheduler();

  // Quota cache â€” macOS-only for now, Linux/Windows stubs return 503 via the
  // /api/quota handler so raids keep running without a quota guardrail there.
  // onRefresh fans the new data out to dashboard (SSE) + any live listener (MQTT)
  // so the UI reflects quota moves without polling.
  const quotaCache = new QuotaCache({
    logger: logger.child({ component: "quota" }),
    onRefresh: (info) => {
      sseEmitter.emit("quota_update", {
        five_hour: info.fiveHour,
        seven_day: info.sevenDay,
        seven_day_sonnet: info.sevenDaySonnet,
        fetched_at: info.fetchedAt,
      });
      mqttBridge.publishQuotaUpdate(info);
    },
  });
  // Hybrid refresh: keep the cache warm whenever agents are online. Tap into
  // SSE events for agent_online/agent_offline since they're already emitted by
  // the REST handler on /api/register and the offline hook. Avoids plumbing a
  // dedicated observer through AgentRegistry.
  sseEmitter.addListener((event) => {
    if (event.type === "agent_online") quotaCache.onAgentActive();
    else if (event.type === "agent_offline") quotaCache.onAgentInactive();
  });

  // Centralized resolution â†’ SSE + MQTT + metrics
  consultation.onResolve((event) => {
    metrics.recordThreadResolved(event.resolution_type);
    sseEmitter.emit("thread_resolved", {
      thread_id: event.thread_id,
      resolution_type: event.resolution_type,
      resolution: event.resolution_summary,
      approved_by: event.approved_by,
      approved_by_name: event.approved_by_name,
      created_at: event.created_at,
      resolved_at: event.resolved_at,
      had_messages: event.had_messages,
    });
    if (event.resolution_type !== "auto_resolved") {
      mqttBridge.publishResolution(event.thread_id, "resolved", event.resolution_summary || "");
    }
    // P1 fix: clear the retained `coordinator/consultations/new` event so a
    // coordinator restart doesn't re-broadcast a consultation that's already
    // been resolved. No-op when the retained slot holds a different (newer)
    // thread.
    mqttBridge.clearRetainedConsultation(event.thread_id);
  });

  return {
    logger, registry, activityTracker, consultation, conflictDetector,
    depMap, fileTracker, impactScorer, workingFiles, introspection, contextProvider, sseEmitter, mqttBridge, quotaCache, metrics, treeSitter, gitCochange,
  };
}

/** Create a new McpServer bound to the shared services (one per MCP session). */
export function createMcpServer(services: CoordinatorServices): McpServer {
  const { registry, activityTracker, consultation, conflictDetector, depMap, fileTracker, impactScorer, introspection, contextProvider, sseEmitter, mqttBridge } = services;
  const mcpLog = services.logger.child({ component: "mcp" });

  const server = new McpServer({
    name: "mcp-coordinator-v3",
    version: VERSION,
  });

  // S1: all 23 MCP tools registered via per-domain modules under src/tools/.
  // Each register*Tools function takes (server, services, mcpLog) and wires
  // its tool group; nothing else lives here. See src/tools/*.ts for behavior.
  registerAgentTools(server, services, mcpLog);
  registerConsultationTools(server, services, mcpLog);
  registerFilesTools(server, services, mcpLog);
  registerDependenciesTools(server, services, mcpLog);
  registerStatusTools(server, services, mcpLog);
  registerMqttTools(server, services, mcpLog);

  return server;
}

