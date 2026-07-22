import type { IncomingMessage, ServerResponse } from "node:http";
import { decodeJwt } from "jose";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";
import { authenticateRequest } from "../auth.js";
import { audit } from "../security/audit.js";
import { bumpTokenEpoch } from "./token-epoch.js";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME, hostCookie, setCookies } from "./cookies.js";

/**
 * T23 — POST /api/auth/logout, /logout-all, /revoke
 *
 * Three handlers sharing rotation/revocation logic for spec §6.8 / RFC 7009.
 *
 *   /api/auth/logout      — local logout (revoke current family)        [204]
 *   /api/auth/logout-all  — global logout (bump token_epoch + revoke all)[204]
 *   /api/auth/revoke      — RFC 7009 token revocation endpoint          [200 always]
 *
 * Auth model:
 *   - /logout and /logout-all accept cookie OR Bearer (T27 Scenario 5)
 *   - /revoke accepts Bearer or cookie; caller identity authorizes the action,
 *     not the token's signature (an attacker presenting a forged refresh JWT
 *     will not find a matching jti → no-op revoke, still 200 per RFC 7009 §2.2)
 *
 * Cookie clearing: both __Host-coordinator_session and __Host-coordinator_csrf
 * are re-issued with Max-Age=0 so browsers drop them immediately.
 */

const LOGOUT_ALL_RATE_LIMIT = { per: 5, window_seconds: 3600 } as const;

/** Issue Set-Cookie headers that expire session + csrf cookies immediately. */
function clearSessionCookies(res: ServerResponse): void {
  setCookies(res, [
    hostCookie(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "Strict",
      maxAge: 0,
    }),
    hostCookie(CSRF_COOKIE_NAME, "", {
      httpOnly: false,
      sameSite: "Strict",
      maxAge: 0,
    }),
  ]);
}

/** Emit a 401 with WWW-Authenticate from an authenticateRequest failure. */
function emit401(
  res: ServerResponse,
  status: 401 | 403,
  error: string,
  wwwAuthenticate: string | undefined,
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
  };
  if (wwwAuthenticate) headers["WWW-Authenticate"] = wwwAuthenticate;
  res.writeHead(status, headers);
  res.end(JSON.stringify(appError("UNAUTHORIZED", error)));
}

/**
 * POST /api/auth/logout — local logout.
 *
 * Revokes every unrevoked refresh_tokens row in the JWT's family_id. Phase 1
 * tokens that lack family_id (`claims.family_id` undefined) get a 204 with
 * no DB writes — they aren't part of the rotation lineage so there's nothing
 * to revoke. Cookies are always cleared.
 *
 * Audit: Tier 2 auth.logout.local.
 */
export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    emit401(res, authResult.status, authResult.error, authResult.wwwAuthenticate);
    return;
  }
  const claims = authResult.claims;

  if (claims.family_id) {
    ctx.db
      .prepare(
        `
        UPDATE refresh_tokens
        SET revoked_at = ?, revoked_reason = 'logout'
        WHERE family_id = ? AND revoked_at IS NULL
      `,
      )
      .run(String(ctx.clock.now()), claims.family_id);
  }

  clearSessionCookies(res);

  audit("auth.logout.local", {
    tier: 2,
    metadata: {
      user_id: claims.user_id,
      family_id: claims.family_id ?? null,
    },
  });

  res.writeHead(204);
  res.end();
}

/**
 * POST /api/auth/logout-all — global logout.
 *
 * Bumps user.token_epoch (T03) which invalidates every JWT for this subject
 * the next time it's verified (iat < epoch fails the check). Also revokes
 * every unrevoked refresh_tokens row for the user as belt-and-suspenders so
 * the rotation lineage doesn't outlive the session.
 *
 * Rate-limited: 5 calls per hour per user. 429 + Retry-After on breach.
 *
 * Audit: Tier 1 auth.logout.global (security event).
 */
export async function handleLogoutAll(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    emit401(res, authResult.status, authResult.error, authResult.wwwAuthenticate);
    return;
  }
  const claims = authResult.claims;

  const rate = await ctx.rateLimiter.check(`logout-all:${claims.user_id}`, LOGOUT_ALL_RATE_LIMIT);
  if (!rate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rate.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many logout-all requests")));
    return;
  }

  bumpTokenEpoch(ctx.db, claims.user_id);

  ctx.db
    .prepare(
      `
      UPDATE refresh_tokens
      SET revoked_at = ?, revoked_reason = 'logout_all'
      WHERE user_id = ? AND revoked_at IS NULL
    `,
    )
    .run(String(ctx.clock.now()), claims.user_id);

  clearSessionCookies(res);

  audit("auth.logout.global", {
    tier: 1,
    metadata: { user_id: claims.user_id },
  });

  res.writeHead(204);
  res.end();
}

/**
 * Read a form-encoded request body to a plain string→string map. Throws on
 * stream errors (handler treats unparseable bodies as "invalid token" → 200
 * per RFC 7009 §2.2, so the throw is caught and ignored).
 */
async function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const params = new URLSearchParams(body);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
    req.on("error", reject);
  });
}

/**
 * POST /api/auth/revoke — RFC 7009 token revocation.
 *
 * Always responds 200 per RFC 7009 §2.2 — even on unknown / forged / already-
 * revoked tokens — to avoid leaking which jtis exist. Audit is only emitted
 * when a row actually transitioned to revoked.
 *
 * Authorization: caller must own the token, or be admin. Cross-user revoke
 * by a non-admin is silently rejected (200, no audit) rather than 403; this
 * is the same anti-enumeration posture as unknown tokens.
 */
export async function handleRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const authResult = await authenticateRequest(req, { authEnabled: true });
  if (!authResult.ok) {
    emit401(res, authResult.status, authResult.error, authResult.wwwAuthenticate);
    return;
  }
  const claims = authResult.claims;

  let body: Record<string, string>;
  try {
    body = await parseFormBody(req);
  } catch {
    // Unparseable → treat as invalid token → 200 (no enumeration leak).
    res.writeHead(200);
    res.end();
    return;
  }

  const token = body.token;
  if (!token) {
    res.writeHead(200);
    res.end();
    return;
  }

  // Decode WITHOUT verifying signature: caller identity authorizes the action,
  // and forged tokens carrying random jtis simply won't match a real row.
  let jti: string | null = null;
  try {
    const decoded = decodeJwt(token) as { jti?: unknown };
    jti = typeof decoded.jti === "string" ? decoded.jti : null;
  } catch {
    // Malformed JWT → 200 per RFC 7009.
    res.writeHead(200);
    res.end();
    return;
  }

  if (!jti) {
    res.writeHead(200);
    res.end();
    return;
  }

  const row = ctx.db
    .prepare("SELECT user_id, revoked_at FROM refresh_tokens WHERE jti = ?")
    .get(jti) as { user_id: string; revoked_at: string | null } | undefined;

  if (!row || row.revoked_at !== null) {
    res.writeHead(200);
    res.end();
    return;
  }

  if (row.user_id !== claims.user_id && claims.role !== "admin") {
    // Caller authenticated but doesn't own this token and isn't admin.
    // RFC 7009 anti-enumeration posture: silently 200.
    res.writeHead(200);
    res.end();
    return;
  }

  ctx.db
    .prepare(
      `
      UPDATE refresh_tokens
      SET revoked_at = ?, revoked_reason = 'admin'
      WHERE jti = ? AND revoked_at IS NULL
    `,
    )
    .run(String(ctx.clock.now()), jti);

  audit("auth.token.revoked", {
    tier: 1,
    metadata: {
      jti,
      revoked_by: claims.user_id,
      target_user_id: row.user_id,
    },
  });

  res.writeHead(200);
  res.end();
}
