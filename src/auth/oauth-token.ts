import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";

/**
 * POST /api/auth/oauth/token — RFC 6749 §5 token endpoint
 * (authorization_code, refresh_token, urn:ietf:params:oauth:grant-type:device_code).
 *
 * STUB: real implementation lands in T18. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleOAuthToken(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleOAuthToken: stub awaits T18")));
}
