# MCP Protocol Spec Conformance Audit

**Conformance Score: 6/10**

The codebase uses the official `@modelcontextprotocol/sdk@1.29.0`, so handshake/transport plumbing is correct by inheritance. Tool registration via `McpServer.tool()` produces well-formed JSON Schemas through Zod. However, the page (and several tool descriptions) advertise `2024-11-05` while the SDK negotiates up to `2025-11-25` — a documentation lie. Beyond that, no tools opt into cancellation, progress, structured errors, resources/prompts/completion capabilities, or `_meta` annotations the modern spec offers.

## Spec Gaps

1. **Outdated protocol claim** — `package.json:6` brands the project for spec `2024-11-05`-era thinking, but `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js:2` sets `LATEST_PROTOCOL_VERSION = '2025-11-25'`. The handshake will negotiate the latest the client supports; any docs/marketing referencing `2024-11-05` are stale and misleading.

2. **No progress reporting on long-running tools** — `wait_for_peers` (`src/server-setup.ts:453-493`) and `wait_for_message` (`src/server-setup.ts:497-507`) block for up to 30s/15s respectively without ever issuing `notifications/progress`. Spec §6.5 requires/encourages progress for any operation > a few hundred ms when the request advertises a `progressToken` in `_meta`. The handler never inspects `_meta.progressToken`.

3. **No cancellation support** — Same blocking tools ignore `notifications/cancelled`. There is no `AbortSignal` plumbing (`src/server-setup.ts:464-478` polls a `setTimeout` loop with no cancel hook). If a client cancels, the server keeps polling and still returns a result, violating §6.4.

4. **Errors stuffed into success envelopes** — `set_dependency_map` (`src/server-setup.ts:410-416`) calls `JSON.parse(modules)` with no try/catch; on bad JSON the SDK will surface a generic `-32603 Internal error` rather than the spec-recommended `isError: true` content envelope or a typed `-32602 Invalid params`. Same pattern in `post_to_thread`/`announce_work` (DB failures bubble as 500-equivalents).

5. **Custom introspection is not MCP-standard** — `IntrospectionManager` (`src/server-setup.ts:11,50,222`) exposes app-domain "introspection" semantics (impact-scoring of agents) that have nothing to do with MCP introspection (which is `tools/list`, `resources/list`, `prompts/list`). Naming will confuse spec-aware clients. There is no `serverInfo.instructions` field set on the `McpServer` constructor (`src/server-setup.ts:109-112`) either, which is the spec-blessed way to ship usage hints.

6. **Capabilities under-declared** — `new McpServer({name, version})` (`src/server-setup.ts:109`) leaves the SDK to advertise only `tools` capability defaults. No `resources`, `prompts`, `logging`, or `completions` capabilities are registered, yet the project clearly has resource-like data (threads, agents, hot files) that would be better modeled as MCP `resources` with URI templates than as 20+ read-only tools.

7. **Stdio mode lacks line-delimited safety** — `src/index.ts:23` connects raw `StdioServerTransport`. The SDK enforces line-delimited JSON correctly, but the `console.error("FATAL:", err)` on `index.ts:29` writes to stderr — fine — yet `services.logger` (`index.ts:25`) defaults to pino which writes to stdout, corrupting the JSON-RPC framing. Stdio mode requires *all* logging to stderr.

## Three Conformance Fixes

1. **Send progress + honor cancellation in blocking tools.** In `wait_for_peers`/`wait_for_message`, accept the SDK handler's second `extra` arg, read `extra.signal` (AbortSignal) and `extra._meta.progressToken`, and call `extra.sendNotification({method:"notifications/progress", params:{progressToken, progress, total}})` every poll. Abort on `signal.aborted`.

2. **Route stdio logging to stderr.** In `src/logger.ts`, when `process.env.MCP_TRANSPORT === "stdio"` (or detect via `!process.stdout.isTTY` + stdio entry), pass pino destination `2` (stderr). Otherwise stdio handshake breaks the moment any log line interleaves.

3. **Return `isError: true` content for tool failures.** Wrap each tool handler body in try/catch and on failure return `{isError: true, content: [{type:"text", text: err.message}]}` per spec §5.2. Today, throws become opaque `-32603` JSON-RPC errors, which clients can't surface to users gracefully.

DONE: C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\20-mcp-spec.md
