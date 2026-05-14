import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "../context.js";
import { sendHtml } from "../html.js";

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signed in &mdash; mcp-coordinator</title>
  <style>body { font-family: system-ui, sans-serif; max-width: 30rem; margin: 4rem auto; padding: 0 1rem; text-align: center; }</style>
</head>
<body>
  <h1>You're signed in.</h1>
  <p>You can close this window.</p>
</body>
</html>`;

/**
 * GET /auth/success — minimal post-OAuth landing page.
 *
 * Reached by 302 redirect from /api/auth/oauth/callback (T16c) after a
 * successful sign-in. The page is static; the session cookie set on
 * callback is what actually authenticates subsequent requests.
 */
export async function handleSuccessPage(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  sendHtml(res, 200, PAGE);
}
