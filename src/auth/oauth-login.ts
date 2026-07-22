import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import type { AuthHandlerContext } from "./context.js";
import { generateVerifier, computeChallenge } from "./pkce.js";
import { createOAuthStateWithVerifier } from "./oauth-state.js";
import { hostCookie, setCookies } from "./cookies.js";
import { sendHtml } from "./html.js";
import { renderLoginPicker } from "./pages/login-picker.html.js";
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
 * Provider selection (T49):
 *   - 0 providers registered    -> 500 NO_IDP_CONFIGURED
 *   - 1 provider                -> redirect straight to authorize URL
 *   - 2+ providers, no ?provider -> render picker page (the user
 *                                  clicks a button which re-issues GET
 *                                  /auth/login?provider=<name>)
 *   - 2+ providers, ?provider=X -> validate name is registered;
 *                                  unknown name -> 400 UNKNOWN_PROVIDER
 *                                  (does NOT silently fall back to the
 *                                  default -- an explicit but wrong
 *                                  selection is a user-visible bug)
 *
 * Once a provider is selected, the flow is identical: PKCE verifier +
 * S256 challenge, oauth_state row, HMAC-bound state cookie (V4 FIX 19),
 * 302 to authorize URL. The state row stores provider.name so the
 * callback knows which IdP issued the code.
 *
 * Cookie SameSite=Lax (NOT Strict): the IdP redirect back to
 * /api/auth/oauth/callback is cross-site, and Strict would drop the
 * cookie. Lax is enough -- the cookie is only read on the callback's
 * top-level navigation, not on cross-site fetches.
 */
export async function handleAuthLogin(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  // Rate limit (per IP). req.socket may be absent in synthetic tests;
  // fall back to a constant bucket so the limiter still engages. The
  // picker render itself consumes a rate-limit token even though it
  // does no DB work; that's intentional -- /auth/login is the
  // entry-point both for picker renders and for actual flow init, and
  // a 60/min burst is generous enough that legitimate users never hit
  // it.
  const ip = req.socket?.remoteAddress ?? "unknown";
  const rate = await ctx.rateLimiter.check(`auth-login:${ip}`, RATE_LIMIT_CONFIG);
  if (!rate.allowed) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(rate.retry_after_seconds),
    });
    res.end(JSON.stringify(appError("RATE_LIMITED", "Too many login attempts")));
    return;
  }

  // T49: select provider. ?provider= takes precedence; otherwise the
  // registry default; otherwise the picker page when ambiguous.
  const url = new URL(req.url ?? "/", "http://localhost");
  const requestedProvider = url.searchParams.get("provider");

  let provider;
  if (requestedProvider !== null) {
    provider = ctx.providers.get(requestedProvider);
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(appError("UNKNOWN_PROVIDER", `Unknown provider: ${requestedProvider}`)),
      );
      return;
    }
  } else if (ctx.providers.size() > 1) {
    // Multiple providers + no explicit selection -> render picker.
    sendHtml(res, 200, renderLoginPicker(ctx.providers.names()));
    return;
  } else {
    provider = ctx.providers.getDefault();
    if (!provider) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(appError("NO_IDP_CONFIGURED", "No IdP provider is registered")));
      return;
    }
  }

  // PKCE — generate verifier (256-bit, base64url) + S256 challenge.
  const codeVerifier = generateVerifier();
  const codeChallenge = computeChallenge(codeVerifier);

  // T55 (v0.10.1): OIDC nonce. 256-bit base64url random; bound to
  // oauth_state and verified against id_token.nonce on callback.
  // Generated unconditionally so providers that don't use OIDC just
  // ignore the value; OIDCProvider passes it through to its
  // authorize URL and verifies it in exchangeCode.
  const nonce = crypto.randomBytes(32).toString("base64url");

  // Persist state + verifier. Normalize trailing slash on publicUrl so
  // the redirect_uri sent to the IdP is canonical (GitHub/Google match exactly).
  const redirectUri = `${ctx.publicUrl.replace(/\/$/, "")}/api/auth/oauth/callback`;
  const { state } = createOAuthStateWithVerifier(
    ctx.db,
    ctx.clock,
    provider.name,
    redirectUri,
    codeVerifier,
    nonce,
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

  // Build IdP authorize URL with state + S256 challenge + nonce.
  const authUrl = await provider.buildAuthUrl(state, redirectUri, codeChallenge, nonce);

  res.writeHead(302, { Location: authUrl });
  res.end();
}
