# GitHub Actions MQTT bridge

Forward mcp-coordinator **consultation events** to a webhook (Slack or a generic
JSON endpoint) from a GitHub Actions workflow.

## The one constraint that shapes everything: Actions is not a daemon

A GitHub Actions job is a short-lived process. It **cannot** hold an MQTT
connection open indefinitely, so this example does not pretend to be a live
bridge. It is a **bounded drain**:

1. connect to the coordinator over WebSocket,
2. subscribe to `coordinator/default/#`,
3. forward every interesting event it sees for `RUN_SECONDS` (default 55s),
4. disconnect and `exit 0`.

The workflow runs this on a schedule (every 15 min by default) and on demand.

### What you do and don't catch

The coordinator publishes the "current state" topics as **QoS 1 retained**
messages, so they are re-delivered on every connect:

- `coordinator/default/consultations/new` (retained)
- `coordinator/default/consultations/<threadId>/status` (retained)

That means a scheduled drain reliably picks up the **latest** open / resolved
state even for consultations that happened between runs.

Transient events are **only** caught if they fire inside a drain window:

- `.../messages`, `.../claimed`, `.../completed`, `broadcast`, `agents/+/status`,
  `quota/update` (not retained)

This gap is inherent to polling. If you need every event with no gaps, run a
long-lived process instead — see [`../systemd`](../systemd) (bare host /
`systemd` unit) or [`../fly-io`](../fly-io) (managed always-on host). Those keep
one connection open continuously; this workflow trades completeness for
"no server to operate."

## Network: WSS through a reverse proxy, not the TCP broker

The coordinator's TCP MQTT listener is bound to `127.0.0.1:1883` and is **not
reachable from a GitHub-hosted runner**. The runner must reach the coordinator's
**MQTT-over-WebSocket** endpoint (`/mqtt`, shares the HTTP server on port 3100),
exposed publicly through a TLS reverse proxy:

```
COORDINATOR_URL = wss://coordinator.example.com/mqtt
```

See [`../nginx-reverse-proxy`](../nginx-reverse-proxy) for a proxy config that
terminates TLS and handles the `/mqtt` WebSocket upgrade. (mqtt.js offers the
`mqtt` WebSocket subprotocol on the handshake; the coordinator doesn't use a
subprotocol and simply ignores it — the handshake still succeeds.)

## Required repo secrets

Set these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Purpose |
|---|---|---|
| `COORDINATOR_URL` | yes | `wss://<host>/mqtt` — the coordinator via your reverse proxy |
| `WEBHOOK_URL` | yes | Slack incoming-webhook URL, or any endpoint accepting a JSON POST |
| `COORDINATOR_TOKEN` | no | Phase-1 JWT, **only** if the coordinator runs with `COORDINATOR_AUTH_ENABLED=true` (sent as the MQTT CONNECT password) |

Optional repository **variable** (not a secret):

| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_TYPE` | `slack` | `slack` sends `{ text }`; `generic` POSTs the raw `{ topic, event, ... }` |

## Files

- `.github/workflows/coordinator-bridge.yml` — the scheduled / dispatch /
  `workflow_call` workflow.
- `bridge.mjs` — the bounded subscriber + forwarder (mqtt.js over ws(s)).
- `package.json` — pins `mqtt`.

## Use it in your own repo

Copy `bridge.mjs`, `package.json`, and the workflow into your repository. Two
ways to wire it up:

**A. Drop-in workflow.** Put `coordinator-bridge.yml` in `.github/workflows/`.
If you place `bridge.mjs`/`package.json` somewhere other than
`examples/github-actions-mqtt-bridge/`, update the `working-directory:` in the
workflow to match.

**B. Reusable (`workflow_call`).** Call it from another workflow:

```yaml
jobs:
  bridge:
    uses: your-org/your-repo/.github/workflows/coordinator-bridge.yml@main
    with:
      run_seconds: "55"
      webhook_type: "slack"
    secrets:
      COORDINATOR_URL: ${{ secrets.COORDINATOR_URL }}
      WEBHOOK_URL: ${{ secrets.WEBHOOK_URL }}
      COORDINATOR_TOKEN: ${{ secrets.COORDINATOR_TOKEN }}
```

## Run it locally

```sh
cd examples/github-actions-mqtt-bridge
npm install
COORDINATOR_URL="wss://coordinator.example.com/mqtt" \
WEBHOOK_URL="https://hooks.slack.com/services/T.../B.../xxxx" \
WEBHOOK_TYPE="slack" \
RUN_SECONDS=20 \
node bridge.mjs
# add COORDINATOR_TOKEN=<jwt> if the coordinator has auth enabled
```

## Adapting the forwarding logic

`bridge.mjs` only forwards consultation topics and, for `/status`, only the
terminal `resolved` state. Edit `summarize()` to widen or narrow that (e.g.
include `broadcast`, or alert on a specific `target_module`). Edit
`webhookBody()` to change the payload shape — for `generic` it forwards the
parsed event verbatim, so a downstream service (PagerDuty, a Lambda, another CI
job) can branch on `topic` and `event`.

## Tuning the schedule

- The `cron` minimum interval is 5 minutes; GitHub may delay runs under load.
- Prefer a **shorter `RUN_SECONDS` run more often** over one long drain — it
  narrows the window where transient events are missed and keeps job minutes low.
- `concurrency` is set so two drains never overlap (overlap would double-forward
  the retained events).
