<div align="center">

# mcp-coordinator

**Stop your AI coding agents from overwriting each other's work.**

One daemon. Every Claude Code / Cursor / Cline / Aider session on the same repo announces what it's about to touch, sees what the others are doing, and resolves conflicts *before* a line of code is written. Zero conflicts, everyone aligned.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-coordinator.svg)](https://www.npmjs.com/package/mcp-coordinator)
[![Tests](https://github.com/swoofer/mcp-coordinator/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions)
[![E2E](https://github.com/swoofer/mcp-coordinator/actions/workflows/e2e.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions/workflows/e2e.yml)

[Getting started](#getting-started) · [Problem](#the-problem) · [How It Works](#how-it-works) · [MCP Tools](#mcp-tools) · [CLI](#cli) · [Auth](#authentication) · [Dashboard](#dashboard) · [Config](#configuration) · [FAQ →](./docs/faq.md) · [Usage guide →](./docs/usage.md)

</div>

---

## Who is this for

| You are… | mcp-coordinator gives you |
|---|---|
| **A solo dev running 2-3 Claude Code sessions in parallel** | Zero-config local daemon. Each session sees the others' file claims; no more "wait, Claude already rewrote that." |
| **A small team where everyone runs their own AI agent on the same repo** | One shared coordinator over LAN. Real-time conflict detection across teammates' agents. |
| **Building a multi-agent orchestrator** | A drop-in conflict layer with MQTT push, 26 MCP tools, and an SDK. Bring your own spawn strategy. |
| **Self-hosting for a regulated org** | OAuth 2.1, 4 IdPs, encrypted IdP tokens at rest, SHA-256 audit chain (SOC 2 tamper-evidence), per-org allowlists. |

---

## The Problem

You ask Claude Code to "add an `updated_at` field to the User type." In another terminal, Cursor is mid-migration on the same schema. Twenty minutes later you're doing git surgery to reconcile the two diffs — and it's not the first time this week.

Specifically:

- **Regressions** — Agent A rewrites a module that Agent B was depending on
- **Duplicated work** — Two agents implement the same feature from different directions
- **Architectural drift** — Agents make local decisions that conflict with each other's designs
- **Wasted reconciliation time** — Hours per week untangling what the agents did to each other

Each agent works in isolation. None of them know what the others are doing.

mcp-coordinator fixes this by giving every agent a **shared nervous system over MQTT** — they announce intentions before coding, conflicts are detected before a single line is written, and agents see each other's actions in real-time to agree on an approach.

Works **with or without** an orchestrator. Standalone with any MCP client (Claude Code, Cursor, Cline, Aider) — see the [usage guide](./docs/usage.md). Or pair with [essaim](https://github.com/swoofer/essaim) for pre-composed agent profiles, work-stealing templates, and a behavior catalog.

> **2500+ tests across 750+ files, passing on every release.** Feature-flagged auth means Phase 1 deployments stay byte-identical to v0.7.x — proven by a 31-case backcompat suite that runs in CI.

---

## Getting started

The fastest path for running a long-lived coordinator is a **global install**:

```bash
# 1. Install once, get the `mcp-coordinator` command on your PATH
npm install -g mcp-coordinator

# 2. First-time setup — creates ~/.mcp-coordinator/, writes a default config,
#    and prints a .mcp.json snippet for your MCP client.
mcp-coordinator init

# 3. Start the server in the background
mcp-coordinator server start --daemon

# 4. Verify
mcp-coordinator server status
mcp-coordinator dashboard      # opens http://localhost:3100/dashboard
```

Requires Node.js 20+ (Node 22+ recommended — Node 20 reaches EOL on 2026-04-30). Step 2 is idempotent — re-running `init` won't overwrite an existing config. The snippet it prints goes into your MCP client's config (e.g., `~/.claude/.mcp.json` for Claude Code). If you'd rather not copy-paste, run `mcp-coordinator init --write-mcp-config <project-path>` and the snippet is written to `<project-path>/.mcp.json` (merging if the file already exists).

After step 4, every Claude Code (or other MCP-compatible) session connected to this coordinator can call all 26 tools (`register_agent`, `announce_work`, `post_to_thread`, `coordinator_status`, ...). For the full multi-Claude or team setup, see the [usage guide](./docs/usage.md).

> 🔀 **Two ways to consume coordination state** — agents can either *poll* the daemon's MCP tools (default, works since v0.6) or accept *push* events through the Channels sidecar (v0.12+, research preview). Most users start with polling and add Channels later when they want real-time reactivity. See [`docs/operating-modes.md`](./docs/operating-modes.md) for the side-by-side comparison and decision guide.

### Other install styles

| Style | When to use | Install | Invoke as |
|---|---|---|---|
| **Global** _(default above)_ | Long-running daemon, ops | `npm install -g mcp-coordinator` | `mcp-coordinator <cmd>` |
| **`npx` (zero install)** | One-shot try, CI scripts | _(none)_ | `npx mcp-coordinator <cmd>` |
| **Local to a project** | Pinning a version per repo | `cd your-project && npm install mcp-coordinator` † | `npx mcp-coordinator <cmd>` from project root |
| **Docker** _(multi-arch)_ | Container-first deployments, k8s | `docker pull ghcr.io/swoofer/mcp-coordinator:0.13.0` | `docker run ghcr.io/swoofer/mcp-coordinator:0.13.0 <cmd>` |
| **Single-file binary** | No Node available, easiest deploy | [GitHub Release tarball](https://github.com/swoofer/mcp-coordinator/releases) | `./mcp-coordinator <cmd>` |

<sub>† Local installs require a `package.json` in the working directory — if you're just trying it out, prefer `-g` or `npx`.</sub>

### Installation légère (skip tree-sitter grammars)

The tree-sitter code-extraction feature ships ~292 MB of grammar packages as `optionalDependencies`. If you don't need cross-repo code extraction, skip them: `npm install mcp-coordinator --omit=optional` (pnpm equivalent: `pnpm install --no-optional`). The rest of the coordinator — agent registry, consultation threads, MQTT, dashboard — works unaffected; only the tree-sitter-backed extraction gracefully degrades.

### Running via Docker

The image is published to GitHub Container Registry on every release tag — multi-arch (linux/amd64 + linux/arm64), with provenance and SBOM attestation. Three tag tracks:

| Tag | Use case |
|---|---|
| `ghcr.io/swoofer/mcp-coordinator:0.13.0` | Pinned exact version — recommended for production |
| `ghcr.io/swoofer/mcp-coordinator:0.13` | Auto-bumps within the 0.13.x patch series |
| `ghcr.io/swoofer/mcp-coordinator:latest` | Tip of releases — fine for trying out, avoid in prod |

A working compose stack (coordinator + Caddy auto-TLS + GitHub OAuth) ships at [`examples/docker-compose/`](./examples/docker-compose/). For a Kubernetes CronJob example doing JWT secret rotation, see [`docs/ops/auto-rotation.md`](./docs/ops/auto-rotation.md).

### Real-time push via Claude Code Channels (research preview)

[Channels](https://code.claude.com/docs/en/channels) is Anthropic's new push-into-session primitive: an out-of-band subprocess streams `<channel>` tags into a running Claude Code session, so the agent reacts to coordination events the moment they happen — no polling, no extra tool call. `mcp-coordinator channel` is a thin bridge over the embedded MQTT broker that emits one channel event per consultation, agent status change, and thread message. It also exposes a `post_to_thread` MCP tool so Claude can reply into a thread directly from the session.

```bash
# 1. Daemon already running? Add the channel server to ~/.claude/.mcp.json
#    (see examples/channels-quickstart/.mcp.json.sample)
# 2. Launch Claude Code with channels enabled
claude --dangerously-load-development-channels server:mcp-coordinator-channel
# 3. Watch consultation events arrive as <channel> tags in the session, and
#    let Claude reply via post_to_thread when appropriate
```

**Research preview** — requires `--dangerously-load-development-channels` in a Channels-capable Claude Code (v2.1.80+). Phase 3 (permission relay) intentionally deferred.

📖 **Choosing between polling and push?** See [`docs/operating-modes.md`](./docs/operating-modes.md) for a full comparison of the two modes, when to pick each, and how to run them side by side. Full setup walkthrough at [`examples/channels-quickstart/`](./examples/channels-quickstart/).

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

### MQTT layer

The coordinator ships with an **embedded [Aedes](https://github.com/moscajs/aedes) MQTT broker**. Agents subscribe once and receive every coordination event in real-time — no polling, no extra infrastructure.

| Transport | Port | Use case |
|-----------|------|----------|
| TCP | `1883` (bind `127.0.0.1` by default) | Local / LAN agents, best latency |
| WebSocket | `/mqtt` on the coordinator HTTP port (default `3100`) | Bun binary, remote agents, firewall-friendly |

Topic map: `coordinator/consultations/new`, `coordinator/consultations/{id}/{messages,status,claimed,completed}`, `coordinator/agents/{id}/status`, `coordinator/broadcast`, `coordinator/quota/update`. Clients self-filter their own messages and the payloads are small JSON envelopes.

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
| 4 | Git co-change history (opt-in) | 40-60 | Files historically modified together — requires `COORDINATOR_REPO_ROOT` + `git` on PATH |

Scores are categorized into three outcomes:

| Score | Category | Action |
|-------|----------|--------|
| ≥ 90 | `concerned` | Thread opened, consultation required |
| 30–89 | `gray_zone` | Thread auto-resolved, introspection recommended |
| < 30 | `pass` | No conflict, proceed immediately |

> **Layer 0 is critical.** Without announced intentions, a two-agent scenario where both work in `src/auth/` would score only 30 (gray zone, auto-resolved). With `announce_work`, the same scenario scores 100 and triggers a full consultation.

`announce_work` accepts an optional `target_symbols?: string[]` (up to 200 entries, max 256 chars each). When two agents touch the same file with disjoint symbols, the score stays 100 but the reason text enriches with `disjoint symbols: you=[X], them=[Y]` — tree-sitter extracts symbols server-side from 15 languages (TS, JS, Python, Go, Rust, Java, C#, C/C++, Ruby, PHP, Kotlin, Swift, Bash) via `optionalDependencies`.

---

## Capabilities at a glance

Out of the box, zero config:

- **Run the coordinator** — `mcp-coordinator server start`, that's the whole setup
- **Conflict detection** — 4-layer impact scoring (announce / file / module / co-change), MQTT push delivery
- **Dashboard** — live timeline, agent panel, scoring breakdown, quota widget
- **Observability** — structured Pino logs, MQTT broker stats, `/livez` + `/readyz` + `/metrics`

<details>
<summary><b>Opt-in for teams and self-hosting</b> — auth, IdPs, audit, admin UI</summary>

| Concern | Opt-in |
|---------|--------|
| **Authentication** | Phase 1 JWT (`COORDINATOR_AUTH_ENABLED`) OR Phase 2 OAuth (`COORDINATOR_OAUTH_ENABLED`) — see [Authentication](#authentication) |
| **Identity providers** | GitHub OAuth App + GitHub App + Google + generic OIDC; up to 4 in parallel via picker UI |
| **Session model** | Cookie sessions + Bearer JWT for MCP transport + service tokens for CI/CD |
| **IdP token encryption at rest** | Column-level AES-256-GCM on `users.idp_access_token` + `users.idp_refresh_token`, key fingerprint guard at boot |
| **Admin UI** | Browser console at `/dashboard/admin.html` for org/user/allowlist management |
| **Audit log** | Tier-1 (never-drop) + Tier-2 (batched) + SHA-256 hash chain for tamper-evidence |
| **Prometheus / Grafana** | 32 app-level metrics (auth, device flow, service tokens, IdP, audit, rate limiting) plus default Node process metrics on `/metrics/auth`, Grafana dashboard JSON, alert rules YAML |
| **Database backend** | SQLite (default) → Postgres (planned, see [design spec](./docs/superpowers/specs/2026-05-16-postgres-adapter-design.md)) |

</details>

Full version-by-version detail in [CHANGELOG.md](./CHANGELOG.md).

---

## MCP Tools

26 tools registered under one HTTP/SSE transport at `/mcp` (and stdio for stdio-mode clients). The three you'll reach for 90% of the time:

| Tool | What it does |
|------|--------------|
| `announce_work` | **The main entry point.** Call before coding — describes target files, dependencies, modules. Returns a `thread_id` if a conflict is detected. |
| `coordinator_status` | Full snapshot — online agents, open threads, hot files, MQTT topics, Anthropic quota. Use it as a heartbeat poll. |
| `wait_for_peers` | Block until N peers come online (or timeout) — useful when an orchestrator spawns a fleet and you need to avoid races before the first announce. |

Any MCP client can discover the full tool schema at runtime via the standard `tools/list` MCP protocol call — no dedicated introspection tool needed.

<details>
<summary><b>All 26 tools</b> — agent registry, consultation, file tracking, dependency map, MQTT, status</summary>

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

</details>

---

## CLI

| Command | Description |
|---------|-------------|
| `mcp-coordinator init [--url <url>] [--write-mcp-config <path>] [--write-claude-md <path>]` | First-time setup — create config dir, default `config.json`, print/write the `.mcp.json` snippet, optionally scaffold a sample `CLAUDE.md` |
| `mcp-coordinator uninstall [--mcp-config <path>] [--claude-md <path>] [--purge] [--force]` | Remove integrations: drop `coordinator` entry from a `.mcp.json`, strip the coordination section from a `CLAUDE.md`, or `--purge` the `~/.mcp-coordinator/` directory entirely |
| `mcp-coordinator server start [--port N] [--data-dir PATH] [--daemon]` | Start the coordinator (foreground or daemon) |
| `mcp-coordinator server stop` | Stop the coordinator |
| `mcp-coordinator server status` | PID, port, online agents, open threads |
| `mcp-coordinator server logs [-n N] [-f]` | Tail the daemon log at `~/.mcp-coordinator/logs/server.log` |
| `mcp-coordinator server backup [--output PATH] [--data-dir PATH] [--force]` | Snapshot `config.json` + the SQLite data dir to a `.tar.gz` archive (refuses to run while the coordinator is up unless `--force`) |
| `mcp-coordinator server restore <tarball> [--force] [--no-backup] [--data-dir PATH]` | Restore a `server backup` archive over `~/.mcp-coordinator/` (moves the existing config dir aside first unless `--no-backup`) |
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

For multi-Claude setups, team deployments, walkthroughs, and debugging recipes, see the [usage guide](./docs/usage.md).

---

## Authentication

The coordinator runs in one of three modes, selected by env-var configuration. **Single-user / dev local stays zero-config**; multi-user deployments opt in to JWT or full OAuth via a single feature flag.

| Mode | When | Enable |
|------|------|--------|
| **Open** _(default)_ | Local dev, single user | No env vars needed — synthetic legacy claims |
| **JWT** _(Phase 1)_ | Small team, shared secret | `COORDINATOR_AUTH_ENABLED=true` + JWT/registration/admin secrets — see [JWT setup](./docs/usage.md#team-setup-with-jwt-internet-facing) |
| **OAuth 2.1** _(Phase 2)_ | Multi-tenant, internet-facing | `COORDINATOR_OAUTH_ENABLED=true` + IdP credentials — see [onboarding](./docs/onboarding-self-host.md) |

OAuth mode adds: 4 IdP providers (GitHub OAuth App, GitHub App, Google, generic OIDC) with picker UI, cookie sessions + Bearer JWT + service tokens, refresh-token rotation with stolen-token detection, SHA-256 audit chain (SOC 2 tamper-evidence), and an admin UI at `/dashboard/admin.html`.

**MCP authorization spec discovery**: `/mcp` does not implement the MCP authorization spec's OAuth discovery flow — no `resource_metadata` (RFC 9728) on `WWW-Authenticate`, no `/.well-known/oauth-protected-resource`. This is a deliberate scope decision, not an oversight: today's clients are the maintainer's own agents under an intra-org trust model (see [`docs/security/threat-model.md`](./docs/security/threat-model.md)), and token provisioning is proprietary — shared-secret registration (`/api/auth/register`, Phase 1) or the device flow (Phase 2) — rather than spec-compliant discovery. Third-party spec-compliant MCP clients need manual configuration (they can't auto-discover the auth flow). The Phase 2 OAuth authorization server already exists, so wiring up spec-compliant discovery later is additive, not a rearchitecture.

| Doc | Topic |
|-----|-------|
| [`docs/onboarding-self-host.md`](./docs/onboarding-self-host.md) | Zero-to-first-signin walkthrough |
| [`docs/idp-providers.md`](./docs/idp-providers.md) | Per-provider setup (GitHub OAuth App, GitHub App, Google, OIDC, Azure AD) |
| [`docs/openapi.yaml`](./docs/openapi.yaml) | OpenAPI 3.1, 17 endpoints |
| [`docs/security/threat-model.md`](./docs/security/threat-model.md) | STRIDE per asset, residual risks |
| [`docs/ops/upgrade-phase1-to-phase2.md`](./docs/ops/upgrade-phase1-to-phase2.md) | Phase 1 → Phase 2 migration |
| [`docs/ops/key-rotation.md`](./docs/ops/key-rotation.md) + [`auto-rotation.md`](./docs/ops/auto-rotation.md) | `JWT_SECRET` rotation procedures |
| [`docs/ops/audit-integrity.md`](./docs/ops/audit-integrity.md) | Audit chain runbook + tip-attestation workflow |
| [`docs/ops/backup-restore.md`](./docs/ops/backup-restore.md) | Litestream + NR12 reconciliation |
| [`docs/gdpr.md`](./docs/gdpr.md) | GDPR Art. 17 procedures |
| [`sdk/README.md`](./sdk/README.md) | TypeScript SDK reference |

Operational tooling: `mcp-coordinator init phase2` (interactive wizard), `mcp-coordinator doctor --phase2` (8 health probes), `mcp-coordinator service-token {issue,list,revoke}`, `mcp-coordinator rotate-jwt-secret`, `tsx scripts/verify-audit-chain.ts`.

---

## Anthropic Quota Pre-flight

The coordinator tracks Anthropic workspace quota live and exposes it on MQTT, the dashboard, and the `coordinator_status` MCP tool — so MCP clients can decide whether to abort, throttle, or proceed before launching expensive turns.

- Reads the Claude Code OAuth token from the macOS Keychain (`security find-generic-password -s "Claude Code-credentials"`) and calls Anthropic's `/api/oauth/usage` endpoint directly — **macOS only**. On Linux/Windows the credential reader is an unimplemented stub, so the quota endpoint returns 503 (fail-open: the rest of the coordinator keeps working without a quota guardrail).
- The coordinator itself enforces no abort threshold — it just serves fresh utilization numbers (2 min cache TTL). Deciding what "too high" means, e.g. via a `MAX_QUOTA_PCT` convention, is left to the orchestrator reading `coordinator_status.quota`.
- Back-off when the usage endpoint itself returns 429 (5 min cool-down by default, or the server's `Retry-After`).
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
- **Agent panel** — online/offline, working/idle/waiting, current file, thread being waited on
- **Scoring breakdown** — which detection layer triggered each conflict
- **Quota widget** — live utilization %, stacked buckets, manual refresh button
- **Consensus metrics** — per session: consensus / timeout / auto-resolved split, token totals

All events arrive via SSE on `/api/events`. No polling.

### Agent activity states

| Status | Indicator | Meaning |
|--------|-----------|---------|
| working | pulsing blue | Actively editing files |
| idle | solid green | Online, no recent activity |
| waiting | pulsing yellow | Blocked on a consultation thread |
| offline | solid red | Disconnected or session ended |

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

### Core env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP port (also serves MQTT-over-WebSocket on `/mqtt`) |
| `COORDINATOR_DATA_DIR` | see below | Directory for the SQLite database |
| `COORDINATOR_MQTT_TCP_PORT` | `1883` | TCP port for the embedded broker |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `NODE_ENV` | — | `development` for pretty logs |
| `COORDINATOR_AUTH_ENABLED` | `false` | Enable Phase 1 JWT authentication |
| `COORDINATOR_OAUTH_ENABLED` | `false` | Enable Phase 2 OAuth |

`COORDINATOR_DATA_DIR`'s default depends on how the server is started:
- **CLI** (`mcp-coordinator server start`, `mcp-coordinator init`, ...) defaults to `~/.mcp-coordinator/data` (see `config.json` above).
- **Direct entry points** — `node dist/src/serve-http.js`, or stdio via `.mcp.json` (`node dist/src/index.js` / `tsx src/index.ts`) — do **not** go through the CLI's config resolution. Without `COORDINATOR_DATA_DIR` set, they fall back to `./data` **relative to the process's current working directory**, which is unpredictable for a server a client spawns from an arbitrary cwd. Both entry points log a warning at boot when this fallback is in effect.

Always set `COORDINATOR_DATA_DIR` explicitly (or use the CLI) for a stable, predictable data location outside of local single-shot dev use.

The complete annotated env reference (50+ variables including all Phase 2 OAuth / multi-IdP / hardening vars) lives in [`.env.example`](./.env.example) — copy-paste and fill in.

---

## Structured Logging

[Pino](https://getpino.io/) emits JSON per subsystem. Component loggers: `http`, `mcp`, `mqtt`, `consultation`, `conflict`, `auth`, `tokens`, `quota`.

```json
{"level":"info","time":1712345678901,"component":"http","msg":"Server started","port":3100}
```

Dev (`NODE_ENV=development`) renders pretty human-readable lines. Levels controlled via `LOG_LEVEL`.

---

## SDK

A TypeScript reference client lives in [`sdk/`](./sdk/) (not yet published to npm). Install via `npm install file:./sdk` from a consumer project.

```ts
import { McpCoordinatorClient, FileTokenStore, ProactiveRefresh } from "@mcp-coordinator/sdk-js";

const client = new McpCoordinatorClient({
  baseUrl: "https://coordinator.example.com",
  store: new FileTokenStore(),
  refreshStrategy: new ProactiveRefresh(),
  refreshLockPath: process.env.HOME + "/.mcp-coordinator/refresh.lock",
});

await client.loadFromStore();
const me = await client.whoami();
```

See [`sdk/README.md`](./sdk/README.md) for the full API.

---

## Integration patterns

- **Any MCP client** — connect to `http://localhost:3100/mcp` (HTTP/SSE) or stdio. The server speaks MCP 2024-11-05.
- **Custom orchestrator** — spawn agents that connect to the MQTT broker and register via the MCP `register_agent` tool. The orchestrator decides spawn count, lifecycle, and quota gating; the coordinator handles the protocol. See [essaim](https://github.com/swoofer/essaim) for a reference implementation, or write your own.
- **Behavior catalog** — coordinator-aware agent behaviors (announce-before-write, work-stealing, conflict resolution) are YAML configs assembled by [@swoofer/promptweave](https://github.com/swoofer/promptweave). See [essaim's behaviors](https://github.com/swoofer/essaim/tree/main/behaviors) for a curated catalog.

---

## Development

```bash
# This repo uses pnpm 10 (pinned via "packageManager" in package.json).
# Run `corepack enable` once — corepack then resolves the right pnpm
# version automatically.

pnpm install
pnpm test
pnpm dev          # HTTP / SSE on port 3100
pnpm dev:stdio    # stdio mode
pnpm build        # TypeScript build → dist/

# Standalone binary (requires Bun)
bun build --compile cli/index.ts --outfile bin/mcp-coordinator
```

Open an issue or PR on [GitHub](https://github.com/swoofer/mcp-coordinator).

---

## Roadmap

- **v1.0** — Multi-instance: Redis-backed cache invalidation + leader election for the sweeper and rate limiter.
- **Postgres adapter** — for regulated multi-instance workloads. See [design spec](./docs/superpowers/specs/2026-05-16-postgres-adapter-design.md).
- **SDK polish** — Windows DPAPI encryption for the on-disk token file (keytar keychain integration and named-profile TOML config already shipped).

Per-version detail for everything already shipped lives in [CHANGELOG.md](./CHANGELOG.md).

---

## Related projects

- **[@swoofer/promptweave](https://github.com/swoofer/promptweave)** — YAML composer for assembling agent prompts, hooks, and MCP configs. Use it with mcp-coordinator-aware behaviors from essaim.
- **[essaim](https://github.com/swoofer/essaim)** — end-to-end orchestrator that spawns N coordinated agents using `@swoofer/promptweave` + `mcp-coordinator`. Ships the reference catalog of coordinator-aware behaviors.

---

## Support

Built and maintained by [@swoofer](https://github.com/swoofer), with a large and growing automated test suite and a growing list of external contributors.

If this project saves you time:

- ⭐ Star the repo — it helps other devs find it
- 💖 [GitHub Sponsors](https://github.com/sponsors/swoofer)
- ☕ [Buy Me A Coffee](https://buymeacoffee.com/swoofer)
- 🐛 [Open an issue](https://github.com/swoofer/mcp-coordinator/issues) if something is broken or missing

---

## License

MIT
