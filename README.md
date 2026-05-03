# mcp-coordinator

**Embedded MQTT broker + MCP server for multi-agent coordination.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/mcp-coordinator.svg)](https://www.npmjs.com/package/mcp-coordinator)
[![Tests](https://github.com/swoofer/mcp-coordinator/actions/workflows/test.yml/badge.svg)](https://github.com/swoofer/mcp-coordinator/actions)

## What it does

When multiple AI agents work on the same repository in parallel, they need a coordination layer to avoid stepping on each other. mcp-coordinator provides:

- **Embedded MQTT broker** (Aedes) for real-time agent-to-agent messaging
- **MCP server** (HTTP/SSE + STDIO) exposing 26 tools for announcement, conflict detection, consultation, and quota tracking
- **SQLite-backed state** for thread persistence
- **Live dashboard** showing connected agents, open consultations, file activity, quota

The server is **client-agnostic**: it speaks the MCP protocol and MQTT, so any MCP-compatible agent (Claude Code, Cursor, Cline, Aider, custom scripts) can connect.

## Quick start

```bash
npm install -g mcp-coordinator
mcp-coordinator server start                    # foreground, port 3100, MQTT 1883
mcp-coordinator server start --daemon           # background
mcp-coordinator server status
mcp-coordinator server stop
mcp-coordinator dashboard                       # opens dashboard URL in browser
```

Or in-process from your own Node app:

```ts
import { startServer } from "mcp-coordinator";

await startServer({
  port: 3100,
  dataDir: "./coordinator-data",
});
```

## MQTT topics

The broker publishes coordination events on well-known topics. Agents subscribe to receive real-time updates.

| Topic | When emitted | Payload |
|---|---|---|
| `coordinator/consultations/new` | A thread is opened | `{ thread_id, subject, initiator_id, target_modules, target_files }` |
| `coordinator/consultations/{id}/messages` | Anyone posts | `{ agent_id, name, content, type }` |
| `coordinator/consultations/{id}/status` | Thread state change | `{ status: open / resolving / resolved / timeout }` |
| `coordinator/consultations/{id}/claimed` | Atomic task claim | `{ claimed_by, thread_id }` |
| `coordinator/consultations/{id}/completed` | Claimed task done | `{ agent_id, thread_id, resolution }` |
| `coordinator/agents/{id}/status` | Agent online/offline | `{ status, name, modules }` |
| `coordinator/quota/update` | Quota refresh | `{ usage, limit, utilization_pct }` |

## MCP tools

The server exposes 26 MCP tools. Highlights: `register_agent`, `announce_work`, `propose_resolution`, `approve_resolution`, `contest_resolution`, `list_threads`, `get_thread`, `post_to_thread`, `wait_for_peers`, `log_action_summary`. See the in-server `introspection` tool for the full schema.

## Configuration

Server reads config from `~/.mcp-coordinator/config.json` (auto-created with defaults on first run) and environment variables:

- `COORDINATOR_DATA_DIR` — sqlite directory (default: `~/.mcp-coordinator/data`)
- `PORT` — HTTP port (default: 3100)
- `COORDINATOR_MQTT_TCP_PORT` — MQTT TCP port (default: 1883)
- `COORDINATOR_AUTH_ENABLED` — set to `"true"` to enable JWT auth (requires `COORDINATOR_JWT_SECRET`)

CLI flags override env vars override config file.

## Integration patterns

### Any MCP client

Connect to `http://localhost:3100/mcp` (HTTP/SSE) or stdio. The server speaks MCP 2024-11-05.

### Custom orchestrator

Spawn agents that connect to the MQTT broker and register via the MCP `register_agent` tool. See the [essaim](https://github.com/swoofer/essaim) reference orchestrator for an example, or write your own.

### Example agent configurations

For a reference catalog of coordinator-aware agent behaviors (announce-before-write, conflict-resolution, work-stealing phases, etc.), see [essaim's behaviors](https://github.com/swoofer/essaim/tree/main/behaviors). These are YAML configs consumable by [@swoofer/promptweave](https://github.com/swoofer/promptweave).

## Related projects

- **[@swoofer/promptweave](https://github.com/swoofer/promptweave)** — YAML composer for assembling agent prompts, hooks, and MCP configs. Use it with mcp-coordinator-aware behaviors from essaim.
- **[essaim](https://github.com/swoofer/essaim)** *(coming soon)* — end-to-end orchestrator that spawns N coordinated agents using `@swoofer/promptweave` + `mcp-coordinator`.

## License

MIT
