import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { initDatabase, getDb } from "./database.js";
import { runCommonAnnounceFlow } from "./announce-workflow.js";
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
  introspection: IntrospectionManager;
  contextProvider: SummaryContextProvider;
  sseEmitter: SseEmitter;
  mqttBridge: MqttBridge;
  quotaCache: QuotaCache;
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
  const impactScorer = new ImpactScorer(registry, fileTracker, consultation);
  const introspection = new IntrospectionManager();
  const conflictDetector = new ConflictDetector(consultation, depMap, fileTracker, logger.child({ component: "conflict" }));
  const contextProvider = new SummaryContextProvider(registry, consultation, fileTracker);
  const sseEmitter = new SseEmitter();
  const mqttBridge = new MqttBridge(logger.child({ component: "mqtt" }));

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

  // Centralized resolution â†’ SSE + MQTT
  consultation.onResolve((event) => {
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
  });

  return {
    logger, registry, activityTracker, consultation, conflictDetector,
    depMap, fileTracker, impactScorer, introspection, contextProvider, sseEmitter, mqttBridge, quotaCache,
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

  // â”€â”€ AGENT REGISTRY TOOLS â”€â”€

  server.tool("register_agent", "Register agent as online with module list", {
    agent_id: z.string(),
    name: z.string(),
    modules: z.array(z.string()),
  }, async ({ agent_id, name, modules }) => {
    mcpLog.info({ tool: "register_agent", agent_id, name, module_count: modules.length }, "Tool called");
    const agent = registry.register(agent_id, name, modules);
    sseEmitter.emit("agent_online", { agent_id, name, modules });
    mqttBridge.registerAgent(agent_id, name);
    return { content: [{ type: "text", text: JSON.stringify(agent) }] };
  });

  server.tool("list_agents", "List registered agents", {
    online_only: z.boolean().optional(),
  }, async ({ online_only }) => {
    const agents = online_only ? registry.listOnline() : registry.listAll();
    return { content: [{ type: "text", text: JSON.stringify(agents) }] };
  });

  server.tool("heartbeat", "Update agent activity status and last seen timestamp", {
    agent_id: z.string(),
    current_file: z.string().optional(),
    current_thread: z.string().optional(),
  }, async ({ agent_id, current_file, current_thread }) => {
    registry.heartbeat(agent_id);
    activityTracker.heartbeat(agent_id, {
      currentFile: current_file || null,
      currentThread: current_thread || null,
    });
    const activity = activityTracker.getActivity(agent_id);
    sseEmitter.emit("agent_activity", {
      agent_id, activity_status: activity.activity_status,
      current_file: activity.current_file, current_thread: activity.current_thread,
    });
    return { content: [{ type: "text", text: JSON.stringify(activity) }] };
  });

  server.tool("agent_activity", "Get activity status for all online agents", {}, async () => {
    const activities = activityTracker.listAll({ idleAfterMinutes: 5 });
    return { content: [{ type: "text", text: JSON.stringify(activities) }] };
  });

  // â”€â”€ CONSULTATION TOOLS â”€â”€

  server.tool("announce_work", "Open a consultation thread before starting work", {
    agent_id: z.string(),
    subject: z.string(),
    plan: z.string().optional(),
    target_modules: z.array(z.string()),
    target_files: z.array(z.string()),
    depends_on_files: z.array(z.string()).optional(),
    exports_affected: z.array(z.string()).optional(),
    keep_open: z.boolean().optional().describe("Keep thread open even if no agents are concerned (for manual coordination like games or debates)"),
    assigned_to: z.string().optional().describe("Directed-dispatch: only this agent_id will be allowed to claim the thread. Use for leadâ†’worker handoffs in maitre/chaine/relais presets. Implies keep_open=true."),
  }, async ({ agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to }) => {
    mcpLog.info({ tool: "announce_work", agent_id, subject, target_modules, target_files, assigned_to }, "Tool called");

    // Pre-step: MCP transport detects file/dependency conflicts (REST does not).
    const conflicts = conflictDetector.detect({ agent_id, target_modules, target_files });
    const thread = consultation.announceWork({
      agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to,
    });
    if (conflicts.length > 0) {
      getDb().prepare("UPDATE threads SET conflicts = ? WHERE id = ?")
        .run(JSON.stringify(conflicts), thread.id);
    }

    // S2 fix: shared workflow (impact scoring, override respondents, auto-resolve,
    // impact_scored + introspection SSE, plan-quality downgrade event). Same
    // function used by the REST /api/announce path.
    const { updated, categorized, respondents, planQuality } = runCommonAnnounceFlow(services, thread.id, {
      agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open,
    });

    // Post-step: MCP-specific thread_opened SSE shape (with conflicts inline)
    // and MQTT publication. REST emits a different shape — kept divergent
    // because consumers may depend on the exact field set.
    sseEmitter.emit("thread_opened", {
      thread_id: thread.id, initiator: agent_id, subject, target_modules, conflicts,
      expected_respondents: respondents,
      mode: planQuality.mode,
      plan: plan || null,
      plan_quality: planQuality,
    });
    mqttBridge.publishConsultation(thread.id, agent_id, subject, target_modules);

    // Gather context from concerned agents for the initiator (MCP-only)
    const contextForInitiator = respondents.map((rid: string) =>
      contextProvider.getRelevantContext(rid, { thread_id: updated.id, subject, target_modules, target_files })
    ).filter((ctx: AgentContext) => ctx.modules.length > 0);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ thread: updated, conflicts, context: contextForInitiator, impact: categorized }),
      }],
    };
  });

  server.tool("post_to_thread", "Post a message to a consultation thread", {
    thread_id: z.string(),
    agent_id: z.string(),
    agent_name: z.string().optional(),
    type: z.enum(["context", "suggestion", "warning"]),
    content: z.string(),
    context_snapshot: z.string().optional(),
    in_reply_to: z.string().optional(),
  }, async ({ thread_id, agent_id, agent_name, type, content, context_snapshot, in_reply_to }) => {
    mcpLog.info({ tool: "post_to_thread", thread_id, agent_id, type }, "Tool called");
    const msg = consultation.postToThread({
      thread_id, agent_id, agent_name, type, content, context_snapshot, in_reply_to,
    });
    const thread = consultation.getThread(thread_id);
    sseEmitter.emit("message_posted", {
      thread_id, agent_id, agent_name: agent_name || agent_id,
      type, content, round: thread?.round || 1,
      token_estimate: msg.token_estimate || 0,
    });
    mqttBridge.publishMessage(thread_id, agent_id, type, content);
    return { content: [{ type: "text", text: JSON.stringify(msg) }] };
  });

  server.tool("propose_resolution", "Propose a resolution for the consultation", {
    thread_id: z.string(),
    agent_id: z.string(),
    summary: z.string(),
    plan: z.string().optional(),
  }, async ({ thread_id, agent_id, summary, plan }) => {
    mcpLog.info({ tool: "propose_resolution", thread_id, agent_id }, "Tool called");
    consultation.proposeResolution(thread_id, agent_id, summary);
    sseEmitter.emit("resolution_proposed", { thread_id, agent_id, summary });
    mqttBridge.publishResolution(thread_id, "resolving", summary);
    const thread = consultation.getThread(thread_id);
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("approve_resolution", "Approve the proposed resolution", {
    thread_id: z.string(),
    agent_id: z.string(),
  }, async ({ thread_id, agent_id }) => {
    mcpLog.info({ tool: "approve_resolution", thread_id, agent_id }, "Tool called");
    const agentInfo = registry.get(agent_id);
    consultation.approveResolution(thread_id, agent_id, agentInfo?.name);
    const thread = consultation.getThread(thread_id)!;
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("contest_resolution", "Contest the proposed resolution", {
    thread_id: z.string(),
    agent_id: z.string(),
    reason: z.string(),
  }, async ({ thread_id, agent_id, reason }) => {
    mcpLog.info({ tool: "contest_resolution", thread_id, agent_id }, "Tool called");
    consultation.contestResolution(thread_id, agent_id, reason);
    const thread = consultation.getThread(thread_id);
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("close_thread", "Close a consultation thread", {
    thread_id: z.string(),
    agent_id: z.string(),
    summary: z.string(),
  }, async ({ thread_id, agent_id, summary }) => {
    mcpLog.info({ tool: "close_thread", thread_id, agent_id }, "Tool called");
    consultation.closeThread(thread_id, agent_id, summary);
    return { content: [{ type: "text", text: "closed" }] };
  });

  server.tool("cancel_thread", "Cancel a consultation thread", {
    thread_id: z.string(),
    agent_id: z.string(),
    reason: z.string().optional(),
  }, async ({ thread_id, agent_id, reason }) => {
    mcpLog.info({ tool: "cancel_thread", thread_id, agent_id }, "Tool called");
    consultation.cancelThread(thread_id, agent_id, reason);
    sseEmitter.emit("thread_cancelled", { thread_id, reason });
    return { content: [{ type: "text", text: "cancelled" }] };
  });

  server.tool("get_thread", "Get a thread with all messages", {
    thread_id: z.string(),
  }, async ({ thread_id }) => {
    const result = consultation.getThreadWithMessages(thread_id);
    mcpLog.debug({ tool: "get_thread", thread_id, message_count: result?.messages.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool("get_thread_updates", "Get new messages since timestamp", {
    agent_id: z.string(),
    since: z.string().optional(),
  }, async ({ agent_id, since }) => {
    const updates = consultation.getThreadUpdates(agent_id, since);
    return { content: [{ type: "text", text: JSON.stringify(updates) }] };
  });

  server.tool("list_threads", "List consultation threads", {
    status: z.string().optional(),
    agent_id: z.string().optional(),
    module: z.string().optional(),
    assigned_to_me: z.string().optional().describe("Filter to threads claimable by this agent_id: open pool (assigned_to NULL) OR directed to me. Use for worker agents receiving directed dispatches."),
  }, async ({ status, agent_id, module, assigned_to_me }) => {
    const threads = consultation.listThreads({ status, agent_id, module, assigned_to_me });
    mcpLog.debug({ tool: "list_threads", status, agent_id, module, assigned_to_me, result_count: threads.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(threads) }] };
  });

  server.tool("log_action_summary", "Log a one-liner summary of an action", {
    session_id: z.string(),
    agent_id: z.string(),
    file_path: z.string().optional(),
    summary: z.string(),
  }, async ({ session_id, agent_id, file_path, summary }) => {
    const result = consultation.logActionSummary({ session_id, agent_id, file_path, summary });
    sseEmitter.emit("action_summary", { agent_id, file_path, summary });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  // â”€â”€ FILE TRACKING TOOLS â”€â”€

  server.tool("hot_files", "List files modified by multiple agents", {
    since_minutes: z.number().optional(),
  }, async ({ since_minutes }) => {
    const files = fileTracker.getHotFiles(since_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("get_session_files", "Get files modified in a session", {
    session_id: z.string(),
  }, async ({ session_id }) => {
    const files = fileTracker.getBySession(session_id);
    return { content: [{ type: "text", text: JSON.stringify(files) }] };
  });

  server.tool("check_file_conflict", "Check if another agent is editing a file", {
    file_path: z.string(),
    agent_id: z.string(),
    within_minutes: z.number().optional(),
  }, async ({ file_path, agent_id, within_minutes }) => {
    const result = fileTracker.checkFileConflict(file_path, agent_id, within_minutes || 30);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  // â”€â”€ DEPENDENCY MAP TOOLS â”€â”€

  server.tool("set_dependency_map", "Load module dependency graph", {
    modules: z.string(), // JSON DependencyMap
  }, async ({ modules }) => {
    const map = JSON.parse(modules);
    depMap.setMap(map);
    return { content: [{ type: "text", text: "ok" }] };
  });

  server.tool("get_blast_radius", "Calculate impact of changes to a module", {
    module_id: z.string(),
  }, async ({ module_id }) => {
    const radius = depMap.getBlastRadius(module_id);
    return { content: [{ type: "text", text: JSON.stringify(radius) }] };
  });

  server.tool("get_module_info", "Get module dependency info", {
    module_id: z.string(),
  }, async ({ module_id }) => {
    const info = depMap.getModuleInfo(module_id);
    return { content: [{ type: "text", text: JSON.stringify(info) }] };
  });

  // â”€â”€ STATUS TOOL â”€â”€

  server.tool("coordinator_status", "Full system status", {}, async () => {
    const online = registry.listOnline();
    const openThreads = consultation.listThreads({ status: "open" });
    const resolvingThreads = consultation.listThreads({ status: "resolving" });
    const hotFiles = fileTracker.getHotFiles(30);
    const status = {
      agents_online: online.length,
      agents: online.map((a) => ({ id: a.id, name: a.name, modules: JSON.parse(a.modules) })),
      open_threads: openThreads.length,
      resolving_threads: resolvingThreads.length,
      hot_files: hotFiles.length,
      mqtt_connected: mqttBridge.isConnected(),
    };
    mcpLog.debug({ tool: "coordinator_status", agents_online: online.length, open_threads: openThreads.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(status) }] };
  });

  // â”€â”€ COORDINATION HELPERS â”€â”€

  server.tool("wait_for_peers", "Block until at least N other online agents are registered, or timeout. Use before the first announce_work to avoid the race where one agent announces before peers have booted.", {
    agent_id: z.string(),
    min_peers: z.number().optional(),
    timeout_seconds: z.number().optional(),
  }, async ({ agent_id, min_peers, timeout_seconds }) => {
    const targetPeers = min_peers ?? 1;
    const timeoutMs = (timeout_seconds ?? 30) * 1000;
    const pollIntervalMs = 1000;
    const startedAt = Date.now();
    mcpLog.info({ tool: "wait_for_peers", agent_id, min_peers: targetPeers, timeout_seconds: timeoutMs / 1000 }, "Tool called");

    while (Date.now() - startedAt < timeoutMs) {
      const peers = registry.listOnline().filter((a) => a.id !== agent_id);
      if (peers.length >= targetPeers) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ready: true,
              online_peers: peers.map((p) => ({ id: p.id, name: p.name })),
              waited_ms: Date.now() - startedAt,
            }),
          }],
        };
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    const finalPeers = registry.listOnline().filter((a) => a.id !== agent_id);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ready: false,
          timeout: true,
          online_peers: finalPeers.map((p) => ({ id: p.id, name: p.name })),
          waited_ms: Date.now() - startedAt,
        }),
      }],
    };
  });

  // â”€â”€ MQTT LISTENER TOOLS (replaces standalone mqtt-mcp-bridge) â”€â”€

  server.tool("wait_for_message", "Block until an MQTT consultation message arrives or timeout", {
    agent_id: z.string(),
    timeout_seconds: z.number().optional(),
  }, async ({ agent_id, timeout_seconds }) => {
    const timeoutMs = (timeout_seconds || 15) * 1000;
    const msg = await mqttBridge.waitForMessage(agent_id, timeoutMs);
    if (msg) {
      return { content: [{ type: "text", text: JSON.stringify(msg) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ timeout: true }) }] };
  });

  server.tool("get_queued_messages", "Get all queued MQTT messages without blocking", {
    agent_id: z.string(),
  }, async ({ agent_id }) => {
    const messages = mqttBridge.getQueuedMessages(agent_id);
    return { content: [{ type: "text", text: JSON.stringify(messages) }] };
  });

  server.tool("mqtt_publish", "Publish a message to an MQTT topic", {
    topic: z.string(),
    payload: z.string(),
  }, async ({ topic, payload }) => {
    mqttBridge.mqttPublish(topic, payload);
    return { content: [{ type: "text", text: "published" }] };
  });

  return server;
}

