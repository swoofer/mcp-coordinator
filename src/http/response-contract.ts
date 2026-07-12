import { getRequestId } from "../auth/request-id.js";

const WWW_AUTH_REALM = "coordinator";

/**
 * Build a WWW-Authenticate header value per RFC 6750 §3.
 *
 *   bearerAuthHeader() → `Bearer realm="coordinator"`
 *   bearerAuthHeader("invalid_token", "Token expired")
 *     → `Bearer realm="coordinator", error="invalid_token", error_description="Token expired"`
 *   bearerAuthHeader("insufficient_scope", "Admin scope required", "admin")
 *     → `... scope="admin"` added
 *
 * Per V4 FIX 13, OAuth-token endpoint (RFC 6749 §5.2) errors return JSON
 * with no WWW-Authenticate header — that's for resource-server 401s.
 */
export function bearerAuthHeader(
  err?: "invalid_token" | "insufficient_scope",
  description?: string,
  scope?: string,
): string {
  let h = `Bearer realm="${WWW_AUTH_REALM}"`;
  if (err) h += `, error="${err}"`;
  if (description) h += `, error_description="${escapeQuoted(description)}"`;
  if (scope) h += `, scope="${scope}"`;
  return h;
}

/**
 * RFC 6749 §5.2 OAuth token error envelope: returned with HTTP 400 from
 * /api/auth/oauth/token endpoint. The standardized `error` codes are:
 * invalid_request, invalid_client, invalid_grant, unauthorized_client,
 * unsupported_grant_type, invalid_scope. RFC 6750 §3.1 adds the
 * Bearer resource-server codes (invalid_token, insufficient_scope) for
 * 401/403 responses with WWW-Authenticate.
 */
export interface OAuthError {
  error: string;
  error_description?: string;
  error_uri?: string;
}

export function oauthError(error: string, description?: string, uri?: string): OAuthError {
  const body: OAuthError = { error };
  if (description !== undefined) body.error_description = description;
  if (uri !== undefined) body.error_uri = uri;
  return body;
}

/**
 * Coordinator app-error envelope: returned from non-OAuth endpoints.
 * Request ID is auto-injected from T10's getRequestId() so clients can
 * cross-reference with server logs (request_id is null when called
 * outside withRequestId, e.g., from unit tests).
 */
export interface AppError {
  code: string;
  message: string;
  request_id: string | null;
  details?: Record<string, unknown>;
}

export function appError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  const body: AppError = {
    code,
    message,
    request_id: getRequestId() ?? null,
  };
  if (details !== undefined) body.details = details;
  return body;
}

/** Escape backslashes and double quotes in WWW-Authenticate error_description values. */
function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
