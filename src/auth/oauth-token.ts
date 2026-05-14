import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { oauthError } from "../http/response-contract.js";
import { audit } from "../security/audit.js";
import { refreshTokenGrant } from "./refresh-rotation.js";
import {
  provisionUser,
  mintTokenPair,
  computeFingerprint,
} from "./oauth-finalize.js";
import { resolveOrgFromMemberships } from "./allowlist.js";
import { IdPTokenRevoked, IdPTransientError } from "./providers/errors.js";
import { hashIdpUserId } from "./audit-helpers.js";

/**
 * POST /api/auth/oauth/token — RFC 6749 §6 unified token endpoint.
 *
 * Form-encoded body. Dispatches on `grant_type`:
 *   - authorization_code: CLI/code-grant — exchange code at GitHub,
 *     allowlist-check via T04 cache + T09, provisionUser inside TX
 *     (T16helpers), mintTokenPair, RFC 6749 §5.1 JSON response.
 *   - refresh_token: delegates to T19 refreshTokenGrant. We forward the
 *     already-parsed body via the optional preParsedBody param so we
 *     don't try to re-stream a consumed request.
 *   - urn:ietf:params:oauth:grant-type:device_code: RFC 8628 §3.4 poll.
 *     Atomic CAS on (last_polled_at, interval) per V4 FIX 18. On approved
 *     → mint pair + DELETE the device_auth_requests row. RFC 8628 §3.5
 *     error codes (authorization_pending, slow_down, expired_token,
 *     access_denied, invalid_grant) routed through T36 oauthError.
 *
 * All error responses use the T36 oauthError envelope (RFC 6749 §5.2).
 *
 * Out of scope here (lands in T29 / T25):
 *   - Wiring into serve-http.ts route table (T29)
 *   - Service-token issuance via this endpoint (T25)
 */

const ACCESS_TTL_S = 15 * 60;

/**
 * Parse a form-encoded request body to a plain string→string map. Mirrors
 * the parser in refresh-rotation.ts; we keep it private here so the
 * dispatcher's stream consumption is independent of T19's helper.
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

function emitOAuthError(
  res: ServerResponse,
  status: number,
  error: string,
  description: string,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(oauthError(error, description)));
}

function emitTokenResponse(
  res: ServerResponse,
  accessJwt: string,
  refreshJwt: string,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      access_token: accessJwt,
      refresh_token: refreshJwt,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
    }),
  );
}

/**
 * grant_type=authorization_code (RFC 6749 §4.1.3) — CLI alternative to
 * the browser callback. Exchanges code at GitHub, runs the same
 * allowlist + provision + mint pipeline as T16c, then returns a JSON
 * token response (no cookies — CLI clients store tokens directly).
 */
async function handleAuthorizationCodeGrant(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
  body: Record<string, string>,
): Promise<void> {
  const code = body.code;
  const redirectUri = body.redirect_uri;
  const codeVerifier = body.code_verifier;
  if (!code || !redirectUri) {
    emitOAuthError(res, 400, "invalid_request", "Missing code or redirect_uri");
    return;
  }

  // 1. Exchange the authorization code at the IdP.
  let exchange;
  try {
    exchange = await ctx.githubProvider.exchangeCode(
      code,
      redirectUri,
      codeVerifier,
    );
  } catch (err) {
    if (err instanceof IdPTokenRevoked) {
      audit("auth.idp.token_revoked", {
        tier: 1,
        metadata: { phase: "auth_code_grant" },
      });
      emitOAuthError(
        res,
        401,
        "invalid_grant",
        "IdP rejected the authorization code",
      );
      return;
    }
    if (err instanceof IdPTransientError) {
      emitOAuthError(
        res,
        503,
        "temporarily_unavailable",
        "Identity provider unavailable",
      );
      return;
    }
    throw err;
  }

  // 2. List memberships via T04 cache and resolve allowlist.
  let memberships: string[];
  try {
    memberships = await ctx.membershipCache.getMemberships(
      exchange.user.idp_user_id,
      ctx.githubProvider,
      exchange.accessToken,
    );
  } catch (err) {
    if (err instanceof IdPTokenRevoked) {
      audit("auth.idp.token_revoked", {
        tier: 1,
        metadata: { phase: "auth_code_membership" },
      });
      emitOAuthError(res, 401, "invalid_grant", "IdP rejected the token");
      return;
    }
    if (err instanceof IdPTransientError) {
      emitOAuthError(
        res,
        503,
        "temporarily_unavailable",
        "Identity provider unavailable",
      );
      return;
    }
    throw err;
  }

  const allowlistMatch = resolveOrgFromMemberships(ctx.db, memberships);
  if (!allowlistMatch) {
    audit("auth.login.denied.not_in_org", {
      tier: 1,
      metadata: {
        idp_user_id_hash: hashIdpUserId(exchange.user.idp_user_id),
        phase: "auth_code_grant",
      },
    });
    emitOAuthError(
      res,
      403,
      "access_denied",
      "User is not in any allowlisted org",
    );
    return;
  }

  // 3. Find-or-create user inside a TX.
  const tx = ctx.db.transaction(() => {
    return provisionUser(ctx.db, ctx.clock, exchange.user, exchange.accessToken, {
      org_id: allowlistMatch.org_id,
      org_name: allowlistMatch.org_name,
    });
  });
  const provisionResult = tx();

  if (provisionResult.isNew) {
    audit("auth.user.created", {
      tier: 2,
      metadata: {
        user_id: provisionResult.user.user_id,
        org_id: provisionResult.user.primary_org_id,
        bootstrap_admin: provisionResult.bootstrapAdmin,
      },
    });
  }
  if (provisionResult.bootstrapAdmin) {
    audit("auth.admin.bootstrapped", {
      tier: 1,
      metadata: {
        user_id: provisionResult.user.user_id,
        org_id: provisionResult.user.primary_org_id,
      },
    });
  }

  // 4. Mint access + refresh pair. Fingerprint derived from request socket.
  const ip = req.socket?.remoteAddress ?? null;
  const ua = (req.headers["user-agent"] as string | undefined) ?? null;
  const fingerprint = computeFingerprint(ip, ua);
  const pair = await mintTokenPair(ctx.db, ctx.clock, {
    user: provisionResult.user,
    registry: ctx.signingKeys,
    issuer: ctx.publicUrl.replace(/\/$/, ""),
    fingerprint,
  });

  audit("auth.login.success", {
    tier: 2,
    metadata: {
      user_id: provisionResult.user.user_id,
      org_id: provisionResult.user.primary_org_id,
      family_id: pair.familyId,
      grant_type: "authorization_code",
    },
  });

  emitTokenResponse(res, pair.accessJwt, pair.refreshJwt);
}

/**
 * grant_type=urn:ietf:params:oauth:grant-type:device_code (RFC 8628 §3.4)
 * — device-flow poll. Uses an atomic UPDATE … WHERE … RETURNING (V4 FIX 18)
 * to enforce per-device slow_down without a SELECT-then-UPDATE race.
 */
async function handleDeviceCodeGrant(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
  body: Record<string, string>,
): Promise<void> {
  const deviceCode = body.device_code;
  if (!deviceCode) {
    emitOAuthError(res, 400, "invalid_request", "Missing device_code");
    return;
  }

  const now = ctx.clock.now();

  // V4 FIX 18: atomic CAS — update last_polled_at iff enough time elapsed.
  // RETURNING gives us the row state in a single round-trip.
  const updated = ctx.db
    .prepare(
      `UPDATE device_auth_requests
       SET last_polled_at = ?
       WHERE device_code = ?
         AND (last_polled_at IS NULL OR (? - last_polled_at) >= interval)
       RETURNING interval, approved_user_id, denied_at, expires_at, org_id`,
    )
    .get(now, deviceCode, now) as
    | {
        interval: number;
        approved_user_id: string | null;
        denied_at: number | null;
        expires_at: number | string;
        org_id: string | null;
      }
    | undefined;

  if (!updated) {
    // Either no row matched the device_code OR the caller polled too fast.
    // Disambiguate with a second lookup so the client gets slow_down vs
    // invalid_grant per RFC 8628 §3.5.
    const exists = ctx.db
      .prepare("SELECT interval FROM device_auth_requests WHERE device_code = ?")
      .get(deviceCode) as { interval: number } | undefined;
    if (!exists) {
      emitOAuthError(res, 400, "invalid_grant", "Unknown device_code");
      return;
    }
    emitOAuthError(
      res,
      400,
      "slow_down",
      `Polling too fast; wait ${exists.interval}s`,
    );
    return;
  }

  const expiresAt = Number(updated.expires_at);
  if (now >= expiresAt) {
    emitOAuthError(res, 400, "expired_token", "Device code expired");
    return;
  }
  if (updated.denied_at !== null) {
    emitOAuthError(res, 400, "access_denied", "Device request was denied");
    return;
  }
  if (updated.approved_user_id === null) {
    emitOAuthError(
      res,
      400,
      "authorization_pending",
      "Waiting for user approval",
    );
    return;
  }

  // Approved → look up user + mint pair.
  const userRow = ctx.db
    .prepare("SELECT id, primary_org_id, role FROM users WHERE id = ?")
    .get(updated.approved_user_id) as
    | { id: string; primary_org_id: string; role: "admin" | "member" | "service" }
    | undefined;
  if (!userRow) {
    emitOAuthError(res, 400, "invalid_grant", "Approved user not found");
    return;
  }

  const pair = await mintTokenPair(ctx.db, ctx.clock, {
    user: {
      user_id: userRow.id,
      primary_org_id: userRow.primary_org_id,
      role: userRow.role,
    },
    registry: ctx.signingKeys,
    issuer: ctx.publicUrl.replace(/\/$/, ""),
    fingerprint: null,
  });

  // Single-use: drop the device_auth_requests row so further polls 404.
  ctx.db
    .prepare("DELETE FROM device_auth_requests WHERE device_code = ?")
    .run(deviceCode);

  audit("auth.login.success", {
    tier: 2,
    metadata: {
      user_id: userRow.id,
      family_id: pair.familyId,
      grant_type: "device_code",
    },
  });

  emitTokenResponse(res, pair.accessJwt, pair.refreshJwt);
}

export async function handleOAuthToken(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const body = await parseFormBody(req).catch(
    () => ({}) as Record<string, string>,
  );
  const grantType = body.grant_type;
  if (!grantType) {
    emitOAuthError(res, 400, "invalid_request", "Missing grant_type");
    return;
  }
  switch (grantType) {
    case "authorization_code":
      await handleAuthorizationCodeGrant(req, res, ctx, body);
      return;
    case "refresh_token":
      // Pass the already-parsed body so refreshTokenGrant doesn't try to
      // re-read the consumed stream.
      await refreshTokenGrant(req, res, ctx, body);
      return;
    case "urn:ietf:params:oauth:grant-type:device_code":
      await handleDeviceCodeGrant(req, res, ctx, body);
      return;
    default:
      emitOAuthError(
        res,
        400,
        "unsupported_grant_type",
        `Unsupported grant_type: ${grantType}`,
      );
      return;
  }
}
