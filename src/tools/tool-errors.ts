/**
 * Shared error shapes for MCP tool handlers.
 */

/**
 * Every tool handler starts by looking up the claims captured for its MCP
 * session. When that lookup comes back empty the handler cannot proceed, and
 * for a long time it threw `"Session has no captured claims (auth bug)"` —
 * internal jargon, 26 times over, with no hint what to do (issue #99).
 *
 * "auth bug" was also misleading. Nothing is broken. Tracing where claims come
 * from:
 *
 *  - stdio (`src/index.ts`) hands every call synthetic claims, so this state is
 *    unreachable there by construction.
 *  - HTTP (`src/serve-http.ts`) stashes claims in `sessionClaims` keyed by the
 *    MCP session id, once `initialize` has assigned one. The idle sweeper then
 *    closes sessions quiet for longer than `COORDINATOR_MCP_SESSION_TTL_MS`
 *    (default 30 min), which evicts their claims.
 *
 * So the reachable causes are a session that was closed or swept, or a tool
 * called before `initialize` finished — not an expired token, and not something
 * a re-login would fix. (The issue proposed pointing users at
 * `mcp-coordinator login`; no such command exists.)
 *
 * The remedy is the same in every case: reconnect and get a fresh session.
 */
export function missingClaimsError(): Error {
  return new Error(
    "This MCP session is not carrying auth claims, so the request cannot be scoped to an org. " +
      "The session was most likely closed, or swept after being idle longer than " +
      "COORDINATOR_MCP_SESSION_TTL_MS (default 30 minutes). " +
      "Reconnect your MCP client to start a new session and retry.",
  );
}
