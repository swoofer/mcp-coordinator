import type { IncomingMessage, ServerResponse } from "http";
import type { ZodError } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";
import { createHash } from "crypto";
import { getDb } from "../database.js";
import { runCommonAnnounceFlow } from "../announce-workflow.js";
import { runRegisterFlow } from "../register-workflow.js";
import { canResetDb } from "../reset-guard.js";
import { json } from "./utils.js";
import { normalizePath } from "../path-normalize.js";
import { safeJsonParse } from "../json-utils.js";
import { appError } from "./response-contract.js";
import {
  RegisterBodySchema,
  SessionStopBodySchema,
  CheckConflictBodySchema,
  LogFileBodySchema,
  AnnounceBodySchema,
  PostToThreadBodySchema,
  TokenUsageBodySchema,
  UnclaimTaskBodySchema,
  ClaimTaskBodySchema,
  ProposeResolutionBodySchema,
  ApproveResolutionBodySchema,
  HotFilesBodySchema,
  IntrospectionResponseBodySchema,
  RunConfigBodySchema,
  CheckInterruptBodySchema,
} from "./rest-schemas.js";

/**
 * qualite-code-01 (1/3): dispatch-table refactor of handleRest. Each function
 * below is a straight extraction of one if/else branch that used to live
 * inline in handleRest — bodies are unchanged, only wrapped in a named
 * function so they can be registered in the ROUTES table in handle-rest.ts.
 */

export interface RestContext {
  services: CoordinatorServices;
  httpLog: Logger;
  authEnabled: boolean;
  /** Authenticated identity for this request. Synthetic legacy claims when AUTH_ENABLED=false and no Bearer. */
  claims: AuthClaims;
  getRunConfig: () => Record<string, unknown> | null;
  setRunConfig: (cfg: Record<string, unknown> | null) => void;
}

export type RestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>
) => Promise<void> | void;

/**
 * qualite-code-02 / architecture-15: send a structured 400 for a body that
 * failed zod validation. Uses the same `appError` envelope as every other
 * structured error response (qualite-code-08) so REST clients get one
 * consistent error contract instead of ad hoc shapes per endpoint.
 */
export function sendValidationError(res: ServerResponse, error: ZodError): void {
  json(res, appError("INVALID_REQUEST", "Request body failed validation", {
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  }), 400);
}

export function handleRegister(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { services } = ctx;
  const parsed = RegisterBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { agent_id, name, modules } = parsed.data;
  // architecture-07: shared flow with MCP register_agent (registry.register +
  // sseEmitter "agent_online" + mqttBridge.registerAgent retained-status publish).
  const agent = runRegisterFlow(services, ctx.claims.org, agent_id, name, modules ?? []);
  json(res, agent);
}

export function handleSessionStart(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, consultation, fileTracker } = ctx.services;
  const online = registry.listOnline(ctx.claims.org);
  const openThreads = consultation.listThreads(ctx.claims.org, { status: "open" });
  const hotFiles = fileTracker.getHotFiles(ctx.claims.org, 30);
  const briefing = [
    `Agents en ligne: ${online.map((a) => a.name).join(", ") || "aucun"}`,
    `Consultations ouvertes: ${openThreads.length}`,
    `Hot files: ${hotFiles.map((f) => f.file_path).join(", ") || "aucun"}`,
  ].join("\n");
  json(res, { briefing, summary: { online: online.length, open_threads: openThreads.length, hot_files: hotFiles.length } });
}

export function handleSessionStop(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, activityTracker, consultation, sseEmitter } = ctx.services;
  const parsed = SessionStopBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { agent_id } = parsed.data;
  registry.setOffline(ctx.claims.org, agent_id);
  activityTracker.reportOffline(ctx.claims.org, agent_id);
  consultation.handleAgentDeparture(agent_id);
  sseEmitter.emit("agent_offline", { agent_id }, { org_id: ctx.claims.org });
  json(res, { ok: true });
}

export function handleCheckConflict(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { fileTracker } = ctx.services;
  const parsed = CheckConflictBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { file, agent_id } = parsed.data;
  const conflict = fileTracker.checkFileConflict(ctx.claims.org, file, agent_id, 30);
  const warnings: string[] = [];
  if (conflict.conflict) {
    warnings.push(`File ${file} recently edited by: ${conflict.agents.join(", ")}`);
  }
  json(res, { conflict: conflict.conflict, warnings });
}

export function handleLogFile(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { fileTracker, activityTracker, sseEmitter } = ctx.services;
  const parsed = LogFileBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { session_id, agent_id, agent_name, tool_name, file } = parsed.data;
  fileTracker.log({ org_id: ctx.claims.org, session_id, agent_id, agent_name, tool_name, file_path: file });
  activityTracker.reportFileActivity(ctx.claims.org, agent_id, file);
  sseEmitter.emit("file_edited", { agent_id, agent_name: agent_name || agent_id, file, tool_name }, { org_id: ctx.claims.org });
  json(res, { ok: true });
}

export function handleAnnounce(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { services, httpLog } = ctx;
  const { registry, consultation, sseEmitter } = services;
  const parsed = AnnounceBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to, target_symbols } = parsed.data;

  const thread = consultation.announceWork(ctx.claims.org, { agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to });
  const agentInfo = registry.get(ctx.claims.org, agent_id);

  // S2 fix: shared workflow (impact scoring, override respondents, auto-resolve,
  // impact_scored + introspection SSE, plan-quality downgrade event). Same
  // function used by the MCP announce_work tool path.
  const { updated, categorized, respondents, planQuality } = runCommonAnnounceFlow(services, thread.id, {
    org_id: ctx.claims.org, agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open,
    target_symbols,
  });

  // REST-specific thread_opened SSE shape (different field set than MCP — kept
  // divergent because consumers may depend on this exact contract).
  sseEmitter.emit("thread_opened", {
    thread_id: thread.id, subject, agent_id, agent_name: agentInfo?.name || agent_id,
    target_modules, target_files, expected_respondents: respondents,
    conflicts: safeJsonParse<unknown[]>(updated.conflicts, [], httpLog, "handle-rest./api/announce:updated.conflicts"),
    created_at: updated.created_at,
    mode: planQuality.mode,
    plan: plan || null,
    plan_quality: planQuality,
  }, { org_id: ctx.claims.org });
  json(res, { thread_id: thread.id, status: updated.status, impact: categorized });
}

export function handlePostToThread(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { consultation, sseEmitter } = ctx.services;
  const parsed = PostToThreadBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { thread_id, agent_id, agent_name, type, content } = parsed.data;
  // Pre-check the thread so we can return actionable status codes instead
  // of always-500 on any error. The client uses the status to decide
  // whether to warn (unexpected) or silently skip (normal race).
  const targetThread = consultation.getThread(ctx.claims.org, thread_id);
  if (!targetThread) {
    json(res, { error: "thread_not_found", thread_id }, 404);
    return;
  }
  if (targetThread.status === "cancelled") {
    json(res, { error: "thread_cancelled", thread_id }, 410);
    return;
  }
  const msg = consultation.postToThread(ctx.claims.org, { thread_id, agent_id, agent_name, type, content });
  const thread = consultation.getThread(ctx.claims.org, thread_id);
  sseEmitter.emit("message_posted", {
    thread_id, agent_id, agent_name: agent_name || agent_id,
    type, content, round: thread?.round || 1,
    token_estimate: msg.token_estimate || 0,
  }, { org_id: ctx.claims.org });
  json(res, msg);
}

export function handleTokenUsage(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { sseEmitter } = ctx.services;
  // Agent → coordinator telemetry, emitted once per LLM turn so the dashboard
  // and reports can pinpoint where tokens are being burned. Free-form shape
  // by design — only validated as a JSON object (not array/primitive).
  const parsed = TokenUsageBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  sseEmitter.emit("token_usage", parsed.data, { org_id: ctx.claims.org });
  json(res, { ok: true });
}

export function handleUnclaimTask(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { httpLog } = ctx;
  const parsed = UnclaimTaskBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { thread_id, agent_id } = parsed.data;
  const db = getDb();
  // F4: increment unclaim counter. After POISON_THRESHOLD aborts, flip status
  // to "poisoned" so no agent claims it again — prevents the tight
  // claim → no DONE → unclaim → re-claim loop we observed on stuck tasks.
  // Only the claiming agent can unclaim to prevent cross-agent interference.
  const POISON_THRESHOLD = 2;
  const result = db.prepare(
    "UPDATE threads SET claimed_by = NULL, claimed_at = NULL, unclaim_count = COALESCE(unclaim_count, 0) + 1 WHERE id = ? AND org_id = ? AND claimed_by = ? AND status = 'open'"
  ).run(thread_id, ctx.claims.org, agent_id);
  let poisoned = false;
  if (result.changes === 1) {
    const row = db.prepare("SELECT unclaim_count FROM threads WHERE id = ? AND org_id = ?").get(thread_id, ctx.claims.org) as { unclaim_count?: number } | undefined;
    if (row && (row.unclaim_count ?? 0) >= POISON_THRESHOLD) {
      db.prepare("UPDATE threads SET status = 'poisoned' WHERE id = ? AND org_id = ? AND status = 'open'").run(thread_id, ctx.claims.org);
      poisoned = true;
      httpLog.warn({ thread_id, unclaim_count: row.unclaim_count }, "thread poisoned after repeated unclaims");
    }
  }
  json(res, { success: result.changes === 1, poisoned });
}

export function handleClaimTask(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { consultation, mqttBridge, sseEmitter } = ctx.services;
  const parsed = ClaimTaskBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { thread_id, agent_id } = parsed.data;
  const db = getDb();
  // Only claim threads with status='open' — poisoned threads are filtered out
  // automatically because the status filter excludes them.
  // Directed-dispatch constraint: if assigned_to is set, only that specific
  // agent can claim; NULL keeps the original open-pool semantics.
  const result = db.prepare(
    "UPDATE threads SET claimed_by = ?, claimed_at = ? WHERE id = ? AND org_id = ? AND claimed_by IS NULL AND status = 'open' AND (assigned_to IS NULL OR assigned_to = ?)"
  ).run(agent_id, new Date().toISOString(), thread_id, ctx.claims.org, agent_id);

  if (result.changes === 1) {
    mqttBridge.publishTaskClaimed(thread_id, agent_id);
    sseEmitter.emit("task_claimed", { thread_id, agent_id }, { org_id: ctx.claims.org });
    json(res, { success: true });
  } else {
    const thread = consultation.getThread(ctx.claims.org, thread_id);
    // Surface the assigned_to in the 'why not' response so clients can
    // distinguish "already claimed by X" from "reserved for Y".
    json(res, {
      success: false,
      claimed_by: thread?.claimed_by || null,
      assigned_to: thread?.assigned_to || null,
      status: thread?.status,
    });
  }
}

export function handleProposeResolution(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, consultation, sseEmitter, mqttBridge } = ctx.services;
  const parsed = ProposeResolutionBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { thread_id, agent_id, summary } = parsed.data;
  const agentInfo = registry.get(ctx.claims.org, agent_id);
  consultation.proposeResolution(ctx.claims.org, thread_id, agent_id, summary);
  sseEmitter.emit("resolution_proposed", {
    thread_id, agent_id, agent_name: agentInfo?.name || agent_id, summary,
  }, { org_id: ctx.claims.org });
  json(res, consultation.getThread(ctx.claims.org, thread_id));
  mqttBridge.publishTaskCompleted(thread_id, agent_id, summary);
}

export function handleApproveResolution(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, consultation } = ctx.services;
  const parsed = ApproveResolutionBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { thread_id, agent_id } = parsed.data;
  const agentInfo = registry.get(ctx.claims.org, agent_id);
  consultation.approveResolution(ctx.claims.org, thread_id, agent_id, agentInfo?.name ?? undefined);
  const t = consultation.getThread(ctx.claims.org, thread_id)!;
  json(res, t);
}

export function handleConsultationStatus(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { httpLog } = ctx;
  const { consultation } = ctx.services;
  const url = req.url || "";
  const threadId = url.split("/")[3];
  const thread = consultation.getThreadWithMessages(ctx.claims.org, threadId);
  if (!thread) {
    json(res, { error: "not found" }, 404);
  } else {
    json(res, {
      status: thread.thread.status,
      messages: thread.messages,
      resolution_summary: thread.thread.resolution_summary,
      expected_respondents: safeJsonParse<string[]>(thread.thread.expected_respondents, [], httpLog, "handle-rest./api/consultation/status:expected_respondents"),
    });
  }
}

export function handleThreadsActive(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { consultation } = ctx.services;
  const open = consultation.listThreads(ctx.claims.org, { status: "open" });
  const resolving = consultation.listThreads(ctx.claims.org, { status: "resolving" });
  json(res, [...open, ...resolving]);
}

export function handleHotFiles(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { fileTracker } = ctx.services;
  const parsed = HotFilesBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { since_minutes } = parsed.data;
  json(res, fileTracker.getHotFiles(ctx.claims.org, since_minutes || 30));
}

export async function handleQuota(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): Promise<void> {
  const { quotaCache } = ctx.services;
  // Pre-flight + live widget endpoint. 200 with fresh QuotaInfo when the
  // Keychain + Anthropic API are reachable, 503 otherwise. Consumers treat
  // 503 as "quota unknown = proceed" (fail-open) per the project decision.
  const info = await quotaCache.get();
  if (!info) {
    const status = quotaCache.snapshot();
    json(res, {
      error: "quota unavailable",
      reason: status.lastError,
      cooldown_until: status.cooldownUntil,
    }, 503);
  } else {
    json(res, {
      five_hour: info.fiveHour,
      seven_day: info.sevenDay,
      seven_day_sonnet: info.sevenDaySonnet,
      fetched_at: info.fetchedAt,
    });
  }
}

export async function handleQuotaRefresh(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): Promise<void> {
  const { quotaCache } = ctx.services;
  // Force-refresh the cache, bypassing the TTL. Used by the dashboard's
  // manual refresh button. The underlying quotaCache.refresh() is single-
  // flight-deduped, so mashing the button doesn't stack parallel fetches.
  // The onRefresh callback on the cache broadcasts via SSE + MQTT, so the
  // dashboard receives the update through the normal channel too — this
  // endpoint only exists for "give me the answer now" semantics.
  const info = await quotaCache.refresh();
  if (!info) {
    const status = quotaCache.snapshot();
    json(res, {
      error: "quota unavailable",
      reason: status.lastError,
      cooldown_until: status.cooldownUntil,
    }, 503);
  } else {
    json(res, {
      five_hour: info.fiveHour,
      seven_day: info.sevenDay,
      seven_day_sonnet: info.sevenDaySonnet,
      fetched_at: info.fetchedAt,
    });
  }
}

export function handleIntrospectionResponse(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { httpLog } = ctx;
  const { registry, consultation, introspection, sseEmitter } = ctx.services;
  const parsed = IntrospectionResponseBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { introspection_id, concerned, reason } = parsed.data;
  const intro = introspection.respond(ctx.claims.org, introspection_id, reason);

  // If concerned, add to thread's expected_respondents
  if (concerned && intro) {
    const db = getDb();
    const thread = consultation.getThread(ctx.claims.org, intro.thread_id);
    if (thread && (thread.status === "open" || thread.status === "resolving")) {
      const respondents: string[] = safeJsonParse<string[]>(thread.expected_respondents, [], httpLog, "handle-rest./api/introspection-response:expected_respondents");
      if (!respondents.includes(intro.agent_id)) {
        respondents.push(intro.agent_id);
        db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ? AND org_id = ?")
          .run(JSON.stringify(respondents), thread.id, ctx.claims.org);
      }
    }
  }

  const agentInfo = registry.get(ctx.claims.org, intro?.agent_id || "");
  sseEmitter.emit("introspection_completed", {
    introspection_id, thread_id: intro?.thread_id,
    agent_id: intro?.agent_id, agent_name: agentInfo?.name || intro?.agent_id,
    concerned, reason,
  }, { org_id: ctx.claims.org });
  json(res, intro);
}

export function handlePendingIntrospections(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { introspection } = ctx.services;
  const url = req.url || "";
  const urlObj = new URL(url, "http://localhost");
  const agent_id = urlObj.searchParams.get("agent_id") || "";
  const pending = introspection.getPending(ctx.claims.org, agent_id);
  json(res, pending);
}

export function handleRunConfig(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { getRunConfig, setRunConfig } = ctx;
  const { sseEmitter } = ctx.services;
  if (req.method === "POST") {
    const parsed = RunConfigBodySchema.safeParse(body);
    if (!parsed.success) { sendValidationError(res, parsed.error); return; }
    setRunConfig(parsed.data);
    sseEmitter.emit("run_config" as Parameters<typeof sseEmitter.emit>[0], getRunConfig() as Record<string, unknown>, { org_id: ctx.claims.org });
    json(res, { ok: true });
  } else {
    json(res, getRunConfig() || { active: false });
  }
}

export function handleReset(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { authEnabled, setRunConfig } = ctx;
  // B4 fix: gate destructive reset when AUTH is disabled.
  // When AUTH_ENABLED=true, ADMIN_ONLY_ROUTES already enforced upstream
  // by authenticateRequest (see auth.ts). This guard covers the AUTH off case.
  if (!canResetDb(process.env, authEnabled)) {
    json(res, {
      error: "Forbidden: /api/reset requires NODE_ENV=test, COORDINATOR_ALLOW_RESET=true, or COORDINATOR_AUTH_ENABLED with admin token",
    }, 403);
    return;
  }
  // Reset all tables for clean test run (disable FK checks to avoid ordering issues)
  const db = getDb();
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("DELETE FROM introspections");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM thread_messages");
  db.exec("DELETE FROM threads");
  db.exec("DELETE FROM action_summaries");
  db.exec("DELETE FROM file_activity");
  db.exec("DELETE FROM agent_activity_status");
  db.exec("DELETE FROM dependency_map");
  db.exec("DELETE FROM agents");
  db.exec("DELETE FROM revoked_agents");
  db.exec("PRAGMA foreign_keys = ON");
  setRunConfig(null);
  json(res, { ok: true });
}

export function handleCheckInterrupt(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { httpLog } = ctx;
  const { consultation } = ctx.services;
  const parsed = CheckInterruptBodySchema.safeParse(body);
  if (!parsed.success) { sendValidationError(res, parsed.error); return; }
  const { agent_id } = parsed.data;
  // Check for threads where this agent is an expected respondent and hasn't posted yet.
  // Covers both open threads (waiting for initial response) and resolving threads
  // (waiting for approval/contest of a proposed resolution).
  const pendingThreads = [
    ...consultation.listThreads(ctx.claims.org, { status: "open" }),
    ...consultation.listThreads(ctx.claims.org, { status: "resolving" }),
  ].filter((t) => {
    const respondents: string[] = safeJsonParse<string[]>(t.expected_respondents, [], httpLog, "handle-rest./api/check-interrupt:expected_respondents");
    return respondents.includes(agent_id);
  });
  if (pendingThreads.length > 0) {
    const details = pendingThreads.map((t) => ({
      thread_id: t.id,
      subject: t.subject,
      initiator_id: t.initiator_id,
      status: t.status,
      target_files: safeJsonParse<string[]>(t.target_files, [], httpLog, "handle-rest./api/check-interrupt:target_files"),
    }));
    json(res, { interrupt: true, threads: details });
  } else {
    json(res, { interrupt: false });
  }
}

export function handleAgentStatus(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, activityTracker } = ctx.services;
  const url = req.url || "";
  const aid = url.split("/")[3];
  const agent = registry.get(ctx.claims.org, aid);
  if (!agent) {
    json(res, { registered: false, status: "unknown" });
  } else {
    const activity = activityTracker.getActivity(ctx.claims.org, aid, { idleAfterMinutes: 5 });
    json(res, { registered: true, status: agent.status, activity: activity.activity_status });
  }
}

export function handleFileActivity(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  if (typeof body.session_id !== "string" || typeof body.agent_id !== "string"
      || typeof body.tool_name !== "string" || typeof body.file_path !== "string") {
    json(res, { error: "missing required fields" }, 400);
    return;
  }
  if (body.agent_name !== undefined && typeof body.agent_name !== "string") {
    json(res, { error: "agent_name must be string when present" }, 400);
    return;
  }
  const repoRoot = process.env.COORDINATOR_REPO_ROOT || null;
  let filePath: string;
  try {
    filePath = normalizePath(repoRoot, body.file_path as string);
  } catch (err) {
    json(res, { error: `invalid file_path: ${(err as Error).message}` }, 400);
    return;
  }
  const MAX_CONTENT = 262144;
  let symbols: string[] | null = null;
  let contentHash: string | null = null;
  if (typeof body.content === "string") {
    if (body.content.length > MAX_CONTENT) {
      json(res, { error: "content exceeds 256 KB" }, 400);
      return;
    }
    contentHash = createHash("sha256").update(body.content).digest("hex");
    symbols = ctx.services.treeSitter.extract(filePath, body.content, null);
  }
  ctx.services.fileTracker.log({
    org_id: ctx.claims.org,
    session_id: body.session_id,
    agent_id: body.agent_id,
    agent_name: body.agent_name,
    tool_name: body.tool_name,
    file_path: filePath,
    content_hash: contentHash,
    symbols_touched: symbols,
  });
  json(res, { ok: true });
}

export function handleWorkingFilesStart(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { services } = ctx;
  if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
    json(res, { error: "agent_id and file_path required" }, 400);
    return;
  }
  const repoRoot = process.env.COORDINATOR_REPO_ROOT || null;
  let filePath: string;
  try {
    filePath = normalizePath(repoRoot, body.file_path as string);
  } catch (err) {
    json(res, { error: `invalid file_path: ${(err as Error).message}` }, 400);
    return;
  }
  const ttl = parseInt(process.env.COORDINATOR_WORKING_FILES_TTL_MIN || "30", 10);
  services.workingFiles.start(ctx.claims.org, body.agent_id as string, filePath, ttl);
  json(res, { ok: true });
}

export function handleWorkingFilesStop(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { services } = ctx;
  if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
    json(res, { error: "agent_id and file_path required" }, 400);
    return;
  }
  const repoRoot = process.env.COORDINATOR_REPO_ROOT || null;
  let filePath: string;
  try {
    filePath = normalizePath(repoRoot, body.file_path as string);
  } catch (err) {
    json(res, { error: `invalid file_path: ${(err as Error).message}` }, 400);
    return;
  }
  services.workingFiles.stop(ctx.claims.org, body.agent_id as string, filePath);
  json(res, { ok: true });
}

export function handleScoringStats(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const url = req.url || "";
  const u = new URL(url, "http://localhost");
  const sinceParam = u.searchParams.get("since") || "24h";
  const sinceMin = sinceParam.endsWith("h") ? parseInt(sinceParam) * 60
                  : sinceParam.endsWith("d") ? parseInt(sinceParam) * 60 * 24
                  : 60 * 24;
  const db = getDb();
  const rows = db.prepare(
    `SELECT
       lf.layer,
       COUNT(*) AS fire_count,
       AVG(lf.score) AS avg_score,
       SUM(CASE WHEN json_extract(e.payload, '$.resolution_type') = 'auto_resolved' THEN 1 ELSE 0 END) AS auto_resolved,
       SUM(CASE WHEN json_extract(e.payload, '$.resolution_type') = 'consensus' THEN 1 ELSE 0 END) AS consensus,
       SUM(CASE WHEN json_extract(e.payload, '$.resolution_type') = 'timeout' THEN 1 ELSE 0 END) AS timeout_count,
       SUM(CASE WHEN json_extract(e.payload, '$.resolution_type') IN ('agent_departure','closed') THEN 1 ELSE 0 END) AS cancelled
     FROM layer_firings lf
     LEFT JOIN events e
       ON e.type = 'thread_resolved'
       AND json_extract(e.payload, '$.thread_id') = lf.thread_id
     WHERE lf.fired_at > datetime('now', '-' || ? || ' minutes')
     GROUP BY lf.layer
     ORDER BY fire_count DESC`
  ).all(sinceMin) as Array<{
    layer: string; fire_count: number; avg_score: number;
    auto_resolved: number; consensus: number; timeout_count: number; cancelled: number;
  }>;
  json(res, {
    window: { since: sinceParam, now: new Date().toISOString() },
    layers: rows.map(r => ({
      layer: r.layer,
      fire_count: r.fire_count,
      avg_score: r.avg_score,
      outcomes: {
        auto_resolved: r.auto_resolved,
        consensus: r.consensus,
        timeout: r.timeout_count,
        cancelled: r.cancelled,
      },
    })),
  });
}

export function handleStatus(req: IncomingMessage, res: ServerResponse, ctx: RestContext, body: Record<string, unknown>): void {
  const { registry, consultation, fileTracker } = ctx.services;
  const online = registry.listOnline(ctx.claims.org);
  const openThreads = consultation.listThreads(ctx.claims.org, { status: "open" });
  json(res, {
    online: online.length,
    open_threads: openThreads.length,
    hot_files: fileTracker.getHotFiles(ctx.claims.org, 30).length,
    mqtt: ctx.services.mqttBridge.isConnected(),
  });
}
