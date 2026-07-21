# Node.js MQTT subscriber

Listens to the coordinator's embedded MQTT broker from Node using
[`mqtt`](https://www.npmjs.com/package/mqtt) (mqtt.js). Since the coordinator is
itself Node/TS, this is the lowest-friction way to react to coordination events
without writing an MCP client.

## Prerequisites

Start a local coordinator:

```bash
mcp-coordinator server start --daemon
```

## Install & run

```bash
cd examples/node-mqtt
npm install
node subscriber.mjs
```

Stop it with `Ctrl-C` (the subscriber disconnects cleanly).

## Configuration

| Env var              | Default                    | Purpose                                              |
| -------------------- | -------------------------- | ---------------------------------------------------- |
| `BROKER_URL`         | `mqtt://127.0.0.1:1883`    | Broker URL. Use the WebSocket form to go over HTTP.  |
| `COORDINATOR_TOKEN`  | _(unset)_                  | Optional Phase-1 JWT. Only needed when auth is on.   |

### Connecting

Two listeners are available; the default is plain TCP because it is the simplest
(no HTTP server in the path):

```bash
# TCP (default)
node subscriber.mjs

# WebSocket — shares the HTTP server on port 3100 at path /mqtt.
# Do NOT set the `mqtt` WS subprotocol; the broker does not use one.
BROKER_URL=ws://localhost:3100/mqtt node subscriber.mjs
```

### Auth (opt-in)

The broker is **anonymous by default** — no credentials are needed. If the
coordinator runs with `COORDINATOR_AUTH_ENABLED=true`, obtain a Phase-1 JWT
(`POST /api/auth/register`) and pass it in; it is sent as the MQTT CONNECT
password (the username is ignored by the broker):

```bash
COORDINATOR_TOKEN="$JWT" node subscriber.mjs
```

## Topics & payloads

The coordinator publishes **everything under a hardcoded org `default`** (there
is no per-org MQTT routing yet), so the subscriber listens on
`coordinator/default/#`. Payloads are JSON and are pretty-printed per topic:

| Topic suffix                                       | Payload fields                                   |
| -------------------------------------------------- | ------------------------------------------------ |
| `consultations/new`                                | `thread_id, agent_id, subject, target_modules[]` |
| `consultations/<threadId>/messages`                | `agent_id, type, content`                        |
| `consultations/<threadId>/status`                  | `status, summary`                                |
| `consultations/<threadId>/claimed`                 | `agent_id, claimed_by, claimed_at`               |
| `consultations/<threadId>/completed`               | `agent_id, completed_by, summary`                |
| `agents/<agentId>/status`                          | `status ("online"/"offline"), name`              |
| `broadcast`                                        | `agent_id, message`                              |
| `quota/update`                                     | `fiveHour, sevenDay, sevenDaySonnet, fetchedAt`  |

Retained `consultations/new` and `.../status` messages may arrive immediately on
connect; an **empty** retained payload means the message was cleared, and the
subscriber skips it.

## What to expect

When an agent announces work, you will see something like:

```text
[coordinator/default/consultations/new]
  consultation opened  thread=thread-123 by=agent-alpha  subject="Update auth docs"  modules=[docs]

[coordinator/default/consultations/thread-123/messages]
  message [context]  by=agent-beta  I am touching the same docs.

[coordinator/default/agents/agent-alpha/status]
  agent online   Agent Alpha
```
