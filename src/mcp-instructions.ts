/**
 * Server `instructions` — the only text this server contributes to an agent's
 * first turn.
 *
 * issue #271: Claude Code defers MCP tool definitions by default (tool search).
 * At session start only tool NAMES and the server's `instructions` enter
 * context; schemas are materialised on demand. `createMcpServer()` passed no
 * `instructions`, so the daemon had no first-turn discovery surface at all.
 *
 * The measurement that motivated this is worth keeping in mind before editing
 * the text: the same imperative wording, word for word, fires 0/3 from a tool
 * DESCRIPTION (deferred or fully loaded) and 5/5 from here. The channel is the
 * variable, not the prose. Making the sentences louder is not the lever.
 *
 * Two hard constraints:
 *
 *   1. Claude Code truncates `instructions` at 2 KB. Anything past that is
 *      simply not read — see the size assertion in the tests.
 *   2. Every tool name below has to exist. The agent resolves them by literal
 *      string, and this repo has already shipped a documented-but-nonexistent
 *      tool once (audit/09-protocole-mcp.md). A test pins the list against the
 *      server's real registrations.
 *
 * Deliberately absent: any heuristic about Claude Code versions or client
 * behaviour. This text describes the server, not its callers.
 */
export const MCP_INSTRUCTIONS = `mcp-coordinator keeps several coding agents working in the same repo from colliding.

Register once per session with register_agent, then, BEFORE you edit, create or delete any source file, call announce_work with the repo-relative paths you are about to touch. It answers with the agents already working on those files and opens a coordination thread when the work overlaps. Skipping it is how two agents end up rewriting the same function in parallel.

Choose an agent id that is stable across your sessions and unlikely to belong to anyone else: registering an id another agent already holds takes it over silently.

Reach for this server when you are about to change code, when you want to know who else is active, or when another agent is waiting on you.

- starting work: register_agent, announce_work, check_file_conflict, wait_for_peers
- staying aware: list_agents, hot_files, agent_activity, coordinator_status
- a thread you are in: get_thread, get_thread_updates, post_to_thread, propose_resolution, approve_resolution, contest_resolution, close_thread
- weighing a change: get_blast_radius, get_module_info

Tool schemas load on demand; the names above are the exact strings to search for. In the two-server push setup, the channel process registers a post_to_thread of its own — the one listed here is this coordinator's.`;
