# Channels quickstart (research preview)

This example wires `mcp-coordinator` into Claude Code's [Channels](https://code.claude.com/docs/en/channels)
feature so that consultation, agent, and thread events arrive in your session
as `<channel>` tags — no polling, no MCP tool call required to receive them.
Claude can also reply into a consultation thread without leaving the channel
surface via the `post_to_thread` tool the channel server exposes.

> **Research preview.** Channels currently ships behind
> `--dangerously-load-development-channels` in Claude Code. The API may change.
> The `mcp-coordinator channel` subcommand documented here is push + reply:
> Phase 1 (push) streams events from the daemon into the session, Phase 2
> (reply) lets Claude post messages back via the `post_to_thread` tool — both
> over MQTT, no HTTP round-trip. Phase 3 (permission relay, out-of-session
> injection) remains deferred.

## Prerequisites

- Node.js 20+ (or use the Docker image)
- Claude Code with channel support
- A running coordinator daemon (steps below)

## 1. Install the coordinator

Either globally via npm:

```bash
npm install -g mcp-coordinator
mcp-coordinator init
```

…or via Docker:

```bash
docker run -d --name coordinator \
  -p 3100:3100 -p 1883:1883 \
  -v ~/.mcp-coordinator:/root/.mcp-coordinator \
  ghcr.io/swoofer/mcp-coordinator:latest server start
```

## 2. Start the daemon

```bash
mcp-coordinator server start --daemon
mcp-coordinator server status
```

The embedded MQTT broker now listens on `localhost:1883` and the dashboard at
`http://localhost:3100/dashboard`.

## 3. Register the channel with Claude Code

Copy [`.mcp.json.sample`](./.mcp.json.sample) into `~/.claude/.mcp.json`
(merging with any existing config). The `mcpServers.coordinator-channel` entry
tells Claude Code how to spawn the channel subprocess:

```json
{
  "mcpServers": {
    "coordinator-channel": {
      "command": "mcp-coordinator",
      "args": ["channel"]
    }
  }
}
```

`mcp-coordinator channel` reads `~/.mcp-coordinator/config.json` to find the
broker port (default `1883`) and subscribes to:

- `coordinator/+/consultations/new`
- `coordinator/+/consultations/+/messages`
- `coordinator/+/agents/+/status`

…then emits a `<channel>` tag per event into the Claude Code session.

## 4. Launch Claude Code with channels enabled

```bash
claude --dangerously-load-development-channels server:mcp-coordinator-channel
```

The `server:mcp-coordinator-channel` argument matches the MCP server name in
`.mcp.json` (without the `mcp__` prefix). Claude Code spawns
`mcp-coordinator channel` as a subprocess and begins streaming channel events
into the session.

## 5. Trigger an event from another agent

In a second terminal, simulate another agent announcing work. The easiest path
is to use the `npx mcp-coordinator` CLI with a tiny MCP script, but for a quick
smoke test you can publish straight to MQTT:

```bash
docker run --rm --network host eclipse-mosquitto \
  mosquitto_pub -h localhost -p 1883 \
  -t 'coordinator/default/consultations/new' \
  -m '{"agent_id":"agent-beta","subject":"Refactor auth middleware","target_modules":["src/auth"],"thread_id":"demo-thread-1"}'
```

…or run the [python-mqtt example](../python-mqtt/) in reverse using
`paho-mqtt`'s `publish.single()`.

## 6. Observe the channel event arrive in the session

Inside your Claude Code session you should now see something like:

```text
<channel name="coordinator-channel">
{"topic":"coordinator/default/consultations/new","agent_id":"agent-beta","subject":"Refactor auth middleware","target_modules":["src/auth"],"thread_id":"demo-thread-1"}
</channel>
```

Claude can now reason about the event and, if relevant, reply directly into
the thread by calling the channel server's `post_to_thread` tool — no need
to leave the channel surface or use the daemon's main MCP toolbelt.

## 7. Reply into the thread from inside the session

When Claude sees the `<channel event_type="consultation_opened">` tag above,
it can post back into the thread by calling the `post_to_thread` tool that
the channel server registers. A typical reply call looks like:

```jsonc
// Claude → channel server (tools/call)
{
  "name": "post_to_thread",
  "arguments": {
    "thread_id": "demo-thread-1",
    "content": "Acknowledged — I'm looking at src/auth right now, will hold off on edits until you confirm scope.",
    "agent_id": "channel"   // optional, defaults to "channel"
  }
}
```

The channel server publishes the message onto
`coordinator/<org>/consultations/demo-thread-1/messages` over MQTT — the same
topic the daemon's `post_to_thread` MCP tool uses — so every other subscriber
(other agents on `wait_for_message`, the dashboard, the audit log) sees the
reply as if it came from any other coordination participant. No HTTP call,
no extra server.

Override `--org <slug>` on `mcp-coordinator channel` (or set
`COORDINATOR_ORG`) when running against a non-default org.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Claude Code refuses to start | `--dangerously-load-development-channels` is gated on Channels-capable builds — verify with `claude --version`. |
| No `<channel>` tags appear | `mcp-coordinator server status` — daemon may be down, or the broker port differs from `~/.mcp-coordinator/config.json`. |
| "command not found: mcp-coordinator" | Either `npm install -g mcp-coordinator` or prefix with `npx`. |
| Events arrive on dashboard but not in session | Topic filter mismatch — check `mcp-coordinator channel --print-topics` (planned) or watch the daemon log at `~/.mcp-coordinator/logs/server.log`. |

## See also

- [Anthropic channels docs](https://code.claude.com/docs/en/channels)
- [Channels reference (event shape)](https://code.claude.com/docs/en/channels-reference)
- [`examples/python-mqtt/`](../python-mqtt/) — same MQTT broker, raw Python subscriber
- [Issue #130](https://github.com/swoofer/mcp-coordinator/issues/130) — Phase 1 tracking
