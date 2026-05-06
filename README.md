<div align="center">

# mcp-coordinator

**Embedded MQTT broker + MCP server for multi-agent coordination. Zero conflicts, everyone aligned.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-coordinator.svg)](https://www.npmjs.com/package/mcp-coordinator)
[![Tests](https://github.com/swoofer/mcp-coordinator/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions)

[Getting started](#getting-started) · [Problem](#the-problem) · [How It Works](#how-it-works) · [MQTT Layer](#mqtt-communication-layer) · [Scoring](#impact-scoring) · [MCP Tools](#mcp-tools) · [CLI](#cli) · [Standalone use](#standalone-use--without-an-orchestrator) · [Quota](#anthropic-quota-pre-flight) · [Dashboard](#dashboard) · [Config](#configuration) · [Auth](#authentication)

</div>

---

## The Problem

When multiple developers each use an AI coding agent in parallel on the same repo, things break:

- **Regressions** — Agent A rewrites a module that Agent B was depending on
- **Duplicated work** — Two agents implement the same feature from different directions
- **Architectural drift** — Agents make local decisions that conflict with each other's designs
- **Wasted reconciliation time** — Developers spend hours untangling what the agents did

Each agent works in isolation. None of them know what the others are doing.

mcp-coordinator fixes this by giving agents a **shared nervous system over MQTT** — they announce intentions before coding, conflicts are detected before a single line is written, and agents see each other's actions in real-time to agree on an approach.

It works **with or without** an orchestrator on top. Use it standalone with any MCP client (Claude Code, Cursor, Cline, Aider) — see [Standalone use](#standalone-use--without-an-orchestrator). Or pair it with [essaim](https://github.com/swoofer/essaim) when you want pre-composed agent profiles, work-stealing templates, and a behavior catalog.

---

## Getting started

```bash
# 1. Install
npm install -g mcp-coordinator

# 2. First-time setup — creates ~/.mcp-coordinator/, writes a default config,
#    and prints a .mcp.json snippet for your MCP client.
mcp-coordinator init

# 3. Start the server (foreground or --daemon for background)
mcp-coordinator server start --daemon

# 4. Verify
mcp-coordinator server status
mcp-coordinator dashboard      # opens http://localhost:3100/dashboard
```

Step 2 is idempotent — re-running `init` won't overwrite an existing config. The snippet it prints goes into your MCP client's config (e.g., `~/.claude/.mcp.json` for Claude Code). If you'd rather not copy-paste, run `mcp-coordinator init --write-mcp-config <project-path>` and the snippet is written to `<project-path>/.mcp.json` (merging if the file already exists).

After step 4, every Claude Code (or other MCP-compatible) session connected to this coordinator can call all 26 tools (`register_agent`, `announce_work`, `post_to_thread`, `coordinator_status`, ...). For the full multi-Claude or team setup, see [Standalone use](#standalone-use--without-an-orchestrator).

---

## How It Works

```
   Agent A                          Agent B
     │                                │
     │  announce_work                 │  announce_work
     ▼                                ▼
┌──────────────┐                ┌──────────────┐
│  MCP client  │ ◄── MQTT ────► │  MCP client  │
│ (any vendor) │   push-based   │ (any vendor) │
└──────┬───────┘                └──────┬───────┘
       │         MCP HTTP / SSE        │
       └──────────────┬────────────────┘
                      │
            ┌─────────▼──────────┐
            │   mcp-coordinator  │
            │  26 MCP tools + DB │
            │  Aedes MQTT broker │
            └─────────┬──────────┘
                      │ SSE
            ┌─────────▼──────────┐
            │     Dashboard      │
            │  live events/quota │
            └────────────────────┘
```

The **consultation cycle** has four steps:

1. **Announce** — A client calls `announce_work` with target files, `depends_on_files`, and target modules before coding.
2. **Detect** — The coordinator scores impact against all online agents and opens a thread if a score ≥ 90 matches.
3. **Consult** — MQTT pushes the new thread to every affected agent. Each agent posts context, constraints, or proposes a resolution.
4. **Resolve** — Agents approve, contest, or propose again. The thread closes when consensus is reached, or auto-resolves after timeout / in gray zones.

The server is **client-agnostic**: any MCP-compatible agent (Claude Code, Cursor, Cline, Aider, custom scripts) can connect over HTTP/SSE or stdio.

---

## MQTT Communication Layer

The coordinator ships with an **embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker**. Agents subscribe once and receive every coordination event in real-time — no polling, no extra infrastructure.

### Broker

| Transport | Port | Use case |
|-----------|------|----------|
| TCP | `1883` (bind `127.0.0.1` by default) | Local / LAN agents, best latency |
| WebSocket | `/mqtt` on the coordinator HTTP port (default `3100`) | Bun binary, remote agents, firewall-friendly |

One coordinator = one broker. Nothing external to install.

### Topic map

Every coordinator event is published on a well-known topic. Clients subscribe to the full set on connect.

| Topic | Emitted when | Payload highlights |
|-------|--------------|--------------------|
| `coordinator/consultations/new` | A thread is opened | `thread_id`, `subject`, `initiator_id`, `target_modules`, `target_files` |
| `coordinator/consultations/{id}/messages` | Anyone posts to a thread | `agent_id`, `name`, `content`, `type` (warning/context/proposal) |
| `coordinator/consultations/{id}/status` | Thread transitions state | `status` ∈ `open` / `resolving` / `resolved` / `timeout` |
| `coordinator/consultations/{id}/claimed` | An agent atomically claims a task (work-stealing) | `claimed_by`, `thread_id` |
| `coordinator/consultations/{id}/completed` | Claimed task finishes | `agent_id`, `thread_id`, `resolution` |
| `coordinator/agents/{id}/status` | Agent goes online / offline | `status`, `name`, `modules` |
| `coordinator/broadcast` | System-wide announcements | arbitrary JSON |
| `coordinator/quota/update` | Anthropic quota refresh | `usage`, `limit`, `utilization_pct` |

### Push delivery flow

```
 COORDINATOR                 BROKER (Aedes)               CLIENT
 ───────────                 ──────────────               ──────

 announce_work() ──────────► publish                      subscribe
                             coordinator/                 ─► event
                             consultations/new ─────────► classify topic
                                                          self-msg filter
                                                          ─► handler
```

Key guarantees:

- **Self-filter** — clients drop messages where `payload.agent_id` equals the local agent's id, so agents never wake on their own actions.
- **Bun compatibility** — when consumed from a Bun-compiled client, a Duplex stream bridges the `mqtt` client to the native WebSocket API (the `ws` package receiver doesn't work under Bun).
- **Backpressure-free** — messages are small JSON envelopes.

---

## Impact Scoring

Every `announce_work` call scores all online agents across multiple detection layers. The highest matching layer wins.

| Layer | Signal | Score | Trigger |
|-------|--------|------:|---------|
| 0a | Same file announced in active thread | 100 | `target_files` ∩ their `target_files` |
| 0b | They modify a file you depend on | 80 | `depends_on_files` ∩ their `target_files` |
| 0c | You modify a file they depend on | 80 | `target_files` ∩ their `depends_on_files` |
| 1 | Same file recently edited | 100 | File tracker conflict (last 60s) |
| 2 | Dependency file recently edited | 80 | `depends_on_files` recently touched |
| 3 | Same module prefix | 30 | `target_modules` overlap |

Scores are categorized into three outcomes:

| Score | Category | Action |
|-------|----------|--------|
| ≥ 90 | `concerned` | Thread opened, consultation required |
| 30–89 | `gray_zone` | Thread auto-resolved, introspection recommended |
| < 30 | `pass` | No conflict, proceed immediately |

> **Layer 0 is critical.** Without announced intentions, a two-agent scenario where both work in `src/auth/` would score only 30 (gray zone, auto-resolved). With `announce_work`, the same scenario scores 100 and triggers a full consultation.

---

## MCP Tools

26 tools organized by function. All registered under one HTTP/SSE transport at `/mcp` (and stdio for stdio-mode clients).

### Agent registry

| Tool | Description |
|------|-------------|
| `register_agent` | Register as online with name and module list |
| `list_agents` | List all registered online agents |
| `heartbeat` | Update last-seen and derive activity status |
| `agent_activity` | Get activity status for all online agents |
| `wait_for_peers` | Block until N peers online, or timeout (prevents race before first announce) |

### Consultation

| Tool | Description |
|------|-------------|
| `announce_work` | Open a consultation thread — the main entry point before coding |
| `post_to_thread` | Post a message (warning, context, question) to an open thread |
| `propose_resolution` | Submit a resolution proposal for participants to approve |
| `approve_resolution` | Approve the current resolution proposal |
| `contest_resolution` | Reject the proposal with a reason — resets to `open` |
| `close_thread` | Close a thread after work is complete |
| `cancel_thread` | Cancel a thread (work abandoned or no longer relevant) |
| `get_thread` | Get a thread with all messages and current status |
| `get_thread_updates` | Poll for new messages since a timestamp |
| `list_threads` | List threads, filterable by status or agent |
| `log_action_summary` | Log a one-liner action summary for the dashboard timeline |

### File tracking

| Tool | Description |
|------|-------------|
| `hot_files` | List files being edited by multiple agents |
| `get_session_files` | Get all files edited by an agent in the current session |
| `check_file_conflict` | Check whether another agent edited a given file recently |

### Dependency map

| Tool | Description |
|------|-------------|
| `set_dependency_map` | Load a module dependency graph (JSON) |
| `get_blast_radius` | Calculate which other modules are affected by changes |
| `get_module_info` | Get dependency and dependent info for a module |

### MQTT

| Tool | Description |
|------|-------------|
| `wait_for_message` | Block until a coordination message arrives on the agent's topic |
| `get_queued_messages` | Drain all queued messages without blocking |
| `mqtt_publish` | Publish a raw message to any MQTT topic |

### Status

| Tool | Description |
|------|-------------|
| `coordinator_status` | Full system status: agents, threads, file activity, MQTT, quota |

The in-server `introspection` tool returns the full schema for every tool — point any MCP client at it for live discovery.

---

## CLI

Two distribution channels:

- **npm** — `npm install -g mcp-coordinator`. Requires Node.js 20+.
- **Single-file binary** — Bun-compiled, no Node required. Download the matching tarball from a [GitHub Release](https://github.com/swoofer/mcp-coordinator/releases).

### Commands

| Command | Description |
|---------|-------------|
| `mcp-coordinator init [--url <url>] [--write-mcp-config <path>] [--write-claude-md <path>]` | First-time setup — create config dir, default `config.json`, print/write the `.mcp.json` snippet, optionally scaffold a sample `CLAUDE.md` |
| `mcp-coordinator uninstall [--mcp-config <path>] [--claude-md <path>] [--purge] [--force]` | Remove integrations: drop `coordinator` entry from a `.mcp.json`, strip the coordination section from a `CLAUDE.md`, or `--purge` the `~/.mcp-coordinator/` directory entirely |
| `mcp-coordinator server start [--port N] [--data-dir PATH] [--daemon]` | Start the coordinator (foreground or daemon) |
| `mcp-coordinator server stop` | Stop the coordinator |
| `mcp-coordinator server status` | PID, port, online agents, open threads |
| `mcp-coordinator server logs [-n N] [-f]` | Tail the daemon log at `~/.mcp-coordinator/logs/server.log` |
| `mcp-coordinator dashboard` | Open `http://localhost:3100/dashboard` |
| `mcp-coordinator doctor [--host H] [--port P] [--mqtt-port P]` | Health check: config, server liveness, `/health`, `/mcp` initialize, dashboard, MQTT broker |
| `mcp-coordinator --version` | Print the installed version |

### Quick start

```bash
# Start the coordinator (embedded MQTT + dashboard)
mcp-coordinator server start --daemon

# Open the dashboard
mcp-coordinator dashboard

# Stop when done
mcp-coordinator server stop
```

### In-process from your own Node app

```ts
import { startServer } from "mcp-coordinator";

await startServer({
  port: 3100,
  dataDir: "./coordinator-data",
});
```

---

## Standalone use — without an orchestrator

You don't need an orchestrator. mcp-coordinator works on its own with any MCP-compatible client — Claude Code, Cursor, Cline, Aider, custom scripts. The two most common setups:

### Solo developer, multiple Claude Code sessions

You're running 2-3 Claude Code sessions in parallel on the same repo and want them to see each other's work. One coordinator instance handles all of them.

```bash
# In one terminal: start the coordinator
mcp-coordinator server start --daemon
```

Then add the coordinator to each Claude Code session's `.mcp.json` (located at `~/.claude/.mcp.json` for the global config, or `<your-project>/.mcp.json` for per-project):

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

Each Claude session now has access to all 26 coordination tools (`register_agent`, `announce_work`, `post_to_thread`, etc.). Open `mcp-coordinator dashboard` in a browser to watch real-time activity across your sessions.

### Team setup — shared coordinator on LAN

One person hosts the coordinator on a shared machine; teammates point their Claude at it.

Host:

```bash
# Bind to all interfaces; default is 127.0.0.1
COORDINATOR_BIND=0.0.0.0 mcp-coordinator server start --daemon
```

Each teammate's `.mcp.json` points to the host's IP:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://192.168.1.42:3100/mcp"
    }
  }
}
```

For internet-facing or multi-tenant deployments, enable JWT auth (see [Authentication](#authentication)). Each teammate registers via `POST /api/auth/register` with the team's `COORDINATOR_REGISTRATION_SECRET`, gets a Bearer token, and adds it to their `.mcp.json`:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "https://coordinator.example.com/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

### Telling Claude to use the coordinator tools

Without a behavior catalog (which is what [essaim](https://github.com/swoofer/essaim) ships), you instruct Claude manually. Easiest path:

```bash
# In your project root — scaffolds CLAUDE.md with coordinator instructions
mcp-coordinator init --write-claude-md ~/my-repo --write-mcp-config ~/my-repo
```

This appends a clearly-marked `mcp-coordinator:coordination-section` block to `~/my-repo/CLAUDE.md` (creating it if absent, replacing the section if it already exists). Combined with `--write-mcp-config`, your project is fully wired in one command.

If you'd rather embed the instructions yourself (or you're not using Claude Code), the section reads roughly:

> Before modifying any source file, register with the coordinator MCP server:
>
> 1. Call `register_agent` with your name and the modules you'll touch
> 2. Call `announce_work` describing what you'll do, listing target files (and `depends_on_files` if applicable)
> 3. If a thread is created (consultation triggered), wait for the resolution before writing code
> 4. After a meaningful change, call `log_action_summary` to update the dashboard timeline
> 5. If another agent is already working on a file you need to touch, post a question to the thread via `post_to_thread` and wait for their response before proceeding
>
> Use the `coordinator_status` tool to see current activity at any time.

That's all you need to start coordinating. The dashboard shows live who's doing what; the SQLite database persists threads across sessions; conflicts are detected before code is written.

### Push vs polling — important architectural note

Vanilla Claude Code talks to mcp-coordinator over MCP (HTTP/stdio request-response). It **does not subscribe to MQTT**. That means events the coordinator publishes on MQTT (`coordinator/consultations/new`, etc.) are not auto-delivered to a Claude Code session — Claude has to **poll** the coordinator to discover new activity. The polling pattern is:

- `announce_work` returns the thread ID immediately if a conflict is detected — that's the most important checkpoint
- After that, periodic calls to `coordinator_status` / `list_threads` / `get_thread_updates` surface new posts on threads you're a participant in
- The CLAUDE.md scaffolded by `mcp-coordinator init --write-claude-md` instructs Claude to do exactly this polling

If you want **real-time push** (every coordination event interrupting Claude between turns instead of waiting for a poll), use [essaim](https://github.com/swoofer/essaim). essaim ships an agent-loop wrapper that subscribes to the MQTT broker and injects events into the turn flow automatically. mcp-coordinator alone supports the polling model — which is sufficient for most use cases (2-3 Claude sessions on a small team) and zero-config to set up.

### End-to-end example: two Claudes coordinating (polling model)

Two terminals, same repo, both Claude Code sessions wired to the same local coordinator. Both sessions have a `CLAUDE.md` scaffolded by `mcp-coordinator init --write-claude-md`, which instructs Claude to register, announce, and poll. The conversation below is what each Claude does — the human user just asks each Claude to make a change.

```
TERMINAL 1 (Alice)                        TERMINAL 2 (Bob)

$ claude                                  $ claude
> "Add updated_at to User type in         > "Migrate User schema"
   src/models/user.ts"                       (touches src/models/user.ts)

[Alice's Claude]                          [Bob's Claude]
register_agent(name="Alice", ...)         register_agent(name="Bob", ...)
announce_work(
  target_files: ["src/models/user.ts"]
)
→ response: { thread_id: null,
              concerned_agents: [] }      announce_work(
                                            target_files: ["src/models/user.ts",
                                                           "migrations/004.sql"]
                                          )
                                          → response: { thread_id: "T-1",
                                                        concerned_agents: ["alice"],
                                                        score: 100, layer: "0a" }
                                          [Bob sees the conflict in the response]
                                          get_thread("T-1")
                                          post_to_thread("T-1", type: "context",
                                            content: "full schema migration; can
                                            wait for your field to land first")

[Alice writes the field, then before                                            
 next major action the CLAUDE.md says
 "poll coordinator_status"]
coordinator_status()
→ response: shows T-1 with Bob's post
get_thread("T-1")
post_to_thread("T-1", type: "context",
  content: "adding 1 field at line 42,
  no rename. Done in 5 min.")
propose_resolution("T-1",
  content: "Alice's field first,
  Bob runs migration after")

                                          [Bob's CLAUDE.md polling step]
                                          coordinator_status()
                                          → shows T-1 in 'resolving' state
                                          get_thread("T-1")
                                          approve_resolution("T-1")

[Alice's next poll]
coordinator_status()
→ T-1 status = 'resolved'
[Alice writes the field]                  [Bob writes the migration]
log_action_summary(...)                   log_action_summary(...)
```

The dashboard at `http://localhost:3100/dashboard/` plays the entire timeline live. `mcp-coordinator server logs -f` (in a third terminal) tails the daemon log if you want to see the protocol-level events. If polling cadence is too coarse and you find Claude missing posts, switch to essaim's agent-loop, which delivers MQTT events automatically.

### Team setup walkthrough — shared coordinator with JWT

Full step-by-step for a team running a coordinator on a shared host with internet-facing or multi-tenant access. Adjust to your network/TLS reality.

**Step 1 (host) — generate secrets**

```bash
# 32+ char shared secret; put in your secrets manager and inject as env vars
JWT_SECRET=$(openssl rand -hex 32)
REGISTRATION_SECRET=$(openssl rand -hex 32)
ADMIN_SECRET=$(openssl rand -hex 32)
```

**Step 2 (host) — start the coordinator with auth enabled**

```bash
COORDINATOR_AUTH_ENABLED=true \
COORDINATOR_JWT_SECRET="$JWT_SECRET" \
COORDINATOR_REGISTRATION_SECRET="$REGISTRATION_SECRET" \
COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" \
COORDINATOR_BIND=0.0.0.0 \
mcp-coordinator server start --daemon --port 3100
```

(Front the server with TLS via nginx/Caddy/etc. for internet exposure. Local LAN can use plain HTTP.)

**Step 3 (each teammate) — request a token**

```bash
curl -X POST https://coordinator.example.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"alice","registration_secret":"<REGISTRATION_SECRET shared via team channel>"}'
# Response: { "agent_id": "alice-abc123", "token": "eyJ...", "expires_at": "...", "role": "agent" }
```

**Step 4 (each teammate) — wire `.mcp.json`**

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "https://coordinator.example.com/mcp",
      "headers": { "Authorization": "Bearer <paste-token-here>" }
    }
  }
}
```

**Step 5 (each teammate) — run `init --write-claude-md` to scaffold project instructions**, OR add the coordination section to their existing `CLAUDE.md`.

**Step 6 (each teammate) — verify**: `mcp-coordinator doctor --host coordinator.example.com --port 443` should show all checks green from any laptop.

**Token rotation**: tokens expire per `COORDINATOR_JWT_EXPIRY` (default 24h). Refresh via `POST /api/auth/refresh` with the current Bearer token. The admin can revoke a specific agent via `POST /api/auth/revoke` (admin token required).

### Logs and debugging

The daemon writes to `~/.mcp-coordinator/logs/server.log`. Tail it:

```bash
mcp-coordinator server logs           # last 50 lines
mcp-coordinator server logs -n 200    # last 200 lines
mcp-coordinator server logs -f        # follow (Ctrl+C to stop)
```

For a one-shot check that everything is wired up correctly (config valid, server up, MCP responds, dashboard reachable, MQTT accepting connections), use the doctor:

```bash
mcp-coordinator doctor
```

`doctor` exits non-zero if any check fails and prints actionable hints next to each failure. Probe a remote coordinator with `--host` and `--port`:

```bash
mcp-coordinator doctor --host coordinator.example.com --port 443 --mqtt-port 1883
```

Logging level is controlled by `LOG_LEVEL` (`debug`, `info`, `warn`, `error` — default `info`). Set `NODE_ENV=development` for human-readable pretty logs:

```bash
NODE_ENV=development LOG_LEVEL=debug mcp-coordinator server start
```

### Removing the integration (per-project or globally)

Symmetric to `init`, the `uninstall` command undoes what was added without touching anything you wrote yourself.

```bash
# Remove coordinator from a project's .mcp.json AND strip its section from CLAUDE.md
mcp-coordinator uninstall --mcp-config ~/my-repo --claude-md ~/my-repo

# Wipe the global config dir (~/.mcp-coordinator/) entirely — config + data + logs + pid file
mcp-coordinator uninstall --purge          # asks for confirmation
mcp-coordinator uninstall --purge --force  # skip the prompt, useful in scripts
```

`--mcp-config <path>` reads `<path>/.mcp.json`, removes only the `coordinator` server entry (other servers untouched), and deletes the file if it ends up empty. `--claude-md <path>` removes only the block between the `<!-- mcp-coordinator:coordination-section -->` sentinels — it never touches text you authored. Combine flags as needed; if the resulting `CLAUDE.md` is empty, it's deleted.

To remove the npm package itself: `npm uninstall -g mcp-coordinator`.

### Running multiple coordinators on the same machine

Useful for per-project isolation — every project gets its own ephemeral coordinator with no cross-contamination. Pick distinct ports + data dirs:

```bash
# Project A
PORT=3110 \
COORDINATOR_MQTT_TCP_PORT=11883 \
mcp-coordinator server start --daemon --data-dir ./.mcp-coordinator-A

# Project B (different terminal)
PORT=3120 \
COORDINATOR_MQTT_TCP_PORT=12883 \
mcp-coordinator server start --daemon --data-dir ./.mcp-coordinator-B
```

The default `~/.mcp-coordinator/server.pid` only tracks ONE daemon at a time. For multi-instance runs, pass `--data-dir` explicitly to each instance — the PID file lives next to the data dir, so multiple instances don't fight over the same file. To stop a specific instance, `cd` to its data dir's parent and run `mcp-coordinator server stop` from there, OR `kill $(cat ./.mcp-coordinator-A/../server.pid)`.

In each project's `.mcp.json`, point at the project's coordinator:

```json
{
  "mcpServers": {
    "coordinator": {
      "type": "http",
      "url": "http://localhost:3110/mcp"
    }
  }
}
```

This pattern works well alongside `essaim`, which uses Strategy A (in-process) and starts its own ephemeral coordinator per `essaim run` — there's no port conflict because essaim picks an isolated dir by default.

---

## Anthropic Quota Pre-flight

The coordinator tracks Anthropic workspace quota live and exposes it on MQTT, the dashboard, and the `coordinator_status` MCP tool — so MCP clients can decide whether to abort, throttle, or proceed before launching expensive turns.

- Reads usage from the Anthropic API using the key in the environment.
- Threshold via `MAX_QUOTA_PCT` env var (default `95`).
- Back-off when the usage endpoint itself returns 429.
- Live widget in the dashboard with manual refresh + historical buckets.
- `coordinator/quota/update` MQTT events stream into the timeline by default.

Orchestrators that spawn N agents at once can read `coordinator_status.quota` and abort their run if utilization is over a configured threshold — the [essaim](https://github.com/swoofer/essaim) reference orchestrator does exactly this.

---

## Token Observability

Every MCP tool call and agent turn is logged with token breakdown.

- **Logs** — component logger `tokens` emits `input_tokens`, `output_tokens`, `cache_read`, `cache_creation`, `thinking`, model id, turn index.
- **Dashboard** — live per-agent token gauge, cumulative session total, quota widget.

Aggregating across runs (e.g., `reports/YYYY-MM-DD-<run-id>.md`) is an orchestrator responsibility — the coordinator emits the events, the orchestrator consumes them.

---

## Dashboard

`http://localhost:3100/dashboard` (or `/dashboard` on whichever port the coordinator is bound to).

- **Timeline** — all threads + `quota_update` events with scores and resolution types
- **Agent panel** — online/offline, working/idle/waiting, current file, thread being waited on. Resizable drag handle.
- **Scoring breakdown** — which detection layer triggered each conflict
- **Quota widget** — live utilization %, stacked buckets, manual refresh button
- **Version banner** — server version shown in the header (dynamic, not hardcoded)
- **Consensus metrics** — per session: consensus / timeout / auto-resolved split, token totals

All events arrive via SSE on `/api/events`. No polling.

---

## Agent Activity States

| Status | Indicator | Meaning |
|--------|-----------|---------|
| working | pulsing blue | Actively editing files |
| idle | solid green | Online, no recent activity |
| waiting | pulsing yellow | Blocked on a consultation thread |
| offline | solid red | Disconnected or session ended |

Activity is derived from heartbeats enriched with the current file/thread context from the file tracker.

---

## Configuration

### Local data

```
~/.mcp-coordinator/
├── config.json          # persistent configuration
├── data/
│   └── coordinator.db   # SQLite database
├── server.pid           # PID file (when daemonized)
└── logs/
    └── server.log       # daemon logs
```

### config.json

```json
{
  "server": { "port": 3100, "data_dir": "~/.mcp-coordinator/data" },
  "defaults": { "coordinator_url": "http://localhost:3100" }
}
```

Resolution priority (highest to lowest): CLI flag → env var → config.json → default.

### Server env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP port (also serves MQTT-over-WebSocket on `/mqtt`) |
| `COORDINATOR_DATA_DIR` | `~/.mcp-coordinator/data` | Directory for the SQLite database |
| `COORDINATOR_MQTT_TCP_PORT` | `1883` | TCP port for the embedded broker |
| `COORDINATOR_MQTT_WS_PATH` | `/mqtt` | WebSocket path on the same HTTP port |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | — | `development` for pretty logs |
| `COORDINATOR_AUTH_ENABLED` | `false` | Enable JWT authentication |
| `COORDINATOR_JWT_SECRET` | — | HMAC signing key (min 32 chars) |
| `COORDINATOR_JWT_EXPIRY` | `24h` | Token lifetime (e.g., `1h`, `7d`) |
| `COORDINATOR_REGISTRATION_SECRET` | — | Shared secret for agent auto-register |
| `COORDINATOR_ADMIN_SECRET` | — | Separate secret for admin token creation |
| `MAX_QUOTA_PCT` | `95` | Pre-flight abort threshold for Anthropic quota |

---

## Structured Logging

[Pino](https://getpino.io/) emits JSON per subsystem. Component loggers: `http`, `mcp`, `mqtt`, `consultation`, `conflict`, `auth`, `tokens`, `quota`.

Production (default):

```json
{"level":"info","time":1712345678901,"component":"http","msg":"Server started","port":3100}
```

Dev (`NODE_ENV=development`):

```
[14:21:03.456] INFO (http): Server started
    port: 3100
```

Levels controlled via `LOG_LEVEL`.

---

## Authentication

Opt-in JWT (HS256 via [jose](https://github.com/panva/jose)). Set `COORDINATOR_AUTH_ENABLED=true` plus the required secrets to enable.

### Setup

```bash
export COORDINATOR_AUTH_ENABLED=true
export COORDINATOR_JWT_SECRET="your-secret-at-least-32-characters-long"
export COORDINATOR_REGISTRATION_SECRET="team-shared-secret"
export COORDINATOR_ADMIN_SECRET="admin-only-secret"
```

### Agent self-register

```bash
curl -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"my-agent","registration_secret":"team-shared-secret"}'
# → { agent_id, token, expires_at, role }
```

### Refresh

```bash
curl -X POST http://localhost:3100/api/auth/refresh \
  -H "Authorization: Bearer <current-token>"
```

### Revoke (admin)

```bash
curl -X POST http://localhost:3100/api/auth/revoke \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"agent-to-revoke"}'
```

### Exempt routes

`GET /health`, `POST /api/auth/register`, `POST /api/auth/refresh`, `GET /api/events` (SSE).

---

## Test Results

All four coordination scenarios are validated end-to-end by the test suite:

| Scenario | Layer | Score | Category | Outcome |
|----------|-------|------:|----------|---------|
| S1 — Same file | 0a | 100 | concerned | Thread opened → consensus |
| S2 — Same module | 3 | 30 | gray_zone | Auto-resolved, introspection |
| S3 — Dependency | 0b | 80 | gray_zone | Auto-resolved, introspection |
| S4 — No overlap | — | 0 | pass | Auto-resolved immediately |

**Performance:**

| Component | Time |
|-----------|------|
| Conflict detection (no LLM) | < 5 ms |
| MQTT push delivery | < 50 ms end-to-end |
| Full consultation cycle (S1) | 30–45 s |

---

## Integration patterns

### Any MCP client

Connect to `http://localhost:3100/mcp` (HTTP/SSE) or stdio. The server speaks MCP 2024-11-05.

### Custom orchestrator

Spawn agents that connect to the MQTT broker and register via the MCP `register_agent` tool. The orchestrator decides spawn count, lifecycle, and quota gating; the coordinator handles the protocol. See [essaim](https://github.com/swoofer/essaim) for a reference implementation, or write your own.

### Reference catalog of coordinator-aware behaviors

The behaviors that make agents announce-before-write, resolve conflicts, and participate in work-stealing are YAML configs assembled by [@swoofer/promptweave](https://github.com/swoofer/promptweave). See [essaim's behaviors](https://github.com/swoofer/essaim/tree/main/behaviors) for a curated catalog.

---

## Development

```bash
# Tests (216 passing across 18 files)
npm test
npm run test:watch

# Dev coordinator (tsx, hot reload)
npm run dev          # HTTP / SSE on port 3100
npm run dev:stdio    # stdio mode

# CLI in dev
npm run cli -- server start
npm run cli -- dashboard

# TypeScript build → dist/
npm run build

# Standalone binary (requires Bun)
bun build --compile cli/index.ts --outfile bin/mcp-coordinator
```

### Project structure

```
src/                # Coordinator (npm package surface)
  serve-http.ts     # HTTP/SSE/MCP server entry
  server-setup.ts   # 26 MCP tool registrations
  impact-scorer.ts  # multi-layer conflict detection
  consultation.ts   # Thread lifecycle
  agent-registry.ts # Online agents
  file-tracker.ts   # File edit history
  dependency-map.ts # Module graph
  agent-activity.ts # working/idle/waiting/offline
  mqtt-broker.ts    # Embedded Aedes (TCP + WS)
  mqtt-bridge.ts    # Coordinator → broker fanout
  quota/            # Anthropic quota pre-flight + refresh
  auth.ts           # Optional JWT
  index.ts          # Stdio entry + programmatic re-exports

cli/                # CLI binary (mcp-coordinator)
  index.ts          # Entry point
  server/           # start / stop / status
  dashboard.ts      # Open dashboard URL
  config.ts         # Config loader
  version.ts        # package.json version helper

tests/unit/         # Vitest — 216 tests, 18 files
dashboard/public/   # Single-file web dashboard
```

---

## Related projects

- **[@swoofer/promptweave](https://github.com/swoofer/promptweave)** — YAML composer for assembling agent prompts, hooks, and MCP configs. Use it with mcp-coordinator-aware behaviors from essaim.
- **[essaim](https://github.com/swoofer/essaim)** — end-to-end orchestrator that spawns N coordinated agents using `@swoofer/promptweave` + `mcp-coordinator`. Ships the reference catalog of coordinator-aware behaviors.

---

## Support

Solo maintainer. If this project saves you time, consider supporting development:

- [GitHub Sponsors](https://github.com/sponsors/swoofer)
- [Buy Me A Coffee](https://buymeacoffee.com/swoofer)

A star on the repo also helps surface the project to other developers.

---

## License

MIT
