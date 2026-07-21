# Slack webhook bridge

Forward mcp-coordinator consultation events into a Slack channel. The bridge
subscribes to the coordinator's embedded MQTT broker and POSTs a formatted
message to a Slack [Incoming Webhook](https://api.slack.com/messaging/webhooks)
for each interesting event.

## Which events are forwarded

The bridge subscribes to `coordinator/default/consultations/#` and forwards:

| Event topic | Slack message |
|---|---|
| `consultations/new` | :mega: New consultation (subject, thread, agent, modules) |
| `consultations/<threadId>/status` | :white_check_mark: Resolved (only the terminal `resolved` status) |
| `consultations/<threadId>/claimed` | :hand: Claimed by an agent |
| `consultations/<threadId>/completed` | :checkered_flag: Completed with summary |

Noise is filtered out: empty retained `consultations/new` payloads (a cleared
announcement), per-message `/messages` chatter, and the intermediate
`resolving` status are all skipped.

> The coordinator publishes every topic under the hardcoded org `default`, so
> the topic filter is literally `coordinator/default/...`. There is no
> per-org MQTT routing today.

## 1. Create a Slack Incoming Webhook

1. Go to <https://api.slack.com/apps> and click **Create New App** →
   **From scratch**. Name it (e.g. `Coordinator`) and pick your workspace.
2. In the app settings, open **Incoming Webhooks** and toggle it **On**.
3. Click **Add New Webhook to Workspace**, choose the target channel, and
   **Allow**.
4. Copy the generated URL. It looks like
   `https://hooks.slack.com/services/T.../B.../xxxx` (keep it secret).

## 2. Configure

The webhook URL is read from an environment variable — never hardcode it.

| Env var | Required | Default | Purpose |
|---|---|---|---|
| `SLACK_WEBHOOK_URL` | yes | — | Slack incoming-webhook URL. |
| `COORDINATOR_MQTT_URL` | no | `mqtt://127.0.0.1:1883` | Broker URL. Use `ws://localhost:3100/mqtt` for WebSocket. |
| `COORDINATOR_TOKEN` | no | — | Phase-1 JWT, only when the coordinator runs with `COORDINATOR_AUTH_ENABLED=true`. |

By default the coordinator's MQTT broker is **anonymous**, so no token is
needed. When auth is enabled, obtain a token via
`POST /api/auth/register` and export it as `COORDINATOR_TOKEN`; the bridge
sends it in the MQTT CONNECT password field.

## 3. Install and run

Requires Node.js 18+ (for the built-in `fetch`).

```bash
cd examples/slack-webhook
npm install
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../xxxx"
npm start
```

On Windows PowerShell:

```powershell
$env:SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T.../B.../xxxx"
npm start
```

Stop it with `Ctrl-C`.

## Sample output

When an agent calls `announce_work`, the coordinator publishes a
`consultations/new` event and the bridge posts to Slack:

```text
:mega: New consultation — Update auth docs
thread: `thread-123` · agent: `agent-alpha` · modules: docs
```

When the consultation is resolved:

```text
:white_check_mark: Consultation resolved — thread `thread-123`
> Docs updated and merged.
```

## Troubleshooting

- **`SLACK_WEBHOOK_URL is not set`** — export the env var before running.
- **Nothing appears in Slack** — confirm the coordinator is running and that
  `mosquitto_sub -h 127.0.0.1 -p 1883 -t 'coordinator/default/#' -v` shows
  events. Slack POST failures are logged to stderr with the HTTP status.
- **Connection refused** — the broker binds to `127.0.0.1:1883`; set
  `COORDINATOR_MQTT_URL` if the coordinator runs elsewhere.
