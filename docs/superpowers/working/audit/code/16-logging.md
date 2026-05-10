# Logging / Observability Audit

**Score: 5 / 10**

Pragmatic dual-backend setup (custom console JSON logger for the Bun binary, Pino in Node) with consistent component child loggers (`http`, `mcp`, `auth`, `mqtt`, `mqtt-broker`, `consultation`, `conflict`, `quota`). Levels are sane, polling endpoints are correctly demoted to debug. The custom JSON logger has a silent data-loss bug with `Error` objects; Pino is unconfigured (no redaction, no serializers); there is no request correlation across HTTP / MCP / MQTT; and one fatal path bypasses the logger entirely.

---

## Issues

### 1. Stack traces are silently dropped in the Bun binary
`src/logger.ts:27-33` — `JSON.stringify({ ...data })` is called on `args[0]`, but `Error` props (`message`, `stack`) are non-enumerable. So `log.error({ err }, "JWT verification error")` from `auth.ts:98`, `mqtt-bridge.ts:81`, `serve-http.ts:775,816` produces `{"err":{}}` in production. Every error logged in the compiled binary loses its stack. Fix: detect `Error` instances and serialize `{ message, stack, name }` explicitly (Pino does this via its built-in `err` serializer; the console fallback does not).

### 2. Pino is created with zero redaction or serializers
`src/logger.ts:55` — `pino({ level, transport })`. No `redact: ['req.headers.authorization', '*.token', '*.registration_secret']`, no custom `err` serializer. If anyone ever passes `req.headers` or a token-bearing object to the logger, JWTs and registration secrets are written verbatim. The auth code is currently disciplined (only `agent_name`, `ip`, `reason` are logged), but there is no defense in depth.

### 3. `console.error` bypasses the logger
`src/index.ts:29` — `console.error("FATAL:", err)` in the stdio entrypoint. Loses structured fields, level routing, and JSON output. Should be `createLogger().fatal({ err }, "Fatal startup error")` mirroring `serve-http.ts:816`.

### 4. No request correlation ID across components
A single `announce_work` call hits `http` -> `mcp` -> `consultation` -> `mqtt-bridge`, each emitting their own log line, with no shared `req_id`/`trace_id`. `serve-http.ts:97` logs `agent_id` only; `consultation.ts:120` logs `thread_id` only; `mqtt-bridge.ts:81` logs neither. Reconstructing one request's path requires cross-referencing timestamps.

### 5. MCP "Tool called" info logs are very noisy and leak user content
`src/server-setup.ts:121,171,274,294,306,318,329,339,462` — every tool invocation emits an info-level line. `announce_work` (line 171) logs `subject` and `target_files`, which contain raw user-supplied strings (paths, free text). For long-running raids this is the dominant log volume and includes content the operator may consider sensitive (file paths leak project structure). Demote routine tool calls to debug; reserve info for state-changing outcomes (resolution, claim, revoke).

### 6. Inconsistent error shape between code paths
`src/mqtt-broker.ts:68` logs `err: err.message` (string), while `auth.ts:98` and `serve-http.ts:775` log `{ err }` (whole Error object). Downstream JSON consumers (Loki, Vector, dashboard) cannot apply a single parser. Pick one shape (`err: { message, stack, name }`) and enforce it via a serializer.

### 7. `LoggerOptions.pretty` is dead code
`src/logger.ts:58-77` — `LoggerOptions` declares `pretty?: boolean`, but `createPinoLogger` ignores it and instead reads `process.env.NODE_ENV === "development"` (line 51). The option cannot actually be used. Either honour the option or remove it.

### 8. `silentLogger` mask hides MQTT bridge failures during construction
`src/mqtt-bridge.ts:23` and `consultation.ts:28` default to `silentLogger` when no logger is passed. `MqttBridge` is always constructed with one in `server-setup.ts:54`, so the fallback only matters in tests, but the pattern means a forgotten `logger.child(...)` argument silently disables observability for that subsystem instead of crashing loudly.

---

## Observability improvements

1. **Add a request-scoped child logger.** Generate `req_id = randomUUID()` at the top of the HTTP handler and pass `httpLog.child({ req_id })` down through `handleRest` / `handleAuth` / MCP transport. Echo the id back as an `X-Request-ID` response header. Lets one log query reconstruct the full HTTP -> MCP -> consultation -> MQTT chain.

2. **Configure Pino properly.** Add `redact: { paths: ['req.headers.authorization', '*.token', '*.registration_secret', '*.admin_secret', '*.jwt_secret'], remove: true }`, register an `err` serializer, and apply the same `Error`-aware serialization in the console fallback so production (Bun binary) and dev (Pino) emit identical JSON shapes. Today they diverge silently.

3. **Emit a few high-value metrics alongside logs.** Counters for `threads_opened`, `threads_resolved{type}`, `tasks_claimed`, `tasks_poisoned`, `auth_rejected`, plus a gauge for `mqtt_listeners_active` and `sse_clients_active`. Even a `/metrics` Prometheus text endpoint is enough; right now operators have to grep JSON logs to answer "how many threads got poisoned today?".

---

DONE: `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\16-logging.md`
