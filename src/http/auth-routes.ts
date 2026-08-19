import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../auth/context.js";
import { handleAuthLogin } from "../auth/oauth-login.js";
import { handleOAuthCallback } from "../auth/oauth-callback.js";
import { handleOAuthToken } from "../auth/oauth-token.js";
import { handleDeviceAuthorization, handleDeviceApprove } from "../auth/device-flow.js";
import { handleLogout, handleLogoutAll, handleRevoke } from "../auth/logout.js";
import { handleUserinfo } from "../auth/userinfo.js";
import {
  handleIssueServiceToken,
  handleListServiceTokens,
  handleRevokeServiceToken,
} from "../admin/handle-service-tokens.js";
import { handleListOrgs, handleCreateOrg, handleUpdateOrg } from "../admin/handle-admin-orgs.js";
import { handleListUsers, handleUpdateUser } from "../admin/handle-admin-users.js";
import { handleDevicePage } from "../auth/pages/device.html.js";
import { handleDeviceConfirmPage } from "../auth/pages/device-confirm.html.js";
import { handleSuccessPage } from "../auth/pages/success.html.js";
import { appError } from "./response-contract.js";

/**
 * Per-IP rate limit on admin mutation endpoints (V3 PATCH 4). Applied before
 * the auth gate so credential-stuffing or admin-cookie probing can't bury
 * the system under POSTs. GETs are unlimited — read-only browsing of the
 * admin UI should not throttle. 30 mutations / 60s matches the order of the
 * device-flow per-min limit and accommodates a busy admin without footgunning
 * shared NAT.
 */
const ADMIN_MUT_RATE_LIMIT = { per: 30, window_seconds: 60 };

// #318: POST /api/auth/oauth/token had no rate limit at all, on any of its
// three grants. It is unauthenticated by design -- it is the endpoint that
// mints the bearer -- so an anonymous caller could drive authorization_code,
// refresh_token and the device_code poll as fast as the box allowed. The
// device poll's own slow_down is keyed on the device_code, which does nothing
// against a caller rotating them.
//
// 60/min per IP leaves the legitimate device poll (RFC 8628 suggests ~5s, so
// about 12/min) a wide margin including retries, while bounding a probe.
const OAUTH_TOKEN_RATE_LIMIT = { per: 60, window_seconds: 60 };

/** Regex matchers for parameterized admin routes — see service-tokens
 *  /revoke pattern at handle-service-tokens.ts §handleRevokeServiceToken. */
const ADMIN_ORG_ID_RE = /^\/api\/admin\/orgs\/([^/]+)$/;
const ADMIN_USER_ID_RE = /^\/api\/admin\/users\/([^/]+)$/;

/**
 * Phase 2 auth-route dispatcher. Returns true if the URL matched an
 * auth route (and the handler was invoked); false if the caller should
 * fall through to handleRest (Phase 1 routes).
 *
 * Route table (Phase 2):
 *   GET  /auth/login                              → handleAuthLogin (T15)
 *   GET  /auth/device                             → handleDevicePage (T21)
 *   GET  /auth/device/confirm                     → handleDeviceConfirmPage (T21)
 *   GET  /auth/success                            → handleSuccessPage (T21)
 *   GET  /api/auth/oauth/callback                 → handleOAuthCallback (T16)
 *   POST /api/auth/oauth/token                    → handleOAuthToken (T18)
 *   POST /api/auth/oauth/device_authorization     → handleDeviceAuthorization (T17)
 *   POST /auth/device/approve                     → handleDeviceApprove (T20)
 *   POST /api/auth/logout                         → handleLogout (T23)
 *   POST /api/auth/logout-all                     → handleLogoutAll (T23)
 *   POST /api/auth/revoke                         → handleRevoke (T23)
 *   GET  /api/auth/me                             → handleUserinfo (T24)
 *   POST /api/admin/service-tokens                → handleIssueServiceToken (T25)
 *   GET  /api/admin/service-tokens                → handleListServiceTokens (T25)
 *   POST /api/admin/service-tokens/<jti>/revoke   → handleRevokeServiceToken (T25)
 *   GET  /api/admin/orgs                          → handleListOrgs (v0.10.6 T05)
 *   POST /api/admin/orgs                          → handleCreateOrg (v0.10.6 T05) [RL]
 *   PATCH /api/admin/orgs/:id                     → handleUpdateOrg (v0.10.6 T05) [RL]
 *   GET  /api/admin/users                         → handleListUsers (v0.10.6 T06)
 *   PATCH /api/admin/users/:id                    → handleUpdateUser (v0.10.6 T06) [RL]
 *
 * [RL] = per-IP pre-auth rate limit on mutations only (V3 PATCH 4, T07).
 * Key namespace `admin:mut:${ip}` is distinct from existing limiters.
 *
 * Discovery doc (T14) is wired separately by serve-http.ts at boot —
 * it doesn't flow through this dispatcher.
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
  if (url === "/auth/device" && method === "GET") {
    await handleDevicePage(req, res, ctx);
    return true;
  }
  if (url === "/auth/device/confirm" && method === "GET") {
    await handleDeviceConfirmPage(req, res, ctx);
    return true;
  }
  if (url === "/auth/success" && method === "GET") {
    await handleSuccessPage(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/oauth/callback" && method === "GET") {
    await handleOAuthCallback(req, res, ctx);
    return true;
  }
  if (url === "/api/auth/oauth/token" && method === "POST") {
    if (!(await checkOAuthTokenRateLimit(req, res, ctx))) return true;
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
  if (url === "/api/admin/service-tokens" && method === "POST") {
    await handleIssueServiceToken(req, res, ctx);
    return true;
  }
  if (url === "/api/admin/service-tokens" && method === "GET") {
    await handleListServiceTokens(req, res, ctx);
    return true;
  }

  // ---------------------------------------------------------------------
  // v0.10.6 admin-UI orgs + users (T05 + T06 handlers, T07 wiring).
  // Mutations (POST/PATCH) are rate-limited per-IP BEFORE auth — see
  // ADMIN_MUT_RATE_LIMIT + checkAdminMutationRateLimit() below.
  // ---------------------------------------------------------------------
  if (url === "/api/admin/orgs" && method === "GET") {
    await handleListOrgs(req, res, ctx);
    return true;
  }
  if (url === "/api/admin/orgs" && method === "POST") {
    if (!(await checkAdminMutationRateLimit(req, res, ctx))) return true;
    await handleCreateOrg(req, res, ctx);
    return true;
  }
  if (url === "/api/admin/users" && method === "GET") {
    await handleListUsers(req, res, ctx);
    return true;
  }

  // Parameterized PATCH /api/admin/orgs/:id. Match via regex; non-PATCH
  // methods on this path fall through to handleRest. The handler itself
  // re-parses :id defensively (see handle-admin-orgs.ts ORG_PATH_RE).
  const orgIdMatch = url.match(ADMIN_ORG_ID_RE);
  if (orgIdMatch && method === "PATCH") {
    if (!(await checkAdminMutationRateLimit(req, res, ctx))) return true;
    await handleUpdateOrg(req, res, ctx);
    return true;
  }

  // Parameterized PATCH /api/admin/users/:id. Same pattern as orgs above.
  const userIdMatch = url.match(ADMIN_USER_ID_RE);
  if (userIdMatch && method === "PATCH") {
    if (!(await checkAdminMutationRateLimit(req, res, ctx))) return true;
    await handleUpdateUser(req, res, ctx);
    return true;
  }

  // Service-token revoke is parameterized (jti in URL). Match via regex
  // before the KNOWN_AUTH_PATHS check; non-POST methods on this path fall
  // through to the dispatcher's return false (handleRest will 404). This
  // skips the 405 branch for parameterized paths -- acceptable trade-off.
  const revokeMatch = url.match(/^\/api\/admin\/service-tokens\/([^/]+)\/revoke$/);
  if (revokeMatch && method === "POST") {
    const jti = decodeURIComponent(revokeMatch[1]!);
    await handleRevokeServiceToken(req, res, ctx, jti);
    return true;
  }

  // Known auth path but wrong method → 405. Match the URL ignoring method.
  if (KNOWN_AUTH_PATHS.has(url)) {
    res.writeHead(405, {
      "Content-Type": "application/json; charset=utf-8",
      Allow: methodForPath(url),
    });
    res.end(JSON.stringify(appError("METHOD_NOT_ALLOWED", `${method} not allowed on ${url}`)));
    return true;
  }

  return false;
}

const KNOWN_AUTH_PATHS = new Set([
  "/auth/login",
  "/auth/device",
  "/auth/device/confirm",
  "/auth/success",
  "/api/auth/oauth/callback",
  "/api/auth/oauth/token",
  "/api/auth/oauth/device_authorization",
  "/auth/device/approve",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/revoke",
  "/api/auth/me",
  "/api/admin/service-tokens",
  "/api/admin/orgs",
  "/api/admin/users",
]);

function methodForPath(url: string): string {
  if (url === "/api/admin/service-tokens") return "GET, POST";
  if (url === "/api/admin/orgs") return "GET, POST";
  if (url === "/api/admin/users") return "GET";
  if (
    url === "/auth/login" ||
    url === "/auth/device" ||
    url === "/auth/device/confirm" ||
    url === "/auth/success" ||
    url === "/api/auth/oauth/callback" ||
    url === "/api/auth/me"
  ) {
    return "GET";
  }
  return "POST";
}

/**
 * Per-IP pre-auth rate-limit gate for admin MUTATION endpoints (V3 PATCH 4).
 * Returns true when the request may proceed; returns false AFTER writing a
 * 429 JSON envelope + Retry-After header (caller must short-circuit).
 *
 * IP source: req.socket.remoteAddress (mirrors device-flow.ts:93,
 * oauth-login.ts:73, oauth-callback.ts:187). Falls back to "unknown" when
 * the socket is unavailable, which buckets all such requests together —
 * acceptable since this is a coarse safety net, not the primary auth gate.
 *
 * Key namespace `admin:mut:${ip}` is intentionally distinct from
 * `device-auth-min:${ip}` / `auth-login:${ip}` / `userinfo:${user_id}` /
 * `logout-all:${user_id}` to avoid cross-contamination between policies.
 */
/**
 * Per-IP throttle for the token endpoint (#318).
 *
 * Key namespace `oauth-token:${ip}` is deliberately distinct from
 * `device-auth-min:` and `auth-login:` so a client exhausting one policy does
 * not consume another's budget.
 *
 * The 429 body uses the appError shape rather than an OAuth error object:
 * device-flow.ts already answers its own 429s that way, and RFC 6749 5.2 has
 * no code for this -- `slow_down` belongs to the device-flow extension and
 * would be wrong on the other two grants.
 */
async function checkOAuthTokenRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<boolean> {
  const ip = req.socket?.remoteAddress ?? "unknown";
  const result = await ctx.rateLimiter.check(`oauth-token:${ip}`, OAUTH_TOKEN_RATE_LIMIT);
  if (result.allowed) return true;
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(result.retry_after_seconds),
  });
  res.end(JSON.stringify(appError("RATE_LIMITED", "Too many token requests")));
  return false;
}

async function checkAdminMutationRateLimit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<boolean> {
  const ip = req.socket?.remoteAddress ?? "unknown";
  // Phase 5: IRateLimiter may be Redis-backed (async).
  const result = await ctx.rateLimiter.check(`admin:mut:${ip}`, ADMIN_MUT_RATE_LIMIT);
  if (result.allowed) return true;
  res.writeHead(429, {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(result.retry_after_seconds),
  });
  res.end(JSON.stringify(appError("RATE_LIMITED", "Too many admin mutation requests")));
  return false;
}
