# Error Handling Audit — mcp-coordinator

**Score: 5/10**

Mixed picture. `quota.ts`/`auth.ts` are exemplary (typed errors, classified failures, fail-open documented). `serve-http.ts`, `mqtt-bridge.ts`, and the MCP tool layer are thin: generic `Error`, single global try/catch, no process-level handlers, no SIGTERM cleanup, no unhandled-rejection guard. Errors get logged but routed back to the wire as raw `.message` strings — no consistent shape, mostly 500s with internal text leaked. MCP tool handlers throw straight back to the SDK with no `isError` envelope, so spec compliance is partial.

## Gaps (file:line)

1. **No process-level handlers anywhere.** `index.ts:28` and `serve-http.ts:814` only catch top-level startup rejection then `process.exit(1)`. There is **no** `process.on('SIGTERM'|'SIGINT')`, no `unhandledRejection`/`uncaughtException` listener. A rejected promise inside an SSE listener, MQTT message callback, or background quota tick (`quota-cache.ts:207`) silently terminates the process under Node ≥15. No graceful flush of SSE clients, no `mqttBridge.disconnect()`, no `closeDb()` on shutdown — `database.ts:187` exists but is never called.

2. **Catch-all 500 leaks internal messages.** `serve-http.ts:774-777`: `json(res, { error: (err as Error).message }, 500)`. Every uncaught path (DB constraint, JSON parse, "Thread X not found", missing claim) returns a free-form English message and HTTP 500. No error code, no shape contract. Stack frames aren't sent but `err.message` from `consultation.ts` ("Only the initiator (xyz) may close...") leaks IDs and internal structure to any caller.

3. **Swallowed catches with no telemetry.** `mqtt-bridge.ts:75` `catch { /* ignore malformed */ }` — bad payload from any client silently drops. No counter, no debug log. Same pattern in `database.ts:170,174,179` (migration `ALTER TABLE` swallowed for "already exists"), and `quota.ts:117-121` (sevenDaySonnet parse failure silently nulled). The migration catches mask real schema errors, not just "duplicate column".

4. **MCP tool handlers don't wrap errors in spec envelope.** `server-setup.ts:120-522` — every `server.tool(..., async () => {...})` handler can throw (e.g. `consultation.proposeResolution` throws raw `Error` from `consultation.ts:184-186`). The MCP spec expects `{ content: [...], isError: true }`. Throws bubble to the SDK which converts them to JSON-RPC errors with code -32603 and full `.message` — internal coordinator state leaked into agent prompts.

5. **`announceWork` is not transactional.** `server-setup.ts:177-211` and mirrored at `serve-http.ts:155-180` perform: `INSERT thread`, then `await import("./database.js")` (dynamic import per request — perf bug too), then `UPDATE conflicts`, then `UPDATE expected_respondents`, then conditional `UPDATE status='resolved'`, then `emitResolution`. Any throw between steps leaves the thread half-built. No `db.transaction(...)`.

6. **MQTT reconnect + listener cleanup absent.** `mqtt-bridge.ts:79-83` `client.on("error")` calls `reject(err)` — but only the *initial* `connect` Promise can be rejected; a runtime error after `resolve()` calls `reject` on an already-settled promise (silent no-op) and never reconnects. `connected` flag stays `true`. No `client.on("offline"|"reconnect"|"close")` handlers. No backoff. `waitForMessage` (line 200) sets `setTimeout` but never clears it on early resolve — minor leak per call.

7. **`cooldownUntil` only respected by `refresh()`.** `quota-cache.ts:128-132`: cool-down honored. `startBackgroundTick:207` schedules `setInterval(refresh, ttlMs=120s)`, but a 429 sets `cooldownUntil = now + 5min`. The interval keeps ticking and re-entering `refresh` which short-circuits — wasted log noise but no real damage. Worse: `get()` at line 100 calls `refresh()` directly without first checking cool-down separately, so callers get `null` back during cool-down with no signal that a retry is pointless until `cooldownUntil`.

8. **`setTimeout`s inside Promises with no cleanup.** `mqtt-bridge.ts:200-205` (`waitForMessage`), `server-setup.ts:478` (`wait_for_peers` — uses busy-wait `while` + 1s `setTimeout`, never abortable, no unref). Long polls hold the event loop and accumulate.

## Three Must-Fix Patterns

1. **Add process handlers + graceful shutdown.** In `serve-http.ts:startServer`, register `SIGTERM`/`SIGINT` to: stop SSE listeners, call `mqttBridge.disconnect()`, `quotaCache.stopBackgroundTick()`, `closeDb()`, then `httpServer.close()`. Add `process.on('unhandledRejection', err => log.fatal({err}))` so background failures are visible.

2. **Standardize error response shape + custom error classes.** Replace `serve-http.ts:776`'s catch-all with `{ error: { code, message, details } }`. Introduce `NotFoundError`/`ForbiddenError`/`ConflictError` in `consultation.ts` (currently 16 generic `throw new Error`s) and map them to 404/403/409 in the HTTP layer. Wrap MCP tool handlers in a helper that returns `{ content: [{type:"text", text:msg}], isError: true }` instead of letting throws bubble.

3. **Wrap `announceWork` in a DB transaction + drop dynamic imports.** Hoist `getDb` to module scope (lines `server-setup.ts:183, 195` and `serve-http.ts:165, 261, 287, 405, 442`), then wrap the multi-statement sequence in `db.transaction(() => {...})()`. Eliminates partial writes and the 7+ async dynamic-import round-trips per `/api/announce`.
