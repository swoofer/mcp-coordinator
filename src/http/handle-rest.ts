import type { IncomingMessage, ServerResponse } from "http";
import type { CoordinatorServices } from "../server-setup.js";
import type { Logger } from "../logger.js";
import { createHash } from "crypto";
import { getDb } from "../database.js";
import { runCommonAnnounceFlow } from "../announce-workflow.js";
import { canResetDb } from "../reset-guard.js";
import { parseBody, json } from "./utils.js";

/**
 * S1: REST router extracted from serve-http.ts. Was a 382-line `handleRest`
 * function inside startServer's closure with module-scope captures for
 * services, httpLog, currentRunConfig, AUTH_ENABLED, etc.
 *
 * The body is unchanged — only ambient closure references became explicit
 * fields on RestContext. parseBody/json moved to ./utils.js to share between
 * REST + SSE + auth handlers.
 *
 * The currentRunConfig mutable state stays in serve-http.ts (single source
 * of truth) and is exposed via getRunConfig/setRunConfig on the context.
 */

export interface RestContext {
  services: CoordinatorServices;
  httpLog: Logger;
  authEnabled: boolean;
  getRunConfig: () => Record<string, unknown> | null;
  setRunConfig: (cfg: Record<string, unknown> | null) => void;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, ctx: RestContext): Promise<void> {
  const { services, httpLog, authEnabled, getRunConfig, setRunConfig } = ctx;
  const url = req.url || "";
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    json(res, { error: e.message || "Invalid request" }, e.statusCode || 400);
    return;
  }
  const agentId = (body as Record<string, unknown>).agent_id as string | undefined;
  // Dashboard/work-stealing polls these endpoints every few seconds — demote to debug
  // to keep the info log focused on coordination events (announce, claim, resolve, etc).
  const isPoll = url === "/api/hot-files" || url === "/api/threads-active" || url === "/api/status" || url === "/api/quota";
  // Note: /api/quota/refresh is NOT in the poll list — it's a manual user
  // action and deserves an info-level log for auditability.
  if (isPoll) {
    httpLog.debug({ method: req.method, url, agent_id: agentId }, "REST request");
  } else {
    httpLog.info({ method: req.method, url, agent_id: agentId }, "REST request");
  }
  const { registry, activityTracker, consultation, fileTracker, introspection, sseEmitter, mqttBridge, quotaCache } = services;

  if (url === "/api/register") {
    const { agent_id, name, modules } = body as { agent_id: string; name: string; modules: string[] };
    const agent = registry.register(agent_id, name, modules || []);
    sseEmitter.emit("agent_online", { agent_id, name, modules });
    json(res, agent);

  } else if (url === "/api/session-start") {
    const online = registry.listOnline();
    const openThreads = consultation.listThreads({ status: "open" });
    const hotFiles = fileTracker.getHotFiles(30);
    const briefing = [
      `Agents en ligne: ${online.map((a) => a.name).join(", ") || "aucun"}`,
      `Consultations ouvertes: ${openThreads.length}`,
      `Hot files: ${hotFiles.map((f) => f.file_path).join(", ") || "aucun"}`,
    ].join("\n");
    json(res, { briefing, summary: { online: online.length, open_threads: openThreads.length, hot_files: hotFiles.length } });

  } else if (url === "/api/session-stop") {
    const { agent_id } = body as { agent_id: string };
    registry.setOffline(agent_id);
    activityTracker.reportOffline(agent_id);
    consultation.handleAgentDeparture(agent_id);
    sseEmitter.emit("agent_offline", { agent_id });
    json(res, { ok: true });

  } else if (url === "/api/check-conflict") {
    const { file, agent_id } = body as { file: string; agent_id: string };
    const conflict = fileTracker.checkFileConflict(file, agent_id, 30);
    const warnings: string[] = [];
    if (conflict.conflict) {
      warnings.push(`File ${file} recently edited by: ${conflict.agents.join(", ")}`);
    }
    json(res, { conflict: conflict.conflict, warnings });

  } else if (url === "/api/log-file") {
    const { session_id, agent_id, agent_name, tool_name, file } = body as {
      session_id: string; agent_id: string; agent_name?: string; tool_name: string; file: string;
    };
    fileTracker.log({ session_id, agent_id, agent_name, tool_name, file_path: file });
    activityTracker.reportFileActivity(agent_id, file);
    sseEmitter.emit("file_edited", { agent_id, agent_name: agent_name || agent_id, file, tool_name });
    json(res, { ok: true });

  } else if (url === "/api/announce") {
    const { agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to, target_symbols } = body as {
      agent_id: string; subject: string; plan?: string; target_modules: string[]; target_files: string[];
      depends_on_files?: string[]; exports_affected?: string[]; keep_open?: boolean; assigned_to?: string | null;
      target_symbols?: string[];
    };

    const thread = consultation.announceWork({ agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to });
    const agentInfo = registry.get(agent_id);

    // S2 fix: shared workflow (impact scoring, override respondents, auto-resolve,
    // impact_scored + introspection SSE, plan-quality downgrade event). Same
    // function used by the MCP announce_work tool path.
    const { updated, categorized, respondents, planQuality } = runCommonAnnounceFlow(services, thread.id, {
      agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open,
      target_symbols,
    });

    // REST-specific thread_opened SSE shape (different field set than MCP — kept
    // divergent because consumers may depend on this exact contract).
    sseEmitter.emit("thread_opened", {
      thread_id: thread.id, subject, agent_id, agent_name: agentInfo?.name || agent_id,
      target_modules, target_files, expected_respondents: respondents,
      conflicts: updated.conflicts ? JSON.parse(updated.conflicts) : [],
      created_at: updated.created_at,
      mode: planQuality.mode,
      plan: plan || null,
      plan_quality: planQuality,
    });
    json(res, { thread_id: thread.id, status: updated.status, impact: categorized });

  } else if (url === "/api/post-to-thread") {
    const { thread_id, agent_id, agent_name, type, content } = body as {
      thread_id: string; agent_id: string; agent_name?: string; type: "context" | "suggestion" | "warning"; content: string;
    };
    // Pre-check the thread so we can return actionable status codes instead
    // of always-500 on any error. The client uses the status to decide
    // whether to warn (unexpected) or silently skip (normal race).
    const targetThread = consultation.getThread(thread_id);
    if (!targetThread) {
      json(res, { error: "thread_not_found", thread_id }, 404);
      return;
    }
    if (targetThread.status === "cancelled") {
      json(res, { error: "thread_cancelled", thread_id }, 410);
      return;
    }
    const msg = consultation.postToThread({ thread_id, agent_id, agent_name, type, content });
    const thread = consultation.getThread(thread_id);
    sseEmitter.emit("message_posted", {
      thread_id, agent_id, agent_name: agent_name || agent_id,
      type, content, round: thread?.round || 1,
      token_estimate: msg.token_estimate || 0,
    });
    json(res, msg);

  } else if (url === "/api/token-usage") {
    // Agent → coordinator telemetry, emitted once per LLM turn so the dashboard
    // and reports can pinpoint where tokens are being burned.
    const payload = body as Record<string, unknown>;
    sseEmitter.emit("token_usage", payload);
    json(res, { ok: true });

  } else if (url === "/api/unclaim-task") {
    const { thread_id, agent_id } = body as { thread_id: string; agent_id: string };
    if (!thread_id || !agent_id) {
      json(res, { success: false, error: "thread_id and agent_id required" }, 400);
      return;
    }
    const db = getDb();
    // F4: increment unclaim counter. After POISON_THRESHOLD aborts, flip status
    // to "poisoned" so no agent claims it again — prevents the tight
    // claim → no DONE → unclaim → re-claim loop we observed on stuck tasks.
    // Only the claiming agent can unclaim to prevent cross-agent interference.
    const POISON_THRESHOLD = 2;
    const result = db.prepare(
      "UPDATE threads SET claimed_by = NULL, claimed_at = NULL, unclaim_count = COALESCE(unclaim_count, 0) + 1 WHERE id = ? AND claimed_by = ? AND status = 'open'"
    ).run(thread_id, agent_id);
    let poisoned = false;
    if (result.changes === 1) {
      const row = db.prepare("SELECT unclaim_count FROM threads WHERE id = ?").get(thread_id) as { unclaim_count?: number } | undefined;
      if (row && (row.unclaim_count ?? 0) >= POISON_THRESHOLD) {
        db.prepare("UPDATE threads SET status = 'poisoned' WHERE id = ? AND status = 'open'").run(thread_id);
        poisoned = true;
        httpLog.warn({ thread_id, unclaim_count: row.unclaim_count }, "thread poisoned after repeated unclaims");
      }
    }
    json(res, { success: result.changes === 1, poisoned });

  } else if (url === "/api/claim-task") {
    const { thread_id, agent_id } = body as { thread_id: string; agent_id: string };
    if (!thread_id || !agent_id) {
      json(res, { success: false, error: "thread_id and agent_id required" }, 400);
      return;
    }
    const db = getDb();
    // Only claim threads with status='open' — poisoned threads are filtered out
    // automatically because the status filter excludes them.
    // Directed-dispatch constraint: if assigned_to is set, only that specific
    // agent can claim; NULL keeps the original open-pool semantics.
    const result = db.prepare(
      "UPDATE threads SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL AND status = 'open' AND (assigned_to IS NULL OR assigned_to = ?)"
    ).run(agent_id, new Date().toISOString(), thread_id, agent_id);

    if (result.changes === 1) {
      mqttBridge.publishTaskClaimed(thread_id, agent_id);
      sseEmitter.emit("task_claimed", { thread_id, agent_id });
      json(res, { success: true });
    } else {
      const thread = consultation.getThread(thread_id);
      // Surface the assigned_to in the 'why not' response so clients can
      // distinguish "already claimed by X" from "reserved for Y".
      json(res, {
        success: false,
        claimed_by: thread?.claimed_by || null,
        assigned_to: thread?.assigned_to || null,
        status: thread?.status,
      });
    }

  } else if (url === "/api/propose-resolution") {
    const { thread_id, agent_id, summary } = body as { thread_id: string; agent_id: string; summary: string };
    const agentInfo = registry.get(agent_id);
    consultation.proposeResolution(thread_id, agent_id, summary);
    sseEmitter.emit("resolution_proposed", {
      thread_id, agent_id, agent_name: agentInfo?.name || agent_id, summary,
    });
    json(res, consultation.getThread(thread_id));
    mqttBridge.publishTaskCompleted(thread_id, agent_id, summary);

  } else if (url === "/api/approve-resolution") {
    const { thread_id, agent_id } = body as { thread_id: string; agent_id: string };
    const agentInfo = registry.get(agent_id);
    consultation.approveResolution(thread_id, agent_id, agentInfo?.name);
    const t = consultation.getThread(thread_id)!;
    json(res, t);

  } else if (url?.startsWith("/api/consultation/") && url?.endsWith("/status")) {
    const threadId = url.split("/")[3];
    const thread = consultation.getThreadWithMessages(threadId);
    if (!thread) {
      json(res, { error: "not found" }, 404);
    } else {
      json(res, {
        status: thread.thread.status,
        messages: thread.messages,
        resolution_summary: thread.thread.resolution_summary,
        expected_respondents: JSON.parse(thread.thread.expected_respondents || "[]"),
      });
    }

  } else if (url === "/api/threads-active") {
    const open = consultation.listThreads({ status: "open" });
    const resolving = consultation.listThreads({ status: "resolving" });
    json(res, [...open, ...resolving]);

  } else if (url === "/api/hot-files") {
    const { since_minutes } = body as { since_minutes?: number };
    json(res, fileTracker.getHotFiles(since_minutes || 30));

  } else if (url === "/api/quota") {
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

  } else if (url === "/api/quota/refresh") {
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

  } else if (url === "/api/introspection-response") {
    const { introspection_id, concerned, reason } = body as {
      introspection_id: string; concerned: boolean; reason: string;
    };
    const intro = introspection.respond(introspection_id, concerned, reason);

    // If concerned, add to thread's expected_respondents
    if (concerned && intro) {
      const db = getDb();
      const thread = consultation.getThread(intro.thread_id);
      if (thread && (thread.status === "open" || thread.status === "resolving")) {
        const respondents: string[] = JSON.parse(thread.expected_respondents || "[]");
        if (!respondents.includes(intro.agent_id)) {
          respondents.push(intro.agent_id);
          db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
            .run(JSON.stringify(respondents), thread.id);
        }
      }
    }

    const agentInfo = registry.get(intro?.agent_id || "");
    sseEmitter.emit("introspection_completed", {
      introspection_id, thread_id: intro?.thread_id,
      agent_id: intro?.agent_id, agent_name: agentInfo?.name || intro?.agent_id,
      concerned, reason,
    });
    json(res, intro);

  } else if (url?.startsWith("/api/pending-introspections")) {
    const urlObj = new URL(url, "http://localhost");
    const agent_id = urlObj.searchParams.get("agent_id") || "";
    const pending = introspection.getPending(agent_id);
    json(res, pending);

  } else if (url === "/api/run-config") {
    if (req.method === "POST") {
      setRunConfig(body as Record<string, unknown>);
      sseEmitter.emit("run_config" as Parameters<typeof sseEmitter.emit>[0], getRunConfig() as Record<string, unknown>);
      json(res, { ok: true });
    } else {
      json(res, getRunConfig() || { active: false });
    }

  } else if (url === "/api/reset") {
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

  } else if (url === "/api/check-interrupt") {
    const { agent_id } = body as { agent_id: string };
    // Check for threads where this agent is an expected respondent and hasn't posted yet.
    // Covers both open threads (waiting for initial response) and resolving threads
    // (waiting for approval/contest of a proposed resolution).
    const pendingThreads = [
      ...consultation.listThreads({ status: "open" }),
      ...consultation.listThreads({ status: "resolving" }),
    ].filter((t) => {
      const respondents: string[] = JSON.parse(t.expected_respondents || "[]");
      return respondents.includes(agent_id);
    });
    if (pendingThreads.length > 0) {
      const details = pendingThreads.map((t) => ({
        thread_id: t.id,
        subject: t.subject,
        initiator_id: t.initiator_id,
        status: t.status,
        target_files: JSON.parse(t.target_files || "[]"),
      }));
      json(res, { interrupt: true, threads: details });
    } else {
      json(res, { interrupt: false });
    }

  } else if (url?.startsWith("/api/agent-status/")) {
    const aid = url.split("/")[3];
    const agent = registry.get(aid);
    if (!agent) {
      json(res, { registered: false, status: "unknown" });
    } else {
      const activity = activityTracker.getActivity(aid, { idleAfterMinutes: 5 });
      json(res, { registered: true, status: agent.status, activity: activity.activity_status });
    }

  } else if (url === "/api/file-activity" && req.method === "POST") {
    if (typeof body.session_id !== "string" || typeof body.agent_id !== "string"
        || typeof body.tool_name !== "string" || typeof body.file_path !== "string") {
      json(res, { error: "missing required fields" }, 400);
      return;
    }
    if (body.agent_name !== undefined && typeof body.agent_name !== "string") {
      json(res, { error: "agent_name must be string when present" }, 400);
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
      symbols = ctx.services.treeSitter.extract(body.file_path, body.content, null);
    }
    ctx.services.fileTracker.log({
      session_id: body.session_id,
      agent_id: body.agent_id,
      agent_name: body.agent_name,
      tool_name: body.tool_name,
      file_path: body.file_path,
      content_hash: contentHash,
      symbols_touched: symbols,
    });
    json(res, { ok: true });

  } else if (url === "/api/working-files/start" && req.method === "POST") {
    if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
      json(res, { error: "agent_id and file_path required" }, 400);
      return;
    }
    const ttl = parseInt(process.env.COORDINATOR_WORKING_FILES_TTL_MIN || "30", 10);
    services.workingFiles.start(body.agent_id as string, body.file_path as string, ttl);
    json(res, { ok: true });

  } else if (url === "/api/working-files/stop" && req.method === "POST") {
    if (typeof body.agent_id !== "string" || typeof body.file_path !== "string") {
      json(res, { error: "agent_id and file_path required" }, 400);
      return;
    }
    services.workingFiles.stop(body.agent_id as string, body.file_path as string);
    json(res, { ok: true });

  } else if (url === "/api/status") {
    const online = registry.listOnline();
    const openThreads = consultation.listThreads({ status: "open" });
    json(res, {
      online: online.length,
      open_threads: openThreads.length,
      hot_files: fileTracker.getHotFiles(30).length,
      mqtt: services.mqttBridge.isConnected(),
    });

  } else {
    json(res, { error: "not found" }, 404);
  }
}
