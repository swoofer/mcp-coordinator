import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../auth/context.js";
import { handleAuthLogin } from "../auth/oauth-login.js";
import { handleOAuthCallback } from "../auth/oauth-callback.js";
import { handleOAuthToken } from "../auth/oauth-token.js";
import { handleDeviceAuthorization, handleDeviceApprove } from "../auth/device-flow.js";
import { handleLogout, handleLogoutAll, handleRevoke } from "../auth/logout.js";
import { handleUserinfo } from "../auth/userinfo.js";

/**
 * Phase 2 auth-route dispatcher. Returns true if the URL matched an
 * auth route (and the handler was invoked); false if the caller should
 * fall through to handleRest (Phase 1 routes).
 *
 * Route table (Phase 2):
 *   GET  /auth/login                              → handleAuthLogin (T15)
 *   GET  /api/auth/oauth/callback                 → handleOAuthCallback (T16)
 *   POST /api/auth/oauth/token                    → handleOAuthToken (T18)
 *   POST /api/auth/oauth/device_authorization     → handleDeviceAuthorization (T17)
 *   POST /auth/device/approve                     → handleDeviceApprove (T20)
 *   POST /api/auth/logout                         → handleLogout (T23)
 *   POST /api/auth/logout-all                     → handleLogoutAll (T23)
 *   POST /api/auth/revoke                         → handleRevoke (T23)
 *   GET  /api/auth/me                             → handleUserinfo (T24)
 *
 * Device + success HTML pages (T21) and discovery doc (T14) are wired
 * separately by serve-http.ts at boot — they don't flow through this
 * dispatcher.
 */
export async function dispatchAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  // Strict method matching — wrong method on a known auth path returns 405.
  if (url === "/auth/login" && method === "GET") {
    await handleAuthLogin(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/oauth/callback" && method === "GET") {
    await handleOAuthCallback(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/oauth/token" && method === "POST") {
    await handleOAuthToken(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/oauth/device_authorization" && method === "POST") {
    await handleDeviceAuthorization(req, res, ctx);
    return true;
  }
  if (url === "/auth/device/approve" && method === "POST") {
    await handleDeviceApprove(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/logout" && method === "POST") {
    await handleLogout(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/logout-all" && method === "POST") {
    await handleLogoutAll(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/revoke" && method === "POST") {
    await handleRevoke(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/me" && method === "GET") {
    await handleUserinfo(req, res, ctx);
    return true;
  }

  // Known auth path but wrong method → 405. Match the URL ignoring method.
  if (KNOWN_AUTH_PATHS.has(url)) {
    res.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
      Allow: methodForPath(url),
    });
    res.end(
      JSON.stringify({ code: "METHOD_NOT_ALLOWED", message: `${method} not allowed on ${url}` }),
    );
    return true;
  }

  return false;
}

const KNOWN_AUTH_PATHS = new Set([
  "/auth/login",
  "/api/auth/oauth/callback",
  "/api/auth/oauth/token",
  "/api/auth/oauth/device_authorization",
  "/auth/device/approve",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/revoke",
  "/api/auth/me",
]);

function methodForPath(url: string): string {
  if (url === "/auth/login" || url === "/api/auth/oauth/callback" || url === "/api/auth/me") {
    return "GET";
  }
  return "POST";
}
