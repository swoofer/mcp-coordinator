import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import type { ExchangeCodeResult } from "./providers/types.js";
import { IdPTokenRevoked, IdPTransientError } from "./providers/errors.js";
import { consumeOAuthState } from "./oauth-state.js";
import { parseCookies } from "./cookies.js";
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
    const inspectRow = ctx.db
      .prepare("SELECT consumed_at, expires_at FROM oauth_state WHERE state = ?")
      .get(state) as { consumed_at: number | null; expires_at: number } | undefined;
    if (!inspectRow) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError("UNKNOWN_STATE", "State not recognized")));
      return;
    }
    if (inspectRow.consumed_at !== null) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError("STATE_ALREADY_CONSUMED", "This authorization was already completed")));
      return;
    }
    // Else expired
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("STATE_EXPIRED", "Authorization expired; please retry")));
    return;
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

async function finalizeBrowserOAuth(
  res: ServerResponse,
  _ctx: AuthHandlerContext,
  _exchange: ExchangeCodeResult,
  _ip: string | null,
  _userAgent: string | null,
): Promise<void> {
  // T16b/c implements provisioning + mint + cookies + redirect.
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "finalizeBrowserOAuth awaits T16b/c")));
}
