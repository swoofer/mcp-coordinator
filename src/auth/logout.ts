import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";

/**
 * POST /api/auth/logout — revoke the caller's current session/refresh
 * token and clear cookies.
 *
 * STUB: real implementation lands in T23. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleLogout(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleLogout: stub awaits T23")));
}

/**
 * POST /api/auth/logout-all — revoke all refresh tokens for the caller's
 * subject (bump the token-epoch).
 *
 * STUB: real implementation lands in T23. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleLogoutAll(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleLogoutAll: stub awaits T23")));
}

/**
 * POST /api/auth/revoke — RFC 7009 token-revocation endpoint.
 *
 * STUB: real implementation lands in T23. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleRevoke(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleRevoke: stub awaits T23")));
}
