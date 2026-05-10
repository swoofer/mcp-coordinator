# DevOps / SRE Audit — mcp-coordinator

**Operability Score: 3 / 10**

A clean dev tool that has been thoughtfully wrapped with a CLI, doctor command, daemonize flag, and structured logs — but it is structurally a single-node desktop daemon. Nothing in the README acknowledges the words "deploy", "supervise", "scale", "restore", "rollback", or "container". The "team setup" advice is literally "one person hosts it". This is not production-ready in any conventional sense.

---

## Operational Gaps (ruthless)

### 1. Health endpoint is a lie
`GET /health` (verified in `src/serve-http.ts:708`) returns `{status:"ok", version}` unconditionally, as long as the HTTP listener accepts the connection. It does NOT check:
- SQLite connectivity / WAL state
- Aedes broker liveness
- Quota subsystem error state
- Whether the SSE bridge is wedged

There is **no liveness vs readiness split**. A k8s probe would never restart a half-dead pod. Add `/healthz` (process up) and `/readyz` (DB + broker + bridge handshake), or load balancers will happily route traffic to a broken instance.

### 2. Zero metrics, zero traces
README brags about Pino structured logs and that's it. No `/metrics` endpoint, no OpenTelemetry, no Prometheus exposition. You cannot answer "p95 of `announce_work`", "MQTT publish latency", "thread queue depth", or "broker connections" without grepping JSON logs. SREs need RED/USE metrics scraped, not log-shipped. The dashboard SSE timeline is **not** observability.

### 3. SQLite + local FS = no backup story
`~/.mcp-coordinator/data/coordinator.db` is single-file SQLite. The README says nothing about:
- Online backup (`VACUUM INTO`, `sqlite3 .backup`)
- WAL checkpointing strategy
- Cross-host replication (Litestream? rsync? — not mentioned)
- Restore drill / RPO / RTO

If the host disk dies, every open thread, dependency map, and quota history is gone. Recovery procedure: undocumented.

### 4. No HA, no failover, single point of failure everywhere
- One coordinator process owns the broker, the DB, the SSE fan-out, and the quota poller.
- No clustering, no leader election, no broker federation (Aedes supports MQEmitter but it's not wired up).
- `server.pid` model assumes one daemon per host; "Running multiple coordinators" exists only for per-project isolation, not redundancy.
- Restart = every connected agent disconnects, in-flight consultations stall.

For a tool whose pitch is "shared nervous system for agents", a 30-second blip kills coordination across the team.

### 5. Container/Kubernetes story does not exist
Verified: only `dashboard/Dockerfile` exists. **No Dockerfile for the coordinator itself**, no compose file, no Helm chart, no example k8s manifest, no health probe documentation. README's "team setup" is `npm install -g` on a laptop. There is no immutable artifact for an SRE to deploy. Bun single-file binary is mentioned but no container image is published.

### 6. Config bifurcation: env vars + config.json + CLI flags
`config.json` defines `server.port` and `data_dir`; env vars (`PORT`, `COORDINATOR_DATA_DIR`) override them; CLI flags override both. Three sources of truth for the same values, and `config.json` carries auth-relevant defaults next to env-injected secrets. In a 12-factor world this is config smell — pick env vars and delete the file, or document precedence with a worked example. Today operators must read source to know which wins.

### 7. Update path is undefined
"How do I upgrade from 0.2.1 to 0.3.0 without losing state?" The README has no answer. There is no:
- Migration framework for SQLite schema (no `migrations/` directory mentioned)
- Documented upgrade procedure (drain → snapshot → npm i -g → restart?)
- Compatibility matrix (which client versions speak to which server versions?)
- Rollback story when the new version corrupts the DB

`npm i -g mcp-coordinator@latest` then `server stop && start` is implicit, and that's terrifying.

### 8. Daemon supervision is hand-rolled
`server start --daemon` writes a PID file. There is no systemd unit, no launchd plist, no Windows service installer, no restart-on-crash, no log rotation (`server.log` grows unbounded). If the daemon segfaults at 3am, nothing brings it back. Pino is JSON but logs go to a local file — no built-in shipping to Loki/CloudWatch/Datadog.

### 9. Secrets handled as env vars in shell history
The JWT walkthrough shows `JWT_SECRET=$(openssl rand -hex 32)` exported into a daemon launched directly from the shell. No integration with Vault, AWS Secrets Manager, or even a `.env` template. Rotation procedure: stop the server, change the env, restart — invalidates every issued token instantly with no grace period.

### 10. Network bind defaults to 127.0.0.1; team mode flips to 0.0.0.0 with no TLS
The "team setup" instruction is `COORDINATOR_BIND=0.0.0.0`. TLS is one parenthetical: "(Front the server with TLS via nginx/Caddy/etc.)". No reference config, no certificate auto-renewal hooks, no mTLS option for MQTT TCP on 1883. Anyone on the LAN with the registration secret gets a Bearer token.

---

## Three Things to Make This Prod-Ready

1. **Ship a container + real health probes.** Publish `swoofer/mcp-coordinator:0.2.1` (and `:latest`) on GHCR with a multi-stage Dockerfile, a HEALTHCHECK that hits `/readyz`, and a documented k8s Deployment + Service + PVC manifest. Split `/livez` (process responsive) from `/readyz` (DB open, broker accepting, bridge connected). Provide a systemd unit for bare-metal users.

2. **Real telemetry: `/metrics` + OpenTelemetry traces.** Expose Prometheus counters/histograms for MCP tool calls (latency, error rate), MQTT broker (connections, msgs/sec, bytes), DB (query duration, WAL size), quota poller (success rate, throttle events). Wire OTEL traces from `announce_work` through impact scoring through MQTT publish. Without this, capacity planning is a guess.

3. **Documented state lifecycle: backup, restore, migrate.** Bundle a `mcp-coordinator backup --to <path>` command (online `sqlite3 .backup`), a `restore --from`, and a versioned migration framework (e.g., umzug or hand-rolled `schema_version` table). Document the upgrade procedure: snapshot → upgrade package → start with `--migrate` flag → verify with `doctor` → resume traffic. Add Litestream-style continuous replication to S3 as an opt-in for HA-curious teams. Until restore is one command, this thing is a toy.

---

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\03-devops.md`
