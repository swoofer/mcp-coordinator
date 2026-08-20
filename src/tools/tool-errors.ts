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
 * #325: those are not one cause, and they used to produce one message. Handlers
 * call `getSessionClaims(ctx.sessionId ?? "")`, so "the transport gave us no
 * session id at all" and "it gave us one this process has never seen" collapse
 * into the same empty result — and the advice that fits one does not fit the
 * other:
 *
 *  - NO SESSION ID means the transport is running sessionless. That is a
 *    supported construction of the MCP server (`sessionIdGenerator: undefined`),
 *    and under it every tool fails, permanently. Reconnecting does not help;
 *    the deployment has to change.
 *  - AN UNKNOWN SESSION ID is the ordinary closed-or-swept case, where
 *    reconnecting is exactly right. It is ALSO what a replicated deployment
 *    produces: `sessionClaims` is an in-process Map while multi-instance
 *    shipped (`COORDINATOR_REDIS_URL`), so a session opened against instance A
 *    is unknown to instance B even with a perfectly valid token.
 *
 * Telling them apart is all this does. Fixing either is #325's open question,
 * and it is larger than the issue frames it: the replacement it names,
 * `BaseContext.http.authInfo`, is a field this server never populates —
 * `authInfo` appears nowhere in `src/` or `cli/`, because the coordinator
 * authenticates at its own HTTP gate and injects claims itself. Building a
 * fallback on it today would produce code that never runs.
 */
export function missingClaimsError(sessionId?: string): Error {
  if (!sessionId) {
    return new Error(
      "This MCP request carried no session id, so it cannot be scoped to an org. " +
        "That is what a sessionless transport looks like — an MCP server constructed with " +
        "sessionIdGenerator: undefined — and under it every coordinator tool fails the same " +
        "way, so reconnecting will not help. Run the server with session ids enabled, or use " +
        "stdio, which supplies its own claims. " +
        "See https://github.com/swoofer/mcp-coordinator/issues/325",
    );
  }
  return new Error(
    "This MCP session is not carrying auth claims, so the request cannot be scoped to an org. " +
      "The session was most likely closed, or swept after being idle longer than " +
      "COORDINATOR_MCP_SESSION_TTL_MS (default 30 minutes). " +
      "Reconnect your MCP client to start a new session and retry. " +
      "If this coordinator runs replicated, note that sessions are held in-process and are not " +
      "shared between instances, so a session opened against another replica looks exactly " +
      "like this one. See https://github.com/swoofer/mcp-coordinator/issues/325",
  );
}
