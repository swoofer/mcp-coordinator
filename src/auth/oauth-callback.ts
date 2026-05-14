import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import type { ExchangeCodeResult } from "./providers/types.js";
import { IdPTokenRevoked, IdPTransientError } from "./providers/errors.js";
import { consumeOAuthState, inspectOAuthState } from "./oauth-state.js";
import { parseCookies } from "./cookies.js";
import { hashIdentifier, isLocked, recordFailedLogin } from "./login-lockout.js";
import { resolveOrgFromMemberships } from "./allowlist.js";
import {
  provisionUser,
  mintTokenPair,
  computeFingerprint,
  setSessionCookies,
  type ProvisionedUser,
  type ProvisionResult,
} from "./oauth-finalize.js";
import { generateCsrfToken } from "./csrf.js";
import { getOrgSetting } from "./org-settings.js";
import { hashIdpUserId } from "./audit-helpers.js";
import { audit } from "../security/audit.js";
import { appError, bearerAuthHeader } from "../http/response-contract.js";

const STATE_COOKIE_NAME = "__Host-coordinator_oauth_state";

/**
 * V4 FIX 19 canonical state-binding HMAC. Identical construction to T15's
 * bindState; recomputed here to verify the cookie matches.
 */
function recomputeStateHmac(state: string, key: Buffer): string {
  const message = Buffer.concat([
    Buffer.from("state-v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(state, "utf8"),
  ]);
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

/**
 * Constant-time comparison of base64url HMAC values. Length pre-check
 * before timingSafeEqual (which throws on unequal-length buffers).
 */
function hmacEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * GET /api/auth/oauth/callback — OAuth code-grant return path.
 *
 * Steps 1-5 (T16a): query parsing, state cookie binding, atomic CAS on
 * oauth_state, mix-up defense, exchangeCode. The post-exchange
 * provisioning + JWT mint + cookies + redirect are deferred to T16b/c
 * (finalizeBrowserOAuth placeholder).
 *
 * Per V4 FIX 19: state cookie value is HMAC-SHA-256("state-v1" || 0x00 ||
 * state, state_binding_key) base64url-encoded. Mismatch → audit
 * auth.state.replay (Tier 1) + 400.
 *
 * Per spec §6.3 mix-up defense: row.provider MUST equal the expected
 * "github". Mismatch → audit auth.state.mixup (Tier 1) + 400.
 *
 * Per RFC 6749 §4.1.2.1: GitHub may redirect with ?error=... instead of
 * ?code=...; bubble that up as 400 with error description.
 */
export async function handleOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const idpError = url.searchParams.get("error");
  const idpErrorDescription = url.searchParams.get("error_description");

  // RFC 6749 §4.1.2.1: provider may signal user denial / scope-deny via
  // error param instead of code.
  if (idpError) {
    audit("auth.login.failure", {
      tier: 2,
      metadata: { idp_error: idpError, idp_error_description: idpErrorDescription ?? null },
    });
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError(
      "OAUTH_DENIED",
      idpErrorDescription ?? `OAuth provider returned error: ${idpError}`,
    )));
    return;
  }

  if (!state || !code) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_REQUEST", "Missing state or code")));
    return;
  }

  // Validate state cookie binding (V4 FIX 19)
  const cookies = parseCookies(req);
  const cookieHmac = cookies[STATE_COOKIE_NAME];
  const expectedHmac = recomputeStateHmac(state, ctx.stateBindingKey);
  if (!cookieHmac || !hmacEqual(cookieHmac, expectedHmac)) {
    audit("auth.state.replay", {
      tier: 1,
      metadata: { reason: cookieHmac ? "hmac_mismatch" : "cookie_missing" },
    });
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("INVALID_STATE", "State validation failed")));
    return;
  }

  // Atomic CAS on oauth_state row
  const row = consumeOAuthState(ctx.db, ctx.clock, state);
  if (!row) {
    // Was it consumed already, expired, or unknown? Disambiguate for status code.
    // inspectOAuthState would throw on a live un-consumed row, but that's
    // impossible post-CAS-failure (CAS would have succeeded on a live row);
    // the throw acts as an invariant assertion.
    const inspectResult = inspectOAuthState(ctx.db, ctx.clock, state);
    switch (inspectResult.status) {
      case "unknown":
        audit("auth.state.replay", { tier: 1, metadata: { reason: "state_unknown" } });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(appError("UNKNOWN_STATE", "State not recognized")));
        return;
      case "consumed":
        audit("auth.state.replay", { tier: 1, metadata: { reason: "state_consumed" } });
        res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(appError("STATE_ALREADY_CONSUMED", "This authorization was already completed")));
        return;
      case "expired":
        audit("auth.state.replay", { tier: 1, metadata: { reason: "state_expired" } });
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(appError("STATE_EXPIRED", "Authorization expired; please retry")));
        return;
    }
  }

  // Mix-up defense (V4)
  if (row.provider !== "github") {
    audit("auth.state.mixup", {
      tier: 1,
      metadata: { observed_provider: row.provider, expected_provider: "github" },
    });
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("PROVIDER_MISMATCH", "State does not match the expected provider")));
    return;
  }

  // Exchange code with GitHub
  let exchangeResult: ExchangeCodeResult;
  try {
    exchangeResult = await ctx.githubProvider.exchangeCode(
      code,
      row.redirect_uri,
      row.code_verifier,
    );
  } catch (err) {
    if (err instanceof IdPTokenRevoked) {
      audit("auth.idp.token_revoked", { tier: 1, metadata: { phase: "callback_exchange" } });
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": bearerAuthHeader("invalid_token", "IdP rejected the token"),
      });
      res.end(JSON.stringify(appError("IDP_TOKEN_REVOKED", "Identity provider rejected the token")));
      return;
    }
    if (err instanceof IdPTransientError) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError("IDP_UNAVAILABLE", "Identity provider temporarily unavailable")));
      return;
    }
    throw err; // unknown error → 500 via top-level handler
  }

  const ip = req.socket?.remoteAddress ?? null;
  const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
  await finalizeBrowserOAuth(res, ctx, exchangeResult, ip, userAgent);
}

/**
 * Sentinel raised inside the provisioning transaction when AUTO_PROVISION
 * is "false" and the user has no existing row. Aborts the TX so the
 * find-or-create + bootstrap-admin path never runs, and lets the caller
 * emit the Tier 2 audit + 403 response after rollback (V4 FIX 23: only
 * audit after the security action commits — here it's the lack of one).
 */
class ProvisioningDeniedError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProvisioningDeniedError";
  }
}

/**
 * T16b: callback provisioning transaction body.
 *
 * Flow (V2 §A.8 + V4 FIX 16/23):
 *   1. Login lockout pre-check (V3 §B-NEW-8) — identifier_hash =
 *      SHA-256("login-lockout-v1\0" + idp_user_id-or-ip). Pre-locked →
 *      429 + Retry-After + Tier 1 audit auth.login.locked. The audit
 *      fires at observation time (the request that hits the lockout)
 *      rather than at the recording call — recordFailedLogin's
 *      locked=true branch is unreachable within a single request because
 *      isLocked's peek short-circuits before a drained bucket can be
 *      observed again.
 *   2. listMemberships via T04 cache (60s positive TTL, 10min
 *      stale-on-error). IdPTokenRevoked → 401 + WWW-Authenticate +
 *      Tier 1 audit. IdPTransientError → 503.
 *   3. resolveOrgFromMemberships (T09). No match → recordFailedLogin +
 *      403 + Tier 1 audit auth.login.denied.not_in_org.
 *   4. AUTO_PROVISION via T44 getOrgSetting (default "true"). "false"
 *      + new user → 403 USER_NOT_PROVISIONED + Tier 2 audit
 *      auth.login.failure(reason=user_not_provisioned).
 *   5. BEGIN IMMEDIATE TX: provisionUser (T16helpers). User-exists
 *      check is inside the TX so AUTO_PROVISION=false races with a
 *      concurrent provisioning attempt cleanly.
 *   6. COMMIT, then emit Tier 2 auth.user.created (new users) and
 *      Tier 1 auth.admin.bootstrapped (bootstrap path). Post-TX so
 *      audits never fire when the TX rolled back (V4 FIX 23).
 *   7. Hand off to finalizeBrowserOAuthMint placeholder (T16c).
 */
async function finalizeBrowserOAuth(
  res: ServerResponse,
  ctx: AuthHandlerContext,
  exchange: ExchangeCodeResult,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  // GitHub uses idp_user_id as the stable login identifier; fall back to
  // ip if neither is meaningful (T44 V2 §A.8 wording: "idp_user_login or ip").
  const lockoutIdentifier = exchange.user.idp_user_id || ip || "unknown";
  const identifierHash = hashIdentifier(lockoutIdentifier);

  // 1. Login lockout pre-check (non-consuming peek). V2 §A.8: auth.login.locked
  //    Tier 1 audit emits on every request that hits the lockout (T12 itself
  //    doesn't emit — T16b owns the emission). This is the audit observation
  //    point for the lockout state; recordFailedLogin's locked=true is a dead
  //    branch in practice because peek blocks before the bucket can drain past
  //    threshold within a single request cycle.
  const lockState = isLocked(ctx.rateLimiter, identifierHash);
  if (lockState.locked) {
    audit("auth.login.locked", {
      tier: 1,
      metadata: { identifier_hash: identifierHash },
    });
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(lockState.retry_after_seconds ?? 900),
    });
    res.end(JSON.stringify(appError("LOGIN_LOCKED", "Too many failed login attempts")));
    return;
  }

  // 2. listMemberships via T04 cache.
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
        metadata: { phase: "callback_memberships" },
      });
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": bearerAuthHeader("invalid_token", "IdP token revoked"),
      });
      res.end(JSON.stringify(appError("IDP_TOKEN_REVOKED", "Identity provider rejected the token")));
      return;
    }
    if (err instanceof IdPTransientError) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError("IDP_UNAVAILABLE", "Identity provider temporarily unavailable")));
      return;
    }
    throw err;
  }

  // 3. Allowlist resolution (T09 — alphabetical tie-break, V4 FIX 22).
  //    On miss: record a failed login (consumes a token; the (threshold+1)th
  //    attempt is what trips the lockout, observed by the NEXT request's
  //    isLocked peek). Emit Tier 1 audit auth.login.denied.not_in_org.
  const allowlistMatch = resolveOrgFromMemberships(ctx.db, memberships);
  if (!allowlistMatch) {
    recordFailedLogin(ctx.rateLimiter, identifierHash);
    audit("auth.login.denied.not_in_org", {
      tier: 1,
      metadata: {
        idp_user_id_hash: hashIdpUserId(exchange.user.idp_user_id),
        identifier_hash: identifierHash,
        memberships_count: memberships.length,
      },
    });
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("NOT_IN_ALLOWLIST", "User is not in any allowlisted org")));
    return;
  }

  // 4. AUTO_PROVISION mode via T44 (orgId=null: pre-provisioning lookup, falls
  //    back to env then default "true"). Normalize to lowercase so operators
  //    setting COORDINATOR_AUTO_PROVISION=False/FALSE all route correctly.
  const autoProvision = String(
    getOrgSetting(ctx.db, null, "auto_provision", "true"),
  ).toLowerCase();

  // 5-6. BEGIN IMMEDIATE TX. The user-existence check for AUTO_PROVISION=false
  //      lives INSIDE the TX so it's atomic with the INSERT — a concurrent
  //      callback can't sneak in between SELECT and INSERT.
  let provisionResult: ProvisionResult;
  try {
    const tx = ctx.db.transaction((): ProvisionResult => {
      if (autoProvision === "false") {
        const existing = ctx.db
          .prepare(
            "SELECT id FROM users WHERE idp_provider = ? AND idp_user_id = ?",
          )
          .get("github", exchange.user.idp_user_id);
        if (!existing) {
          throw new ProvisioningDeniedError("USER_NOT_PROVISIONED");
        }
      }
      return provisionUser(
        ctx.db,
        ctx.clock,
        exchange.user,
        exchange.accessToken,
        {
          org_id: allowlistMatch.org_id,
          org_name: allowlistMatch.org_name,
        },
      );
    });
    provisionResult = tx.immediate();
  } catch (err) {
    if (err instanceof ProvisioningDeniedError) {
      audit("auth.login.failure", {
        tier: 2,
        metadata: {
          reason: "user_not_provisioned",
          idp_user_id_hash: hashIdpUserId(exchange.user.idp_user_id),
        },
      });
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError(
        "USER_NOT_PROVISIONED",
        "User must be provisioned by an admin before signing in",
      )));
      return;
    }
    throw err;
  }

  // Post-TX audits (V4 FIX 23: commit-then-audit — never emit for a
  // rolled-back TX). Order: user.created first (Tier 2), then
  // admin.bootstrapped (Tier 1) when applicable.
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

  // 7. Hand off to T16c (JWT mint + cookies + 302).
  await finalizeBrowserOAuthMint(res, ctx, provisionResult.user, ip, userAgent);
}

/**
 * T16c: complete the OAuth callback after T16b's provisioning TX commits.
 *
 * Flow:
 *   1. Compute SHA-256 fingerprint(ip|ua) via T16helpers (V3 §B-NEW-2 —
 *      consumed by T19b for stolen-token detection on refresh rotation).
 *      Null when both inputs are null.
 *   2. Generate 256-bit base64url CSRF token via T08.
 *   3. mintTokenPair (T16helpers): signs access + refresh JWTs and INSERTs
 *      the refresh_tokens row (single-statement INSERT is atomic; the prior
 *      provisionUser TX already committed when we land here).
 *   4. Tier 2 audit auth.login.success (V4 FIX 23 commit-then-audit; the
 *      token mint + refresh INSERT have already committed). Tier 2 because
 *      successful logins are high-volume operational, not security incidents.
 *   5. Emit __Host-coordinator_session (HttpOnly) + __Host-coordinator_csrf
 *      (NOT HttpOnly so JS can echo it for CSRF double-submit) + Max-Age=0
 *      expire of __Host-coordinator_oauth_state.
 *   6. 302 redirect to {publicUrl}/auth/success (V4 FIX 9 allowed HTML route).
 */
async function finalizeBrowserOAuthMint(
  res: ServerResponse,
  ctx: AuthHandlerContext,
  user: ProvisionedUser,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const fingerprint = computeFingerprint(ip, userAgent);
  const csrfToken = generateCsrfToken();

  const issuer = ctx.publicUrl.replace(/\/$/, "");
  const pair = await mintTokenPair(ctx.db, ctx.clock, {
    user,
    registry: ctx.signingKeys,
    issuer,
    fingerprint,
  });

  audit("auth.login.success", {
    tier: 2,
    metadata: {
      user_id: user.user_id,
      org_id: user.primary_org_id,
      role: user.role,
      family_id: pair.familyId,
    },
  });

  setSessionCookies(res, {
    accessJwt: pair.accessJwt,
    csrfToken,
    clearStateCookie: true,
  });

  res.writeHead(302, { Location: `${issuer}/auth/success` });
  res.end();
}

/**
 * Exported only for tests that exercise the T16b provisioning flow
 * directly without driving through the upstream state/CAS/exchange
 * stages. Production callers MUST use {@link handleOAuthCallback}.
 */
export { finalizeBrowserOAuth as __finalizeBrowserOAuth };

/**
 * Exported only for T16c tests that exercise the JWT mint + cookies +
 * redirect path directly, bypassing the T16b provisioning flow. Production
 * callers MUST use {@link handleOAuthCallback}.
 */
export { finalizeBrowserOAuthMint as __finalizeBrowserOAuthMint };
