import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import { generateVerifier, computeChallenge } from "./pkce.js";
import { createOAuthStateWithVerifier } from "./oauth-state.js";
import { hostCookie, setCookies } from "./cookies.js";
import { appError } from "../http/response-contract.js";

const STATE_COOKIE_NAME = "__Host-coordinator_oauth_state";
const STATE_COOKIE_MAX_AGE_S = 600;

const RATE_LIMIT_CONFIG = { per: 30, window_seconds: 60 } as const;

/**
 * Canonical state-cookie HMAC construction per V4 FIX 19 + V2 §C.10:
 *
 *   message = "state-v1" || 0x00 || state
 *   hmac    = HMAC-SHA-256(state_binding_key, message)
 *   cookie  = base64url(hmac)
 *
 * Domain separator "state-v1" + null byte prevents cross-purpose HMAC
 * collisions (e.g., a future "csrf-v1" usage of the same key produces
 * different output for the same state value).
 */
function bindState(state: string, key: Buffer): string {
  const message = Buffer.concat([
    Buffer.from("state-v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(state, "utf8"),
  ]);
  return crypto.createHmac("sha256", key).update(message).digest("base64url");
}

/**
 * GET /auth/login — OAuth flow init.
 *
 * Phase 2 single-provider: redirects to GitHub authorize URL with state +
 * PKCE S256 code_challenge. The state cookie is HMAC-bound (V4 FIX 19)
 * so the callback can verify the state came from this server, not a
 * forged/replayed query parameter.
 *
 * Cookie SameSite=Lax (NOT Strict): the GitHub redirect back to
 * /api/auth/oauth/callback is cross-site, and Strict would drop the
 * cookie. Lax is enough — the cookie is only read on the callback's
 * top-level navigation, not on cross-site fetches.
 */
export async function handleAuthLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  // Rate limit (per IP). req.socket may be absent in synthetic tests;
  // fall back to a constant bucket so the limiter still engages.
  const ip = req.socket?.remoteAddress ?? "unknown";
  const rate = ctx.rateLimiter.check(`auth-login:${ip}`, RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rate.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many login attempts")));
    return;
  }

  // T46: resolve provider via the registry. Phase 2 always uses the
  // implicit default (GitHub). Future picker UI (T48) will pass an
  // explicit ?provider= query param.
  const provider = ctx.providers.getDefault();
  if (!provider) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(appError("NO_IDP_CONFIGURED", "No IdP provider is registered")));
    return;
  }

  // PKCE — generate verifier (256-bit, base64url) + S256 challenge.
  const codeVerifier = generateVerifier();
  const codeChallenge = computeChallenge(codeVerifier);

  // Persist state + verifier. Normalize trailing slash on publicUrl so
  // the redirect_uri sent to the IdP is canonical (GitHub/Google match exactly).
  const redirectUri = `${ctx.publicUrl.replace(/\/$/, "")}/api/auth/oauth/callback`;
  const { state } = createOAuthStateWithVerifier(
    ctx.db,
    ctx.clock,
    provider.name,
    redirectUri,
    codeVerifier,
  );

  // HMAC-bound state cookie (V4 FIX 19). The callback recomputes this
  // HMAC over the query-param state and compares via timingSafeEqual.
  const cookieValue = bindState(state, ctx.stateBindingKey);
  const stateCookie = hostCookie(STATE_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: STATE_COOKIE_MAX_AGE_S,
  });
  setCookies(res, [stateCookie]);

  // Build IdP authorize URL with state + S256 challenge.
  const authUrl = provider.buildAuthUrl(state, redirectUri, codeChallenge);

  res.writeHead(302, { Location: authUrl });
  res.end();
}
