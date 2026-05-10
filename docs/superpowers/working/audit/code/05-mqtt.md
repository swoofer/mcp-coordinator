# MQTT Broker & Bridge Audit

**Score: 4/10**

Aedes runs as a default-configured embedded broker with no auth, no QoS, no LWT, and a fanout pattern that breaks coordination semantics. Functional for a single trusted box; unfit for any multi-host or shared-LAN scenario.

## Versions
- `aedes ^1.0.2` (`package.json:60`) — current major; check CVEs in `aedes-protocol-decoder` and `mqtt-packet` chain.
- `mqtt ^5.15.0` (`package.json:64`) — MQTT.js, supports MQTT 3.1.1 by default (no MQTT 5 features used).
- `ws ^8.20.0` (`package.json:66`) — recent.

## MQTT-Layer Issues

### 1. No QoS specified anywhere — defaults to QoS 0 (`mqtt-bridge.ts:97-169`)
Every `client.publish(...)` call omits the `qos` option. MQTT.js defaults to **QoS 0 (fire-and-forget)**. Critical coordination events — `publishTaskClaimed` (line 148), `publishTaskCompleted` (line 156), `publishResolution` (line 122), `publishAgentOffline` (line 139) — can be silently dropped on transient network blips. For task-claim races this is a correctness bug, not a perf hint. Should be QoS 1 minimum.

### 2. No Last Will & Testament (LWT) on bridge connect (`mqtt-bridge.ts:32-35`)
The connect options set `clientId` and `clean: true` only. There is no `will: { topic, payload, qos, retain }`. The comment on line 42 ("Subscribe to agent status for LWT detection") is aspirational — nothing publishes a will. Crash detection relies entirely on `publishAgentOffline` (line 137), which never runs if the process is killed (-9, OOM, panic). Agents will appear "online" forever.

### 3. No authentication / ACL on TCP 1883 (`mqtt-broker.ts:59, 74-92`)
`Aedes.createBroker()` is called with no `authenticate` / `authorizePublish` / `authorizeSubscribe` hooks. TCP listener binds to `127.0.0.1` (line 82) — that mitigates LAN exposure for TCP, **but the WebSocket transport piggy-backs on the shared HTTP server** (line 100) which typically binds 0.0.0.0. Anyone reaching `/mqtt` over WS can publish/subscribe to any topic, including `coordinator/agents/+/status` retained messages and forge `task_claimed`.

### 4. Listener fanout broadcasts every consultation msg to every agent (`mqtt-bridge.ts:66-74`)
Subscription `coordinator/consultations/#` (line 48) is a single shared subscription, then the on-message handler iterates `for (const listener of this.listeners.values())` and delivers the same message to **all** registered agents regardless of `agent_id` / `target_modules`. This is N×M storm-prone, and worse — it means any agent calling `waitForMessage` can receive messages targeted at others. Topic-level filtering is bypassed in favor of in-process broadcast.

### 5. Retained-message lifecycle leak (`mqtt-bridge.ts:101, 126, 142`)
`registerAgent` publishes status with `retain: true`, and `publishResolution` retains thread status. There is no retained-message cleanup on legitimate shutdown for consultations, and `publishAgentOffline` overwrites with `{status: "offline"}` rather than the canonical empty payload that clears the retained slot. Broker memory grows unbounded with every consultation thread ID ever created.

### 6. WebSocket → Duplex bridge swallows backpressure (`mqtt-broker.ts:13-33`)
`write()` calls `ws.send(chunk)` and immediately invokes `callback()`. `ws.send` is async with its own internal buffer; the `(err, cb)` form of `ws.send` is not used, so write errors after the first tick are lost and slow consumers cause unbounded buffering inside `ws`. No `bufferedAmount` check.

### 7. No keepalive configured (`mqtt-bridge.ts:32-35`)
MQTT.js defaults `keepalive` to 60s and `reconnectPeriod` to 1000ms — acceptable, but never explicit. Aedes default `heartbeatInterval` is 60s. Agent-death detection latency is therefore 1.5 × keepalive ≈ 90s — too slow for "live coordination" claims.

### 8. JSON.parse without size limit (`mqtt-bridge.ts:64`)
A malicious WS client can publish a 100MB payload to `coordinator/consultations/x` and OOM the bridge. No `maxPayload` on `WebSocketServer` (`mqtt-broker.ts:95`) and aedes default is 1MB but no app-level guard.

## Recommendations

1. **Set QoS 1 on all coordination publishes** and add LWT on connect: `will: { topic: 'coordinator/agents/<id>/status', payload: '{"status":"offline"}', qos: 1, retain: true }`. Fixes correctness for task races and crash detection in one change.
2. **Add aedes `authenticate` + `authorizePublish` hooks** keyed on a shared secret or JWT (you already depend on `jose`). Restrict publish to `coordinator/agents/<own-id>/...` so an agent cannot forge another's status or claim.
3. **Replace in-process listener broadcast with per-agent topic subscriptions** (`coordinator/agents/<id>/inbox`) and let the broker do the routing. Removes N×M fanout, fixes cross-agent message leakage, and lets you add `maxInflightMessages` for backpressure.

DONE: C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\code\05-mqtt.md
