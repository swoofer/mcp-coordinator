import type { IncomingMessage, ServerResponse } from "http";
import { parseBody, json, redactTokenParam } from "./utils.js";
import type { RestContext, RestHandler } from "./rest-handlers.js";
import {
  handleRegister,
  handleSessionStart,
  handleSessionStop,
  handleCheckConflict,
  handleLogFile,
  handleAnnounce,
  handlePostToThread,
  handleTokenUsage,
  handleUnclaimTask,
  handleClaimTask,
  handleProposeResolution,
  handleApproveResolution,
  handleConsultationStatus,
  handleThreadsActive,
  handleHotFiles,
  handleQuota,
  handleQuotaRefresh,
  handleIntrospectionResponse,
  handlePendingIntrospections,
  handleRunConfig,
  handleReset,
  handleCheckInterrupt,
  handleAgentStatus,
  handleFileActivity,
  handleWorkingFilesStart,
  handleWorkingFilesStop,
  handleScoringStats,
  handleStatus,
} from "./rest-handlers.js";

export type { RestContext, RestHandler };

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
 *
 * qualite-code-01 (1/3): the if/else chain of 24+ url branches was replaced
 * by a dispatch table. Each former branch is now a named handler in
 * ./rest-handlers.ts — bodies copied verbatim, only wrapped in a function.
 * Routes that also gate on req.method (file-activity, working-files/*) are
 * keyed as "METHOD url" so a method mismatch simply misses the table lookup
 * and falls through to the same 404 as before. Routes matched by URL prefix
 * (consultation/:id/status, pending-introspections, agent-status/:id,
 * scoring-stats) can't be exact-keyed, so they're tried after the exact
 * table in a small ordered list — none of their prefixes collide with any
 * exact route key, so this reordering is behavior-preserving relative to
 * the original interleaved if/else sequence.
 */

// Exact url-only matches (method is irrelevant to routing).
const ROUTES: Record<string, RestHandler> = {
  "/api/register": handleRegister,
  "/api/session-start": handleSessionStart,
  "/api/session-stop": handleSessionStop,
  "/api/check-conflict": handleCheckConflict,
  "/api/log-file": handleLogFile,
  "/api/announce": handleAnnounce,
  "/api/post-to-thread": handlePostToThread,
  "/api/token-usage": handleTokenUsage,
  "/api/unclaim-task": handleUnclaimTask,
  "/api/claim-task": handleClaimTask,
  "/api/propose-resolution": handleProposeResolution,
  "/api/approve-resolution": handleApproveResolution,
  "/api/threads-active": handleThreadsActive,
  "/api/hot-files": handleHotFiles,
  "/api/quota": handleQuota,
  "/api/quota/refresh": handleQuotaRefresh,
  "/api/introspection-response": handleIntrospectionResponse,
  "/api/run-config": handleRunConfig,
  "/api/reset": handleReset,
  "/api/check-interrupt": handleCheckInterrupt,
  "/api/status": handleStatus,
};

// Exact url matches that also require a specific req.method — original code
// used `url === "..." && req.method === "POST"`, so a wrong method must fall
// through to the generic 404 exactly like before.
const METHOD_ROUTES: Record<string, RestHandler> = {
  "POST /api/file-activity": handleFileActivity,
  "POST /api/working-files/start": handleWorkingFilesStart,
  "POST /api/working-files/stop": handleWorkingFilesStop,
};

// URL-prefix matches, tried in the same relative order they appeared in the
// original if/else chain. None of their prefixes are a prefix of (or equal
// to) any key in ROUTES/METHOD_ROUTES, so trying all exact matches first is
// equivalent to the original interleaved ordering.
const PREFIX_ROUTES: Array<{
  test: (url: string, method: string | undefined) => boolean;
  handler: RestHandler;
}> = [
  {
    test: (url) => url?.startsWith("/api/consultation/") && url?.endsWith("/status"),
    handler: handleConsultationStatus,
  },
  {
    test: (url) => url?.startsWith("/api/pending-introspections"),
    handler: handlePendingIntrospections,
  },
  { test: (url) => url?.startsWith("/api/agent-status/"), handler: handleAgentStatus },
  {
    test: (url, method) => url?.startsWith("/api/scoring-stats") && method === "GET",
    handler: handleScoringStats,
  },
];

export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
): Promise<void> {
  const { httpLog } = ctx;
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
  const isPoll =
    url === "/api/hot-files" ||
    url === "/api/threads-active" ||
    url === "/api/status" ||
    url === "/api/quota";
  // Note: /api/quota/refresh is NOT in the poll list — it's a manual user
  // action and deserves an info-level log for auditability.
  // securite-auth-03: url may carry ?token=<jwt> on a GET request — mask
  // before logging (see redactTokenParam doc in ./utils.ts).
  const logUrl = redactTokenParam(url);
  if (isPoll) {
    httpLog.debug({ method: req.method, url: logUrl, agent_id: agentId }, "REST request");
  } else {
    httpLog.info({ method: req.method, url: logUrl, agent_id: agentId }, "REST request");
  }

  const handler = ROUTES[url] || (req.method ? METHOD_ROUTES[`${req.method} ${url}`] : undefined);
  if (handler) {
    await handler(req, res, ctx, body);
    return;
  }
  for (const route of PREFIX_ROUTES) {
    if (route.test(url, req.method)) {
      await route.handler(req, res, ctx, body);
      return;
    }
  }
  json(res, { error: "not found" }, 404);
}
