import type { IncomingMessage, ServerResponse } from "http";
import type { ZodError } from "zod";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import type { AuthClaims } from "../auth.js";
import type { ThreadStatus } from "../types.js";
import { createHash } from "crypto";
import { getDb } from "../database.js";
import { runCommonAnnounceFlow } from "../announce-workflow.js";
import { runRegisterFlow } from "../register-workflow.js";
import { canResetDb } from "../reset-guard.js";
import { isCredentialReaderSupported } from "../quota/credential-reader.js";
import { json } from "./utils.js";
import { normalizePath, normalizeDeclaredPaths } from "../path-normalize.js";
import { repoRoots } from "../repo-roots.js";
import { safeJsonParse } from "../json-utils.js";
import { appError } from "./response-contract.js";
import {
  RegisterBodySchema,
  SessionStopBodySchema,
  CheckConflictBodySchema,
  LogFileBodySchema,
  AnnounceBodySchema,
  PostToThreadBodySchema,
  UnclaimTaskBodySchema,
  ClaimTaskBodySchema,
  ProposeResolutionBodySchema,
  ApproveResolutionBodySchema,
  HotFilesBodySchema,
  ThreadsActiveBodySchema,
  ThreadsSummaryBodySchema,
  IntrospectionResponseBodySchema,
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
}

export type RestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
) => Promise<void> | void;

/**
 * qualite-code-02 / architecture-15: send a structured 400 for a body that
 * failed zod validation. Uses the same `appError` envelope as every other
 * structured error response (qualite-code-08) so REST clients get one
 * consistent error contract instead of ad hoc shapes per endpoint.
 */
export function sendValidationError(res: ServerResponse, error: ZodError): void {
  json(
    res,
    appError("INVALID_REQUEST", "Request body failed validation", {
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    }),
    400,
  );
}

export function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { services } = ctx;
  const parsed = RegisterBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { agent_id, name, modules } = parsed.data;
  // architecture-07: shared flow with MCP register_agent (registry.register +
  // sseEmitter "agent_online" + mqttBridge.registerAgent retained-status publish).
  const agent = runRegisterFlow(services, ctx.claims.org, agent_id, name, modules ?? []);
  json(res, agent);
}

export function handleSessionStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { registry, consultation, fileTracker } = ctx.services;
  const online = registry.listOnline(ctx.claims.org);
  const openThreads = consultation.listThreads(ctx.claims.org, { status: "open" });
  const hotFiles = fileTracker.getHotFiles(ctx.claims.org, 30);
  const briefing = [
    `Agents en ligne: ${online.map((a) => a.name).join(", ") || "aucun"}`,
    `Consultations ouvertes: ${openThreads.length}`,
    `Hot files: ${hotFiles.map((f) => f.file_path).join(", ") || "aucun"}`,
  ].join("\n");
  json(res, {
    briefing,
    summary: {
      online: online.length,
      open_threads: openThreads.length,
      hot_files: hotFiles.length,
    },
  });
}

export function handleSessionStop(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { registry, activityTracker, consultation, sseEmitter } = ctx.services;
  const parsed = SessionStopBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { agent_id } = parsed.data;
  registry.setOffline(ctx.claims.org, agent_id);
  activityTracker.reportOffline(ctx.claims.org, agent_id);
  consultation.handleAgentDeparture(ctx.claims.org, agent_id);
  sseEmitter.emit("agent_offline", { agent_id }, { org_id: ctx.claims.org });
  json(res, { ok: true });
}

export function handleCheckConflict(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { fileTracker } = ctx.services;
  const parsed = CheckConflictBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { file, agent_id } = parsed.data;
  // issue #275: the REST twin of check_file_conflict, and the same trap --
  // this asked a normalized column about a raw string.
  const declared = normalizeDeclaredPaths(repoRoots(), [file]);
  if (!declared.ok) {
    json(
      res,
      appError(
        "INVALID_REQUEST",
        `invalid file ${declared.rejected.path}: ${declared.rejected.message}`,
      ),
      400,
    );
    return;
  }
  const normFile = declared.paths[0];
  const conflict = fileTracker.checkFileConflict(ctx.claims.org, normFile, agent_id, 30);
  const warnings: string[] = [];
  if (conflict.conflict) {
    warnings.push(`File ${normFile} recently edited by: ${conflict.agents.join(", ")}`);
  }
  json(res, { conflict: conflict.conflict, warnings });
}

export function handleLogFile(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { fileTracker, activityTracker, sseEmitter } = ctx.services;
  const parsed = LogFileBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { session_id, agent_id, agent_name, tool_name, file } = parsed.data;
  // #375: this was the one writer into file_activity that stored the caller's
  // string as it arrived. Every reader matches by exact SQL equality --
  // file-tracker.ts has no normalisation of its own -- so a single raw writer
  // is enough to poison the column for checkFileConflict, the impact scorer
  // and hot_files: a row written as C:\repo\src\Types.ts never joins a query
  // carrying src/types.ts, though they name the same file.
  const repoRoot = repoRoots();
  let filePath: string;
  try {
    filePath = normalizePath(repoRoot, file);
  } catch (err) {
    json(res, { error: `invalid file: ${(err as Error).message}` }, 400);
    return;
  }
  fileTracker.log({
    org_id: ctx.claims.org,
    session_id,
    agent_id,
    agent_name,
    tool_name,
    file_path: filePath,
  });
  activityTracker.reportFileActivity(ctx.claims.org, agent_id, filePath);
  sseEmitter.emit(
    "file_edited",
    { agent_id, agent_name: agent_name || agent_id, file: filePath, tool_name },
    { org_id: ctx.claims.org },
  );
  json(res, { ok: true });
}

export function handleAnnounce(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { services, httpLog } = ctx;
  const { registry, consultation, sseEmitter } = services;
  const parsed = AnnounceBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const {
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
    run_id,
  } = parsed.data;

  // issue #275: normalize the declared side, exactly as /api/file-activity and
  // /api/working-files already do for the observed side. AnnounceBodySchema is
  // a bare z.array(z.string()), so without this the scorer compares raw strings
  // against normalized columns by exact SQL equality and joins nothing.
  const declared = normalizeDeclaredPaths(repoRoots(), [
    ...target_files,
    ...(depends_on_files ?? []),
    ...(exports_affected ?? []),
  ]);
  if (!declared.ok) {
    json(
      res,
      appError(
        "INVALID_REQUEST",
        `invalid path ${declared.rejected.path}: ${declared.rejected.message}`,
      ),
      400,
    );
    return;
  }
  const nTargets = target_files.length;
  const nDepends = depends_on_files?.length ?? 0;
  const normTargetFiles = declared.paths.slice(0, nTargets);
  const normDependsOn = depends_on_files && declared.paths.slice(nTargets, nTargets + nDepends);
  const normExports = exports_affected && declared.paths.slice(nTargets + nDepends);

  const thread = consultation.announceWork(ctx.claims.org, {
    agent_id,
    subject,
    plan,
    target_modules,
    target_files: normTargetFiles,
    depends_on_files: normDependsOn,
    exports_affected: normExports,
    keep_open,
    assigned_to,
    run_id,
  });
  const agentInfo = registry.get(ctx.claims.org, agent_id);

  // S2 fix: shared workflow (impact scoring, override respondents, auto-resolve,
  // impact_scored + introspection SSE, plan-quality downgrade event). Same
  // function used by the MCP announce_work tool path.
  const { updated, categorized, respondents, planQuality, planDowngradeReason } =
    runCommonAnnounceFlow(services, thread.id, {
      org_id: ctx.claims.org,
      agent_id,
      subject,
      plan,
      target_modules,
      target_files: normTargetFiles,
      depends_on_files: normDependsOn,
      exports_affected: normExports,
      keep_open,
      target_symbols,
    });

  // REST-specific thread_opened SSE shape (different field set than MCP — kept
  // divergent because consumers may depend on this exact contract).
  sseEmitter.emit(
    "thread_opened",
    {
      thread_id: thread.id,
      subject,
      agent_id,
      agent_name: agentInfo?.name || agent_id,
      target_modules,
      target_files,
      expected_respondents: respondents,
      conflicts: safeJsonParse<unknown[]>(
        updated.conflicts,
        [],
        httpLog,
        "handle-rest./api/announce:updated.conflicts",
      ),
      created_at: updated.created_at,
      mode: planQuality.mode,
      plan: plan || null,
      plan_quality: planQuality,
    },
    { org_id: ctx.claims.org },
  );
  // #351: plan_quality reached the SSE stream (the dashboard) but never the
  // announcing agent. Additive -- no existing key changes.
  json(res, {
    thread_id: thread.id,
    status: updated.status,
    impact: categorized,
    plan_quality: planQuality,
    plan_downgrade_reason: planDowngradeReason,
  });
}

export function handlePostToThread(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { consultation, sseEmitter, registry } = ctx.services;
  const parsed = PostToThreadBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
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
  // issue #233: posting to a thread proves the agent is alive, so it refreshes
  // last_seen_at the same way an explicit heartbeat would.
  registry.heartbeat(ctx.claims.org, agent_id);
  const msg = consultation.postToThread(ctx.claims.org, {
    thread_id,
    agent_id,
    agent_name,
    type,
    content,
  });
  const thread = consultation.getThread(ctx.claims.org, thread_id);
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
    { org_id: ctx.claims.org },
  );
  json(res, msg);
}

export function handleUnclaimTask(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { httpLog } = ctx;
  const parsed = UnclaimTaskBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { thread_id, agent_id } = parsed.data;
  const db = getDb();
  // F4: increment unclaim counter. After POISON_THRESHOLD aborts, flip status
  // to "poisoned" so no agent claims it again — prevents the tight
  // claim → no DONE → unclaim → re-claim loop we observed on stuck tasks.
  // Only the claiming agent can unclaim to prevent cross-agent interference.
  const POISON_THRESHOLD = 2;
  const result = db
    .prepare(
      "UPDATE threads SET claimed_by = NULL, claimed_at = NULL, unclaim_count = COALESCE(unclaim_count, 0) + 1 WHERE id = ? AND org_id = ? AND claimed_by = ? AND status = 'open'",
    )
    .run(thread_id, ctx.claims.org, agent_id);
  let poisoned = false;
  if (result.changes === 1) {
    const row = db
      .prepare("SELECT unclaim_count FROM threads WHERE id = ? AND org_id = ?")
      .get(thread_id, ctx.claims.org) as { unclaim_count?: number } | undefined;
    if (row && (row.unclaim_count ?? 0) >= POISON_THRESHOLD) {
      db.prepare(
        "UPDATE threads SET status = 'poisoned' WHERE id = ? AND org_id = ? AND status = 'open'",
      ).run(thread_id, ctx.claims.org);
      poisoned = true;
      httpLog.warn(
        { thread_id, unclaim_count: row.unclaim_count },
        "thread poisoned after repeated unclaims",
      );
    }
  }
  json(res, { success: result.changes === 1, poisoned });
}

/**
 * Why a claim was refused because of file overlap (issue #258): the thread
 * already holding those files, and which files collided.
 */
interface ClaimConflict {
  thread_id: string;
  files: string[];
}

/**
 * Explain a claim that the overlap guard refused (issue #258): which
 * already-claimed thread holds the colliding files, and which files they are.
 *
 * Diagnostic only — runs after the UPDATE decided, so it is a plain read.
 * Returns null when the refusal had some other cause (already claimed,
 * reserved for another agent, not open), leaving the existing fields to
 * explain it.
 */
function findClaimFileConflict(
  orgId: string,
  threadId: string,
  agentId: string,
): ClaimConflict | null {
  const db = getDb();
  const candidate = db
    .prepare("SELECT target_files FROM threads WHERE id = ? AND org_id = ?")
    .get(threadId, orgId) as { target_files: string } | undefined;
  if (!candidate) return null;
  const wanted = safeJsonParse<string[]>(candidate.target_files, []);
  if (wanted.length === 0) return null;

  const held = db
    .prepare(
      `SELECT id, target_files FROM threads
       WHERE org_id = ? AND id != ? AND status = 'open'
         AND claimed_by IS NOT NULL AND claimed_by != ?`,
    )
    .all(orgId, threadId, agentId) as { id: string; target_files: string }[];

  for (const other of held) {
    const overlap = wanted.filter((f) =>
      safeJsonParse<string[]>(other.target_files, []).includes(f),
    );
    if (overlap.length > 0) return { thread_id: other.id, files: overlap };
  }
  return null;
}

export function handleClaimTask(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { consultation, mqttBridge, sseEmitter } = ctx.services;
  const parsed = ClaimTaskBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { thread_id, agent_id } = parsed.data;
  const db = getDb();

  // Only claim threads with status='open' — poisoned threads are filtered out
  // automatically because the status filter excludes them.
  // Directed-dispatch constraint: if assigned_to is set, only that specific
  // agent can claim; NULL keeps the original open-pool semantics.
  //
  // issue #258: the id predicate serializes two agents racing for the SAME
  // thread, but says nothing about what those threads touch. Two agents
  // claiming two DIFFERENT threads with overlapping target_files both got
  // success:true and both started editing the same file. The client cannot
  // close this — essaim only refetches its busy-file set on success:false, the
  // branch that never fired.
  //
  // The overlap test is a NOT EXISTS in the same statement rather than a
  // read-then-write in a transaction. That matters twice over: it keeps the
  // claim a single atomic UPDATE (same guarantee the original CAS had, with no
  // window between checking and writing), and it avoids needing
  // `transaction.immediate()`, which the portable DatabaseAdapter deliberately
  // does not expose because bun:sqlite has to satisfy the same interface.
  //
  // target_files is JSON TEXT, so the intersection uses json_each rather than a
  // column comparison. Only threads held by SOMEONE ELSE block: one agent
  // holding two overlapping threads serializes itself.
  const result = db
    .prepare(
      `UPDATE threads SET claimed_by = ?, claimed_at = ?
       WHERE id = ? AND org_id = ? AND claimed_by IS NULL AND status = 'open'
         AND (assigned_to IS NULL OR assigned_to = ?)
         AND NOT EXISTS (
           SELECT 1 FROM threads other
           WHERE other.org_id = threads.org_id
             AND other.id != threads.id
             AND other.status = 'open'
             AND other.claimed_by IS NOT NULL
             AND other.claimed_by != ?
             AND EXISTS (
               SELECT 1
               FROM json_each(threads.target_files) mine
               JOIN json_each(other.target_files) theirs ON mine.value = theirs.value
             )
         )`,
    )
    .run(agent_id, new Date().toISOString(), thread_id, ctx.claims.org, agent_id, agent_id);

  if (result.changes === 1) {
    mqttBridge.publishTaskClaimed(ctx.claims.org, thread_id, agent_id);
    sseEmitter.emit("task_claimed", { thread_id, agent_id }, { org_id: ctx.claims.org });
    json(res, { success: true });
  } else {
    const thread = consultation.getThread(ctx.claims.org, thread_id);
    // Diagnostic only, and deliberately AFTER the update: it explains a refusal
    // that already happened, so it needs no atomicity of its own.
    //
    // Without it the #258 case reads as "nothing is wrong" — the thread is
    // still unclaimed, so claimed_by/assigned_to/status all look fine and the
    // client has no idea why it was turned away.
    const conflict = findClaimFileConflict(ctx.claims.org, thread_id, agent_id);
    // Surface the assigned_to in the 'why not' response so clients can
    // distinguish "already claimed by X" from "reserved for Y".
    json(res, {
      success: false,
      claimed_by: thread?.claimed_by || null,
      assigned_to: thread?.assigned_to || null,
      status: thread?.status,
      ...(conflict ? { conflict } : {}),
    });
  }
}

export function handleProposeResolution(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { registry, consultation, sseEmitter, mqttBridge } = ctx.services;
  const parsed = ProposeResolutionBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { thread_id, agent_id, summary } = parsed.data;
  const agentInfo = registry.get(ctx.claims.org, agent_id);
  consultation.proposeResolution(ctx.claims.org, thread_id, agent_id, summary);
  sseEmitter.emit(
    "resolution_proposed",
    {
      thread_id,
      agent_id,
      agent_name: agentInfo?.name || agent_id,
      summary,
    },
    { org_id: ctx.claims.org },
  );
  json(res, consultation.getThread(ctx.claims.org, thread_id));
  mqttBridge.publishTaskCompleted(ctx.claims.org, thread_id, agent_id, summary);
}

export function handleApproveResolution(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { registry, consultation } = ctx.services;
  const parsed = ApproveResolutionBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { thread_id, agent_id } = parsed.data;
  const agentInfo = registry.get(ctx.claims.org, agent_id);
  consultation.approveResolution(ctx.claims.org, thread_id, agent_id, agentInfo?.name ?? undefined);
  const t = consultation.getThread(ctx.claims.org, thread_id)!;
  json(res, t);
}

export function handleConsultationStatus(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
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
      expected_respondents: safeJsonParse<string[]>(
        thread.thread.expected_respondents,
        [],
        httpLog,
        "handle-rest./api/consultation/status:expected_respondents",
      ),
    });
  }
}

export function handleThreadsActive(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { consultation } = ctx.services;
  // The body used to be ignored outright. `run_id` scopes the listing so an
  // aborted run stops leaking its stale threads into the next one; omitted, the
  // response is exactly what it always was.
  const parsed = ThreadsActiveBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { run_id } = parsed.data;
  const open = consultation.listThreads(ctx.claims.org, { status: "open", run_id });
  const resolving = consultation.listThreads(ctx.claims.org, { status: "resolving", run_id });
  json(res, [...open, ...resolving]);
}

/**
 * POST /api/threads-summary — thread counts by status for one run, so a
 * client can report a run's final state.
 *
 * Why this exists: /api/threads-active only ever returns 'open' and
 * 'resolving' threads, and a 'poisoned' thread (handleUnclaimTask, F4 —
 * unclaimed POISON_THRESHOLD times) is a table UPDATE with no matching SSE
 * event. A client reconstructing outcomes from the event stream (essaim's
 * run reporter) cannot distinguish an abandoned thread from a resolved one.
 * This reads the DB truth directly instead.
 *
 * Deliberately NOT consultation.listThreads's `run_id = ? OR run_id IS
 * NULL` semantics (see ThreadsActiveBodySchema doc): that OR exists so a
 * live agent doesn't miss a concurrent human session's threads. A run
 * summary asks the opposite question — "what did THIS run do" — so
 * un-scoped threads must never be folded into another run's counts.
 */
export function handleThreadsSummary(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const parsed = ThreadsSummaryBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { run_id } = parsed.data;
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS n FROM threads WHERE org_id = ? AND run_id = ? GROUP BY status",
    )
    .all(ctx.claims.org, run_id) as Array<{ status: ThreadStatus; n: number }>;

  const counts: Record<ThreadStatus, number> = {
    open: 0,
    resolving: 0,
    resolved: 0,
    cancelled: 0,
    poisoned: 0,
  };
  let total = 0;
  for (const row of rows) {
    counts[row.status] = row.n;
    total += row.n;
  }
  json(res, { run_id, total, counts });
}

export function handleHotFiles(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { fileTracker } = ctx.services;
  const parsed = HotFilesBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { since_minutes } = parsed.data;
  json(res, fileTracker.getHotFiles(ctx.claims.org, since_minutes || 30));
}

export async function handleQuota(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): Promise<void> {
  const { quotaCache } = ctx.services;
  // Pre-flight + live widget endpoint. 200 with fresh QuotaInfo when the
  // Keychain + Anthropic API are reachable, 503 otherwise. Consumers treat
  // 503 as "quota unknown = proceed" (fail-open) per the project decision.
  const info = await quotaCache.get();
  if (!info) {
    const status = quotaCache.snapshot();
    json(
      res,
      {
        error: "quota unavailable",
        reason: status.lastError,
        cooldown_until: status.cooldownUntil,
        // #341: distinguishes 'this platform has no credential reader' from
        // 'the fetch failed'. The first is permanent and not actionable, so
        // the dashboard hides the widget instead of showing a standing error.
        unsupported_platform: !isCredentialReaderSupported(),
      },
      503,
    );
  } else {
    json(res, {
      five_hour: info.fiveHour,
      seven_day: info.sevenDay,
      seven_day_sonnet: info.sevenDaySonnet,
      fetched_at: info.fetchedAt,
    });
  }
}

export async function handleQuotaRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): Promise<void> {
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
    json(
      res,
      {
        error: "quota unavailable",
        reason: status.lastError,
        cooldown_until: status.cooldownUntil,
      },
      503,
    );
  } else {
    json(res, {
      five_hour: info.fiveHour,
      seven_day: info.sevenDay,
      seven_day_sonnet: info.sevenDaySonnet,
      fetched_at: info.fetchedAt,
    });
  }
}

export function handleIntrospectionResponse(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { httpLog } = ctx;
  const { registry, consultation, introspection, sseEmitter } = ctx.services;
  const parsed = IntrospectionResponseBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { introspection_id, concerned, reason } = parsed.data;
  const intro = introspection.respond(ctx.claims.org, introspection_id, reason);

  // If concerned, add to thread's expected_respondents
  if (concerned && intro) {
    const db = getDb();
    const thread = consultation.getThread(ctx.claims.org, intro.thread_id);
    if (thread && (thread.status === "open" || thread.status === "resolving")) {
      const respondents: string[] = safeJsonParse<string[]>(
        thread.expected_respondents,
        [],
        httpLog,
        "handle-rest./api/introspection-response:expected_respondents",
      );
      if (!respondents.includes(intro.agent_id)) {
        respondents.push(intro.agent_id);
        db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ? AND org_id = ?").run(
          JSON.stringify(respondents),
          thread.id,
          ctx.claims.org,
        );
      }
    }
  }

  const agentInfo = registry.get(ctx.claims.org, intro?.agent_id || "");
  sseEmitter.emit(
    "introspection_completed",
    {
      introspection_id,
      thread_id: intro?.thread_id,
      agent_id: intro?.agent_id,
      agent_name: agentInfo?.name || intro?.agent_id,
      concerned,
      reason,
    },
    { org_id: ctx.claims.org },
  );
  json(res, intro);
}

export function handlePendingIntrospections(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { introspection } = ctx.services;
  const url = req.url || "";
  const urlObj = new URL(url, "http://localhost");
  const agent_id = urlObj.searchParams.get("agent_id") || "";
  const pending = introspection.getPending(ctx.claims.org, agent_id);
  json(res, pending);
}

export function handleReset(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { authEnabled } = ctx;
  // B4 fix: gate destructive reset when AUTH is disabled.
  // When AUTH_ENABLED=true, ADMIN_ONLY_ROUTES already enforced upstream
  // by authenticateRequest (see auth.ts). This guard covers the AUTH off case.
  if (!canResetDb(process.env, authEnabled)) {
    json(
      res,
      {
        error:
          "Forbidden: /api/reset requires NODE_ENV=test, COORDINATOR_ALLOW_RESET=true, or COORDINATOR_AUTH_ENABLED with admin token",
      },
      403,
    );
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
  json(res, { ok: true });
}

export function handleCheckInterrupt(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { httpLog } = ctx;
  const { consultation } = ctx.services;
  const parsed = CheckInterruptBodySchema.safeParse(body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { agent_id } = parsed.data;
  // Check for threads where this agent is an expected respondent and hasn't posted yet.
  // Covers both open threads (waiting for initial response) and resolving threads
  // (waiting for approval/contest of a proposed resolution).
  const pendingThreads = [
    ...consultation.listThreads(ctx.claims.org, { status: "open" }),
    ...consultation.listThreads(ctx.claims.org, { status: "resolving" }),
  ].filter((t) => {
    const respondents: string[] = safeJsonParse<string[]>(
      t.expected_respondents,
      [],
      httpLog,
      "handle-rest./api/check-interrupt:expected_respondents",
    );
    return respondents.includes(agent_id);
  });
  if (pendingThreads.length > 0) {
    const details = pendingThreads.map((t) => ({
      thread_id: t.id,
      subject: t.subject,
      initiator_id: t.initiator_id,
      status: t.status,
      target_files: safeJsonParse<string[]>(
        t.target_files,
        [],
        httpLog,
        "handle-rest./api/check-interrupt:target_files",
      ),
    }));
    json(res, { interrupt: true, threads: details });
  } else {
    json(res, { interrupt: false });
  }
}

export function handleAgentStatus(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
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

export function handleFileActivity(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  if (
    typeof body.session_id !== "string" ||
    typeof body.agent_id !== "string" ||
    typeof body.tool_name !== "string" ||
    typeof body.file_path !== "string"
  ) {
    json(res, { error: "missing required fields" }, 400);
    return;
  }
  if (body.agent_name !== undefined && typeof body.agent_name !== "string") {
    json(res, { error: "agent_name must be string when present" }, 400);
    return;
  }
  const repoRoot = repoRoots();
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

export function handleWorkingFilesStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { services } = ctx;
  if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
    json(res, { error: "agent_id and file_path required" }, 400);
    return;
  }
  const repoRoot = repoRoots();
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

export function handleWorkingFilesStop(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const { services } = ctx;
  if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
    json(res, { error: "agent_id and file_path required" }, 400);
    return;
  }
  const repoRoot = repoRoots();
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

export function handleScoringStats(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
  const url = req.url || "";
  const u = new URL(url, "http://localhost");
  const sinceParam = u.searchParams.get("since") || "24h";
  const sinceMin = sinceParam.endsWith("h")
    ? parseInt(sinceParam) * 60
    : sinceParam.endsWith("d")
      ? parseInt(sinceParam) * 60 * 24
      : 60 * 24;
  const db = getDb();
  const rows = db
    .prepare(
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
       AND e.org_id = lf.org_id
     WHERE lf.org_id = ?
       AND lf.fired_at > datetime('now', '-' || ? || ' minutes')
     GROUP BY lf.layer
     ORDER BY fire_count DESC`,
    )
    .all(ctx.claims.org, sinceMin) as Array<{
    layer: string;
    fire_count: number;
    avg_score: number;
    auto_resolved: number;
    consensus: number;
    timeout_count: number;
    cancelled: number;
  }>;
  json(res, {
    window: { since: sinceParam, now: new Date().toISOString() },
    layers: rows.map((r) => ({
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

export function handleStatus(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  body: Record<string, unknown>,
): void {
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
