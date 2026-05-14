import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../context.js";
import { escapeHtml, sendHtml } from "../html.js";
import { generateCsrfToken } from "../csrf.js";
import { hostCookie, setCookies } from "../cookies.js";

/** Look up the user-friendly error string for a code from ?error=... */
function errorMessage(code: string): string {
  switch (code) {
    case "invalid_code":
      return "That code wasn't recognized. Check for typos and try again.";
    case "expired":
      return "That code has expired. Request a new one from your device.";
    case "consumed":
      return "That code was already used.";
    case "lockout":
      return "Too many failed attempts. Try again in 15 minutes.";
    default:
      return "Something went wrong. Try again.";
  }
}

function buildPage(errorMsg: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Enter Device Code &mdash; mcp-coordinator</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    input[name=user_code] { font-size: 1.25rem; letter-spacing: 0.15em; padding: 0.5rem; text-transform: uppercase; width: 100%; box-sizing: border-box; }
    button { font-size: 1rem; padding: 0.5rem 1rem; margin-top: 1rem; cursor: pointer; }
    .error { color: #c00; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Enter your device code</h1>
  <p>Type the code shown on the device that's signing in.</p>
  <form method="GET" action="/auth/device/confirm" autocomplete="off">
    <input name="user_code" pattern="[A-Z0-9-]{4,16}" maxlength="16" required autofocus aria-label="device code">
    <button type="submit">Continue</button>
  </form>
  ${errorMsg !== null ? `<p class="error">${escapeHtml(errorMsg)}</p>` : ""}
</body>
</html>`;
}

/**
 * GET /auth/device — user_code entry form.
 *
 * Unauthenticated page: a user with a device code first reaches this
 * page, types the code, then is redirected to /auth/device/confirm
 * (which performs the user-code lookup + authentication binding).
 *
 * Sets a CSRF cookie so the later /auth/device/approve POST (T20) can
 * verify the form submission came from the same browser session. Per
 * V4 CUT 2, the CSRF token is random double-submit (no HMAC layer).
 */
export async function handleDevicePage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const errorParam = url.searchParams.get("error");
  const errorMsg = errorParam !== null ? errorMessage(errorParam) : null;

  const csrf = generateCsrfToken();
  const cookie = hostCookie("__Host-coordinator_csrf", csrf, {
    httpOnly: false,
    sameSite: "Strict",
    maxAge: 600,
  });
  setCookies(res, [cookie]);

  sendHtml(res, 200, buildPage(errorMsg));
}
