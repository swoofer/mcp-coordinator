import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import path from "path";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

let __filename: string;
try {
  __filename = fileURLToPath(import.meta.url);
} catch {
  __filename = process.cwd();
}
const __dirname = path.dirname(__filename);
import { createServices, createMcpServer, CoordinatorServices } from "./server-setup.js";
import { createLogger, type Logger } from "./logger.js";
import {
  initAuth,
  authenticateRequest,
  createToken,
  refreshToken,
  revokeAgent,
  setAuthLogger,
  verifyToken,
  type AuthResult,
  type AuthRole,
  type AuthClaims,
} from "./auth.js";
import { canResetDb } from "./reset-guard.js";
import { safeJoinUnderRoot } from "./path-guard.js";
import { handleRest as handleRestExt, type RestContext } from "./http/handle-rest.js";
import { handleLivez, handleReadyz, handleHealth } from "./http/handle-health.js";
import { handleHealthz, handleHealthReady } from "./http/health.js";
import { handleDiscovery } from "./discovery.js";
import { serveMetrics } from "./metrics.js";
import { handleMetrics } from "./http/metrics.js";
import {
  parseBody as parseBodyShared,
  json as jsonShared,
  jsonAuthError as jsonAuthErrorShared,
  metricRoute,
  decodeJwtPayload,
  safeEqual,
  redactTokenParam,
} from "./http/utils.js";
import { appError } from "./http/response-contract.js";
import { isAllowedOrigin } from "./http/origin.js";
import type { CoordinatorEvent } from "./types.js";
import { getVersion } from "./version.js";
const VERSION = getVersion();
import { startEmbeddedMqttBroker, type MqttAuthResult } from "./mqtt-broker.js";
import { withRequestId, resolveRequestId } from "./auth/request-id.js";
import { withAuditContext } from "./auth/audit-context.js";
import { bootPhase2, type Phase2Bootstrap } from "./boot.js";
import { Sweeper } from "./sweeper/index.js";
import { realClock } from "./auth/clock.js";
import { RateLimiter, type RateLimitConfig, type IRateLimiter } from "./auth/rate-limit.js";
import { dispatchAuthRoutes } from "./http/auth-routes.js";
import { connectRedis, acquireLock, withLock, type RedisHandles } from "./infra/redis.js";
import { setTokenEpochBus, noteEpochBump } from "./auth/token-epoch.js";
import os from "node:os";
import { getDb } from "./database.js";
import type DatabaseT from "better-sqlite3";

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
// Multi-instance: opt-in shared state via Redis. Unset
// (default) = single-instance, all in-memory implementations unchanged.
const REDIS_URL = process.env.COORDINATOR_REDIS_URL || "";
// Unique instance identity for distributed locks (boot migration, sweeper
// leadership, MQTT-offline dedup).
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
// External-broker support: run with an external MQTT broker instead of the
// embedded Aedes one. Default keeps the embedded broker (upstream behavior).
// NOTE: the per-org MQTT topic ACL (authorizeSubscribe/authorizePublish in
// mqtt-broker.ts) is enforced only by the embedded Aedes broker. When
// COORDINATOR_MQTT_EMBEDDED=false, this process does NOT enforce tenant
// isolation on the wire — operators are responsible for configuring
// equivalent per-org topic ACLs on the external broker itself.
const MQTT_EMBEDDED = process.env.COORDINATOR_MQTT_EMBEDDED !== "false";
const MQTT_URL = process.env.COORDINATOR_MQTT_URL || "";
const MQTT_USERNAME = process.env.COORDINATOR_MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.COORDINATOR_MQTT_PASSWORD || undefined;
const AUTH_ENABLED = process.env.COORDINATOR_AUTH_ENABLED === "true";
const JWT_SECRET = process.env.COORDINATOR_JWT_SECRET || "";
// Capture whether the env var was EXPLICITLY set at startup. Do not derive this
// from the runtime signing key — `initAuth()` may have generated a random
// per-boot secret, in which case the key's length is > 0 but the operator did
// not provide one. `/healthz` must report the operator's intent, not the
// random fallback.
const JWT_SECRET_EXPLICITLY_SET = !!process.env.COORDINATOR_JWT_SECRET;
const JWT_EXPIRY = process.env.COORDINATOR_JWT_EXPIRY || "24h";
const JWT_PREV_SECRET = process.env.COORDINATOR_JWT_PREV_SECRET || "";
const REGISTRATION_SECRET = process.env.COORDINATOR_REGISTRATION_SECRET || "";
const ADMIN_SECRET = process.env.COORDINATOR_ADMIN_SECRET || "";

// securite-surface-05: /api/auth/register is Phase 1 and NOT authenticated
// (agent_name + registration_secret only) — without a rate limit an attacker
// can mass-register agents (registration_secret brute-force, or just quota
// exhaustion once each successful call mints a JWT). 10 requests / 60s per
// IP is generous enough for normal onboarding bursts while capping abuse.
const REGISTER_RATE_LIMIT_CONFIG: RateLimitConfig = {
  per: parseInt(process.env.COORDINATOR_REGISTER_RATE_LIMIT_PER || "10", 10),
  window_seconds: parseInt(process.env.COORDINATOR_REGISTER_RATE_LIMIT_WINDOW_SECONDS || "60", 10),
};

let services: CoordinatorServices;
let httpLog: Logger;
let mcpLog: Logger;
let authLog: Logger;
// architecture-02: services/httpLog above are module-level
// state, reassigned on every startServer() call — the request handler closes
// over these module bindings, not over per-call locals. That means this
// process supports exactly ONE live coordinator at a time: a second
// concurrent startServer() would silently repoint every in-flight request
// handler at the new instance's services/config, corrupting the first one.
// serverRunning is the fail-closed guard for that: set true on entry, reset
// to false in stop() (or on startup failure — see the startServer() wrapper
// below). Sequential restart (stop() then startServer() again) remains fully
// supported; only *concurrent* in-process instances are rejected.
let serverRunning = false;
// securite-surface-05: set once per startServer() call — see registration
// rate-limit wiring there. Reuses bootPhase2's RateLimiter (already swept)
// when Phase 2 is active, mirroring the retentionSweeper reuse-or-own
// pattern below; owns its own sweeper lifecycle otherwise.
let registerRateLimiter: IRateLimiter;

// S1: parseBody and json moved to ./http/utils.js (shared with handle-rest.ts).
// Re-bound to local names so the rest of this file (handleAuth, handleSse,
// startServer) can keep using `parseBody` / `json` without changes.
const parseBody = parseBodyShared;
const json = jsonShared;
const jsonAuthError = jsonAuthErrorShared;
// S1: decodeJwtPayload and safeEqual moved to ./http/utils.js (qualite-code-05).

// S1: handleRest extracted to ./http/handle-rest.ts. Thin wrapper here keeps
// startServer's call site stable while the 382-line REST router lives in its
// own module.
// claims: always populated by the caller (synthetic legacy claims when AUTH_ENABLED=false).
async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  claims: AuthClaims,
): Promise<void> {
  const ctx: RestContext = {
    services,
    httpLog,
    authEnabled: AUTH_ENABLED,
    claims,
  };
  return handleRestExt(req, res, ctx);
}

async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || "";
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    json(res, { error: e.message || "Invalid request" }, e.statusCode || 400);
    return;
  }

  if (url === "/api/auth/register" && req.method === "POST") {
    // securite-surface-05: per-IP token bucket, checked BEFORE credential
    // validation so both failed AND successful attempts count against the
    // same budget (an attacker with a valid registration_secret shouldn't
    // be able to mass-mint agents any more than one brute-forcing it can).
    const ip = req.socket.remoteAddress || "unknown";
    // Phase 5: registerRateLimiter may be reused from bootPhase2's context,
    // which is Redis-backed (async) when COORDINATOR_REDIS_URL is set.
    const rateResult = await registerRateLimiter.check(
      `register:${ip}`,
      REGISTER_RATE_LIMIT_CONFIG,
    );
    if (!rateResult.allowed) {
      res.setHeader("Retry-After", String(rateResult.retry_after_seconds));
      authLog.warn({ ip }, "Registration rate limit exceeded");
      json(res, { error: "Too many registration attempts. Try again later." }, 429);
      return;
    }

    const { agent_name, registration_secret } = body as {
      agent_name: string;
      registration_secret: string;
    };

    if (!agent_name || !registration_secret) {
      json(res, { error: "agent_name and registration_secret are required" }, 400);
      return;
    }

    let role: AuthRole = "agent";
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

    authLog.info(
      { agent_id: agentId, agent_name, role, method: "auto-register" },
      "Agent registered via auto-register",
    );
    json(res, { agent_id: agentId, token, expires_at: expiresAt, role });
  } else if (url === "/api/auth/refresh" && req.method === "POST") {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      // RFC 6750 §3: 401 from a Bearer-protected endpoint must include
      // WWW-Authenticate. /api/auth/refresh doesn't go through
      // authenticateRequest (it consumes the prior token, doesn't enforce
      // current validity), so we set the header manually here.
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-coordinator", error="invalid_token"');
      json(res, { error: "Bearer token required" }, 401);
      return;
    }

    try {
      const newToken = await refreshToken(authHeader.slice(7), { authEnabled: AUTH_ENABLED });
      const payload = decodeJwtPayload(newToken);
      const expiresAt = new Date((payload.exp as number) * 1000).toISOString();
      authLog.info({ agent_id: payload.sub }, "Token refreshed");
      json(res, { token: newToken, expires_at: expiresAt });
    } catch {
      res.setHeader("WWW-Authenticate", 'Bearer realm="mcp-coordinator", error="invalid_token"');
      json(res, { error: "Invalid or expired token (beyond grace period)" }, 401);
    }
  } else if (url === "/api/auth/revoke" && req.method === "POST") {
    const authResult = await authenticateRequest(req, { authEnabled: AUTH_ENABLED });
    if (!authResult.ok) {
      jsonAuthError(res, authResult);
      return;
    }

    const { agent_id } = body as { agent_id: string };
    if (!agent_id) {
      json(res, { error: "agent_id is required" }, 400);
      return;
    }

    revokeAgent(authResult.claims.org, agent_id, authResult.claims.sub);
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

// P3: heartbeat interval in ms. Default 30s — well under nginx/Cloudflare's
// typical 60s idle SSE timeout, but infrequent enough to add negligible
// bandwidth (one ":keep-alive\n\n" comment is ~16 bytes).
const SSE_HEARTBEAT_MS = (() => {
  const raw = process.env.COORDINATOR_SSE_HEARTBEAT_MS;
  if (!raw) return 30_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

// performance-02: number of events sent to a freshly-connected SSE client
// that has no Last-Event-ID (i.e. "catch me up on recent activity"). Bounded
// at the SQL layer via SseEmitter.getRecentEvents — this many rows, never more.
const SSE_RECENT_EVENTS_LIMIT = 50;

// performance-02: safety cap for Last-Event-ID resumption. A client that
// reconnects with a very old id (or a forged/corrupted one) must not be able
// to force a full-history load — cap the SQL result set so the worst case is
// a bounded, predictable read instead of an unbounded synchronous scan.
const SSE_RESUME_CAP = 1000;

async function handleSse(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Task 21.5: authenticate SSE GET requests. EventSource does not send
  // Authorization headers, so we also accept a ?token= query param on GET.
  // The ?token= fallback is handled inside authenticateRequest (GET-only,
  // Authorization header takes precedence when both are present).
  const authResult = await authenticateRequest(req, { authEnabled: AUTH_ENABLED });
  if (!authResult.ok) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    if (authResult.wwwAuthenticate) {
      headers["WWW-Authenticate"] = authResult.wwwAuthenticate;
    }
    res.writeHead(authResult.status, headers);
    res.end(JSON.stringify({ error: authResult.error }));
    services.metrics.recordHttpRequest("/api/events", authResult.status);
    return;
  }

  const orgId = authResult.claims.org;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  // Flush the 200 + headers to the socket immediately. Without this, a quiet
  // org with no recent events writes no body until the first heartbeat (up to
  // COORDINATOR_SSE_HEARTBEAT_MS, default 30s), so the browser EventSource sits
  // in "Connecting" and never fires `onopen` until then. flushHeaders() opens
  // the stream right away. (found via the dashboard e2e smoke, tests-05.)
  res.flushHeaders();
  services.metrics.incSseClients();
  services.metrics.recordHttpRequest("/api/events", 200);

  // Use Last-Event-ID for resumption, otherwise send last 50. performance-02:
  // both branches are bounded at the SQL layer (LIMIT), never a full-table
  // load followed by an in-memory slice.
  const lastEventId = parseInt((req.headers["last-event-id"] as string) || "0", 10);
  const events =
    lastEventId > 0
      ? services.sseEmitter.getEventsSince(orgId, lastEventId, SSE_RESUME_CAP)
      : services.sseEmitter.getRecentEvents(orgId, SSE_RECENT_EVENTS_LIMIT);
  for (const event of events) {
    writeSseEvent(res, event);
  }

  // Listen for new events
  const unsubscribe = services.sseEmitter.addListener(orgId, (event: CoordinatorEvent) => {
    writeSseEvent(res, event);
  });

  // P3: heartbeat. Browsers ignore the `:` comment line per the SSE spec,
  // but it counts as activity for intermediate proxies that would otherwise
  // kill an idle connection after ~60s. Wrapped in try/catch because once
  // the socket is half-closed res.write throws synchronously.
  const heartbeat = setInterval(() => {
    try {
      res.write(":keep-alive\n\n");
    } catch {
      // Connection already torn down — req.on("close") will clean up shortly.
    }
  }, SSE_HEARTBEAT_MS);
  // Don't keep the event loop alive solely for heartbeats; without unref()
  // a still-open SSE connection at process shutdown delays exit.
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  req.on("close", () => {
    // P3: clear the interval BEFORE unsubscribing so a heartbeat tick that
    // fires between close and unsubscribe can't write to a dead socket.
    clearInterval(heartbeat);
    unsubscribe();
    services.metrics.decSseClients();
  });
}

/**
 * MCP per-request auth gate (Task 23).
 *
 * Called on EVERY POST /mcp — both new-session and existing-session branches.
 * Returns claims on success, or writes 401 + returns null so the caller can
 * immediately `return` without further processing.
 *
 * When AUTH_ENABLED=false (open-coordinator mode) returns synthetic legacy
 * claims so that tool handlers (Task 23.5+) always have a claims object keyed
 * by org='default'. Does NOT stash claims on `req` — RequestHandlerExtra in
 * the MCP SDK does not expose IncomingMessage to tool handlers. Task 23.5
 * will populate a sessionClaims Map<sessionId, AuthClaims> instead.
 */
async function authenticateMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthClaims | null> {
  if (!AUTH_ENABLED) {
    // Open-coordinator mode: synthetic legacy claims.
    return { sub: "legacy", user_id: "legacy", org: "default", role: "admin", jti: "legacy" };
  }
  const authResult = await authenticateRequest(req, { authEnabled: AUTH_ENABLED });
  if (!authResult.ok) {
    jsonAuthError(res, authResult);
    return null;
  }
  return authResult.claims;
}

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  /**
   * MQTT TCP listener port. Defaults to COORDINATOR_MQTT_TCP_PORT env or 1883.
   * Pass 0 to run multiple coordinator PROCESSES side by side (e.g. parallel
   * test workers) without port collision: the OS assigns a free port as the
   * broker binds, and the internal bridge follows it. Do NOT pre-probe a free
   * port and pass the number — closing the probe socket before we re-bind
   * leaves a window for another process to take it (EADDRINUSE).
   * Does NOT enable multiple concurrent coordinators
   * within the same process — see architecture-02 note above serverRunning:
   * this module holds mono-instance-per-process state, so only one
   * startServer() may be live at a time in a given process.
   */
  mqttTcpPort?: number;
  /**
   * MQTT WebSocket path on the HTTP server. Defaults to COORDINATOR_MQTT_WS_PATH or "/mqtt".
   */
  mqttWsPath?: string;
  /**
   * If false, do NOT register process-level SIGTERM/SIGINT handlers. Default
   * true. Embedders that manage their own signals should pass false and call
   * `handle.stop()` from their own teardown. NOTE: this does not make the
   * process safe for multiple *concurrent* in-process coordinators — this
   * module is mono-instance-per-process (architecture-02). An embedder that
   * wants several coordinators must run several processes (each with its own
   * port/mqttTcpPort/dataDir), or start/stop them sequentially in-process.
   */
  registerSignalHandlers?: boolean;
}

/**
 * Returned by startServer(). Lets callers shut down all owned resources
 * (HTTP server, MQTT broker + bridge, SSE listeners, DB, quota timer) without
 * waiting for process exit. Safe to call multiple times.
 *
 * Backward-compatible: previous callers used `await startServer({...})` and
 * ignored the resolved value. They continue to work; the new return value is
 * additive.
 */
export interface ServerHandle {
  /**
   * The port actually bound — not necessarily the one passed in. Callers that
   * pass `port: 0` (the race-free way to get an ephemeral port: let the OS
   * pick it *while* binding, rather than probing for a free one and racing to
   * re-bind it) read the real port back from here.
   */
  port: number;
  httpServer: import("node:http").Server;
  stop: () => Promise<void>;
  /**
   * performance-01: the single live Sweeper instance running retention for
   * this server — either bootPhase2's own instance (Phase 2 active) or one
   * started here for Phase-1-only deployments. Exposed mainly so tests can
   * trigger a real runPass() without waiting for the 60s timer; also usable
   * by embedders that want retention observability without re-implementing
   * the Phase1-vs-Phase2 wiring decision.
   */
  sweeper: Sweeper;
  /**
   * performance-07 / protocole-mcp-07: manually trigger one idle-MCP-session
   * eviction pass without waiting for the 60s interval. Returns the number
   * of sessions evicted. Mirrors `sweeper.runPass()` above — same reasoning:
   * tests need a deterministic hook, not a real-timer race.
   */
  sweepMcpSessions: () => number;
}

/**
 * qualite-code-01: request-handler-local state that createHttpHandler
 * closes over. Everything else the handler touches (services, httpLog,
 * mcpLog, AUTH_ENABLED, and the handleXxx/json/appError/etc. helpers) is
 * module-level state already shared by handleAuth/handleSse/handleRest —
 * only these five are genuinely per-startServerInner-call locals.
 */
interface HttpHandlerCtx {
  phase2Bootstrap: Phase2Bootstrap | null;
  /**
   * The retention sweeper, so /health/ready can report whether its circuit
   * breaker is open. handleHealthReady used to be called with no options at
   * all, which made its sweeper probe answer ok:true unconditionally.
   */
  retentionSweeper: Sweeper;
  port: number;
  sessions: Map<string, NodeStreamableHTTPServerTransport>;
  sessionClaims: Map<string, AuthClaims>;
  sessionLastActivity: Map<string, number>;
}

/**
 * qualite-code-01: the HTTP request router, moved verbatim out of
 * startServerInner's `createServer(async (req, res) => {...})` call. Same
 * body, same route order, same auth gates — only the five ctx.* fields
 * above replace what used to be startServerInner locals.
 */
function createHttpHandler(
  ctx: HttpHandlerCtx,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const requestId = resolveRequestId(req.headers["x-request-id"]);
    res.setHeader("X-Request-Id", requestId);
    // #319: withRequestId was the only scope opened per request, so every
    // audit row the daemon wrote carried actor_ip, actor_user_agent,
    // actor_user_id and actor_org_id as NULL -- withAuditContext had no
    // production call site at all. A security event that cannot say who
    // caused it answers half the question it exists for.
    //
    // The network half is known here and seeded immediately. The identity
    // half is filled in by applyRouteGuards once claims resolve; requests
    // that never authenticate keep a null actor, which is accurate.
    return withRequestId(requestId, async () =>
      withAuditContext(
        { userId: null, orgId: null },
        {
          ip: req.socket?.remoteAddress ?? null,
          userAgent:
            typeof req.headers["user-agent"] === "string"
              ? (req.headers["user-agent"] as string)
              : null,
        },
        async () => {
          const url = req.url || "";

          // CORS preflight
          // protocole-mcp-02 / securite-surface-06: never reflect "*" — validate the
          // Origin header (MCP spec MUST + DNS-rebinding hardening) and echo back
          // only an allowed Origin. Non-browser callers (no Origin header at all)
          // are unaffected. Disallowed cross-site Origins get a 403, not a
          // same-response allow-all.
          if (req.method === "OPTIONS") {
            const origin = req.headers.origin;
            if (!isAllowedOrigin(origin, process.env.COORDINATOR_PUBLIC_URL)) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Origin not allowed" }));
              return;
            }
            res.writeHead(204, {
              "Access-Control-Allow-Origin": origin ?? "*",
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Authorization",
              // protocole-mcp-11: without Access-Control-Expose-Headers, a browser
              // MCP client cannot read the `mcp-session-id` response header (only
              // "CORS-safelisted" headers are exposed by default), so it can never
              // learn the session id `initialize` assigns it — session
              // establishment silently fails for browser clients. Harmless on
              // preflights for non-/mcp routes too.
              "Access-Control-Expose-Headers": "mcp-session-id",
              ...(origin ? { Vary: "Origin" } : {}),
            });
            res.end();
            return;
          }

          // T29: Phase 2 auth-route dispatch. Only active when Phase 2 was composed
          // (COORDINATOR_OAUTH_ENABLED=true). Runs BEFORE the Phase 1 route checks so
          // OAuth endpoints (/auth/login, /api/auth/oauth/*, /auth/device/*, etc.) are
          // owned by the dispatcher. Returns true if the URL was an auth route and the
          // handler ran; we then short-circuit. False means "not my URL — fall through".
          if (ctx.phase2Bootstrap) {
            try {
              const handled = await dispatchAuthRoutes(req, res, ctx.phase2Bootstrap.context);
              if (handled) return;
            } catch (err) {
              httpLog.error(
                { err, url: redactTokenParam(req.url || "") },
                "Phase 2 auth route error",
              );
              // qualite-code-08: never leak err.message (file paths, SQLite errors, ...)
              // to the client — log the detail, return a generic body + request_id.
              if (!res.headersSent) {
                json(res, appError("INTERNAL_ERROR", "Internal server error"), 500);
              }
              return;
            }
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
              // B5 fix: defend against path traversal. safeJoinUnderRoot decodes the
              // URL, strips leading slashes, resolves the path, and verifies the
              // result stays under dashboardDir. Returns null on traversal attempts.
              let filePath: string | null;
              if (url === "/dashboard" || url === "/dashboard/") {
                filePath = path.join(dashboardDir, "index.html");
              } else {
                // Strip query string before joining (browsers append ?v=...)
                const urlPath = (url.split("?")[0] || "").replace("/dashboard/", "");
                filePath = safeJoinUnderRoot(dashboardDir, urlPath);
              }
              if (filePath && existsSync(filePath)) {
                const ext = path.extname(filePath);
                const contentTypes: Record<string, string> = {
                  ".html": "text/html",
                  ".js": "application/javascript",
                  ".css": "text/css",
                  ".json": "application/json",
                };
                const content = readFileSync(filePath, "utf-8");
                // T08 (v0.10.6): admin pages get hardened headers and DROP the
                // wildcard CORS that the legacy dashboard inherits. Scope regex
                // matches admin.{html,js,css} and admin-<word>.{html,js,css}
                // (e.g. admin-orgs.html, admin-users.html) ONLY — rejects
                // admin.html.bak, notadmin.html, admin/orgs.html, admin-x-y.html.
                // index.html and any other legacy dashboard asset keep existing
                // headers untouched (Round 2 finding #1, V3 PATCH 6 + 7).
                const urlNoQuery = url.split("?")[0] || "";
                const isAdminAsset = /^\/dashboard\/admin(?:-[a-z]+)?\.(?:html|js|css)$/.test(
                  urlNoQuery,
                );
                if (isAdminAsset) {
                  res.writeHead(200, {
                    "Content-Type": contentTypes[ext] || "text/plain",
                    "Content-Security-Policy":
                      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
                    "X-Frame-Options": "DENY",
                    "X-Content-Type-Options": "nosniff",
                    "Referrer-Policy": "same-origin",
                    "Cache-Control": "no-store",
                  });
                } else {
                  // securite-surface-07 / architecture-14 follow-up: legacy
                  // dashboard assets (index.html, dashboard.js, and any other
                  // non-admin-scoped file under this path) now get the same
                  // strict script-src as the admin baseline. The former inline
                  // <script> in index.html was extracted to dashboard.js (#192)
                  // and the 5 remaining inline onclick= handlers were converted
                  // to addEventListener — nothing in this asset set relies on
                  // inline script anymore, so `script-src 'self'` is safe (it's
                  // same-origin, so dashboard.js/.css load fine). `style-src`
                  // keeps 'unsafe-inline': the ~16 inline `style="..."` attributes
                  // and the <style> block in index.html are unmigrated (separate,
                  // non-security-critical follow-up) — inline CSS isn't an XSS
                  // vector the way inline JS is, so this doesn't undercut the
                  // script-src hardening. X-Frame-Options: DENY is safe here too:
                  // nothing in this repo (or its docs) iframes the legacy
                  // dashboard, so there's no legitimate embedding to preserve.
                  // ACAO: * is left untouched — some deployments may have
                  // external clients depending on it.
                  res.writeHead(200, {
                    "Content-Type": contentTypes[ext] || "text/plain",
                    "Access-Control-Allow-Origin": "*",
                    "Content-Security-Policy":
                      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
                    "X-Content-Type-Options": "nosniff",
                    "X-Frame-Options": "DENY",
                    "Referrer-Policy": "same-origin",
                  });
                }
                res.end(content);
              } else {
                json(res, { error: "not found" }, 404);
              }
              return;
            } else if (url === "/livez") {
              handleLivez(req, res);
              services.metrics.recordHttpRequest("/livez", 200);
            } else if (url === "/readyz") {
              handleReadyz(req, res, services);
              services.metrics.recordHttpRequest("/readyz", res.statusCode || 0);
            } else if (url === "/health") {
              await handleHealth(req, res, {
                authEnabled: AUTH_ENABLED,
                jwtSecretSet: JWT_SECRET_EXPLICITLY_SET,
              });
              services.metrics.recordHttpRequest("/health", 200);
            } else if (url === "/healthz") {
              // architecture-01: alias consumed by the SDK/doctor (cli/doctor.ts
              // probe 1 — HEAD /healthz). Distinct handler from /livez: same
              // alive-only semantics but the minimal { status: "alive" } body the
              // SDK's HealthzResponse type expects, per T29's src/http/health.ts.
              handleHealthz(req, res);
              services.metrics.recordHttpRequest("/healthz", 200);
            } else if (url === "/health/ready") {
              // architecture-01: alias consumed by the SDK/doctor (cli/doctor.ts
              // probes 6/7 — audit_queue depth + sweeper circuit). NOT the same
              // handler as /readyz: /readyz reports db+mqtt+tree_sitter+git_cochange
              // (Phase 1 dependency readiness), while /health/ready reports
              // db+audit_queue+sweeper+draining (Phase 2 auth-flow readiness) —
              // the exact shape sdk/src/types.ts::HealthReadyResponse documents.
              await handleHealthReady(req, res, {
                sweeperCircuitOpen: ctx.retentionSweeper.metrics.circuitOpen,
              });
              services.metrics.recordHttpRequest("/health/ready", res.statusCode || 0);
            } else if (url === "/.well-known/oauth-authorization-server" && ctx.phase2Bootstrap) {
              // protocole-mcp-03: RFC 8414 discovery doc, gated on Phase 2 actually
              // being active. When OAuth is off there is no metadata to serve —
              // falls through to the generic 404 below rather than leaking the
              // route's existence/shape to an unauthenticated prober.
              handleDiscovery(req, res, ctx.phase2Bootstrap.context.publicUrl);
              services.metrics.recordHttpRequest("/.well-known/oauth-authorization-server", 200);
            } else if (url === "/metrics" && req.method === "GET") {
              // Unlike /api/* and /mcp, this route used to be dispatched before
              // the shared authenticateRequest gate below and carried no
              // AUTH_ENABLED check of its own — reachable without a token even
              // with auth turned on. Gate it the same way: skip entirely when
              // auth is disabled (unchanged open behavior), otherwise require a
              // valid token before serving the Prometheus text exposition.
              if (AUTH_ENABLED) {
                const authResult = await authenticateRequest(req, { authEnabled: AUTH_ENABLED });
                if (!authResult.ok) {
                  jsonAuthError(res, authResult);
                  services.metrics.recordHttpRequest("/metrics", authResult.status);
                  return;
                }
              }
              await serveMetrics(req, res, services, services.metrics);
              services.metrics.recordHttpRequest("/metrics", 200);
            } else if (url === "/metrics/auth" && req.method === "GET" && ctx.phase2Bootstrap) {
              // documentation-02 / securite-surface-02: the Phase 2 metrics
              // registry (29 metrics — src/observability/metrics.ts), gated on
              // Phase 2 actually being active (no registry to serve when it
              // isn't — falls through to the generic 404 below, matching
              // docs/ops/feature-flag-rollout.md's documented behavior). Access
              // control (loopback OR bearer) is handled entirely inside
              // handleMetrics; see src/http/metrics.ts.
              await handleMetrics(req, res, {
                localhostOnly: true,
                bearerToken: process.env.COORDINATOR_METRICS_BEARER,
              });
              services.metrics.recordHttpRequest("/metrics/auth", res.statusCode || 200);
            } else if (url === "/api/events" && req.method === "GET") {
              await handleSse(req, res);
            } else if (url.startsWith("/api/auth/")) {
              if (!AUTH_ENABLED && url !== "/api/auth/refresh") {
                json(res, { error: "Authentication is not enabled on this coordinator" }, 501);
              } else {
                await handleAuth(req, res);
              }
            } else if (url === "/mcp") {
              // protocole-mcp-02: MCP spec MUST — validate Origin on every request
              // to the Streamable HTTP transport, not just the OPTIONS preflight.
              // No-Origin requests (curl, the MCP SDK's HTTP client — never sets
              // Origin) are unaffected; only a present-and-disallowed Origin is
              // rejected.
              if (!isAllowedOrigin(req.headers.origin, process.env.COORDINATOR_PUBLIC_URL)) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Origin not allowed" }));
                return;
              }
              const sessionId = req.headers["mcp-session-id"] as string | undefined;

              // protocole-mcp-11: expose `mcp-session-id` via CORS on the actual
              // /mcp response too (not just the OPTIONS preflight) — browser MCP
              // clients need to read this header off the `initialize` response to
              // establish a session. Setting it here (before the transport writes
              // its own headers) is preserved: Node merges response.setHeader()
              // values with whatever headers.writeHead() passes later, as long as
              // that later call doesn't redeclare the same header name — the SDK
              // transport never sets Access-Control-Expose-Headers itself.
              res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

              if (sessionId && ctx.sessions.has(sessionId)) {
                // Existing-session branch — AUTH-GATED ON EVERY REQUEST per spec §J.
                const claims = await authenticateMcpRequest(req, res);
                if (!claims) return; // 401 already written
                // Task 23.5: update stored claims to support mid-session JWT rotation.
                // The latest verified claims always win.
                ctx.sessionClaims.set(sessionId, claims);
                // performance-07: any authenticated request against a known session
                // counts as activity — resets the idle clock so the sweeper leaves
                // it alone.
                ctx.sessionLastActivity.set(sessionId, Date.now());
                await ctx.sessions.get(sessionId)!.handleRequest(req, res);
              } else if (req.method === "POST" && !sessionId) {
                // New-session branch — also gated.
                const claims = await authenticateMcpRequest(req, res);
                if (!claims) return; // 401 already written
                const authenticatedAgent = claims.sub;

                // Create transport + server
                // securite-surface-06: enableDnsRebindingProtection is defense-in-depth
                // on top of the Origin check above (deprecated-but-functional SDK
                // option; the SDK's own docs point at "external middleware" for this,
                // which is exactly what the check above is). allowedOrigins only
                // needs to cover the known-safe static set since anything else was
                // already rejected before we got here.
                const allowedOriginsForTransport = [
                  `http://localhost:${ctx.port}`,
                  `http://127.0.0.1:${ctx.port}`,
                  `http://[::1]:${ctx.port}`,
                ];
                const publicUrlEnv = process.env.COORDINATOR_PUBLIC_URL;
                if (publicUrlEnv) {
                  try {
                    allowedOriginsForTransport.push(new URL(publicUrlEnv).origin);
                  } catch {
                    /* malformed COORDINATOR_PUBLIC_URL — ignore */
                  }
                }
                const transport = new NodeStreamableHTTPServerTransport({
                  sessionIdGenerator: () => randomUUID(),
                  enableDnsRebindingProtection: true,
                  allowedOrigins: allowedOriginsForTransport,
                });
                // Task 23.5: pass a getter so tool handlers can look up per-session claims.
                const mcpServer = createMcpServer(
                  services,
                  (sid) => ctx.sessionClaims.get(sid) ?? null,
                );

                // performance-07 / protocole-mcp-07: set onclose BEFORE connect() so
                // the SDK's own wrapping (Protocol#connect chains whatever onclose
                // is already present, then runs its own McpServer-side cleanup)
                // actually fires. Assigning onclose AFTER connect() — as this code
                // used to — silently clobbers the SDK's wrapped handler, so the
                // McpServer's internal state (pending handlers, abort controllers)
                // never got cleaned up on close, transport eviction or not.
                transport.onclose = () => {
                  const sid = transport.sessionId;
                  if (sid) {
                    ctx.sessions.delete(sid);
                    ctx.sessionClaims.delete(sid); // Task 23.5: evict claims on session close
                    ctx.sessionLastActivity.delete(sid);
                  }
                  mcpLog.info(
                    { session_id: sid, remaining: ctx.sessions.size },
                    "MCP session closed",
                  );
                };
                await mcpServer.connect(transport);

                await transport.handleRequest(req, res);

                const sid = transport.sessionId;
                if (sid) {
                  ctx.sessions.set(sid, transport);
                  ctx.sessionClaims.set(sid, claims); // Task 23.5: stash claims after sessionId is assigned
                  ctx.sessionLastActivity.set(sid, Date.now());
                  mcpLog.info(
                    { session_id: sid, total: ctx.sessions.size, agent_id: authenticatedAgent },
                    "MCP session opened",
                  );
                }
              } else {
                json(
                  res,
                  {
                    error:
                      "Session not found. Send a request without mcp-session-id to start a new session.",
                  },
                  404,
                );
              }
            } else {
              // Always authenticate — under AUTH_ENABLED=false this returns synthetic legacy claims
              // so handlers can always read claims.org. Required for Tasks 15-19 which scope every
              // database query by claims.org.
              const authResult = await authenticateRequest(req, { authEnabled: AUTH_ENABLED });
              if (!authResult.ok) {
                authLog.warn(
                  {
                    reason: authResult.error,
                    url: redactTokenParam(url),
                    ip: req.socket.remoteAddress,
                  },
                  "Auth rejected",
                );
                services.metrics.recordAuthRejected();
                jsonAuthError(res, authResult);
                return;
              }

              if (url.startsWith("/api/") && (req.method === "POST" || req.method === "GET")) {
                await handleRest(req, res, authResult.claims);
                // performance-03: normalize id-like segments so cardinality is bounded
                // by route TEMPLATES, not by distinct ids ever seen. See src/http/utils.ts.
                services.metrics.recordHttpRequest(
                  metricRoute(url.split("?")[0] || ""),
                  res.statusCode || 0,
                );
              } else {
                json(res, { error: "not found" }, 404);
                // performance-03: a 404 is, by definition, an unmatched path — never
                // give it a dynamic label (unbounded cardinality from prober/scanner
                // traffic). Use a single constant label instead.
                services.metrics.recordHttpRequest("<unmatched>", 404);
              }
            }
          } catch (err) {
            httpLog.error({ err }, "HTTP request error");
            // qualite-code-08: never leak err.message (file paths, SQLite errors, ...)
            // to the client — log the detail, return a generic body + request_id.
            if (!res.headersSent) {
              json(res, appError("INTERNAL_ERROR", "Internal server error"), 500);
            }
          }
        },
      ),
    );
  };
}

/**
 * qualite-code-01: embedded MQTT broker + internal bridge wiring, moved
 * verbatim out of startServerInner. Depends only on per-call locals
 * (mqttTcpPort, mqttWsPath, httpServer, log) plus the module-level
 * AUTH_ENABLED/services/createToken it already closed over. Returns the
 * broker handle so startServerInner (and wireShutdown's stop()) can
 * close it on teardown.
 */
interface MqttWiring {
  mqttTcpPort: number;
  mqttWsPath: string;
  httpServer: import("node:http").Server;
  log: Logger;
  /** Phase 5 multi-instance: when set, agent-departure processing is
   *  deduplicated across replicas via a short Redis lock. Absent = every
   *  event is processed locally, unchanged (single-instance behavior). */
  redis?: RedisHandles;
}

async function wireMqtt(opts: MqttWiring): Promise<{
  broker: Awaited<ReturnType<typeof startEmbeddedMqttBroker>> | undefined;
  resolvedMqttTcpPort: number;
}> {
  const { mqttTcpPort, mqttWsPath, httpServer, log, redis } = opts;
  // External-broker support: when COORDINATOR_MQTT_EMBEDDED=false, skip
  // starting the embedded Aedes broker and connect the internal bridge to
  // the externally configured URL instead. Default (unset) keeps the
  // embedded broker — upstream behavior unchanged.
  // Start the embedded MQTT broker (TCP + WebSocket on HTTP upgrade).
  // Awaiting ensures the TCP listener is fully bound before we connect our
  // own client or tell users the coordinator is ready.
  // B3 fix: when AUTH_ENABLED, gate every MQTT CONNECT by JWT in the password
  // field. Anonymous connections are rejected. Default off (essaim and any
  // client without auth keep working unchanged).
  // Only install the verifier (and therefore the ACL hooks) when auth is enabled.
  // Without this guard, AUTH_ENABLED=false would still reject anonymous v0.6
  // MQTT clients at the authenticate hook, breaking backward compatibility.
  // #280: an occupied 1883 -- a previous daemon still alive, or any other
  // broker on the box -- used to take the entire HTTP server down with it.
  // wireMqtt was unguarded and mqtt-broker.ts rejects on the listener's error
  // event, so the rejection reached startServer and killed the boot.
  //
  // Everything else in the tree already treats the broker as optional: the
  // three MQTT tools return an explicit isError when the bridge is absent,
  // every publisher in mqtt-bridge.ts opens with an `if (!this.client ...)`
  // guard, stdio mode runs all 26 tools with no broker at all, and the
  // dashboard reads /api/events over SSE rather than MQTT. Startup was the
  // only place treating it as mandatory.
  //
  // Set COORDINATOR_MQTT_REQUIRED=true to keep the strict behaviour.
  const mqttRequired = process.env.COORDINATOR_MQTT_REQUIRED === "true";
  let broker: Awaited<ReturnType<typeof startEmbeddedMqttBroker>> | undefined;
  try {
    broker = MQTT_EMBEDDED
      ? await startEmbeddedMqttBroker({
          tcpPort: mqttTcpPort,
          httpServer,
          wsPath: mqttWsPath,
          logger: log.child({ component: "mqtt-broker" }),
          ...(AUTH_ENABLED
            ? {
                authenticate: async (
                  _username: string | undefined,
                  password: Buffer | undefined,
                ): Promise<MqttAuthResult> => {
                  if (!password) return { ok: false };
                  try {
                    const { verifyTokenStrict } = await import("./auth.js");
                    const { claims } = await verifyTokenStrict(password.toString("utf-8"));
                    // Thread the role through so mqtt-broker.ts's ACL hooks can
                    // recognize and exempt the internal bridge (role "internal",
                    // minted below) from the org-prefix check.
                    return { ok: true as const, org: claims.org, role: claims.role };
                  } catch {
                    return { ok: false };
                  }
                },
              }
            : {}),
        })
      : undefined;
  } catch (err) {
    if (mqttRequired) throw err;
    log.warn(
      { err, tcpPort: mqttTcpPort },
      "MQTT broker failed to start - continuing without MQTT. The 3 MQTT tools will report unavailable; everything else is unaffected. Set COORDINATOR_MQTT_REQUIRED=true to fail startup instead.",
    );
    return { broker: undefined, resolvedMqttTcpPort: mqttTcpPort };
  }

  // B3: when AUTH_ENABLED, the internal coordinator client must authenticate
  // too. Mint a short-lived internal-role token for the bridge: "internal"
  // (not "admin") is the role mqtt-broker.ts's ACL hooks exempt from the
  // org-prefix check, so the bridge can route every org's traffic without a
  // real org-admin's token also implicitly gaining that bypass.
  const internalToken = AUTH_ENABLED
    ? await createToken("coordinator-internal", "internal", "1h")
    : undefined;
  // The broker reports the port it actually bound; `mqttTcpPort` may be the
  // 0 sentinel meaning "OS, pick one". Connecting the bridge to `:0` would
  // send mqtt.js to its 1883 default and fail with ECONNREFUSED.
  const resolvedMqttTcpPort = broker?.tcpPort ?? mqttTcpPort;
  try {
    await services.mqttBridge.connect({
      url: MQTT_URL || `mqtt://127.0.0.1:${resolvedMqttTcpPort}`,
      username: AUTH_ENABLED ? "coordinator-internal" : MQTT_USERNAME,
      password: AUTH_ENABLED ? internalToken : MQTT_PASSWORD,
      // P1 fix: stable agent identity for LWT topic
      // (`coordinator/agents/coordinator-internal/status`).
      agentId: "coordinator-internal",
    });
  } catch (err) {
    if (mqttRequired) throw err;
    // The broker may have bound before the bridge failed to reach it; close
    // it rather than leaving a listener nothing will ever shut down -- the
    // teardown path only closes the handle we return.
    try {
      await broker?.close();
    } catch {
      // best effort: we are already degrading
    }
    log.warn(
      { err },
      "MQTT bridge failed to connect - continuing without MQTT. Set COORDINATOR_MQTT_REQUIRED=true to fail startup instead.",
    );
    return { broker: undefined, resolvedMqttTcpPort };
  }
  // issue #236: surface discarded messages as a counter alongside the warn
  // line the bridge already emits, so a steady drip of drops is visible on
  // /metrics rather than only in the log.
  services.mqttBridge.onDrop((reason) => {
    services.metrics.mqttMessagesDropped.inc({ reason });
  });
  services.mqttBridge.onOffline((orgId, agentId) => {
    // Task 22: the org is recovered from the MQTT topic prefix
    // (`coordinator/<org>/agents/<id>/status`) and threaded through here, so
    // the registry mutation and SSE emit target the agent's real tenant
    // instead of a hard-coded "default". Presence is now published under the
    // real org too (agents-tools registerAgent), so this topic carries the
    // correct org.
    const processDeparture = () => {
      services.registry.setOffline(orgId, agentId);
      services.consultation.handleAgentDeparture(orgId, agentId);
      // Clear in-flight working_files AFTER consultation cleanup so any future
      // consultation logic that might inspect working_files state for this agent
      // sees the pre-cleanup view.
      services.workingFiles.clearForAgent(orgId, agentId);
      services.sseEmitter.emit("agent_offline", { agent_id: agentId }, { org_id: orgId });
    };
    if (!redis) {
      processDeparture();
      return;
    }
    // Phase 5: every instance subscribes to the same broker topics, so an
    // offline event fires on ALL replicas. A short NX lock elects exactly one
    // processor — the DB mutations are idempotent, but double-processing
    // would duplicate SSE/resolution side effects. On Redis error, process
    // anyway (idempotence makes duplicates benign; a lost departure is not).
    void acquireLock(redis.client, `coordinator:offline:${orgId}:${agentId}`, 10, INSTANCE_ID)
      .then((won) => {
        if (won) processDeparture();
      })
      .catch(() => processDeparture());
  });
  return { broker, resolvedMqttTcpPort };
}

/**
 * qualite-code-01: builds stop() (drain sweeper/rate-limiter → HTTP →
 * MQTT bridge → MQTT broker → timers → DB) and, unless the caller opted
 * out, registers the SIGTERM/SIGINT handlers — moved verbatim out of
 * startServerInner. Same teardown order, same idempotent `stopped` guard,
 * same serverRunning reset.
 */
interface ShutdownDeps {
  phase2Bootstrap: Phase2Bootstrap | null;
  retentionSweeper: Sweeper;
  registerRateLimiter: IRateLimiter;
  httpServer: import("node:http").Server;
  /** External-broker support: undefined when COORDINATOR_MQTT_EMBEDDED=false
   *  (nothing to close — the bridge disconnect above already tears down our
   *  client connection to the externally managed broker). */
  broker: Awaited<ReturnType<typeof startEmbeddedMqttBroker>> | undefined;
  mcpSessionSweepHandle: NodeJS.Timeout;
  log: Logger;
  registerSignalHandlers: boolean;
  /** Phase 5 multi-instance: closed during teardown when present. */
  redis?: RedisHandles;
}

function wireShutdown(deps: ShutdownDeps): () => Promise<void> {
  const {
    phase2Bootstrap,
    retentionSweeper,
    registerRateLimiter,
    httpServer,
    broker,
    mcpSessionSweepHandle,
    log,
    redis,
  } = deps;
  // B6 fix: graceful shutdown.
  // Cleanup sequence: stop accepting new HTTP connections → end MQTT bridge →
  // close MQTT broker → stop quota background timer → close DB.
  // Idempotent: stopped flag prevents double-cleanup if SIGTERM races with
  // an explicit handle.stop() call.
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // architecture-02: release the mono-instance guard so a subsequent
    // sequential startServer() (this process's supported restart pattern)
    // is allowed. Must happen even if cleanup below throws — do it up front.
    serverRunning = false;
    log.info("Coordinator shutting down...");
    // T29: Phase 2 shutdown — stop sweeper + drain audit queue BEFORE closing
    // the HTTP server, so any final Tier 2 audit emissions from in-flight
    // requests land before the DB closes. shutdown() is idempotent.
    if (phase2Bootstrap) {
      try {
        await phase2Bootstrap.shutdown();
      } catch (err) {
        log.warn({ err }, "Error during Phase 2 shutdown");
      }
    } else {
      // performance-01: we own this Sweeper's lifecycle (Phase-1-only —
      // bootPhase2 didn't run, so nothing else stops/drains it).
      try {
        retentionSweeper.stop();
        await retentionSweeper.drain(5000);
      } catch (err) {
        log.warn({ err }, "Error stopping retention sweeper");
      }
      // securite-surface-05: same reasoning — we only own the register
      // RateLimiter's sweeper when Phase 2 didn't already start one. Only
      // the in-memory RateLimiter has a sweeper to stop (Phase 5: the
      // Redis-backed limiter relies on native key TTLs).
      try {
        if (registerRateLimiter instanceof RateLimiter) {
          registerRateLimiter.stopSweeper();
        }
      } catch (err) {
        log.warn({ err }, "Error stopping register rate-limit sweeper");
      }
    }
    try {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    } catch (err) {
      log.warn({ err }, "Error closing HTTP server");
    }
    try {
      await services.mqttBridge.disconnect();
    } catch (err) {
      log.warn({ err }, "Error disconnecting MQTT bridge");
    }
    try {
      if (broker) await broker.close();
    } catch (err) {
      log.warn({ err }, "Error closing MQTT broker");
    }
    try {
      services.quotaCache.stopBackgroundTick();
    } catch (err) {
      log.warn({ err }, "Error stopping quota timer");
    }
    try {
      setTokenEpochBus(null);
      await redis?.close();
    } catch (err) {
      log.warn({ err }, "Error closing Redis");
    }
    try {
      services.consultation.stopTimeoutSweeper();
    } catch (err) {
      log.warn({ err }, "Error stopping timeout sweeper");
    }
    try {
      services.workingFiles.stopSweeper();
    } catch (err) {
      log.warn({ err }, "Error stopping working-files sweeper");
    }
    try {
      clearInterval(mcpSessionSweepHandle);
    } catch (err) {
      log.warn({ err }, "Error stopping MCP session idle sweeper");
    }
    try {
      const { closeDb } = await import("./database.js");
      closeDb?.();
    } catch (err) {
      log.warn({ err }, "Error closing database");
    }
    log.info("Coordinator shutdown complete");
  };

  // Register signal handlers (default true). Embedders can opt out via
  // registerSignalHandlers: false to manage their own teardown.
  if (deps.registerSignalHandlers) {
    const onSignal = (signal: NodeJS.Signals) => {
      log.info({ signal }, "Received shutdown signal");
      stop()
        .then(() => process.exit(0))
        .catch((err) => {
          log.error({ err }, "Shutdown error, forcing exit");
          process.exit(1);
        });
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }

  return stop;
}

/**
 * architecture-02: fail-closed guard for the mono-instance-per-process model
 * described above serverRunning. Rejects a 2nd concurrent startServer() call
 * outright rather than silently corrupting the 1st instance's module-level
 * state (services/httpLog). Sequential use — stop() then
 * startServer() again — is unaffected: stop() resets serverRunning to false,
 * and a failed startup (thrown/rejected before returning a handle) resets it
 * too, so a caller can retry after an error without restarting the process.
 */
export async function startServer(opts?: ServerOptions): Promise<ServerHandle> {
  if (serverRunning) {
    throw new Error(
      "startServer(): a coordinator is already running in this process; call handle.stop() before starting another. Multiple concurrent in-process coordinators are not supported.",
    );
  }
  serverRunning = true;
  try {
    return await startServerInner(opts);
  } catch (err) {
    serverRunning = false;
    throw err;
  }
}

async function startServerInner(opts?: ServerOptions): Promise<ServerHandle> {
  const port = opts?.port ?? PORT;
  const dataDir = opts?.dataDir ?? DATA_DIR;
  // Resolve MQTT ports per-call so tests/embedders can override module-load env values.
  const mqttTcpPort = opts?.mqttTcpPort ?? MQTT_TCP_PORT;
  const mqttWsPath = opts?.mqttWsPath ?? MQTT_WS_PATH;

  // Phase 5: connect Redis BEFORE the services boot — the DB migrations in
  // createServices/initDatabase must run under a cross-instance lock (the
  // "PRAGMA user_version write race" is the most dangerous multi-instance
  // hazard per single-instance-constraints.md). Loud failure on a bad URL.
  let redis: RedisHandles | undefined;
  if (REDIS_URL) {
    redis = await connectRedis(REDIS_URL);
  }
  if (redis) {
    services = await withLock(
      redis.client,
      "coordinator:boot:migration",
      120,
      INSTANCE_ID,
      () => createServices({ dataDir }),
      { retryMs: 500, maxWaitMs: 120_000 },
    );
  } else {
    services = createServices({ dataDir });
  }
  const log = services.logger;
  httpLog = log.child({ component: "http" });
  mcpLog = log.child({ component: "mcp" });
  authLog = log.child({ component: "auth" });
  setAuthLogger(authLog);

  // architecture-06: COORDINATOR_DATA_DIR unset AND no explicit dataDir
  // override means we just fell back to "./data" resolved against
  // process.cwd() — unpredictable for a server a client spawns from an
  // arbitrary working directory (and NOT the `~/.mcp-coordinator/data` the
  // CLI uses). Warn once at boot so operators notice before they lose data
  // to a cwd change, rather than silently. Only fires on the true fallback
  // path — an explicit opts.dataDir (tests, embedders) is not this case.
  if (!opts?.dataDir && !process.env.COORDINATOR_DATA_DIR) {
    httpLog.warn(
      { resolvedDataDir: path.resolve(dataDir) },
      `COORDINATOR_DATA_DIR not set — using cwd-relative ./data (${path.resolve(dataDir)}); set COORDINATOR_DATA_DIR or use the CLI for a stable location.`,
    );
  }

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
    initAuth(JWT_SECRET, JWT_EXPIRY, JWT_PREV_SECRET ? { prevSecret: JWT_PREV_SECRET } : {});
    log.info("Auth enabled (JWT HS256)");
  }

  // T29: Phase 2 init. Gated on COORDINATOR_OAUTH_ENABLED=true. When unset
  // or "false" (Phase 1 deployments), bootPhase2 returns null and none of
  // the Phase 2 wiring activates — request handler bypasses dispatchAuthRoutes,
  // SIGTERM skips the Phase 2 shutdown branch. Throws BootValidationError on
  // misconfiguration; we let it propagate so startup fails loudly rather than
  // silently degrading to Phase 1.
  const phase2Bootstrap: Phase2Bootstrap | null = bootPhase2({
    enabled: process.env.COORDINATOR_OAUTH_ENABLED === "true",
    db: getDb() as unknown as DatabaseT.Database,
    ...(redis ? { redis } : {}),
  });
  if (phase2Bootstrap) {
    log.info("Phase 2 OAuth enabled (dispatchAuthRoutes wired, sweeper running)");
  }

  // performance-01: retention Sweeper. bootPhase2 already starts (and owns
  // the teardown of) a Sweeper when Phase 2 is active — reuse that SAME
  // instance rather than creating a second one (would double-run every
  // DELETE pass). When Phase 2 is NOT active (Phase-1-only, the default
  // mono-tenant deployment), bootPhase2 returns null and nothing sweeps
  // retention today, so start our own instance here and own its teardown.
  const retentionSweeper: Sweeper =
    phase2Bootstrap?.sweeper ?? new Sweeper(getDb() as unknown as DatabaseT.Database, realClock);
  if (!phase2Bootstrap) {
    retentionSweeper.start();
  }

  // securite-surface-05: reuse bootPhase2's RateLimiter (Phase 2 active —
  // its sweeper is already running, "register:" keys share the bucket map
  // harmlessly with "lockout:" keys via namespacing) or own a dedicated
  // instance + sweeper lifecycle for Phase-1-only deployments, same
  // reuse-or-own shape as retentionSweeper above.
  registerRateLimiter = phase2Bootstrap?.context.rateLimiter ?? new RateLimiter(realClock);
  if (!phase2Bootstrap && registerRateLimiter instanceof RateLimiter) {
    registerRateLimiter.startSweeper();
  }

  // Phase 5: token-epoch bump pub/sub — collapses the cross-instance WAL
  // visibility window to pub/sub latency. The publisher also receives its own
  // messages; noteEpochBump is a monotonic max, so that is harmless.
  if (redis) {
    const EPOCH_CHANNEL = "coordinator:token-epoch";
    setTokenEpochBus({
      publish: (userId, epoch) => {
        void redis!.client
          .publish(EPOCH_CHANNEL, JSON.stringify({ u: userId, e: epoch }))
          .catch((err) => log.warn({ err }, "token-epoch publish failed"));
      },
    });
    await redis.subscriber.subscribe(EPOCH_CHANNEL, (message) => {
      try {
        const { u, e } = JSON.parse(message) as { u: string; e: number };
        noteEpochBump(u, e);
      } catch {
        /* malformed — ignore */
      }
    });
    log.info(
      { url: redis.url, instance: INSTANCE_ID },
      "Multi-instance mode: Redis connected (locks, rate-limit, epoch pub/sub)",
    );
  }

  // Multi-session: one transport+server per MCP client session
  const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
  // Task 23.5: per-session claims map. Populated when a session is opened or
  // re-verified (mid-session JWT rotation); evicted when the transport closes.
  const sessionClaims = new Map<string, AuthClaims>();
  // performance-07 / protocole-mcp-07: last-activity timestamp (ms epoch) per
  // session. Updated on every request carrying a known mcp-session-id (and
  // when a session is first opened). Today `sessions`/`sessionClaims` are
  // ONLY evicted via transport.onclose, which assumes a clean DELETE/close
  // from the client — a client that vanishes (crash, network drop) leaks its
  // transport + McpServer + claims forever. The idle sweeper below closes
  // (not just deletes) sessions that go quiet longer than the TTL.
  const sessionLastActivity = new Map<string, number>();
  const MCP_SESSION_TTL_MS = parseInt(
    process.env.COORDINATOR_MCP_SESSION_TTL_MS || String(30 * 60 * 1000),
    10,
  );
  const MCP_SESSION_SWEEP_INTERVAL_MS = 60_000;

  /**
   * Evict sessions idle longer than MCP_SESSION_TTL_MS. Closes the transport
   * (transport.close() -> fires onclose -> evicts sessions/sessionClaims/
   * sessionLastActivity together) rather than just deleting map entries, so
   * the underlying SSE stream / socket resources are actually released, not
   * merely forgotten. Idempotent: re-running before onclose has fired for a
   * prior call is harmless (close() on an already-closing transport is a
   * no-op on the SDK side); entries with no matching transport are pruned
   * defensively. Returns the number of sessions evicted this pass.
   */
  function sweepIdleMcpSessions(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [sid, lastActivity] of sessionLastActivity.entries()) {
      if (now - lastActivity <= MCP_SESSION_TTL_MS) continue;
      const transport = sessions.get(sid);
      if (transport) {
        evicted++;
        transport.close().catch((err) => {
          mcpLog.warn({ err, session_id: sid }, "Error closing idle MCP session");
        });
      } else {
        // Defensive: shouldn't happen (kept in sync with `sessions`), but
        // don't let a stale activity entry linger either way.
        sessionLastActivity.delete(sid);
      }
    }
    return evicted;
  }

  const mcpSessionSweepHandle = setInterval(() => {
    sweepIdleMcpSessions();
  }, MCP_SESSION_SWEEP_INTERVAL_MS);
  if (typeof mcpSessionSweepHandle.unref === "function") mcpSessionSweepHandle.unref();

  const handlerCtx: HttpHandlerCtx = {
    phase2Bootstrap,
    retentionSweeper,
    port,
    sessions,
    sessionClaims,
    sessionLastActivity,
  };
  const httpServer = createServer(createHttpHandler(handlerCtx));

  const { broker, resolvedMqttTcpPort } = await wireMqtt({
    mqttTcpPort,
    mqttWsPath,
    httpServer,
    log,
    redis,
  });

  // Wait for the HTTP server to be actually listening before resolving the
  // returned handle. Otherwise callers (tests, essaim) may try to connect
  // before the port is bound.
  const bindHost = process.env.COORDINATOR_BIND?.trim() || "127.0.0.1";
  const boundPort = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, bindHost, () => {
      httpServer.off("error", onError);
      // `port: 0` asks the OS for an ephemeral port, so the number we were
      // called with is a sentinel, not the port we ended up on. Read the real
      // one back and use it everywhere downstream: the returned handle, the
      // startup banner, and — importantly — the handler ctx, whose
      // DNS-rebinding allowlist would otherwise be built from `:0` and match
      // no real Origin.
      const addr = httpServer.address();
      const actualPort = addr !== null && typeof addr !== "string" ? addr.port : port;
      handlerCtx.port = actualPort;
      log.info(
        {
          port: actualPort,
          host: bindHost,
          mcp: `POST http://localhost:${actualPort}/mcp`,
          rest: `POST http://localhost:${actualPort}/api/*`,
          sse: `GET http://localhost:${actualPort}/api/events`,
          mqtt_tcp: MQTT_URL || `mqtt://127.0.0.1:${resolvedMqttTcpPort}`,
          mqtt_ws: MQTT_EMBEDDED
            ? `ws://localhost:${actualPort}${mqttWsPath}`
            : "(embedded broker disabled)",
        },
        "Coordinator v3 started",
      );
      resolve(actualPort);
    });
  });

  // B2 fix: start the consultation timeout sweeper.
  // Reads no longer mutate state — this background tick handles timeouts.
  services.consultation.startTimeoutSweeper();

  const stop = wireShutdown({
    phase2Bootstrap,
    retentionSweeper,
    registerRateLimiter,
    httpServer,
    broker,
    mcpSessionSweepHandle,
    log,
    redis,
    registerSignalHandlers: opts?.registerSignalHandlers !== false,
  });

  return {
    port: boundPort,
    httpServer,
    stop,
    sweeper: retentionSweeper,
    sweepMcpSessions: sweepIdleMcpSessions,
  };
}

// Auto-start when run directly (not imported)
const isMainModule =
  process.argv[1]?.endsWith("serve-http.ts") || process.argv[1]?.endsWith("serve-http.js");
if (isMainModule) {
  startServer().catch((err) => {
    const log = createLogger();
    log.fatal({ err }, "Fatal startup error");
    process.exit(1);
  });
}
