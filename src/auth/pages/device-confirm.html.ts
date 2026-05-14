import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../context.js";
import { escapeHtml, sendHtml } from "../html.js";
import { generateCsrfToken } from "../csrf.js";
import { hostCookie, setCookies } from "../cookies.js";

interface DeviceRequestRow {
  device_code: string;
  user_code: string;
  approved_user_id: string | null;
  denied_at: number | null;
  expires_at: number;
  requester_ip: string | null;
  requester_user_agent: string | null;
  requester_country: string | null;
}

function buildPage(row: DeviceRequestRow, csrf: string): string {
  const ip = row.requester_ip ?? "unknown";
  const ua = row.requester_user_agent ?? "unknown";
  const country = row.requester_country ?? "unknown";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Confirm Device &mdash; mcp-coordinator</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.5rem; }
    dl dt { font-weight: 600; margin-top: 0.5rem; }
    dl dd { margin: 0; font-family: monospace; font-size: 0.9rem; }
    label { display: block; margin: 1rem 0; }
    button { font-size: 1rem; padding: 0.5rem 1rem; cursor: pointer; }
    .warn { color: #b50; margin-top: 1rem; }
  </style>
</head>
<body>
  <h1>Confirm sign-in</h1>
  <p>A device is asking to sign in. Verify it's yours before approving.</p>
  <dl>
    <dt>Device code</dt>
    <dd>${escapeHtml(row.user_code)}</dd>
    <dt>Requested from</dt>
    <dd>IP: ${escapeHtml(ip)}</dd>
    <dt>User agent</dt>
    <dd>${escapeHtml(ua)}</dd>
    <dt>Approximate location</dt>
    <dd>${escapeHtml(country)}</dd>
  </dl>
  <p class="warn">Approve only if you recognize this device. If you didn't initiate this sign-in, deny it.</p>
  <form method="POST" action="/auth/device/approve">
    <input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="user_code" value="${escapeHtml(row.user_code)}">
    <label>
      <input type="checkbox" name="acknowledge" required>
      I recognize this device.
    </label>
    <button type="submit" name="action" value="approve">Approve</button>
    <button type="submit" name="action" value="deny" formnovalidate>Deny</button>
  </form>
</body>
</html>`;
}

type ErrorReason = "missing" | "invalid_code" | "expired" | "consumed";

function buildErrorPage(reason: ErrorReason): string {
  const messages: Record<ErrorReason, string> = {
    missing: "No device code provided. Go back to /auth/device to enter one.",
    invalid_code: "That device code wasn't recognized.",
    expired: "That device code has expired. Request a new one from your device.",
    consumed: "That device code was already approved or denied.",
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Device code error &mdash; mcp-coordinator</title>
  <style>body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; }</style>
</head>
<body>
  <h1>Couldn't continue</h1>
  <p>${escapeHtml(messages[reason])}</p>
  <p><a href="/auth/device">Try again</a></p>
</body>
</html>`;
}

/**
 * GET /auth/device/confirm?user_code=XXXX-XXXX — consent page.
 *
 * Looks up the device_auth_requests row by user_code. If the row is
 * missing/expired/already-resolved, renders a friendly error page.
 *
 * Mints a per-user_code CSRF token (V3 §B-NEW-9 phishing defense:
 * distinct CSRF token per user_code, not per session — prevents replay
 * of an old CSRF token across different device codes). Cookie is
 * Max-Age=600s matching the device_auth_requests TTL.
 *
 * The page does NOT authenticate the user yet — T20's POST handler does
 * that (cookie session → approver identity → audit row).
 */
export async function handleDeviceConfirmPage(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AuthHandlerContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const userCode = url.searchParams.get("user_code");
  if (!userCode) {
    sendHtml(res, 400, buildErrorPage("missing"));
    return;
  }

  // Inspect-then-lookup: if row missing OR expired OR consumed/denied
  // we want a specific error code, not just a 404. Single SELECT pulls
  // every column needed both for the gate logic and for the rendered
  // page (avoids a race-window between two queries).
  const row = ctx.db
    .prepare(
      `SELECT device_code, user_code, approved_user_id, denied_at, expires_at,
              requester_ip, requester_user_agent, requester_country
       FROM device_auth_requests
       WHERE user_code = ?`,
    )
    .get(userCode) as DeviceRequestRow | undefined;

  const now = ctx.clock.now();

  if (!row) {
    sendHtml(res, 400, buildErrorPage("invalid_code"));
    return;
  }
  if (row.expires_at <= now) {
    sendHtml(res, 400, buildErrorPage("expired"));
    return;
  }
  if (row.approved_user_id !== null || row.denied_at !== null) {
    sendHtml(res, 409, buildErrorPage("consumed"));
    return;
  }

  const csrf = generateCsrfToken();
  const cookie = hostCookie("__Host-coordinator_csrf", csrf, {
    httpOnly: false,
    sameSite: "Strict",
    maxAge: 600,
  });
  setCookies(res, [cookie]);

  sendHtml(res, 200, buildPage(row, csrf));
}
