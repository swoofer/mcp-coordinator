# API Design Audit — 26 MCP Tools Surface

**Score: 5/10** — Functional, but inconsistent naming, no error envelope, no pagination, schema leaks via stringified JSON.

## Surface Overview
26 tools across 6 groups (registry, consultation, file, dependency, status, MQTT). Granularity is roughly right for an MCP surface, but several tools could merge and a few are missing critical features (pagination, error codes, idempotency keys).

## API Issues

### 1. Naming inconsistency — verbs, nouns, and abbreviations mixed
`server-setup.ts:116-516` mixes imperatives (`register_agent`, `announce_work`, `post_to_thread`), bare nouns (`hot_files:385`, `coordinator_status:434`, `agent_activity:153`), and underscored compounds (`mqtt_publish:516`). LLM tool selection suffers — `agent_activity` reads as a getter while `heartbeat:135` is the writer for the same data. Convention should be `verb_resource` (e.g. `list_hot_files`, `get_coordinator_status`, `get_agent_activity`).

### 2. No structured error envelope — every response is a JSON blob in a text field
Every tool returns `{ content: [{ type: "text", text: JSON.stringify(x) }] }` (e.g. `server-setup.ts:125, 132, 285, 422`). There is **no discriminated union** for success/error, no error codes, no machine-readable status. Failures fall through as raw thrown exceptions or silent `null` returns (`get_thread:347` returns `null` if missing — caller can't distinguish "missing" from "invalid id"). A consistent `{ ok: true, data } | { ok: false, error: { code, message } }` envelope is needed.

### 3. Stringified JSON inside JSON — schema leak and double-encoding
`Agent.modules` is typed `string` (JSON array) at `types.ts:7`, and tools return it raw — clients must `JSON.parse(agent.modules)` themselves (see `coordinator_status:441` doing exactly that server-side). Same for `Thread.target_modules`, `target_files`, `expected_respondents`, `conflicts`, `depends_on_files`, `exports_affected` (`types.ts:32-45`). The wire format leaks the SQLite storage choice. Tools should deserialize before returning.

### 4. No pagination on list endpoints — unbounded result sets
`list_threads:361`, `list_agents:128`, `hot_files:385`, `get_thread_updates:353`, `agent_activity:153`, `get_queued_messages:509` all return full collections with no `limit`/`offset`/`cursor`. After weeks of operation `list_threads({status:"resolved"})` will dump thousands of rows in a single MCP response (eating context). Cursor-based pagination is the standard answer.

### 5. Idempotency hazards — register_agent and announce_work are not safe to retry
`register_agent:116` calls `registry.register` then `sseEmitter.emit("agent_online")` and `mqttBridge.registerAgent` — re-running on retry triggers duplicate online events. `announce_work:160` is even worse: a retry would create a **second thread**, re-run conflict detection, re-emit `thread_opened` and `impact_scored` for every gray_zone agent, and create duplicate introspection records (`server-setup.ts:222`). No `idempotency_key` parameter, no dedup logic.

### 6. Missing tool from listed group — `respond_to_introspection` exists in `IntrospectionManager` (`introspection.ts:33`) but is **not exposed as an MCP tool**. Gray-zone agents receive `introspection_requested` SSE events but have no MCP tool to respond — surface gap.

### 7. `set_dependency_map:410` takes a stringified JSON parameter (`modules: z.string()`) instead of `z.record(...)`. Schema validation is bypassed; clients can send malformed JSON that only fails at `JSON.parse:414`. Should be `z.record(z.object({...ModuleInfo}))`.

### 8. No versioning strategy — schemas evolve via breaking changes
No `apiVersion` field, no deprecation markers, no `schemaVersion` on responses. Adding a required field to `announce_work` (e.g. `assigned_to:169` was added later) silently breaks older clients. Tool descriptions should encode minor version, or tools should accept an `api_version` hint.

### 9. `wait_for_peers:453` and `wait_for_message:497` block the MCP request for up to 30s/15s — long-poll over MCP burns the per-request budget and can stall the session. Should be event-subscription via SSE, not blocking RPC.

### 10. Tool descriptions too terse for LLM disambiguation
`heartbeat` vs `agent_activity` vs `register_agent` — descriptions at lines 116, 135, 153 don't tell an LLM **when** to choose one over another. `close_thread:324` vs `cancel_thread:334` vs `approve_resolution:302` — no guidance on the difference. `announce_work:160` description is single-line but the tool has 9 parameters with subtle semantics.

## Three Highest-Impact Improvements

1. **Adopt a structured response envelope** with discriminated `ok: true|false`, error codes (`NOT_FOUND`, `CONFLICT`, `INVALID_INPUT`, `IDEMPOTENT_REPLAY`), and **deserialize all JSON-string fields server-side** (`types.ts:7,32-45`). Single biggest correctness + DX win.

2. **Add pagination + idempotency keys** to all writes/lists. `announce_work`, `register_agent`, `post_to_thread` accept `idempotency_key`; `list_*` accept `cursor`/`limit` and return `next_cursor`. Prevents duplicate threads on retry and unbounded context blowup.

3. **Rename for consistency + expand descriptions**. Use `verb_resource` everywhere (`get_hot_files`, `get_coordinator_status`, `update_heartbeat`); expand each tool description to 2-3 sentences covering when to use vs. its neighbors. Add the missing `respond_to_introspection` tool to close the surface gap.

DONE. Path: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\08-api-design.md`
