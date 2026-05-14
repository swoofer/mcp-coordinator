import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { authenticateRequest } from "../auth.js";
import { appError } from "../http/response-contract.js";

const RATE_LIMIT_CONFIG = { per: 600, window_seconds: 60 } as const;

interface UserinfoRow {
  id: string;
  primary_org_id: string;
  email: string;
  name: string | null;
  role: "admin" | "member" | "service";
}

interface OrgRow {
  id: string;
  name: string;
}

/**
 * GET /api/auth/me — current user + org context. UX helper for SDKs to
 * display "Logged in as X (org: Y)" without parsing the JWT.
 *
 * Auth: cookie (T27 Scenario 5) or Bearer. Returns 401 unauthenticated.
 * Rate-limited 600/min per user (V4 NR11) — generous for SDK polling.
 *
 * No audit emission: read-only UX path; high-volume; not security-relevant
 * (the response carries the SAME data the JWT already conveys).
 *
 * Response shape:
 *   {
 *     user_id: string,
 *     email: string,
 *     name: string | null,
 *     role: "admin" | "member" | "service",
 *     org: { id: string, name: string },
 *     active_org_id: string  // alias of org.id for Phase 5 forward-compat
 *   }
 */
export async function handleUserinfo(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    res.writeHead(authResult.status, {
      "Content-Type": "application/json; charset=utf-8",
      ...(authResult.wwwAuthenticate ? { "WWW-Authenticate": authResult.wwwAuthenticate } : {}),
    });
    res.end(JSON.stringify(appError("UNAUTHORIZED", authResult.error)));
    return;
  }
  const claims = authResult.claims;

  // Rate limit per user
  const rate = ctx.rateLimiter.check(`userinfo:${claims.user_id}`, RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rate.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many userinfo requests")));
    return;
  }

  // Look up user + org
  const userRow = ctx.db
    .prepare(`
      SELECT id, primary_org_id, email, name, role
      FROM users WHERE id = ?
    `)
    .get(claims.user_id) as UserinfoRow | undefined;

  if (!userRow) {
    // Token claims a user_id that doesn't exist in the DB. Shouldn't happen
    // in healthy flows (callback inserts the user), but defensive 404 is
    // better than crashing.
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("USER_NOT_FOUND", "User record missing")));
    return;
  }

  const orgRow = ctx.db
    .prepare("SELECT id, name FROM orgs WHERE id = ?")
    .get(userRow.primary_org_id) as OrgRow | undefined;

  if (!orgRow) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("ORG_NOT_FOUND", "Org record missing")));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({
    user_id: userRow.id,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
    org: { id: orgRow.id, name: orgRow.name },
    active_org_id: orgRow.id,
  }));
}
