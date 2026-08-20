import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AgentContext } from "../types.js";
import { getDb } from "../database.js";
import { normalizeDeclaredPaths } from "../path-normalize.js";
import { runCommonAnnounceFlow } from "../announce-workflow.js";
import type { AuthClaims } from "../auth.js";

import { missingClaimsError } from "./tool-errors.js";

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
  getSessionClaims: (sessionId: string) => AuthClaims | null,
): void {
  const { registry, consultation, conflictDetector, contextProvider, sseEmitter, mqttBridge } =
    services;

  server.registerTool(
    "announce_work",
    {
      description: "Open a consultation thread before starting work",
      inputSchema: z.object({
        agent_id: z.string().describe("ID of the agent announcing the work."),
        subject: z.string().describe("Short human-readable summary of the work being announced."),
        plan: z
          .string()
          .optional()
          .describe(
            "Free-text plan describing the intended change, used for plan-quality scoring.",
          ),
        target_modules: z
          .array(z.string())
          .describe("Module IDs (as used in the dependency map) this work will touch."),
        target_files: z
          .array(z.string())
          .describe(
            "Repo-relative file paths, forward-slash (e.g. 'src/foo.ts'). Normalized on arrival so they match observed activity: './' is stripped, backslashes become '/', and an absolute path under the configured repo root is rewritten relative to it — one outside it is rejected.",
          ),
        depends_on_files: z
          .array(z.string())
          .optional()
          .describe("Repo-relative file paths your work depends on."),
        exports_affected: z
          .array(z.string())
          .optional()
          .describe("Repo-relative file paths whose exports your work modifies."),
        keep_open: z
          .boolean()
          .optional()
          .describe(
            "Keep thread open even if no agents are concerned (for manual coordination like games or debates)",
          ),
        assigned_to: z
          .string()
          .optional()
          .describe(
            "Directed-dispatch: only this agent_id will be allowed to claim the thread. Use for lead→worker handoffs in maitre/chaine/relais presets. Implies keep_open=true.",
          ),
        target_symbols: z
          .array(z.string().max(256))
          .max(200)
          .optional()
          .describe(
            "Qualified symbol names you intend to touch (e.g. 'UserService.getById'). Used by Layer 0.5 to annotate same-file overlaps.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Announce work" },
    },
    async (
      {
        agent_id,
        subject,
        plan,
        target_modules,
        target_files,
        depends_on_files,
        exports_affected,
        keep_open,
        assigned_to,
        target_symbols,
      },
      ctx,
    ) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info(
        { tool: "announce_work", agent_id, subject, target_modules, target_files, assigned_to },
        "Tool called",
      );

      // issue #275: the declared side is normalized here, at the entry point,
      // exactly as /api/file-activity and /api/working-files do for the observed
      // side. Without this the two never join: the scorer queries normalized
      // columns by exact SQL equality, so `src/Types.ts` announced on Windows
      // silently matched nothing.
      const repoRoot = process.env.COORDINATOR_REPO_ROOT || null;
      const declared = normalizeDeclaredPaths(repoRoot, [
        ...target_files,
        ...(depends_on_files ?? []),
        ...(exports_affected ?? []),
      ]);
      if (!declared.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `invalid path ${declared.rejected.path}: ${declared.rejected.message}`,
            },
          ],
        };
      }
      const nTargets = target_files.length;
      const nDepends = depends_on_files?.length ?? 0;
      target_files = declared.paths.slice(0, nTargets);
      depends_on_files = depends_on_files && declared.paths.slice(nTargets, nTargets + nDepends);
      exports_affected = exports_affected && declared.paths.slice(nTargets + nDepends);

      const conflicts = conflictDetector.detect({
        org_id: claims.org,
        agent_id,
        target_modules,
        target_files,
      });
      const thread = consultation.announceWork(claims.org, {
        agent_id,
        subject,
        plan,
        target_modules,
        target_files,
        depends_on_files,
        exports_affected,
        keep_open,
        assigned_to,
      });
      if (conflicts.length > 0) {
        getDb()
          .prepare("UPDATE threads SET conflicts = ? WHERE id = ?")
          .run(JSON.stringify(conflicts), thread.id);
      }

      const { updated, categorized, respondents, planQuality, planDowngradeReason } =
        runCommonAnnounceFlow(services, thread.id, {
          org_id: claims.org,
          agent_id,
          subject,
          plan,
          target_modules,
          target_files,
          depends_on_files,
          exports_affected,
          keep_open,
          target_symbols,
        });

      sseEmitter.emit(
        "thread_opened",
        {
          thread_id: thread.id,
          initiator: agent_id,
          subject,
          target_modules,
          conflicts,
          expected_respondents: respondents,
          mode: planQuality.mode,
          plan: plan || null,
          plan_quality: planQuality,
        },
        { org_id: claims.org },
      );
      mqttBridge.publishConsultation(claims.org, thread.id, agent_id, subject, target_modules);

      const contextForInitiator = respondents
        .map((rid: string) =>
          contextProvider.getRelevantContext(claims.org, rid, {
            thread_id: updated.id,
            subject,
            target_modules,
            target_files,
          }),
        )
        .filter((ctx: AgentContext) => ctx.modules.length > 0);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              thread: updated,
              conflicts,
              context: contextForInitiator,
              impact: categorized,
              // #351: the verdict used to go only to the dashboard. An agent
              // whose plan was scored down could not learn it, which made the
              // signal decorative. Additive: no existing key changes.
              plan_quality: planQuality,
              plan_downgrade_reason: planDowngradeReason,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "post_to_thread",
    {
      description: "Post a message to a consultation thread",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z.string().describe("ID of the agent posting the message."),
        agent_name: z.string().optional().describe("Display name of the posting agent."),
        type: z
          .enum(["context", "suggestion", "warning"])
          .describe(
            "Kind of message: shared context, a suggestion, or a warning about a conflict/risk.",
          ),
        content: z.string().describe("Message body."),
        context_snapshot: z
          .string()
          .optional()
          .describe("Optional free-text snapshot of relevant context at post time."),
        in_reply_to: z
          .string()
          .optional()
          .describe("ID of the message this one replies to, if any."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Post to thread" },
    },
    async (
      { thread_id, agent_id, agent_name, type, content, context_snapshot, in_reply_to },
      ctx,
    ) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "post_to_thread", thread_id, agent_id, type }, "Tool called");
      // issue #233: posting to a thread proves the agent is alive, so it
      // refreshes last_seen_at the same way an explicit heartbeat would.
      services.registry.heartbeat(claims.org, agent_id);
      const msg = consultation.postToThread(claims.org, {
        thread_id,
        agent_id,
        agent_name,
        type,
        content,
        context_snapshot,
        in_reply_to,
      });
      const thread = consultation.getThread(claims.org, thread_id);
      sseEmitter.emit(
        "message_posted",
        {
          thread_id,
          agent_id,
          agent_name: agent_name || agent_id,
          type,
          content,
          round: thread?.round || 1,
          token_estimate: msg.token_estimate || 0,
        },
        { org_id: claims.org },
      );
      mqttBridge.publishMessage(claims.org, thread_id, agent_id, type, content);
      return { content: [{ type: "text", text: JSON.stringify(msg) }] };
    },
  );

  server.registerTool(
    "propose_resolution",
    {
      description: "Propose a resolution for the consultation",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z
          .string()
          .describe(
            "ID of the agent proposing the resolution (must be the initiator or claimant).",
          ),
        summary: z.string().describe("Summary of the proposed resolution."),
        plan: z.string().optional().describe("Optional revised plan accompanying the resolution."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Propose resolution" },
    },
    async ({ thread_id, agent_id, summary }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "propose_resolution", thread_id, agent_id }, "Tool called");
      consultation.proposeResolution(claims.org, thread_id, agent_id, summary);
      sseEmitter.emit(
        "resolution_proposed",
        { thread_id, agent_id, summary },
        { org_id: claims.org },
      );
      mqttBridge.publishResolution(claims.org, thread_id, "resolving", summary);
      const thread = consultation.getThread(claims.org, thread_id);
      return { content: [{ type: "text", text: JSON.stringify(thread) }] };
    },
  );

  server.registerTool(
    "approve_resolution",
    {
      description: "Approve the proposed resolution",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z.string().describe("ID of the agent approving the resolution."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Approve resolution" },
    },
    async ({ thread_id, agent_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "approve_resolution", thread_id, agent_id }, "Tool called");
      const agentInfo = registry.get(claims.org, agent_id);
      consultation.approveResolution(claims.org, thread_id, agent_id, agentInfo?.name ?? undefined);
      const thread = consultation.getThread(claims.org, thread_id)!;
      return { content: [{ type: "text", text: JSON.stringify(thread) }] };
    },
  );

  server.registerTool(
    "contest_resolution",
    {
      description: "Contest the proposed resolution",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z.string().describe("ID of the agent contesting the resolution."),
        reason: z.string().describe("Reason the proposed resolution is being contested."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Contest resolution" },
    },
    async ({ thread_id, agent_id, reason }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "contest_resolution", thread_id, agent_id }, "Tool called");
      consultation.contestResolution(claims.org, thread_id, agent_id, reason);
      const thread = consultation.getThread(claims.org, thread_id);
      return { content: [{ type: "text", text: JSON.stringify(thread) }] };
    },
  );

  server.registerTool(
    "close_thread",
    {
      description: "Close a consultation thread",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z.string().describe("ID of the agent closing the thread."),
        summary: z
          .string()
          .describe("Final summary of what was done, recorded on the closed thread."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, title: "Close thread" },
    },
    async ({ thread_id, agent_id, summary }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "close_thread", thread_id, agent_id }, "Tool called");
      consultation.closeThread(claims.org, thread_id, agent_id, summary);
      return { content: [{ type: "text", text: "closed" }] };
    },
  );

  server.registerTool(
    "cancel_thread",
    {
      description: "Cancel a consultation thread",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
        agent_id: z.string().describe("ID of the agent cancelling the thread."),
        reason: z.string().optional().describe("Optional reason the thread is being cancelled."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, title: "Cancel thread" },
    },
    async ({ thread_id, agent_id, reason }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      mcpLog.info({ tool: "cancel_thread", thread_id, agent_id }, "Tool called");
      consultation.cancelThread(claims.org, thread_id, agent_id, reason ?? undefined);
      sseEmitter.emit("thread_cancelled", { thread_id, reason }, { org_id: claims.org });
      return { content: [{ type: "text", text: "cancelled" }] };
    },
  );

  server.registerTool(
    "get_thread",
    {
      description: "Get a thread with all messages",
      inputSchema: z.object({
        thread_id: z.string().describe("Thread ID returned by announce_work or list_threads."),
      }),
      annotations: { readOnlyHint: true, title: "Get thread" },
    },
    async ({ thread_id }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const result = consultation.getThreadWithMessages(claims.org, thread_id);
      mcpLog.debug(
        { tool: "get_thread", thread_id, message_count: result?.messages.length },
        "Tool called",
      );
      if (!result) {
        return {
          isError: true,
          content: [{ type: "text", text: `Thread not found: ${thread_id}` }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "get_thread_updates",
    {
      description: "Get new messages since timestamp",
      inputSchema: z.object({
        agent_id: z.string().describe("ID of the agent requesting updates."),
        since: z
          .string()
          .optional()
          .describe(
            "Timestamp cursor. Messages at or after this time are returned -- the comparison is inclusive, so the message on the boundary comes back again. Pass back the created_at of the last message you saw: that value is already in the accepted shape. ISO-8601 with an offset or a trailing Z is also accepted. Omit to get all updates for this agent.",
          ),
      }),
      annotations: { readOnlyHint: true, title: "Get thread updates" },
    },
    async ({ agent_id, since }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const updates = consultation.getThreadUpdates(claims.org, agent_id, since ?? undefined);
      return { content: [{ type: "text", text: JSON.stringify(updates) }] };
    },
  );

  server.registerTool(
    "list_threads",
    {
      description: "List consultation threads",
      inputSchema: z.object({
        status: z
          .enum(["open", "resolving", "resolved", "cancelled", "poisoned"])
          .optional()
          .describe("Filter to threads in this status."),
        agent_id: z.string().optional().describe("Filter to threads initiated by this agent_id."),
        module: z.string().optional().describe("Filter to threads targeting this module_id."),
        assigned_to_me: z
          .string()
          .optional()
          .describe(
            "Filter to threads claimable by this agent_id: open pool (assigned_to NULL) OR directed to me. Use for worker agents receiving directed dispatches.",
          ),
      }),
      annotations: { readOnlyHint: true, title: "List threads" },
    },
    async ({ status, agent_id, module, assigned_to_me }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const threads = consultation.listThreads(claims.org, {
        status,
        agent_id,
        module,
        assigned_to_me,
      });
      mcpLog.debug(
        {
          tool: "list_threads",
          status,
          agent_id,
          module,
          assigned_to_me,
          result_count: threads.length,
        },
        "Tool called",
      );
      return { content: [{ type: "text", text: JSON.stringify(threads) }] };
    },
  );

  server.registerTool(
    "log_action_summary",
    {
      description: "Log a one-liner summary of an action",
      inputSchema: z.object({
        session_id: z.string().describe("Session ID the action was performed under."),
        agent_id: z.string().describe("ID of the agent that performed the action."),
        file_path: z.string().optional().describe("Repo-relative file path."),
        summary: z.string().describe("One-liner summary of the action taken."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, title: "Log action summary" },
    },
    async ({ session_id, agent_id, file_path, summary }, ctx) => {
      const claims = getSessionClaims(ctx.sessionId ?? "");
      if (!claims) throw missingClaimsError();
      const result = consultation.logActionSummary(claims.org, {
        session_id,
        agent_id,
        file_path,
        summary,
      });
      sseEmitter.emit("action_summary", { agent_id, file_path, summary }, { org_id: claims.org });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
