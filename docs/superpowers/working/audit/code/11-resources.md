# Resource Management Audit

**Score: 3/10**

The codebase has working "happy path" startup but no real shutdown discipline. Cleanup hooks exist only on the foreground daemon and only delete the PID file — every long-lived resource (HTTP server, MQTT broker, SQLite handle, SSE listeners, in-flight MCP sessions, file descriptor) is leaked on `process.exit(0)`. Stop is a SIGTERM hammer.

---

## Leaks / Lifecycle Bugs

### 1. HTTP server never closed on shutdown — `cli/server/start.ts:79-80`
```ts
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
```
`cleanup()` only unlinks the PID file. `httpServer.close()` is never called, so in-flight requests are torn down mid-flush, sockets reset, and clients see ECONNRESET instead of a graceful drain.

### 2. Embedded MQTT broker never stopped — `src/serve-http.ts:783-788`
`startEmbeddedMqttBroker` returns `{ close }` (`mqtt-broker.ts:113-117`) which closes the TCP listener, the WSS, and the aedes broker. The return value is discarded, so on SIGTERM the TCP listener at port 1883, the WebSocket upgrade handler, and the aedes instance all leak.

### 3. SQLite database handle never closed — `src/database.ts:187-189`
`closeDb()` is exported but never called. WAL files (`coordinator.db-wal`, `-shm`) can be left in a non-checkpointed state on abrupt exit, risking lock contention on next startup.

### 4. PID file orphaned in daemon mode — `cli/server/start.ts:60-67`
The detached daemon writes the PID file but installs no `SIGINT`/`SIGTERM` handlers of its own (start.ts:79-80 only run in foreground mode, after the early `process.exit(0)` at line 67). When the daemon dies, `~/.config/.../server.pid` lingers and `server stop` will try to signal a stale PID.

### 5. SSE listener leak on listener-throw — `src/sse-emitter.ts:23-25` + `serve-http.ts:620-624`
`emit()` invokes listeners synchronously inside a `for` loop with no try/catch. If one SSE response is half-broken (socket already RSTed but `req.on("close")` not fired yet), `res.write` throws, the loop aborts, *and the listener is never removed*. Also: there's no cap on listeners; a misbehaving client that reconnects in a tight loop accumulates listeners until OOM.

### 6. MCP sessions can leak if `transport.onclose` never fires — `src/serve-http.ts:738-753`
Sessions are inserted into the `sessions` Map keyed by `transport.sessionId`. The `onclose` deletion is the only removal path. If the underlying socket dies before the SDK fires onclose (network partition, client crash), the entry stays forever along with the connected `mcpServer`. No idle timeout, no keepalive sweep.

### 7. Daemon log fd never closed — `cli/server/start.ts:25-26`
`openSync(logPath, "a")` is passed as stdio to the child but the parent's fd is leaked (no `closeSync(logFd)` after `child.unref()`). The parent exits at line 67 so the kernel reclaims it, but in long-running spawn loops (tests, supervisors) this is a real fd leak.

### 8. `setTimeout` poll loop in stop has no clearTimeout — `cli/server/stop.ts:37-54`
The recursive `check()` schedules `setTimeout(check, 200)` until deadline. On SIGKILL path (line 46) the function returns but if a prior timer is already armed it still fires once more, calling `process.kill(pid, 0)` after we've already `unlinkSync`-ed.

### 9. `req.on("data" / "end" / "error")` listeners never removed — `src/serve-http.ts:55-65`
`parseBody` attaches three listeners but if the promise rejects mid-stream (socket dies between data and end), the `error` and `data` handlers stay attached to the already-destroyed `IncomingMessage`. Per-request, low impact; under load test storms, measurable.

### 10. WebSocket→Duplex bridge double-destroy — `src/mqtt-broker.ts:29-31`
`ws.on("close")` calls `duplex.push(null)` *and* `duplex.destroy()`. If the broker is mid-write when the WS closes, the write callback fires after destroy and aedes logs an error — or worse, the error escapes and crashes the broker.

---

## Top 3 Cleanup Priorities

1. **Wire a real shutdown sequence in `serve-http.ts`** — return the `httpServer` and `mqttBroker` handles from `startServer()`, and have `cli/server/start.ts` call `httpServer.close()` → drain MCP sessions → `mqttBroker.close()` → `closeDb()` before `process.exit(0)`. This single fix kills leaks #1, #2, #3, #6.
2. **Add daemon-mode signal handlers + atexit PID cleanup** — fork in start.ts:67 leaves zero teardown hooks; install SIGTERM/SIGINT in the child path too, plus `process.on("exit", cleanup)` to catch crashes.
3. **Harden `SseEmitter.emit` and `parseBody`** — wrap each listener call in try/catch (auto-unsubscribe failures), and use `req.once(...)` + explicit `removeAllListeners` in `parseBody`'s reject path.

---

DONE: C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\11-resources.md
