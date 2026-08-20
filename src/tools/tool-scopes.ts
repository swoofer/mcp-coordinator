import type { AuthClaims } from "../auth.js";
import type { ServiceTokenScope } from "../auth/service-tokens.js";

/**
 * Which scope each MCP tool requires (#313).
 *
 * `ServiceTokenScope` was validated at minting, signed into the JWT, and — until
 * the claim was carried through verification — discarded. This is the other
 * half: the table that gives the claim meaning, and the check that applies it.
 *
 * WHERE THE CHECK LIVES, and why it is not the HTTP gate. The issue proposes
 * `BearerAuthOptions.requiredScopes`. That cannot work here, for two reasons
 * and only the second is about types:
 *
 *  - `/mcp` is ONE endpoint. Authentication runs in serve-http before
 *    `transport.handleRequest`, while the JSON-RPC body is still an unread
 *    stream. The tool name does not exist yet at the moment the authorization
 *    decision would be made. Buffering and peeking at the body to recover it
 *    would put a reinjection hazard on the hot path of every request.
 *  - `requiredScopes` is a fixed per-gate list, typed on Web `Request` /
 *    `Response`, while this gate is `node:http`.
 *
 * There is also a positive argument the issue does not make: HTTP is the wrong
 * GRANULARITY. A 403 rejects the request, and on a multiplexed endpoint the
 * request is the transport. A read token calling a write tool should be told
 * no about that tool and remain free to call a read tool next — which is a
 * per-call answer, i.e. a JSON-RPC error. That is also what this codebase
 * already does for the sibling failure: every tool throws for missing claims.
 *
 * FAIL-OPEN FOR EVERYTHING THAT IS NOT A SERVICE TOKEN. Only
 * `service-token issue` mints a scope. Phase 1 agent tokens, Phase 2 cookie
 * sessions and stdio's synthetic claims carry none, and must keep working
 * exactly as before — a coordinator upgrade that started refusing them would
 * break every existing deployment. `undefined` therefore means unrestricted,
 * not "least privilege".
 */

/** Ordered weakest to strongest. A scope grants everything at or below it. */
const RANK: Record<ServiceTokenScope, number> = { read: 0, write: 1, admin: 2 };

/**
 * The 26 registered tools.
 *
 * `read` is pure observation. `write` mutates coordination state — including
 * three cases worth naming because they do not look like writes:
 *
 *  - `heartbeat` and `register_agent` update the agent registry. An observer
 *    that only watches does neither.
 *  - `wait_for_message` and `get_queued_messages` DRAIN the queue. There is no
 *    ack, so reading a message consumes it for everyone; that is a mutation
 *    however it is spelled.
 *
 * No tool is `admin`. `set_dependency_map` is the closest — it replaces the
 * whole map — but it is coordination state like the rest, and reserving
 * `admin` for the HTTP admin surface keeps the three levels meaning something
 * distinct.
 */
export const TOOL_SCOPES: Record<string, ServiceTokenScope> = {
  // agents-tools
  register_agent: "write",
  list_agents: "read",
  heartbeat: "write",
  agent_activity: "read",
  // consultation-tools
  announce_work: "write",
  post_to_thread: "write",
  propose_resolution: "write",
  approve_resolution: "write",
  contest_resolution: "write",
  close_thread: "write",
  cancel_thread: "write",
  get_thread: "read",
  get_thread_updates: "read",
  list_threads: "read",
  log_action_summary: "write",
  // dependencies-tools
  set_dependency_map: "write",
  get_blast_radius: "read",
  get_module_info: "read",
  // files-tools
  hot_files: "read",
  get_session_files: "read",
  check_file_conflict: "read",
  // mqtt-tools
  wait_for_message: "write",
  get_queued_messages: "write",
  mqtt_publish: "write",
  // status-tools
  coordinator_status: "read",
  wait_for_peers: "read",
};

export function insufficientScopeError(tool: string, held: ServiceTokenScope): Error {
  const needed = TOOL_SCOPES[tool];
  return new Error(
    `This service token has scope "${held}" and ${tool} requires "${needed}". ` +
      `Scopes are set when the token is minted and cannot be widened at call time — ` +
      `issue a new one with: mcp-coordinator service-token issue --scope ${needed} ... ` +
      `Read-scoped tokens can call the read-only tools (${readOnlyToolList()}).`,
  );
}

function readOnlyToolList(): string {
  return Object.entries(TOOL_SCOPES)
    .filter(([, s]) => s === "read")
    .map(([t]) => t)
    .sort()
    .join(", ");
}

/**
 * Throw unless the caller's scope covers this tool.
 *
 * No-op when the claims carry no scope, which is every credential except a
 * service token — see the fail-open note above.
 */
export function requireScope(claims: AuthClaims, tool: string): void {
  const held = claims.scope;
  if (!held) return;
  const needed = TOOL_SCOPES[tool];
  // An unknown tool name means the table has drifted from the registrations.
  // Failing closed here would break a tool on a rename; a test keeps the two
  // in step instead.
  if (!needed) return;
  if (RANK[held] < RANK[needed]) throw insufficientScopeError(tool, held);
}
