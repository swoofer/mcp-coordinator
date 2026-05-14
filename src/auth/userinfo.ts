import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";

/**
 * GET /api/auth/me — return the authenticated subject's profile
 * (OIDC userinfo-equivalent, scoped to the org from the session).
 *
 * STUB: real implementation lands in T24. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleUserinfo(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleUserinfo: stub awaits T24")));
}
