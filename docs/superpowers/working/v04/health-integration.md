# v0.4 Operability — Health probes integration patch

Audit (`docs/superpowers/working/audit/03-devops.md`) flagged the legacy
`/health` route as a stub: `{status:"ok",version}` returned unconditionally,
no DB / broker / SSE checks, no liveness vs readiness split.

This patch wires the new Kubernetes-style probes into `src/serve-http.ts`
without changing any other behavior. Backwards compatibility is preserved:
`/health` remains and now aliases `/livez`.

---

## Files added (already in tree, do not re-create)

- `src/http/handle-health.ts` — `handleLivez`, `handleReadyz`, `handleHealth`
- `tests/unit/health-handlers.test.ts` — 8 unit tests, all green

---

## Patch to apply in `src/serve-http.ts`

### 1. Add the import (top of file, alongside the other `./http/*` imports)

Find this line (~line 19):

```ts
import { handleRest as handleRestExt, type RestContext } from "./http/handle-rest.js";
```

Add immediately below it:

```ts
import { handleLivez, handleReadyz, handleHealth } from "./http/handle-health.js";
```

### 2. Replace the existing `/health` route block

Find this block in `startServer()` inside the `createServer` request handler
(currently around line 337–338):

```ts
      } else if (url === "/health") {
        json(res, { status: "ok", version: VERSION });
      } else if (url === "/api/events" && req.method === "GET") {
```

Replace it with:

```ts
      } else if (url === "/livez") {
        // Kubernetes-style liveness probe — process alive, never checks deps.
        // Used by orchestrators (k8s, systemd) to decide whether to restart.
        handleLivez(req, res);
      } else if (url === "/readyz") {
        // Kubernetes-style readiness probe — DB + MQTT must be green for the
        // load balancer to add this pod to rotation. 503 drains traffic.
        handleReadyz(req, res, services);
      } else if (url === "/health") {
        // Backwards-compat alias. Pre-v0.4 callers (uptime monitors,
        // dashboards) hit /health expecting an alive-only check; we keep
        // that contract by delegating to /livez.
        handleHealth(req, res);
      } else if (url === "/api/events" && req.method === "GET") {
```

That is the entire integration. The `VERSION` import at the top of
`serve-http.ts` is still needed for other code paths (REST status banner,
MCP server name) and stays as-is.

---

## Why these endpoint names

- `/livez` and `/readyz` follow the Kubernetes convention (used by core
  components since 1.16). `/healthz` was deprecated in favor of split
  semantics; we adopt the same split.
- `/health` is preserved unchanged at the wire level — same HTTP method,
  same 200 status — so existing probes keep their dashboards green.

## Why no SSE check in /readyz

SSE is a server-push protocol layered on the same HTTP server that already
serves `/readyz`. If `/readyz` reaches us, the SSE listener is reachable by
construction. Adding an explicit check would only flag bugs in the SSE
emitter, which are surfaced by `tests/unit/sse-emitter.test.ts` and would
not be fixed by traffic draining anyway.

## Why DB + MQTT only

These are the two external-state dependencies the coordinator cannot work
without:

- DB (`getDb().prepare("SELECT 1").get()`) — every REST + MCP path reads
  or writes SQLite. A locked or closed handle means we cannot serve.
- MQTT (`services.mqttBridge.isConnected()`) — agent coordination flows
  through the broker (LWT, claims, broadcasts). A disconnected bridge
  means agents will appear stuck.

Quota cache, dependency map, etc. degrade gracefully (503 on `/api/quota`,
empty result on dep map) and should NOT gate readiness.

## Verification

```bash
npx vitest run tests/unit/health-handlers.test.ts
# Test Files  1 passed (1)
# Tests       8 passed (8)
```

After applying the patch:

```bash
curl -i http://localhost:3100/livez   # 200 {"status":"alive",...}
curl -i http://localhost:3100/readyz  # 200 ready, or 503 not_ready+checks
curl -i http://localhost:3100/health  # 200 {"status":"alive",...} (alias)
```
