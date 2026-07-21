# Go MQTT subscriber

This example listens to the coordinator's embedded MQTT broker from Go and
prints one readable line per coordination event. It is the Go counterpart to
`examples/python-mqtt/` and is handy for Go tooling that wants to react to
coordination events without implementing a full MCP client.

## Prerequisites

Start a local coordinator:

```bash
mcp-coordinator server start --daemon
```

The embedded MQTT broker listens on `127.0.0.1:1883` (anonymous by default).

## Install

```bash
cd examples/go-mqtt
go mod tidy
```

## Run

```bash
go run .
```

The subscriber connects to `mqtt://127.0.0.1:1883`, subscribes to
`coordinator/default/#`, JSON-parses each payload, and prints one line per
event. Stop it with `Ctrl-C` (clean shutdown, no stack trace).

## Environment variables

| Variable                | Default                  | Purpose                                                              |
|-------------------------|--------------------------|---------------------------------------------------------------------|
| `COORDINATOR_MQTT_URL`  | `mqtt://127.0.0.1:1883`  | Broker URL. Use `ws://localhost:3100/mqtt` for the WebSocket bridge. |
| `COORDINATOR_TOKEN`     | _(unset)_                | Optional Phase-1 JWT. Sent in the MQTT CONNECT **password** field.   |
| `COORDINATOR_CLIENT_ID` | `go-mqtt-subscriber`     | Client ID shown to the broker (also used as username when a token is set). |

Auth is opt-in on the coordinator (`COORDINATOR_AUTH_ENABLED=true`). When it is
off — the default — no credentials are needed. When it is on, mint a token with
`POST /api/auth/register` and export it:

```bash
COORDINATOR_TOKEN="<phase-1 jwt>" go run .
```

The MQTT username is ignored by the broker but is conventionally the agent id,
so this example sends the client id as the username alongside the token. Only
Phase-1 HS256 tokens are accepted for MQTT; Phase-2 OAuth tokens do not work.

## Org is hardcoded `default`

The coordinator publishes everything under a hardcoded org `default` — there is
no per-org MQTT routing today. Every topic is literally `coordinator/default/…`,
and this example subscribes to `coordinator/default/#`.

## Topics and payloads handled

The subscriber branches on the topic suffix and prints a summary tailored to
each event class. Payload shapes below are the exact ones the coordinator
publishes (all payloads are JSON).

| Topic | Payload |
|---|---|
| `coordinator/default/consultations/new` | `{ thread_id, agent_id, subject, target_modules: string[] }` (retained; an **empty** payload means the retained value was cleared and is skipped) |
| `coordinator/default/consultations/<threadId>/messages` | `{ agent_id, type: "context"\|"suggestion"\|"warning", content }` |
| `coordinator/default/consultations/<threadId>/status` | `{ status: "resolving"\|"resolved", summary }` |
| `coordinator/default/consultations/<threadId>/claimed` | `{ agent_id, claimed_by, claimed_at }` (ISO 8601) |
| `coordinator/default/consultations/<threadId>/completed` | `{ agent_id, completed_by, summary }` |
| `coordinator/default/agents/<agentId>/status` | `{ status: "online", name }` / `{ status: "offline" }` / LWT `{ status: "offline", reason: "lwt_unexpected" }` |
| `coordinator/default/broadcast` | `{ agent_id, message }` |

Any other topic under `coordinator/default/#` (for example `quota/update`) is
printed with its compact JSON payload rather than a typed summary.

## What to expect

When an agent calls `announce_work`, the coordinator publishes a new
consultation. Sample output:

```text
coordinator/default/consultations/new                   | NEW consultation "thread-123" by agent-alpha subject="Update auth docs" modules=docs
coordinator/default/consultations/thread-123/messages   | MESSAGE thread=thread-123 from=agent-beta [context] I am touching the same docs.
coordinator/default/consultations/thread-123/claimed    | CLAIMED thread=thread-123 by=agent-beta at=2026-07-21T10:15:00Z
coordinator/default/consultations/thread-123/status     | STATUS thread=thread-123 -> resolved merged the doc edits
coordinator/default/agents/agent-alpha/status           | AGENT agent-alpha is online (Agent Alpha)
coordinator/default/broadcast                           | BROADCAST from=agent-alpha heads up: deploying in 5m
```
