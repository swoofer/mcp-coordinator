# Connecting an MCP client

The coordinator is client-agnostic. Any MCP-capable agent can talk to it — the
only thing that differs between clients is *where* their config file lives.

This page covers the part that is the same everywhere. For the file location,
follow your client's own documentation: those paths move between releases, and
a stale path here is worse than no path.

## Before you start

The daemon has to be running:

```bash
mcp-coordinator server start --daemon
mcp-coordinator server status          # exits non-zero if it is not up
```

## Two ways to connect

### HTTP (recommended)

One daemon, many clients, all sharing coordination state. This is the mode the
coordinator is designed around — it is also the only mode that carries the MQTT
push events and the dashboard.

`mcp-coordinator init` prints this snippet, with your configured port
substituted:

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

If your client wants the file written for you:

```bash
mcp-coordinator init --write-mcp-config <project-path>
```

It writes `<project-path>/.mcp.json`, merging into an existing file rather than
overwriting it.

Behind a reverse proxy or on another machine, point `url` at that address
instead — `mcp-coordinator init --url https://coordinator.example.com/mcp`.

### stdio

Some clients only speak stdio. The coordinator ships a stdio server, but there
is **no CLI subcommand for it** — you invoke the shipped file directly:

```json
{
  "mcpServers": {
    "coordinator": {
      "command": "node",
      "args": ["<install-path>/dist/src/index.js"],
      "env": { "COORDINATOR_DATA_DIR": "/absolute/path/to/data" }
    }
  }
}
```

Find `<install-path>` with `npm root -g` (append `/mcp-coordinator`).

Two things to know before choosing stdio:

- **It is unauthenticated by contract.** The trust boundary is "you spawned this
  process", the same as any local stdio MCP server. `COORDINATOR_AUTH_ENABLED`
  is ignored.
- **No MQTT.** The embedded broker is not started, so `wait_for_message`,
  `get_queued_messages` and `mqtt_publish` are unavailable. Every client gets
  its own process and its own SQLite handle rather than sharing one daemon —
  which is usually not what you want when the point is coordination between
  agents.

Prefer HTTP unless your client cannot do it.

## Set `COORDINATOR_DATA_DIR`

Without it the daemon falls back to `./data` relative to whatever directory the
client happened to spawn it from, and logs a warning. Two clients started from
different directories then coordinate against two different databases and never
see each other.

The CLI (`mcp-coordinator server start`) already uses a stable location; set the
variable explicitly for any stdio config.

## Verify it worked

From inside the client, call the `coordinator_status` tool. A working connection
returns the agent/thread/file counters. If the client lists tools but every call
fails, the daemon is not reachable at the configured URL.

From outside:

```bash
curl -s localhost:3100/healthz     # {"status":"alive"}
mcp-coordinator doctor             # checks config, server, MCP, MQTT
```

## Per-client notes

| Client | Transport | Notes |
|---|---|---|
| Claude Code | HTTP | `mcp-coordinator init` targets this directly; the snippet goes in the project's `.mcp.json`. |
| Cursor | HTTP | Uses the same `mcpServers` shape. Check its docs for the config path — it has changed across releases. |
| Cline | HTTP | Same shape, configured through the extension's MCP settings UI rather than a hand-edited file. |
| Aider | stdio | Confirm current MCP support against its docs before wiring anything; use the stdio block above, and read the stdio caveats first. |

Config paths are deliberately not listed. They move, and a wrong path in this
repo costs more than a link to the client's own docs. If you set one up and want
to save the next person the lookup, a PR adding the path you verified — with the
client version you verified it on — is welcome.

## When it does not connect

| Symptom | Cause |
|---|---|
| Client shows no tools | Daemon not running, or wrong port. `mcp-coordinator server status`. |
| Tools listed, every call fails | Reachable but unhealthy — `curl localhost:3100/readyz`. |
| "not carrying auth claims" | The MCP session was closed or swept after idling past `COORDINATOR_MCP_SESSION_TTL_MS` (default 30 min). Reconnect the client. |
| Agents do not see each other | Almost always two different `COORDINATOR_DATA_DIR` values. |

More in [troubleshooting.md](./troubleshooting.md).
