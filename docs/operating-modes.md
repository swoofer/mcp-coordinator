# Operating modes — polling vs push

mcp-coordinator runs as a single long-lived daemon (HTTP MCP + embedded MQTT broker + dashboard). On top of that daemon, your **Claude Code session** can consume coordination state in one of two ways. Picking the right one depends on how often you want events to interrupt the model.

| | **Polling mode** (default) | **Push mode** (Channels, v0.12+) |
|---|---|---|
| Daemon required | Yes — `mcp-coordinator server start --daemon` | Yes — same daemon |
| Extra process per session | None | One `mcp-coordinator channel` stdio subprocess (spawned by Claude Code) |
| How Claude learns about events | Calls `coordinator_status` / `list_threads` between turns | Events arrive as `<channel>` tags injected into the model's context the moment they happen |
| Reply path | Existing MCP tools (`post_to_thread`, etc.) over HTTP | The channel's `post_to_thread` MCP tool, which publishes via MQTT |
| Claude Code version | Any | v2.1.80+ (research preview) |
| Special flag | None | `--dangerously-load-development-channels` until the plugin is on Anthropic's curated allowlist |
| Best for | Stable workflows, multi-team setups, anything that needs auth + dashboard | Real-time coordination where you want Claude to react between turns without you typing |

Both modes can coexist — the daemon doesn't care which combination of clients is talking to it.

---

## Mode 1 — Polling (works since v0.6)

This is the "vanilla" path. Any MCP client connects to the daemon's HTTP `/mcp` endpoint and calls tools. Claude only learns about coordination state when it explicitly asks. Events between turns are surfaced when Claude next runs `coordinator_status` (or the orchestrator's wrapper polls and injects the result).

```
┌─────────────────┐    HTTP / MCP    ┌──────────────────────────────┐
│ Claude Code     │ ───────────────► │  mcp-coordinator (daemon)    │
│  session(s)     │ ◄─────────────── │  • HTTP / MCP                │
└─────────────────┘    polled tools  │  • Embedded MQTT broker      │
                                     │  • Dashboard + SSE           │
                                     └──────────────────────────────┘
```

### Setup

```bash
npm install -g mcp-coordinator
mcp-coordinator init                 # writes ~/.mcp-coordinator/config.json + .mcp.json snippet
mcp-coordinator server start --daemon

# Paste the .mcp.json snippet into ~/.claude/.mcp.json:
# {
#   "mcpServers": {
#     "coordinator": { "type": "http", "url": "http://localhost:3100/mcp" }
#   }
# }
```

That's it. Claude now has all 26 tools available. State surfaces via tool calls between turns.

### When this is enough

- You manually invoke coordinator tools when you want to know what's going on (low cognitive overhead)
- You run an orchestrator (essaim, Aider, etc.) that handles the polling for you
- You don't need *immediate* awareness of events from other agents — a few-second delay is acceptable

---

## Mode 2 — Push via Claude Code Channels (v0.12+)

This is the new path. A second tiny process (`mcp-coordinator channel`) runs as a stdio MCP server that Claude Code spawns alongside your session. It subscribes to the daemon's MQTT broker and pushes every relevant coordination event into the session as `<channel>` tags. Claude reacts in real time. With Phase 2, Claude can also reply into threads directly via the channel's `post_to_thread` tool.

```
┌──────────────────────────────────────────────────┐
│  Claude Code session                             │
│  (started with --channels mcp-coordinator-channel)│
└────────────────┬─────────────────────────────────┘
                 │ stdio (Claude Code spawned)
┌────────────────▼─────────────────────────────────┐
│  mcp-coordinator channel (stdio MCP server)      │
│  • declares  claude/channel  capability          │
│  • exposes  post_to_thread  tool                 │
└────────────────┬─────────────────────────────────┘
                 │ MQTT subscribe / publish
                 │ (loopback by default)
┌────────────────▼─────────────────────────────────┐
│  mcp-coordinator (daemon)                        │
│  • HTTP / MCP                                    │
│  • Embedded MQTT broker                          │
│  • Dashboard + SSE                               │
└──────────────────────────────────────────────────┘
```

### Setup

```bash
# 1. Daemon already running per Mode 1 above.

# 2. Add the channel stdio entry to ~/.claude/.mcp.json alongside the HTTP coordinator entry:
{
  "mcpServers": {
    "coordinator":         { "type": "http",  "url": "http://localhost:3100/mcp" },
    "mcp-coordinator-channel": {
      "type": "stdio",
      "command": "mcp-coordinator",
      "args": ["channel"]
    }
  }
}

# 3. Launch Claude Code with the development flag (required during research preview):
claude --dangerously-load-development-channels server:mcp-coordinator-channel
```

### What you see in the session

When another agent calls `announce_work` and a consultation opens, Claude receives a tag like:

```
<channel source="mcp-coordinator" event_type="consultation_opened" thread_id="abc123" subject="Update auth docs" agent_id="agent-alpha">
{ ...payload... }
</channel>
```

Claude can act on it immediately (read files, propose changes, etc.) and reply via the `post_to_thread` tool:

```json
{
  "name": "post_to_thread",
  "arguments": {
    "thread_id": "abc123",
    "content": "I just edited that file in src/auth/login.ts. Holding off on auth doc changes until tomorrow."
  }
}
```

### Event filter

Phase 1 + 2 subscribe to these topic patterns:

- `coordinator/+/consultations/new` — a new consultation thread opened
- `coordinator/+/consultations/+/messages` — message posted into a thread (useful when other agents reply)
- `coordinator/+/agents/+/status` — an agent came online / offline / changed state

See [`docs/superpowers/specs/2026-05-23-channels-event-catalog.md`](./superpowers/specs/2026-05-23-channels-event-catalog.md) for the full topic taxonomy and which events were intentionally excluded.

### When to switch to push

- You want Claude to react to other agents **between turns** — no polling delay
- You're running multiple agents in parallel and want each to see the others' announcements immediately
- You'd otherwise have to write a shell loop or scheduler that pokes `coordinator_status` regularly

### Caveats

- **Research preview**. The `claude/channel` capability is still tagged research preview by Anthropic — schema can change. mcp-coordinator's Phase 1 + 2 will follow upstream changes.
- **`--dangerously-load-development-channels`** is required until the channel plugin is on Anthropic's curated allowlist. Submission requires a partner relationship with Anthropic.
- **No permission relay** (Phase 3). Tool-approval prompts still appear only in the local terminal. The maintainers chose not to implement permission relay because the loopback-MQTT trust model makes the sender-allowlist gate awkward to design well.
- **Phase 1 + 2 are local-loopback only**. The channel connects to `mqtt://127.0.0.1:1883` by default. For a remote daemon, the channel CLI would need a configurable broker URL — open an issue if you need this.

---

## Running both at once

Polling and push aren't mutually exclusive. A common setup is:

- HTTP coordinator entry for direct tool calls Claude initiates
- Channel stdio entry for events Claude shouldn't have to ask about

Both connect to the same daemon. Both see the same state. Use the channel for reactivity, the HTTP MCP for explicit queries. The example in [`examples/channels-quickstart/`](../examples/channels-quickstart/) wires both.

---

## See also

- [Channels reference (Anthropic)](https://code.claude.com/docs/en/channels-reference) — the upstream spec
- [`examples/channels-quickstart/`](../examples/channels-quickstart/) — copy-paste setup
- [`docs/superpowers/specs/2026-05-23-channels-event-catalog.md`](./superpowers/specs/2026-05-23-channels-event-catalog.md) — every event mcp-coordinator publishes, with Phase 1 priority
- [`docs/superpowers/working/channels-reference-plugins-study.md`](./superpowers/working/channels-reference-plugins-study.md) — patterns from Anthropic's reference plugins
