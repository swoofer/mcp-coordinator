import type { IncomingMessage, ServerResponse } from "node:http";
import type { AuthHandlerContext } from "./context.js";
import { appError } from "../http/response-contract.js";

/**
 * POST /api/auth/oauth/device_authorization — RFC 8628 §3.1 device
 * authorization endpoint.
 *
 * STUB: real implementation lands in T17. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleDeviceAuthorization(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleDeviceAuthorization: stub awaits T17")));
}

/**
 * POST /auth/device/approve — user-facing form post that approves (or
 * denies) a pending device-authorization request.
 *
 * STUB: real implementation lands in T20. The stub returns 501 with a
 * structured app-error envelope so route registration can be tested
 * before the handler body exists.
 */
export async function handleDeviceApprove(
  _req: IncomingMessage,
  res: ServerResponse,
  _ctx: AuthHandlerContext,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(appError("NOT_IMPLEMENTED", "handleDeviceApprove: stub awaits T20")));
}
