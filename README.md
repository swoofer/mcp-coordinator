<div align="center">

# mcp-coordinator

**Embedded MQTT broker + MCP server for multi-agent coordination. Zero conflicts, everyone aligned.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-coordinator.svg)](https://www.npmjs.com/package/mcp-coordinator)
[![Tests](https://github.com/swoofer/mcp-coordinator/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions)

[Problem](#the-problem) · [How It Works](#how-it-works) · [MQTT Layer](#mqtt-communication-layer) · [Scoring](#impact-scoring) · [MCP Tools](#mcp-tools) · [CLI](#cli) · [Quota](#anthropic-quota-pre-flight) · [Observability](#token-observability) · [Dashboard](#dashboard) · [Config](#configuration) · [Auth](#authentication) · [Dev](#development)

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
| `mcp-coordinator server start [--port N] [--data-dir PATH] [--daemon]` | Start the coordinator (foreground or daemon) |
| `mcp-coordinator server stop` | Stop the coordinator |
| `mcp-coordinator server status` | PID, port, online agents, open threads |
| `mcp-coordinator dashboard` | Open `http://localhost:3100/dashboard` |
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
- **[essaim](https://github.com/swoofer/essaim)** *(coming soon)* — end-to-end orchestrator that spawns N coordinated agents using `@swoofer/promptweave` + `mcp-coordinator`. Ships the reference catalog of coordinator-aware behaviors.

---

## License

MIT
