# MQTT topics -- topic map & payload schemas

mcp-coordinator embeds an MQTT broker that mirrors coordination events
(consultations, agent presence, broadcasts, quota) onto a set of
well-known topics. This is the **canonical reference** for every topic
the coordinator publishes: its trigger, exact payload schema, QoS, and
retained flag. Any subscriber -- an SDK, a `mqtt_publish` user, or a
one-off `mosquitto_sub` -- should be able to build against this page
alone.

If you just want working code, start from a runnable subscriber and read
this page for the schema details:

- `examples/node-mqtt/` -- mqtt.js subscriber (lowest friction; the
  coordinator is itself Node/TS)
- `examples/go-mqtt/` -- paho.mqtt.golang subscriber
- `examples/python-mqtt/` -- paho-mqtt subscriber

References: `src/mqtt-bridge.ts`, README §"MQTT Communication Layer".

## Org scoping -- read this first

**The coordinator publishes EVERYTHING under a hardcoded org `default`.**
Every topic is literally `coordinator/default/...`. There is **no
per-org MQTT routing today** -- the `<org>` segment does not vary, it is
always the string `default`. Subscribers listen on `coordinator/default/#`.

Do not build tenant isolation on top of MQTT topics: a token minted for
any org still sees the same `coordinator/default/...` stream. If you need
real per-org scoping, use SSE at `/api/events` instead (see
[MQTT vs SSE](#mqtt-vs-sse) below).

Throughout this document, wherever you see `<org>` in a topic template
it resolves to `default`, and `<threadId>` / `<agentId>` are the only
segments that actually vary.

## Connection surfaces

Two listeners front the same broker. Pick whichever is easiest for your
runtime; they carry identical topics and payloads.

| Surface | URL | Env override (default) | Notes |
|---------|-----|------------------------|-------|
| TCP | `mqtt://127.0.0.1:1883` | `COORDINATOR_MQTT_TCP_PORT` (`1883`) | Bound to `127.0.0.1`, **not** `0.0.0.0`. Simplest -- no HTTP server in the path. |
| WebSocket | `ws://localhost:3100/mqtt` | `COORDINATOR_MQTT_WS_PATH` (`/mqtt`) | Shares the HTTP server on port 3100. |

### WebSocket specifics

- **No `mqtt` WS subprotocol.** Do **not** send a
  `Sec-WebSocket-Protocol: mqtt` header -- the broker does not negotiate
  one, and clients that insist on it will fail the handshake. (In
  mqtt.js this is the default; in browsers, do not pass a subprotocol
  to the `WebSocket` constructor.)
- **Frame cap: 1 MiB.** Individual WebSocket frames larger than 1 MiB
  are rejected. Coordinator payloads are far below this, but keep it in
  mind if you republish large blobs through the same broker.

The TCP listener is bound to loopback and the HTTP port should never be
exposed directly -- terminate TLS at a reverse proxy
(`examples/nginx-reverse-proxy/`) if you need remote access.

## Authentication -- opt-in

The broker is **anonymous by default**. No username, no password, no
token -- a fresh coordinator accepts any CONNECT. Auth is controlled by a
single flag:

```sh
export COORDINATOR_AUTH_ENABLED=true
```

When enabled:

- Put a **Phase-1 JWT in the MQTT CONNECT `password` field**.
- The `username` is **ignored** by the broker, but conventionally set to
  the agent id.
- An **empty password is rejected** -- there is no anonymous fallback
  once auth is on.

### Getting a Phase-1 token

```sh
curl -sX POST http://localhost:3100/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"agent_name":"my-subscriber","registration_secret":"'"$COORDINATOR_REGISTRATION_SECRET"'"}'
```

Registration requires `COORDINATOR_REGISTRATION_SECRET` (admin
operations use `COORDINATOR_ADMIN_SECRET`). The response is:

```json
{ "agent_id": "...", "token": "<JWT>", "expires_at": "...", "role": "..." }
```

The token's `org` claim is `default` -- which matches the publish org,
so the token can see the whole `coordinator/default/#` stream.

### Phase-2 tokens do NOT work for MQTT

MQTT CONNECT auth verifies **only the Phase-1 HS256 secret**. Phase-2
OAuth tokens (from the IdP login flow) are **not accepted** on the
broker. If you have an OAuth session, you still need a Phase-1 token to
authenticate against MQTT. (SSE at `/api/events` is the reverse -- it
honors the real token org; see below.)

## Topic table

All topics below are **published by the coordinator** (broker → subscriber).
All payloads are JSON -- `JSON.parse` / `json.Unmarshal` every message.
`<org>` is always `default`.

| Topic | Trigger | Payload schema | QoS | Retained |
|-------|---------|----------------|-----|----------|
| `coordinator/<org>/consultations/new` | An agent opens a consultation thread | `{ thread_id: string, agent_id: string, subject: string, target_modules: string[] }` | 1 | **yes** (see [retained-clear](#retained-clear-semantics)) |
| `coordinator/<org>/consultations/<threadId>/messages` | A message is posted to a thread | `{ agent_id: string, type: "context" \| "suggestion" \| "warning", content: string }` | 0 | no |
| `coordinator/<org>/consultations/<threadId>/status` | Thread resolution proposed / resolved (via MCP) | `{ status: "resolving" \| "resolved", summary: string }` | 1 | **yes** |
| `coordinator/<org>/consultations/<threadId>/claimed` | An agent claims the thread's task | `{ agent_id: string, claimed_by: string, claimed_at: string /* ISO 8601 */ }` | 1 | no |
| `coordinator/<org>/consultations/<threadId>/completed` | Resolution proposed via REST (see [divergences](#known-divergences)) | `{ agent_id: string, completed_by: string, summary: string }` | 1 | no |
| `coordinator/<org>/agents/<agentId>/status` | Agent presence changes | see [agent status](#agent-status-payloads) | 0 (online/offline), 1 (LWT) | **yes** (online/offline), no (LWT) |
| `coordinator/<org>/broadcast` | An agent broadcasts a message to all | `{ agent_id: string, message: string }` | 0 | no |
| `coordinator/<org>/quota/update` | Usage quota refreshed | `{ fiveHour: number, sevenDay: number, sevenDaySonnet: number, fetchedAt: string }` (camelCase) | 0 | no |

### Agent status payloads

`coordinator/<org>/agents/<agentId>/status` carries one of three shapes,
distinguished by `status` (and `reason`):

| Situation | Payload | QoS | Retained |
|-----------|---------|-----|----------|
| Agent comes online | `{ status: "online", name: string }` | 0 | yes |
| Agent goes offline cleanly | `{ status: "offline" }` | 0 | yes |
| Agent dropped (Last Will & Testament) | `{ status: "offline", reason: "lwt_unexpected" }` | 1 | no |

The retained online/offline message means a subscriber that connects
late still learns each agent's last known presence. The LWT message is
the broker-published death notice when a client disconnects without a
clean DISCONNECT -- it carries `reason: "lwt_unexpected"` and is **not**
retained.

### Retained-clear semantics

`consultations/new` and `consultations/<threadId>/status` are **retained**.
Because they are retained, a subscriber that connects after the fact will
immediately receive the last value on connect.

When the coordinator wants to **clear** a retained topic (e.g. a
consultation is no longer "new"), it publishes an **empty payload** to
that topic. Per MQTT semantics an empty retained publish deletes the
retained message.

**Every subscriber must treat a zero-length payload as "cleared" and skip
it** -- do not attempt to `JSON.parse` an empty buffer:

```js
client.on("message", (topic, payload) => {
  if (payload.length === 0) return; // retained message cleared
  const data = JSON.parse(payload.toString("utf8"));
  // ...
});
```

Both `examples/node-mqtt` and `examples/go-mqtt` implement exactly this
guard.

## Minimal subscriber recipe

1. Connect to `mqtt://127.0.0.1:1883` (or `ws://localhost:3100/mqtt`).
   Anonymous by default -- no credentials.
2. Subscribe to `coordinator/default/#` (or narrow to specific subtrees:
   `coordinator/default/consultations/#`,
   `coordinator/default/agents/+/status`,
   `coordinator/default/broadcast`).
3. On each message: skip zero-length payloads (retained-clear), then
   `JSON.parse` and branch on the topic suffix.

### Anonymous (the default)

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'coordinator/default/#' -v
```

### With auth enabled

Pass the Phase-1 JWT as the password (`-P`); the username (`-u`) is
ignored by the broker but conventionally the agent id:

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -t 'coordinator/default/#' -v \
  -u my-subscriber -P "$JWT"
```

### In code

The example subscribers put the JWT in the CONNECT password field only
when a token is present, and otherwise connect anonymously:

- **Node** (`examples/node-mqtt/subscriber.mjs`): `BROKER_URL` and
  `COORDINATOR_TOKEN` env vars; sets `options.password = TOKEN` when set.
- **Go** (`examples/go-mqtt/main.go`): `COORDINATOR_MQTT_URL` and
  `COORDINATOR_TOKEN`; `opts.SetPassword(token)` when set; subscribes in
  the on-connect handler so it recovers after a broker restart.

## HTTP endpoints alongside MQTT

The same process serves a few HTTP endpoints on port 3100 that are
useful next to the broker:

| Endpoint | Returns | Status |
|----------|---------|--------|
| `GET /health` | `{ status: "alive", uptime_seconds, version, auth_enabled, jwt_secret_set, warnings }` | always 200 |
| `GET /readyz` | `{ status, checks: { db, mqtt, tree_sitter, git_cochange } }` | 200 / 503 |
| `GET /api/events` | Server-Sent Events stream (see below) | 200 |

`/health` is a liveness probe (does not gate on dependencies);
`/readyz` is the readiness probe and returns 503 until DB + MQTT + the
analysis subsystems are up.

## MQTT vs SSE

The coordinator exposes the **same coordination events twice**: over
MQTT (this page) and over Server-Sent Events at `GET /api/events`. They
are not interchangeable -- the key difference is org scoping:

| | MQTT broker | SSE (`/api/events`) |
|---|---|---|
| Org scoping | Hardcoded `default` for everyone | **Honors the real token org** |
| Auth token | Phase-1 JWT only, in CONNECT password | Phase-1 JWT via `?token=<JWT>` query param (EventSource can't set headers) |
| Transport | Long-lived MQTT session, QoS/retained | One-way HTTP stream, no retained state |
| Event names | Topic suffixes (`new`, `status`, ...) | SSE event types (`thread_opened`, ...) |

SSE event types: `thread_opened`, `message_posted`, `resolution_proposed`,
`thread_resolved`, `task_claimed`, `agent_online`, `agent_offline`,
`quota_update`.

**If you need genuine per-org isolation, use SSE**, which filters the
stream by the org claim in the presented token. MQTT gives every
authenticated (or anonymous) client the full `coordinator/default/#`
firehose.

## Known divergences

These are real inconsistencies in the current implementation. They are
documented here so subscriber authors are not surprised; **do not "fix"
them in example code** -- match the wire reality below.

1. **No per-org MQTT routing.** The publisher org is hardcoded to
   `default`. The `<org>` topic segment never varies. (Per-org routing
   is future work; use SSE for real scoping today.)

2. **REST `/completed` vs MCP `/status`.** The two resolution paths
   publish to different topics for what is conceptually the same action:
   - REST "propose resolution" → `consultations/<threadId>/completed`
     (`{ agent_id, completed_by, summary }`)
   - MCP `propose_resolution` → `consultations/<threadId>/status`
     (`{ status, summary }`)

   A subscriber that wants to catch *all* resolutions must listen on
   **both** `.../status` and `.../completed`.

3. **Quota camelCase (MQTT) vs snake_case (SSE).** The `quota/update`
   MQTT payload is camelCase (`fiveHour`, `sevenDay`, `sevenDaySonnet`,
   `fetchedAt`). The equivalent SSE `quota_update` event uses snake_case.
   Do not share one deserializer across both transports without a field
   mapping.
