## Operability

Everything you need to run mcp-coordinator under a process supervisor, scrape it for metrics, ship it as a container, and back up its state.

### Health probes

Three endpoints, exempt from auth, designed to plug straight into Kubernetes / Docker / systemd readiness logic.

| Endpoint | Returns | Use case |
|----------|---------|----------|
| `GET /livez` | `200` always while the process is alive | Kubernetes `livenessProbe`, restart-on-hang |
| `GET /readyz` | `200` when DB and MQTT broker are both ready, `503` with per-check details otherwise | Kubernetes `readinessProbe`, load-balancer health |
| `GET /health` | Alias of `/livez` | Backwards compat with v0.3.x and the `doctor` command |

`/readyz` returns a JSON body listing each subsystem (`db`, `mqtt`, `http`) and its status — useful for diagnosing why a pod is stuck `NotReady`.

### Metrics

`GET /metrics` exposes Prometheus text format on the same HTTP port (no extra listener, no auth required). Scrape it from Prometheus and visualize in Grafana.

**Counters**

| Metric | Labels | Description |
|--------|--------|-------------|
| `mcp_coordinator_announces_total` | — | `announce_work` calls received |
| `mcp_coordinator_threads_resolved_total` | `type` (consensus/timeout/auto) | Threads that reached a terminal state |
| `mcp_coordinator_mqtt_publishes_total` | — | Messages published to the embedded broker |
| `mcp_coordinator_http_requests_total` | `route`, `status` | All HTTP requests, by route and status code |
| `mcp_coordinator_auth_rejected_total` | — | JWT verification failures |

**Gauges**

| Metric | Description |
|--------|-------------|
| `mcp_coordinator_agents_online` | Currently registered online agents |
| `mcp_coordinator_threads_open` | Threads in `open` state |
| `mcp_coordinator_threads_resolving` | Threads in `resolving` state |
| `mcp_coordinator_mqtt_listeners_active` | Active MQTT subscriber connections |
| `mcp_coordinator_sse_clients_active` | Dashboard SSE clients connected to `/api/events` |

### Container

An official multi-stage `Dockerfile` lives at the repo root.

```bash
docker build -t mcp-coordinator .
docker run -d \
  -p 3100:3100 -p 1883:1883 \
  -v mcp-data:/data \
  --name coordinator \
  mcp-coordinator
```

- Alpine base, ~150 MB final image.
- Runs as a non-root user.
- `/data` is the canonical mount point — both `config.json` and the SQLite database live there.
- Exposed ports: `3100` (HTTP / MCP / SSE / WebSocket-MQTT) and `1883` (MQTT TCP).
- `HEALTHCHECK` calls `/livez` every 30 s.
- A reference `docker-compose.yml` is shipped alongside the Dockerfile for the common single-host setup.

### Backup and restore

Two CLI commands snapshot and restore the entire state directory (config + SQLite). Both refuse to run while a coordinator is active on the data dir to avoid corrupting an open database — this is a safety default, not a hard limit.

```bash
# Snapshot — produces ./mcp-coordinator-backup-<timestamp>.tar.gz by default
mcp-coordinator backup [--output <file>] [--data-dir <path>] [--force]

# Restore — moves the existing data dir to <data-dir>.bak-<timestamp>, then extracts
mcp-coordinator restore <tarball> [--data-dir <path>]
```

- `backup` archives `config.json` + `data/coordinator.db` (PID and log files are skipped — they're runtime state).
- `--force` bypasses the running-coordinator check; for true online backups, use SQLite's Online Backup API directly against the live DB file.
- `restore` always preserves the previous data dir as `.bak-<timestamp>` next to the original — nothing is destroyed in place. Roll back by swapping the directories.

### Graceful shutdown

`SIGTERM` and `SIGINT` trigger an orderly stop:

1. HTTP listener stops accepting new connections, drains in-flight requests.
2. MQTT bridge disconnects from the broker.
3. Embedded Aedes broker closes (existing client connections receive a clean disconnect).
4. Background timers (heartbeat sweeper, thread auto-resolver, quota refresh) cancel.
5. SQLite is closed cleanly.

When daemonized, the PID file at `~/.mcp-coordinator/server.pid` is removed implicitly when the process exits. `mcp-coordinator server stop` sends `SIGTERM` and waits for exit; under Docker / Kubernetes the platform's standard termination signal does the same thing.
