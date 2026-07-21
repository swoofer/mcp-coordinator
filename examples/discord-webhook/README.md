# Discord webhook bridge

Forward mcp-coordinator consultation events to a Discord channel using an
incoming webhook. The bridge subscribes to the coordinator's embedded MQTT
broker and posts a formatted embed whenever a consultation is opened, resolved,
claimed, or completed.

No coordinator code changes are required — this is a standalone subscriber.

## Prerequisites

Start a local coordinator with the embedded MQTT broker (TCP on
`127.0.0.1:1883` by default):

```bash
mcp-coordinator server start --daemon
```

Node.js 18+ (the bridge uses the built-in global `fetch`).

## Create a Discord webhook

1. In Discord, open **Server Settings → Integrations → Webhooks**.
2. Click **New Webhook**, pick the target channel, optionally rename it.
3. Click **Copy Webhook URL**. It looks like
   `https://discord.com/api/webhooks/<id>/<token>`.

Treat the URL as a secret — anyone with it can post to your channel.

## Configure

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `DISCORD_WEBHOOK_URL` | yes | — | The webhook URL you copied above. |
| `COORDINATOR_MQTT_URL` | no | `mqtt://127.0.0.1:1883` | Coordinator MQTT endpoint. |
| `COORDINATOR_TOKEN` | no | — | Phase-1 JWT. Only needed when the coordinator runs with `COORDINATOR_AUTH_ENABLED=true`. |

The bridge connects anonymously by default. When auth is enabled, obtain a
token via `POST /api/auth/register` and pass it as `COORDINATOR_TOKEN`; it is
sent in the MQTT CONNECT password field.

## Install & run

```bash
cd examples/discord-webhook
npm install
export DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/...'
npm start
```

If `DISCORD_WEBHOOK_URL` is missing the bridge exits immediately with
instructions.

## Events forwarded

The bridge subscribes to `coordinator/default/consultations/#` (the coordinator
publishes everything under the hardcoded org `default`) and forwards:

| MQTT topic | Discord message |
|---|---|
| `coordinator/default/consultations/new` | "New consultation" embed (subject, thread, agent, target modules) |
| `coordinator/default/consultations/<threadId>/status` (`status: "resolved"`) | "Consultation resolved" embed with summary |
| `coordinator/default/consultations/<threadId>/claimed` | "Consultation claimed" embed (who / when) |
| `coordinator/default/consultations/<threadId>/completed` | "Consultation completed" embed with summary |

Everything else on the subtree — in-thread `messages`, `resolving` status
updates — is ignored to keep the channel quiet. A retained
`consultations/new` with an **empty** payload means the consultation was
cleared, and is skipped.

## Sample output

A `consultations/new` event renders in Discord roughly as:

> **New consultation**
> Update auth docs
> **Thread** thread-123   **Agent** agent-alpha
> **Modules** docs

## Notes

- The coordinator hardcodes the org segment to `default`; there is no
  per-org MQTT routing yet, so the topic filter is fixed.
- WebSocket transport is also available at `ws://localhost:3100/mqtt` — set
  `COORDINATOR_MQTT_URL` accordingly if you prefer it.
