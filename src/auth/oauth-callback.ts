import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";

/**
 * GET /api/auth/oauth/callback — OAuth provider redirect target.
 *
 * STUB: real implementation lands in T16a/b/c (state validation, code
 * exchange, session mint). The stub returns 501 with a structured
 * app-error envelope so route registration can be tested before the
 * handler body exists.
 */
export async function handleOAuthCallback(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleOAuthCallback: stub awaits T16")));
}
