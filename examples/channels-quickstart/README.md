# Channels quickstart (research preview)

This example wires `mcp-coordinator` into Claude Code's [Channels](https://code.claude.com/docs/en/channels)
feature so that consultation, agent, and thread events arrive in your session
as `<channel>` tags — no polling, no MCP tool call required to receive them.
Claude can also reply into a consultation thread without leaving the channel
surface via the `post_to_thread` tool the channel server exposes.

> **Read this before you follow the steps.** On a stock, up-to-date Claude
> Code, the channel **does not load**, and the failure is completely silent —
> no error, no log, nothing sent to the MCP server. Two host-side gates cause
> it and neither is ours. [Does this actually work?](#does-this-actually-work)
> has the detail. The walkthrough below is still correct and still worth
> having; it just does not currently end with a tag in your session.

> **Research preview.** Channels ships behind
> `--dangerously-load-development-channels` in Claude Code. The API may change.
> The `mcp-coordinator channel` subcommand documented here is push + reply:
> Phase 1 (push) streams events from the daemon into the session, Phase 2
> (reply) lets Claude post messages back via the `post_to_thread` tool — both
> over MQTT, no HTTP round-trip. Phase 3 (permission relay, out-of-session
> injection) remains deferred.

## Prerequisites

- Node.js 22+ (or use the Docker image)
- Claude Code with channel support — see the caveat above
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
(merging with any existing config). The `mcpServers.mcp-coordinator-channel` entry
tells Claude Code how to spawn the channel subprocess:

```json
{
  "mcpServers": {
    "mcp-coordinator-channel": {
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

The `server:mcp-coordinator-channel` argument matches **the key you registered
the server under** in `.mcp.json` — not the server's own `serverInfo.name`,
and without the `mcp__` prefix. The two happen to be identical here, which is
why they must be kept identical: rename the key and the launch argument stops
matching anything, silently.

Claude Code then spawns `mcp-coordinator channel` as a subprocess. **On a stock
install it will not stream anything — see [Does this actually work?]
(#does-this-actually-work) below before you spend time on it.**

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

What the channel process sends is a `notifications/claude/channel` with a
freeform `content` string and a `meta` bag:

```jsonc
{
  "content": "New consultation from agent-beta (thread demo-thread-1): Refactor auth middleware",
  "meta": {
    "event_type": "consultation_new",
    "org": "default",
    "thread_id": "demo-thread-1",
    "agent_id": "agent-beta"
  }
}
```

How the client renders that into a `<channel>` tag is its business, and we
have never observed it: no stock install has loaded the channel (below). The
tag shape this document used to show here was inferred, not captured, so it
has been removed rather than left to look like a measurement.

Claude can now reason about the event and, if relevant, reply directly into
the thread by calling the channel server's `post_to_thread` tool — no need
to leave the channel surface or use the daemon's main MCP toolbelt.

## 7. Reply into the thread from inside the session

When Claude sees a `consultation_new` event, it can post back into the thread
by calling the `post_to_thread` tool that the channel server registers. A
typical reply call looks like:

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

## Does this actually work?

**Not on a stock, up-to-date install — and the failure is completely silent.**

Measured on Claude Code 2.1.233 / Windows 11, across four configurations: no
`<channel>` tag was ever injected. Two independent host-side gates explain it,
both read out of the shipped client:

1. **`--dangerously-load-development-channels` is not parsed outside an
   interactive session.** The argument is read only on the interactive path;
   its result feeds the onboarding UI.
2. **Availability sits behind an Anthropic-side feature flag that defaults to
   off.** Nothing you can set locally changes it.

None of the client's refusal paths emits a message — not to you, not to the
MCP server. Claude Code starts normally, the subprocess is spawned or not, and
nothing says which. So there is no log to check and no symptom to search for.

**What this means for you.** Everything below the daemon is testable and works:
the broker, the topics, the `mcp-coordinator channel` process itself (it is
covered by `tests/integration/channel-smoke.test.ts` against a real MCP
client). What is not reachable today is the last hop — the client accepting
the channel. If you are here to evaluate the feature, use polling mode; if you
are here to develop against the channel process, the smoke test is the loop
you want, not a live session.

If you *do* see a tag in a real interactive session, that is news:
[#328](https://github.com/swoofer/mcp-coordinator/issues/328) is the place to
say so, and it unblocks the rest of the work.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `<channel>` tags appear | Almost certainly the host gates above, not your setup. Rule out the daemon first (`mcp-coordinator server status`, and check the broker port against `~/.mcp-coordinator/config.json`), then stop — there is nothing further to fix on this side. |
| The launch argument names a server that is not there | `server:<key>` must match the **key** in `.mcp.json`, which is `mcp-coordinator-channel`. A mismatch is silent. |
| "command not found: mcp-coordinator" | Either `npm install -g mcp-coordinator` or prefix with `npx`. |
| Events arrive on the dashboard but not in the session | This is the expected outcome today, per the section above. The dashboard reads the daemon directly; the session hop is what is gated. |

## See also

- [Anthropic channels docs](https://code.claude.com/docs/en/channels)
- [Channels reference (event shape)](https://code.claude.com/docs/en/channels-reference)
- [`examples/python-mqtt/`](../python-mqtt/) — same MQTT broker, raw Python subscriber
- [Issue #130](https://github.com/swoofer/mcp-coordinator/issues/130) — Phase 1 tracking
