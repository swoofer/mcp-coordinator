import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID, timingSafeEqual } from "crypto";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
let __filename: string;
try {
  __filename = fileURLToPath(import.meta.url);
} catch {
  __filename = process.cwd();
}
const __dirname = path.dirname(__filename);
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServices, createMcpServer, CoordinatorServices } from "./server-setup.js";
import { createLogger, type Logger } from "./logger.js";
import { initAuth, authenticateRequest, createToken, refreshToken, revokeAgent, setAuthLogger, type AuthResult } from "./auth.js";
import { assessPlanQuality } from "./plan-quality.js";
import type { CoordinatorEvent } from "./types.js";
import { getVersion } from "../cli/version.js";
const VERSION = getVersion();
import { startEmbeddedMqttBroker } from "./mqtt-broker.js";

const SERVER_FILE_DIR = path.dirname(__filename);

async function getDashboardDir(): Promise<string> {
  // src/serve-http.ts (tsx) → dashboard/public is at ../dashboard/public
  // dist/src/serve-http.js → dashboard/public is at ../../dashboard/public
  // Walk up until we find a directory containing dashboard/public/index.html.
  let dir = SERVER_FILE_DIR;
  while (dir !== path.dirname(dir)) {
    const candidate = path.resolve(dir, "dashboard", "public", "index.html");
    if (existsSync(candidate)) return path.resolve(dir, "dashboard", "public");
    dir = path.dirname(dir);
  }
  throw new Error(`mcp-coordinator: could not locate dashboard/public/ from ${SERVER_FILE_DIR}`);
}

const PORT = parseInt(process.env.PORT || "3100");
const DATA_DIR = process.env.COORDINATOR_DATA_DIR || "./data";
// MQTT is always embedded; ports/paths are configurable for multi-instance setups
const MQTT_TCP_PORT = parseInt(process.env.COORDINATOR_MQTT_TCP_PORT || "1883");
const MQTT_WS_PATH = process.env.COORDINATOR_MQTT_WS_PATH || "/mqtt";
const AUTH_ENABLED = process.env.COORDINATOR_AUTH_ENABLED === "true";
const JWT_SECRET = process.env.COORDINATOR_JWT_SECRET || "";
const JWT_EXPIRY = process.env.COORDINATOR_JWT_EXPIRY || "24h";
const REGISTRATION_SECRET = process.env.COORDINATOR_REGISTRATION_SECRET || "";
const ADMIN_SECRET = process.env.COORDINATOR_ADMIN_SECRET || "";

let services: CoordinatorServices;
let httpLog: Logger;
let mcpLog: Logger;
let authLog: Logger;
let currentRunConfig: Record<string, unknown> | null = null;

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  // Used only on tokens we just minted ourselves (to read the `exp` claim
  // before returning it to the client). Real verification of inbound tokens
  // happens in `authenticateRequest` via jose.jwtVerify().
  const base64url = token.split(".")[1];
  return JSON.parse(Buffer.from(base64url, "base64url").toString("utf-8"));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || "";
  const body = await parseBody(req);
  const agentId = (body as Record<string, unknown>).agent_id as string | undefined;
  // Dashboard/work-stealing polls these endpoints every few seconds â€” demote to debug
  // to keep the info log focused on coordination events (announce, claim, resolve, etc).
  const isPoll = url === "/api/hot-files" || url === "/api/threads-active" || url === "/api/status" || url === "/api/quota";
  // Note: /api/quota/refresh is NOT in the poll list â€” it's a manual user
  // action and deserves an info-level log for auditability.
  if (isPoll) {
    httpLog.debug({ method: req.method, url, agent_id: agentId }, "REST request");
  } else {
    httpLog.info({ method: req.method, url, agent_id: agentId }, "REST request");
  }
  const { registry, activityTracker, consultation, fileTracker, impactScorer, introspection, sseEmitter, mqttBridge, quotaCache } = services;

  if (url === "/api/register") {
    const { agent_id, name, modules } = body as { agent_id: string; name: string; modules: string[] };
    const agent = registry.register(agent_id, name, modules || []);
    sseEmitter.emit("agent_online", { agent_id, name, modules });
    json(res, agent);

  } else if (url === "/api/session-start") {
    const { agent_id, agent_name } = body as { agent_id: string; agent_name: string };
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
    const { agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to } = body as {
      agent_id: string; subject: string; plan?: string; target_modules: string[]; target_files: string[];
      depends_on_files?: string[]; exports_affected?: string[]; keep_open?: boolean; assigned_to?: string | null;
    };

    // Quality gate on plan
    const planQuality = assessPlanQuality(plan);
    const effectiveMode = planQuality.mode;

    const thread = consultation.announceWork({ agent_id, subject, plan, target_modules, target_files, depends_on_files, exports_affected, keep_open, assigned_to });
    const agentInfo = registry.get(agent_id);

    // Impact scoring: categorize all online agents
    const categorized = impactScorer.categorize({
      agent_id, target_modules, target_files, depends_on_files, exports_affected,
    });

    // Override expected_respondents with concerned agents from scorer
    {
      const db = (await import("./database.js")).getDb();
      const concernedIds = categorized.concerned.map(s => s.agent_id);
      db.prepare("UPDATE threads SET expected_respondents = ? WHERE id = ?")
        .run(JSON.stringify(concernedIds), thread.id);
      // Only auto-resolve when truly alone â€” no other online agents.
      // If peers are online but not yet concerned (e.g. they haven't announced
      // yet), keep the thread open so a subsequent announce can still match
      // this work via Layer 0. Thread will timeout naturally if no one joins.
      const otherOnlineCount = registry.listOnline().filter((a) => a.id !== agent_id).length;
      const shouldAutoResolve = concernedIds.length === 0 && otherOnlineCount === 0;
      if (shouldAutoResolve && thread.status === "open" && !keep_open) {
        db.prepare("UPDATE threads SET status = 'resolved', resolved_at = ? WHERE id = ?")
          .run(new Date().toISOString(), thread.id);
        consultation.emitResolution(thread.id, "auto_resolved");
      }
    }

    // Emit impact_scored SSE events for all agents
    for (const s of [...categorized.concerned, ...categorized.gray_zone, ...categorized.pass]) {
      sseEmitter.emit("impact_scored", {
        thread_id: thread.id, agent_id: s.agent_id, agent_name: s.agent_name,
        score: s.score, reasons: s.reasons, category: s.score >= 90 ? "concerned" : s.score >= 30 ? "gray_zone" : "pass",
      });
    }

    // Create introspection records and emit introspection_requested for gray_zone agents
    for (const s of categorized.gray_zone) {
      introspection.create({ thread_id: thread.id, agent_id: s.agent_id, score: s.score, reasons: s.reasons });
      sseEmitter.emit("introspection_requested", {
        thread_id: thread.id, agent_id: s.agent_id, agent_name: s.agent_name, score: s.score, reasons: s.reasons,
      });
    }

    const updated = consultation.getThread(thread.id)!;
    const respondents = JSON.parse(updated.expected_respondents || "[]");
    // Emit downgrade event when plan is provided but quality is insufficient
    if (plan && effectiveMode === "discovery") {
      sseEmitter.emit("impact_scored" as any, {
        thread_id: thread.id,
        agent_id: agent_id,
        agent_name: agentInfo?.name || agent_id,
        score: planQuality.score,
        reasons: [`plan downgraded: score ${planQuality.score}/3 â€” ${!planQuality.checks.mentions_files ? 'no files' : ''} ${!planQuality.checks.concrete_approach ? 'vague approach' : ''} ${!planQuality.checks.sufficient_detail ? 'too short' : ''}`.trim()],
        category: "plan_quality",
      });
    }

    sseEmitter.emit("thread_opened", {
      thread_id: thread.id, subject, agent_id, agent_name: agentInfo?.name || agent_id,
      target_modules, target_files, expected_respondents: respondents,
      conflicts: updated.conflicts ? JSON.parse(updated.conflicts) : [],
      created_at: updated.created_at,
      mode: effectiveMode,
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
    // Agent â†’ coordinator telemetry, emitted once per LLM turn so the dashboard
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
    const db = (await import("./database.js")).getDb();
    // F4: increment unclaim counter. After POISON_THRESHOLD aborts, flip status
    // to "poisoned" so no agent claims it again â€” prevents the tight
    // claim â†’ no DONE â†’ unclaim â†’ re-claim loop we observed on stuck tasks.
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
    const db = (await import("./database.js")).getDb();
    // Only claim threads with status='open' â€” poisoned threads are filtered out
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
    // dashboard receives the update through the normal channel too â€” this
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
      const db = (await import("./database.js")).getDb();
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
      currentRunConfig = body as Record<string, unknown>;
      sseEmitter.emit("run_config" as any, currentRunConfig);
      json(res, { ok: true });
    } else {
      json(res, currentRunConfig || { active: false });
    }

  } else if (url === "/api/reset") {
    // Reset all tables for clean test run (disable FK checks to avoid ordering issues)
    const db = (await import("./database.js")).getDb();
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
    currentRunConfig = null;
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
    const agentId = url.split("/")[3];
    const agent = registry.get(agentId);
    if (!agent) {
      json(res, { registered: false, status: "unknown" });
    } else {
      const activity = activityTracker.getActivity(agentId, { idleAfterMinutes: 5 });
      json(res, { registered: true, status: agent.status, activity: activity.activity_status });
    }

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

async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || "";
  const body = await parseBody(req);

  if (url === "/api/auth/register" && req.method === "POST") {
    const { agent_name, registration_secret } = body as { agent_name: string; registration_secret: string };

    if (!agent_name || !registration_secret) {
      json(res, { error: "agent_name and registration_secret are required" }, 400);
      return;
    }

    let role: "agent" | "admin" = "agent";
    if (safeEqual(registration_secret, ADMIN_SECRET)) {
      role = "admin";
    } else if (!safeEqual(registration_secret, REGISTRATION_SECRET)) {
      authLog.warn({ agent_name, ip: req.socket.remoteAddress }, "Invalid registration secret");
      json(res, { error: "Invalid registration secret" }, 401);
      return;
    }

    const agentId = randomUUID();
    const token = await createToken(agentId, role);

    const payload = decodeJwtPayload(token);
    const expiresAt = new Date((payload.exp as number) * 1000).toISOString();

    authLog.info({ agent_id: agentId, agent_name, role, method: "auto-register" }, "Agent registered via auto-register");
    json(res, { agent_id: agentId, token, expires_at: expiresAt, role });

  } else if (url === "/api/auth/refresh" && req.method === "POST") {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      json(res, { error: "Bearer token required" }, 401);
      return;
    }

    try {
      const newToken = await refreshToken(authHeader.slice(7));
      const payload = decodeJwtPayload(newToken);
      const expiresAt = new Date((payload.exp as number) * 1000).toISOString();
      authLog.info({ agent_id: payload.sub }, "Token refreshed");
      json(res, { token: newToken, expires_at: expiresAt });
    } catch {
      json(res, { error: "Invalid or expired token (beyond grace period)" }, 401);
    }

  } else if (url === "/api/auth/revoke" && req.method === "POST") {
    const authResult = await authenticateRequest(req);
    if (!authResult.ok) {
      json(res, { error: authResult.error }, authResult.status);
      return;
    }

    const { agent_id } = body as { agent_id: string };
    if (!agent_id) {
      json(res, { error: "agent_id is required" }, 400);
      return;
    }

    revokeAgent(agent_id, authResult.claims.sub);
    authLog.info({ agent_id, revoked_by: authResult.claims.sub }, "Agent revoked");
    json(res, { ok: true, agent_id, revoked_by: authResult.claims.sub });

  } else {
    json(res, { error: "not found" }, 404);
  }
}

/**
 * Splice `_ts` (the event's created_at, set by the server when the event was
 * first emitted) into the payload JSON. Done as a string prepend rather than
 * JSON.parse+stringify to avoid the round-trip on every SSE message â€” the
 * payload is always a JSON object literal by contract. The client reads `_ts`
 * to render the original event time on page reload / replay instead of
 * falling back to Date.now() which painted every historical event with the
 * current wall clock.
 */
function injectTimestamp(payloadJson: string, createdAt: string): string {
  if (!payloadJson.startsWith("{")) return payloadJson;
  const body = payloadJson.slice(1);
  // Empty object `{}` â†’ `{"_ts":"..."}` with no stray comma.
  if (body === "}") return `{"_ts":${JSON.stringify(createdAt)}}`;
  return `{"_ts":${JSON.stringify(createdAt)},${body}`;
}

function writeSseEvent(res: ServerResponse, event: CoordinatorEvent): void {
  // created_at is optional in the DB row type but always set at emit time by
  // the SseEmitter. Fall back to "now" for the rare case a row predates the
  // field â€” the client uses Date.now() when _ts is missing anyway.
  const data = injectTimestamp(event.payload, event.created_at ?? new Date().toISOString());
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`);
}

function handleSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Use Last-Event-ID for resumption, otherwise send last 50
  const lastEventId = parseInt(req.headers["last-event-id"] as string || "0", 10);
  const events = lastEventId > 0
    ? services.sseEmitter.getEventsSince(lastEventId)
    : services.sseEmitter.getEventsSince(0).slice(-50);
  for (const event of events) {
    writeSseEvent(res, event);
  }

  // Listen for new events
  const unsubscribe = services.sseEmitter.addListener((event: CoordinatorEvent) => {
    writeSseEvent(res, event);
  });

  req.on("close", () => unsubscribe());
}

export interface ServerOptions {
  port?: number;
  dataDir?: string;
}

export async function startServer(opts?: ServerOptions): Promise<void> {
  const port = opts?.port ?? PORT;
  const dataDir = opts?.dataDir ?? DATA_DIR;

  services = createServices({ dataDir });
  const log = services.logger;
  httpLog = log.child({ component: "http" });
  mcpLog = log.child({ component: "mcp" });
  authLog = log.child({ component: "auth" });
  setAuthLogger(authLog);

  if (AUTH_ENABLED) {
    if (!JWT_SECRET || JWT_SECRET.length < 32) {
      log.fatal("COORDINATOR_JWT_SECRET is required (min 32 chars) when auth is enabled");
      process.exit(1);
    }
    if (!REGISTRATION_SECRET) {
      log.fatal("COORDINATOR_REGISTRATION_SECRET is required when auth is enabled");
      process.exit(1);
    }
    if (!ADMIN_SECRET) {
      log.fatal("COORDINATOR_ADMIN_SECRET is required when auth is enabled");
      process.exit(1);
    }
    initAuth(JWT_SECRET, JWT_EXPIRY);
    log.info("Auth enabled (JWT HS256)");
  }

  // Multi-session: one transport+server per MCP client session
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = req.url || "";

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Authorization",
      });
      res.end();
      return;
    }

    try {
      if (url === "/dashboard" || url.startsWith("/dashboard/")) {
        const dashboardDir = await getDashboardDir().catch((err) => {
          httpLog.warn({ err }, "Dashboard not found");
          return null;
        });
        if (!dashboardDir) {
          json(res, { error: "dashboard not available" }, 404);
          return;
        }
        const filePath = url === "/dashboard" || url === "/dashboard/"
          ? path.join(dashboardDir, "index.html")
          : path.join(dashboardDir, url.replace("/dashboard/", ""));
        if (existsSync(filePath)) {
          const ext = path.extname(filePath);
          const contentTypes: Record<string, string> = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
          };
          const content = readFileSync(filePath, "utf-8");
          res.writeHead(200, {
            "Content-Type": contentTypes[ext] || "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(content);
        } else {
          json(res, { error: "not found" }, 404);
        }
        return;
      } else if (url === "/health") {
        json(res, { status: "ok", version: VERSION });
      } else if (url === "/api/events" && req.method === "GET") {
        handleSse(req, res);
      } else if (url.startsWith("/api/auth/")) {
        if (!AUTH_ENABLED) {
          json(res, { error: "Authentication is not enabled on this coordinator" }, 501);
        } else {
          await handleAuth(req, res);
        }
      } else if (url === "/mcp") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session â€” already authenticated, route directly
          await sessions.get(sessionId)!.handleRequest(req, res);
        } else if (req.method === "POST" && !sessionId) {
          // New session â€” auth guard required
          let authenticatedAgent: string | undefined;
          if (AUTH_ENABLED) {
            const authResult = await authenticateRequest(req);
            if (!authResult.ok) {
              authLog.warn({ reason: authResult.error, url, ip: req.socket.remoteAddress }, "Auth rejected");
              json(res, { error: authResult.error }, authResult.status);
              return;
            }
            authenticatedAgent = authResult.claims.sub;
          }

          // Create transport + server
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
          const mcpServer = createMcpServer(services);
          await mcpServer.connect(transport);

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) sessions.delete(sid);
            mcpLog.info({ session_id: sid, remaining: sessions.size }, "MCP session closed");
          };

          await transport.handleRequest(req, res);

          if (transport.sessionId) {
            sessions.set(transport.sessionId, transport);
            mcpLog.info({ session_id: transport.sessionId, total: sessions.size, agent_id: authenticatedAgent }, "MCP session opened");
          }
        } else {
          json(res, { error: "Session not found. Send a request without mcp-session-id to start a new session." }, 404);
        }
      } else {
        // Auth guard for protected routes
        if (AUTH_ENABLED) {
          const authResult = await authenticateRequest(req);
          if (!authResult.ok) {
            authLog.warn({ reason: authResult.error, url, ip: req.socket.remoteAddress }, "Auth rejected");
            json(res, { error: authResult.error }, authResult.status);
            return;
          }
        }

        if (url.startsWith("/api/") && (req.method === "POST" || req.method === "GET")) {
          await handleRest(req, res);
        } else {
          json(res, { error: "not found" }, 404);
        }
      }
    } catch (err) {
      httpLog.error({ err }, "HTTP request error");
      json(res, { error: (err as Error).message }, 500);
    }
  });

  // Start the embedded MQTT broker (TCP + WebSocket on HTTP upgrade).
  // Awaiting ensures the TCP listener is fully bound before we connect our
  // own client or tell users the coordinator is ready.
  await startEmbeddedMqttBroker({
    tcpPort: MQTT_TCP_PORT,
    httpServer,
    wsPath: MQTT_WS_PATH,
    logger: log.child({ component: "mqtt-broker" }),
  });

  // Connect the coordinator's own MQTT client to the embedded broker BEFORE
  // the HTTP server accepts requests â€” agents shouldn't see a half-ready coordinator.
  await services.mqttBridge.connect({ url: `mqtt://127.0.0.1:${MQTT_TCP_PORT}` });
  services.mqttBridge.onOffline((agentId) => {
    services.registry.setOffline(agentId);
    services.consultation.handleAgentDeparture(agentId);
    services.sseEmitter.emit("agent_offline", { agent_id: agentId });
  });

  httpServer.listen(port, () => {
    log.info({
      port,
      mcp: `POST http://localhost:${port}/mcp`,
      rest: `POST http://localhost:${port}/api/*`,
      sse: `GET http://localhost:${port}/api/events`,
      mqtt_tcp: `mqtt://127.0.0.1:${MQTT_TCP_PORT}`,
      mqtt_ws: `ws://localhost:${port}${MQTT_WS_PATH}`,
    }, "Coordinator v3 started");
  });
}

// Auto-start when run directly (not imported)
const isMainModule = process.argv[1]?.endsWith("serve-http.ts") || process.argv[1]?.endsWith("serve-http.js");
if (isMainModule) {
  startServer().catch((err) => {
    const log = createLogger();
    log.fatal({ err }, "Fatal startup error");
    process.exit(1);
  });
}

