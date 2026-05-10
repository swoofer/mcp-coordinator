# Metrics integration patch (v0.4 Operability)

Closes audit gap: README says "Production-ready" but only `/health` was
exposed (no scrape endpoint). This patch wires the new `Metrics` class into
the HTTP server and the shared services bundle so a Prometheus scraper can
hit `GET /metrics` and get counters/gauges keyed off the events that already
flow through the coordinator.

## Files modified by this patch

1. `package.json` (already done by agent-metrics) - adds `prom-client` to deps
2. `src/server-setup.ts` - adds `Metrics` to `CoordinatorServices` and
   instantiates it in `createServices()`
3. `src/serve-http.ts` - registers `/metrics` route and wires the lifecycle
   hooks (HTTP request/response counter, SSE client gauge, auth-rejected
   counter, MQTT-listener gauge from the bridge tick)
4. `src/mqtt-bridge.ts` *(optional, recommended)* - increments
   `mqttPublishes` from inside `mqttPublish()` / each `publishX()` call. If
   you skip this, the counter stays at 0 and only HTTP/auth metrics work.

Files created by this patch (already on disk):
- `src/metrics.ts`
- `tests/unit/metrics.test.ts`

## Step 1 - install dependency

```bash
npm install prom-client@^15.1.3
```

(Already added to `package.json` by this agent. The `npm install` command
above is what the integrator runs to materialise it in `node_modules/`.)

## Step 2 - patch `src/server-setup.ts`

Add the import near the other class imports:

```diff
 import { QuotaCache } from "./quota/quota-cache.js";
+import { Metrics } from "./metrics.js";
 import type { CoordinatorConfig, AgentContext } from "./types.js";
```

Extend the `CoordinatorServices` interface:

```diff
 export interface CoordinatorServices {
   logger: Logger;
   registry: AgentRegistry;
   activityTracker: AgentActivityTracker;
   consultation: Consultation;
   conflictDetector: ConflictDetector;
   depMap: DependencyMapper;
   fileTracker: FileTracker;
   impactScorer: ImpactScorer;
   introspection: IntrospectionManager;
   contextProvider: SummaryContextProvider;
   sseEmitter: SseEmitter;
   mqttBridge: MqttBridge;
   quotaCache: QuotaCache;
+  metrics: Metrics;
 }
```

Inside `createServices()`, instantiate `Metrics` and wire the resolution
counter to the existing `consultation.onResolve` callback (which already
fires for every consensus / timeout / agent_departure / closed resolution -
exactly the labels we want):

```diff
   const sseEmitter = new SseEmitter();
   const mqttBridge = new MqttBridge(logger.child({ component: "mqtt" }));
+  const metrics = new Metrics();
```

```diff
   // Centralized resolution -> SSE + MQTT
   consultation.onResolve((event) => {
+    metrics.recordThreadResolved(event.resolution_type);
     sseEmitter.emit("thread_resolved", {
```

Update the return statement:

```diff
   return {
     logger, registry, activityTracker, consultation, conflictDetector,
-    depMap, fileTracker, impactScorer, introspection, contextProvider, sseEmitter, mqttBridge, quotaCache,
+    depMap, fileTracker, impactScorer, introspection, contextProvider, sseEmitter, mqttBridge, quotaCache, metrics,
   };
 }
```

## Step 3 - patch `src/serve-http.ts`

Add the import:

```diff
 import { startEmbeddedMqttBroker } from "./mqtt-broker.js";
+import { serveMetrics } from "./metrics.js";
```

Register the `/metrics` route in the `createServer` request handler. Place
it right after the `/health` branch so it matches before any auth-guarded
fallthrough (a Prometheus scrape job should NOT need a JWT):

```diff
       } else if (url === "/health") {
         json(res, { status: "ok", version: VERSION });
+      } else if (url === "/metrics" && req.method === "GET") {
+        await serveMetrics(req, res, services, services.metrics);
+        services.metrics.recordHttpRequest("/metrics", 200);
+        return;
       } else if (url === "/api/events" && req.method === "GET") {
```

Patch `handleSse` to bracket the connection lifecycle around the SSE-clients
gauge so the gauge tracks live websocket-style holds correctly:

```diff
 function handleSse(req: IncomingMessage, res: ServerResponse): void {
   res.writeHead(200, {
     "Content-Type": "text/event-stream",
     "Cache-Control": "no-cache",
     Connection: "keep-alive",
     "Access-Control-Allow-Origin": "*",
   });
+  services.metrics.incSseClients();
+  services.metrics.recordHttpRequest("/api/events", 200);
   ...
-  req.on("close", () => unsubscribe());
+  req.on("close", () => {
+    unsubscribe();
+    services.metrics.decSseClients();
+  });
 }
```

Wire `recordAuthRejected` to the two existing `Auth rejected` log sites so
the counter mirrors what the auth log already emits:

```diff
           if (AUTH_ENABLED) {
             const authResult = await authenticateRequest(req);
             if (!authResult.ok) {
               authLog.warn({ reason: authResult.error, url, ip: req.socket.remoteAddress }, "Auth rejected");
+              services.metrics.recordAuthRejected();
               json(res, { error: authResult.error }, authResult.status);
               return;
             }
```

(Apply the same two-line addition to the second `Auth rejected` block lower
in the file - the one inside the `else { ... }` fallthrough that protects
`/api/*` routes.)

For per-route HTTP request accounting, wrap `handleRest` and the catch-all
404. Easiest minimal change is to bump the counter from inside the
`/api/*` branch:

```diff
         if (url.startsWith("/api/") && (req.method === "POST" || req.method === "GET")) {
           await handleRest(req, res);
+          services.metrics.recordHttpRequest(url.split("?")[0], res.statusCode || 0);
         } else {
           json(res, { error: "not found" }, 404);
+          services.metrics.recordHttpRequest(url.split("?")[0], 404);
         }
```

Optional refresh of `mqttListenersActive` on a low-frequency tick (or just
every scrape - which `Metrics.gaugeSnapshot` could be extended to do once
`MqttBridge` exposes a public `listenerCount(): number`):

```diff
   await services.mqttBridge.connect({ ... });
+  // Refresh the MQTT-listeners gauge once per minute. Cheap; avoids needing
+  // an event hook from MqttBridge.registerListener / removeListener.
+  const mqttGaugeTimer = setInterval(() => {
+    // After exposing MqttBridge.listenerCount(), call it here:
+    // services.metrics.setMqttListeners(services.mqttBridge.listenerCount());
+  }, 60000);
+  mqttGaugeTimer.unref();
```

Add `clearInterval(mqttGaugeTimer)` to the existing `stop()` cleanup
sequence to avoid keeping the event loop alive on shutdown.

## Step 4 *(recommended)* - patch `src/mqtt-bridge.ts`

The bridge already centralises every publish through one `client.publish`
call. Add a single counter call so `mcp_coordinator_mqtt_publishes_total`
isn't permanently 0. Since `MqttBridge` shouldn't import the Metrics class
directly (would create a back-edge through `server-setup`), pass a publish
hook in via the constructor or expose a tiny `onPublish` setter:

```diff
 export class MqttBridge {
   private client: mqtt.MqttClient | null = null;
   private connected = false;
+  private onPublishCallback: (() => void) | null = null;
   ...
+  onPublish(cb: () => void): void { this.onPublishCallback = cb; }
+
+  private publish(topic: string, payload: string | Buffer, opts?: mqtt.IClientPublishOptions): void {
+    if (!this.client || !this.connected) return;
+    if (opts) this.client.publish(topic, payload, opts);
+    else this.client.publish(topic, payload);
+    this.onPublishCallback?.();
+  }
```

Then replace each `this.client.publish(...)` call with `this.publish(...)`.
Wire the callback in `createServices()`:

```diff
   const mqttBridge = new MqttBridge(logger.child({ component: "mqtt" }));
   const metrics = new Metrics();
+  mqttBridge.onPublish(() => metrics.recordMqttPublish());
```

## Step 5 - announce_work counter

`runCommonAnnounceFlow` already returns the `auto_resolve` flag. The cleanest
place to hook the announce counter is inside `consultation.announceWork` (it
already knows whether the thread auto-resolved). Add at the end of that
method, after the log line:

```diff
   this.log.info({ ..., auto_resolve: autoResolve, ... }, "Thread opened");
+  this.onAnnounceCallback?.(autoResolve ? "auto_resolved" : "thread_opened");
```

Add the callback wiring (same shape as `onResolveCallback`) and register it
from `createServices`:

```diff
   consultation.onResolve((event) => { ... });
+  consultation.onAnnounce((result) => metrics.recordAnnounce(result));
```

(If you'd rather keep `Consultation` untouched, hook the counter from inside
`runCommonAnnounceFlow` instead - it already imports `services` and runs
once per announce, so `services.metrics.recordAnnounce(...)` slots in
naturally there.)

## Verification after integration

```bash
npm test -- tests/unit/metrics.test.ts   # 12 tests, all green
npm run dev                              # start coordinator
curl -s http://localhost:3100/metrics    # see the exposition format
```

Sample expected output:

```
# HELP mcp_coordinator_announces_total Total announce_work calls...
# TYPE mcp_coordinator_announces_total counter
mcp_coordinator_announces_total{result="thread_opened"} 0
# HELP mcp_coordinator_agents_online Current number of agents...
# TYPE mcp_coordinator_agents_online gauge
mcp_coordinator_agents_online 0
...
```
