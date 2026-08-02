/**
 * Shared error for MCP tool handlers when session claims are missing.
 * Prefer this over ad-hoc Error strings so callers get consistent remediation.
 */
export const MISSING_SESSION_CLAIMS_MESSAGE =
  "Session is missing user claims. This usually means your token expired or was issued before a JWT rotation. Try re-authenticating with: mcp-coordinator login";

export function unauthorizedError(
  reason: string = MISSING_SESSION_CLAIMS_MESSAGE,
): Error {
  return new Error(reason);
}
