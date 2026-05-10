# HTTP / SSE Transport Audit

**Score: 4 / 10**

Bare `node:http` dispatcher works for the current scale but lacks the safety
nets (body limits, content-type checks, SSE keepalive, connection caps,
streaming) that production HTTP/SSE deployments require. Single-process,
unbounded growth, no backpressure.

---

## Issues

### 1. SSE has no heartbeat / keepalive (`serve-http.ts:602-625`)
`handleSse` writes the headers and never emits a comment line afterwards.
NAT/load-balancer/proxy idle timeouts (typically 30-60s) will silently kill
the socket; the client only learns when its next reconnect fires. Send
`res.write(": ping\n\n")` every ~15s and `clearInterval` on `req.on("close")`.
Also no `res.flushHeaders()` so proxies that buffer (nginx default) won't
deliver anything until the first event.

### 2. Unbounded body parser - DoS vector (`serve-http.ts:55-65`)
`parseBody` concatenates all `data` chunks into a string with **no size cap**.
A single `POST /api/log-file` with a 2 GB body crashes the process via OOM.
Also no `Content-Type` validation - anything is JSON-parsed. Add a 1 MiB
cap, reject when `req.headers["content-type"]` isn't `application/json`,
and return `413 Payload Too Large`. Bonus: `body += chunk.toString()` does
UTF-8 decoding per chunk - corrupts multi-byte chars on chunk boundaries.

### 3. Wide-open CORS (`serve-http.ts:67-70, 668-674, 699-702`)
`Access-Control-Allow-Origin: *` is sprinkled across every helper. Combined
with `Authorization: Bearer` headers and a `mcp-session-id` cookie-equivalent,
any web page on the internet can hit the coordinator from a logged-in
browser. Restrict to an env-driven allowlist (`COORDINATOR_CORS_ORIGIN`).

### 4. SSE listener leak + no client cap (`serve-http.ts:620-624`,
`sse-emitter.ts:35-40`)
Every `/api/events` connection pushes onto a **plain array** with no upper
bound. A misbehaving client looping reconnects (or a slowloris) accumulates
listeners forever; each emit fan-outs `O(N)` writes synchronously, blocking
the event loop. No `MAX_SSE_CLIENTS` guard, no `res.writableNeedDrain`
backpressure check, no socket timeout. `removeAllListeners()` exists but is
never wired to shutdown.

### 5. Body parsed for every request, even GETs (`serve-http.ts:87, 510`)
`handleRest` calls `await parseBody(req)` unconditionally. GET `/api/quota`
hangs until the request body 'ends' - which on a GET means until the client
times out the unused write side. Slowloris-friendly. Skip parsing on GET /
DELETE; only parse for POST/PUT/PATCH with non-zero `content-length`.

### 6. Synchronous file I/O on every dashboard hit (`serve-http.ts:690, 698`)
`existsSync` + `readFileSync` block the event loop. With a few users
loading `index.html` + assets, REST/SSE/MQTT all stall. Use `fs/promises`
or stream via `createReadStream`. No ETag / `Cache-Control`, no MIME for
SVG/PNG/woff2, no path-traversal guard (`url.replace("/dashboard/", "")`
happily resolves `..%2F..%2Fetc/passwd`).

### 7. No timeouts, HTTP/1.1 only, no TLS (`serve-http.ts:663, 799`)
`createServer()` defaults to no `requestTimeout`, no `headersTimeout`, no
`keepAliveTimeout`. No HTTPS path - operators must run nginx/caddy in front
but nothing in the README enforces it. `localhost` binding is implicit
(actually binds `::` - exposed on all interfaces).

### 8. Event id type mismatch (`sse-emitter.ts:17`, `serve-http.ts:611`)
`lastInsertRowid` is `number | bigint`; cast as `number` will silently
overflow at 2^53 events. `parseInt(...)` of `Last-Event-ID` returns NaN on
a non-numeric header, then `getEventsSince(NaN)` returns nothing - the
client thinks resumption succeeded but loses all history.

---

## Three Transport Improvements

1. **Adopt Fastify** with `@fastify/cors`, `@fastify/helmet`,
   `@fastify/rate-limit`, and a built-in body size limit. Free schema
   validation per route eliminates the cast-then-pray pattern in
   `handleRest`.
2. **SSE hardening**: 15s heartbeat interval, `MAX_SSE_CLIENTS=200` with
   `429` rejection, per-client write backpressure, `flushHeaders()`,
   structured close logging. Move the listener list to a `Set` for O(1)
   unsubscribe.
3. **Defense-in-depth on body**: `Content-Length` pre-check, 1 MiB cap,
   `application/json` content-type guard, GET/DELETE skip body parse,
   request/header timeouts (10s/5s), bind to `127.0.0.1` by default.

DONE: C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\18-http-sse.md
