import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AgentContext } from "../types.js";
import { getDb } from "../database.js";
import { runCommonAnnounceFlow } from "../announce-workflow.js";

/**
 * S1 fix (partial): consultation domain tools extracted from server-setup.ts.
 *
 * Originally these 11 tools (announce_work, post_to_thread, propose/approve/
 * contest_resolution, close/cancel_thread, get_thread, get_thread_updates,
 * list_threads, log_action_summary) lived inline in createMcpServer's
 * 420-line body. Extraction here:
 *   - reduces server-setup.ts by ~200 lines
 *   - groups related tools by domain (= one file per concern)
 *   - keeps behavior identical (no signature changes, no SSE/MQTT shape
 *     changes — verified by all existing tests)
 *
 * Other tool groups (agents, files, dependencies, mqtt, status) remain in
 * server-setup.ts under their existing section comments. Splitting them is
 * straightforward following this pattern but kept out of this PR to minimize
 * the diff for reviewers.
 */
export function registerConsultationTools(
  server: McpServer,
  services: CoordinatorServices,
  mcpLog: Logger,
): void {
  const { registry, consultation, conflictDetector, contextProvider, sseEmitter, mqttBridge } = services;

  server.tool("announce_work", "Open a consultation thread before starting work", {
    agent_id: z.string(),
    subject: z.string(),
    plan: z.string().optional(),
    target_modules: z.array(z.string()),
    target_files: z.array(z.string()).describe("Repo-relative file paths (forward-slash, e.g. 'src/foo.ts'). Absolute paths are not accepted in team-mode."),
    depends_on_files: z.array(z.string()).optional().describe("Repo-relative file paths your work depends on."),
    exports_affected: z.array(z.string()).optional().describe("Repo-relative file paths whose exports your work modifies."),
    keep_open: z.boolean().optional().describe("Keep thread open even if no agents are concerned (for manual coordination like games or debates)"),
    assigned_to: z.string().optional().describe("Directed-dispatch: only this agent_id will be allowed to claim the thread. Use for lead→worker handoffs in maitre/chaine/relais presets. Implies keep_open=true."),
    target_symbols: z.array(z.string().max(256)).max(200).optional()
      .describe("Qualified symbol names you intend to touch (e.g. 'UserService.getById'). Used by Layer 0.5 to annotate same-file overlaps."),
  }, async ({ agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to, target_symbols }) => {
    mcpLog.info({ tool: "announce_work", agent_id, subject, target_modules, target_files, assigned_to }, "Tool called");

    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const conflicts = conflictDetector.detect({ org_id: "default", agent_id, target_modules, target_files });
    const thread = consultation.announceWork("default", {
      agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to,
    });
    if (conflicts.length > 0) {
      getDb().prepare("UPDATE threads SET conflicts = ? WHERE id = ?")
        .run(JSON.stringify(conflicts), thread.id);
    }

    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const { updated, categorized, respondents, planQuality } = runCommonAnnounceFlow(services, thread.id, {
      org_id: "default", agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, target_symbols,
    });

    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default'.
    sseEmitter.emit("thread_opened", {
      thread_id: thread.id, initiator: agent_id, subject, target_modules, conflicts,
      expected_respondents: respondents,
      mode: planQuality.mode,
      plan: plan || null,
      plan_quality: planQuality,
    }, { org_id: "default" });
    mqttBridge.publishConsultation(thread.id, agent_id, subject, target_modules);

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
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const msg = consultation.postToThread("default", {
      thread_id, agent_id, agent_name, type, content, context_snapshot, in_reply_to,
    });
    const thread = consultation.getThread("default", thread_id);
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default'.
    sseEmitter.emit("message_posted", {
      thread_id, agent_id, agent_name: agent_name || agent_id,
      type, content, round: thread?.round || 1,
      token_estimate: msg.token_estimate || 0,
    }, { org_id: "default" });
    mqttBridge.publishMessage(thread_id, agent_id, type, content);
    return { content: [{ type: "text", text: JSON.stringify(msg) }] };
  });

  server.tool("propose_resolution", "Propose a resolution for the consultation", {
    thread_id: z.string(),
    agent_id: z.string(),
    summary: z.string(),
    plan: z.string().optional(),
  }, async ({ thread_id, agent_id, summary }) => {
    mcpLog.info({ tool: "propose_resolution", thread_id, agent_id }, "Tool called");
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    consultation.proposeResolution("default", thread_id, agent_id, summary);
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default'.
    sseEmitter.emit("resolution_proposed", { thread_id, agent_id, summary }, { org_id: "default" });
    mqttBridge.publishResolution(thread_id, "resolving", summary);
    const thread = consultation.getThread("default", thread_id);
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("approve_resolution", "Approve the proposed resolution", {
    thread_id: z.string(),
    agent_id: z.string(),
  }, async ({ thread_id, agent_id }) => {
    mcpLog.info({ tool: "approve_resolution", thread_id, agent_id }, "Tool called");
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const agentInfo = registry.get("default", agent_id);
    consultation.approveResolution("default", thread_id, agent_id, agentInfo?.name ?? undefined);
    const thread = consultation.getThread("default", thread_id)!;
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("contest_resolution", "Contest the proposed resolution", {
    thread_id: z.string(),
    agent_id: z.string(),
    reason: z.string(),
  }, async ({ thread_id, agent_id, reason }) => {
    mcpLog.info({ tool: "contest_resolution", thread_id, agent_id }, "Tool called");
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    consultation.contestResolution("default", thread_id, agent_id, reason);
    const thread = consultation.getThread("default", thread_id);
    return { content: [{ type: "text", text: JSON.stringify(thread) }] };
  });

  server.tool("close_thread", "Close a consultation thread", {
    thread_id: z.string(),
    agent_id: z.string(),
    summary: z.string(),
  }, async ({ thread_id, agent_id, summary }) => {
    mcpLog.info({ tool: "close_thread", thread_id, agent_id }, "Tool called");
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    consultation.closeThread("default", thread_id, agent_id, summary);
    return { content: [{ type: "text", text: "closed" }] };
  });

  server.tool("cancel_thread", "Cancel a consultation thread", {
    thread_id: z.string(),
    agent_id: z.string(),
    reason: z.string().optional(),
  }, async ({ thread_id, agent_id, reason }) => {
    mcpLog.info({ tool: "cancel_thread", thread_id, agent_id }, "Tool called");
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    consultation.cancelThread("default", thread_id, agent_id, reason ?? undefined);
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default'.
    sseEmitter.emit("thread_cancelled", { thread_id, reason }, { org_id: "default" });
    return { content: [{ type: "text", text: "cancelled" }] };
  });

  server.tool("get_thread", "Get a thread with all messages", {
    thread_id: z.string(),
  }, async ({ thread_id }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const result = consultation.getThreadWithMessages("default", thread_id);
    mcpLog.debug({ tool: "get_thread", thread_id, message_count: result?.messages.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  server.tool("get_thread_updates", "Get new messages since timestamp", {
    agent_id: z.string(),
    since: z.string().optional(),
  }, async ({ agent_id, since }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const updates = consultation.getThreadUpdates("default", agent_id, since ?? undefined);
    return { content: [{ type: "text", text: JSON.stringify(updates) }] };
  });

  server.tool("list_threads", "List consultation threads", {
    status: z.string().optional(),
    agent_id: z.string().optional(),
    module: z.string().optional(),
    assigned_to_me: z.string().optional().describe("Filter to threads claimable by this agent_id: open pool (assigned_to NULL) OR directed to me. Use for worker agents receiving directed dispatches."),
  }, async ({ status, agent_id, module, assigned_to_me }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const threads = consultation.listThreads("default", { status, agent_id, module, assigned_to_me });
    mcpLog.debug({ tool: "list_threads", status, agent_id, module, assigned_to_me, result_count: threads.length }, "Tool called");
    return { content: [{ type: "text", text: JSON.stringify(threads) }] };
  });

  server.tool("log_action_summary", "Log a one-liner summary of an action", {
    session_id: z.string(),
    agent_id: z.string(),
    file_path: z.string().optional().describe("Repo-relative file path."),
    summary: z.string(),
  }, async ({ session_id, agent_id, file_path, summary }) => {
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default' (cross-org leak window — single-tenant only)
    const result = consultation.logActionSummary("default", { session_id, agent_id, file_path, summary });
    // TODO(Task 23.5): thread real org_id from MCP session claims; for now MCP uses 'default'.
    sseEmitter.emit("action_summary", { agent_id, file_path, summary }, { org_id: "default" });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}
