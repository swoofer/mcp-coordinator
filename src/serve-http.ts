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
import { initAuth, authenticateRequest, createToken, refreshToken, revokeAgent, setAuthLogger, verifyToken, type AuthResult } from "./auth.js";
import { canResetDb } from "./reset-guard.js";
import { safeJoinUnderRoot } from "./path-guard.js";
import { handleRest as handleRestExt, type RestContext } from "./http/handle-rest.js";
import { handleLivez, handleReadyz, handleHealth } from "./http/handle-health.js";
import { serveMetrics } from "./metrics.js";
import { parseBody as parseBodyShared, json as jsonShared } from "./http/utils.js";
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

// S1: parseBody and json moved to ./http/utils.js (shared with handle-rest.ts).
// Re-bound to local names so the rest of this file (handleAuth, handleSse,
// startServer) can keep using `parseBody` / `json` without changes.
const parseBody = parseBodyShared;
const json = jsonShared;

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


// S1: handleRest extracted to ./http/handle-rest.ts. Thin wrapper here keeps
// startServer's call site stable while the 382-line REST router lives in its
// own module. currentRunConfig stays here as the single mutable owner; the
// extracted function reads/writes via getRunConfig/setRunConfig accessors.
async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx: RestContext = {
    services,
    httpLog,
    authEnabled: AUTH_ENABLED,
    getRunConfig: () => currentRunConfig,
    setRunConfig: (cfg) => { currentRunConfig = cfg; },
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

// P3: heartbeat interval in ms. Default 30s — well under nginx/Cloudflare's
// typical 60s idle SSE timeout, but infrequent enough to add negligible
// bandwidth (one ":keep-alive\n\n" comment is ~16 bytes).
const SSE_HEARTBEAT_MS = (() => {
  const raw = process.env.COORDINATOR_SSE_HEARTBEAT_MS;
  if (!raw) return 30_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

function handleSse(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  services.metrics.incSseClients();
  services.metrics.recordHttpRequest("/api/events", 200);

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

export interface ServerOptions {
  port?: number;
  dataDir?: string;
  /**
   * MQTT TCP listener port. Defaults to COORDINATOR_MQTT_TCP_PORT env or 1883.
   * Pass an OS-ephemeral free port (see net.createServer().listen(0)) to run
   * multiple coordinators in the same process without collision.
   */
  mqttTcpPort?: number;
  /**
   * MQTT WebSocket path on the HTTP server. Defaults to COORDINATOR_MQTT_WS_PATH or "/mqtt".
   */
  mqttWsPath?: string;
  /**
   * If false, do NOT register process-level SIGTERM/SIGINT handlers. Default
   * true. Embedders that manage their own signals (essaim's orchestrator runs
   * many in-process coordinators per session) should pass false and call
   * `handle.stop()` from their own teardown.
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
  port: number;
  stop: () => Promise<void>;
}

export async function startServer(opts?: ServerOptions): Promise<ServerHandle> {
  const port = opts?.port ?? PORT;
  const dataDir = opts?.dataDir ?? DATA_DIR;
  // Resolve MQTT ports per-call so tests/embedders can override module-load env values.
  const mqttTcpPort = opts?.mqttTcpPort ?? MQTT_TCP_PORT;
  const mqttWsPath = opts?.mqttWsPath ?? MQTT_WS_PATH;

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
          res.writeHead(200, {
            "Content-Type": contentTypes[ext] || "text/plain",
            "Access-Control-Allow-Origin": "*",
          });
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
        handleHealth(req, res);
        services.metrics.recordHttpRequest("/health", 200);
      } else if (url === "/metrics" && req.method === "GET") {
        await serveMetrics(req, res, services, services.metrics);
        services.metrics.recordHttpRequest("/metrics", 200);
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
            services.metrics.recordAuthRejected();
            json(res, { error: authResult.error }, authResult.status);
            return;
          }
        }

        if (url.startsWith("/api/") && (req.method === "POST" || req.method === "GET")) {
          await handleRest(req, res);
          services.metrics.recordHttpRequest((url.split("?")[0] || ""), res.statusCode || 0);
        } else {
          json(res, { error: "not found" }, 404);
          services.metrics.recordHttpRequest((url.split("?")[0] || ""), 404);
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
  // B3 fix: when AUTH_ENABLED, gate every MQTT CONNECT by JWT in the password
  // field. Anonymous connections are rejected. Default off (essaim and any
  // client without auth keep working unchanged).
  const mqttAuth = AUTH_ENABLED
    ? async (_username: string | undefined, password: Buffer | undefined): Promise<boolean> => {
        if (!password) return false;
        try {
          await verifyToken(password.toString("utf-8"));
          return true;
        } catch {
          return false;
        }
      }
    : undefined;

  const broker = await startEmbeddedMqttBroker({
    tcpPort: mqttTcpPort,
    httpServer,
    wsPath: mqttWsPath,
    logger: log.child({ component: "mqtt-broker" }),
    authenticate: mqttAuth,
  });

  // B3: when AUTH_ENABLED, the internal coordinator client must authenticate
  // too. Mint a short-lived admin token for the bridge.
  const internalToken = AUTH_ENABLED ? await createToken("coordinator-internal", "admin", "1h") : undefined;
  await services.mqttBridge.connect({
    url: `mqtt://127.0.0.1:${mqttTcpPort}`,
    username: AUTH_ENABLED ? "coordinator-internal" : undefined,
    password: internalToken,
    // P1 fix: stable agent identity for LWT topic
    // (`coordinator/agents/coordinator-internal/status`).
    agentId: "coordinator-internal",
  });
  services.mqttBridge.onOffline((agentId) => {
    services.registry.setOffline(agentId);
    services.consultation.handleAgentDeparture(agentId);
    // Clear in-flight working_files AFTER consultation cleanup so any future
    // consultation logic that might inspect working_files state for this agent
    // sees the pre-cleanup view.
    services.workingFiles.clearForAgent(agentId);
    services.sseEmitter.emit("agent_offline", { agent_id: agentId });
  });

  // Wait for the HTTP server to be actually listening before resolving the
  // returned handle. Otherwise callers (tests, essaim) may try to connect
  // before the port is bound.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, () => {
      httpServer.off("error", onError);
      log.info({
        port,
        mcp: `POST http://localhost:${port}/mcp`,
        rest: `POST http://localhost:${port}/api/*`,
        sse: `GET http://localhost:${port}/api/events`,
        mqtt_tcp: `mqtt://127.0.0.1:${mqttTcpPort}`,
        mqtt_ws: `ws://localhost:${port}${mqttWsPath}`,
      }, "Coordinator v3 started");
      resolve();
    });
  });

  // B2 fix: start the consultation timeout sweeper.
  // Reads no longer mutate state — this background tick handles timeouts.
  services.consultation.startTimeoutSweeper();

  // B6 fix: graceful shutdown.
  // Cleanup sequence: stop accepting new HTTP connections → end MQTT bridge →
  // close MQTT broker → stop quota background timer → close DB.
  // Idempotent: stopped flag prevents double-cleanup if SIGTERM races with
  // an explicit handle.stop() call.
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    log.info("Coordinator shutting down...");
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
      await broker.close();
    } catch (err) {
      log.warn({ err }, "Error closing MQTT broker");
    }
    try {
      services.quotaCache.stopBackgroundTick();
    } catch (err) {
      log.warn({ err }, "Error stopping quota timer");
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
      const { closeDb } = await import("./database.js");
      closeDb?.();
    } catch (err) {
      log.warn({ err }, "Error closing database");
    }
    log.info("Coordinator shutdown complete");
  };

  // Register signal handlers (default true). Embedders can opt out via
  // registerSignalHandlers: false to manage their own teardown.
  if (opts?.registerSignalHandlers !== false) {
    const onSignal = (signal: NodeJS.Signals) => {
      log.info({ signal }, "Received shutdown signal");
      stop().then(() => process.exit(0)).catch((err) => {
        log.error({ err }, "Shutdown error, forcing exit");
        process.exit(1);
      });
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  }

  return { port, stop };
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

