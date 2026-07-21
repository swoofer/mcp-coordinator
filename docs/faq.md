# FAQ

The dozen questions people ask most often. For the long-form walkthroughs, follow
the links at the end of each answer.

- [What is mcp-coordinator? Who is it for?](#what-is-mcp-coordinator-who-is-it-for)
- [Do I need to set up authentication?](#do-i-need-to-set-up-authentication)
- [When do I turn auth on — Phase 1 JWT vs Phase 2 OAuth?](#when-do-i-turn-auth-on--phase-1-jwt-vs-phase-2-oauth)
- [How do agents connect to the coordinator?](#how-do-agents-connect-to-the-coordinator)
- [npx vs global install vs Docker vs binary — which do I use?](#npx-vs-global-install-vs-docker-vs-binary--which-do-i-use)
- [Can I run it for multiple projects or organizations?](#can-i-run-it-for-multiple-projects-or-organizations)
- [How do I get a token for an agent?](#how-do-i-get-a-token-for-an-agent)
- [Is my data persisted? Where?](#is-my-data-persisted-where)
- [How do I put it behind TLS / HTTPS?](#how-do-i-put-it-behind-tls--https)
- [Does it run on Bun?](#does-it-run-on-bun)
- [Where are the logs?](#where-are-the-logs)
- [Can I run more than one coordinator at once?](#can-i-run-more-than-one-coordinator-at-once)

---

## What is mcp-coordinator? Who is it for?

A single daemon that stops parallel AI coding agents from overwriting each other's
work. Every Claude Code / Cursor / Cline / Aider session on the same repo announces
what it's about to touch, sees what the others are doing, and resolves conflicts
before code is written. It fits a solo dev running 2–3 sessions, a small team
sharing one coordinator over LAN, or an orchestrator builder needing a drop-in
conflict layer. See the [README](../README.md) and [usage guide](./usage.md).

## Do I need to set up authentication?

No. The default is **Open mode** — zero config, no env vars, no credentials. It is
meant for local single-user dev: you start the daemon and connect. MQTT, the MCP
tools, and the dashboard all work anonymously out of the box. Turn auth on only
when more than one person (or an internet-facing deployment) shares the
coordinator. See [Authentication](../README.md#authentication).

## When do I turn auth on — Phase 1 JWT vs Phase 2 OAuth?

Two opt-in modes, each a single feature flag:

| Mode | When | Enable |
|------|------|--------|
| **Phase 1 JWT** | Small trusted team, shared secret | `COORDINATOR_AUTH_ENABLED=true` + JWT/registration/admin secrets |
| **Phase 2 OAuth 2.1** | Multi-tenant, internet-facing | `COORDINATOR_OAUTH_ENABLED=true` + IdP credentials |

Phase 2 adds IdPs (GitHub, Google, OIDC), sessions, service tokens, and a
SHA-256 audit chain. Start with JWT; upgrade later — it's additive. See
[JWT setup](./usage.md#team-setup-with-jwt-internet-facing),
[onboarding](./onboarding-self-host.md), and
[Phase 1 → Phase 2](./ops/upgrade-phase1-to-phase2.md).

## How do agents connect to the coordinator?

Agents speak **MCP over HTTP** (or stdio) at `/mcp` on port `3100` — that's the
default path and works since v0.6 (agents poll tools like `coordinator_status`).
For real-time push, the coordinator also runs an **embedded MQTT broker**
(TCP `1883`, or WebSocket at `/mqtt` on the HTTP port), and the dashboard consumes
**SSE** at `/api/events`. Most users start with polling and add push later. See
[operating modes](./operating-modes.md).

## npx vs global install vs Docker vs binary — which do I use?

| Style | When | Invoke |
|-------|------|--------|
| **Global** *(default)* | Long-running daemon, ops | `npm i -g mcp-coordinator` → `mcp-coordinator <cmd>` |
| **npx** | One-shot try, CI | `npx mcp-coordinator <cmd>` |
| **Local to a project** | Pin a version per repo | `npm i mcp-coordinator` → `npx mcp-coordinator <cmd>` |
| **Docker** | Containers, k8s | `docker run ghcr.io/swoofer/mcp-coordinator:<version>` |
| **Single-file binary** | No Node available | download the release tarball → `./mcp-coordinator <cmd>` |

Global install is the recommended path for a persistent coordinator. See
[install styles](../README.md#other-install-styles).

## Can I run it for multiple projects or organizations?

You can point agents from **multiple repos** at one coordinator, and the CLI
`init --write-mcp-config <path>` wires each project's `.mcp.json`. Real
multi-**org** isolation is not there yet, though: today the MQTT broker publishes
**everything under a hardcoded org `default`** (`coordinator/default/#`), so there
is no per-org topic routing. SSE honors real token orgs; MQTT does not. For true
multi-tenant separation, run a coordinator per data directory. See the
[MQTT layer](../README.md#mqtt-layer) note.

## How do I get a token for an agent?

Only relevant when auth is enabled. `POST /api/auth/register` with
`{ agent_name, registration_secret }` (the server needs
`COORDINATOR_REGISTRATION_SECRET` set; admin tokens use `COORDINATOR_ADMIN_SECRET`).
It returns `{ agent_id, token, expires_at, role }`. For MQTT, put that Phase 1 JWT
in the CONNECT **password** field (an empty password is rejected). Phase 2 OAuth
tokens do **not** work for MQTT — the broker verifies only the Phase 1 secret. See
[onboarding](./onboarding-self-host.md).

## Is my data persisted? Where?

Yes — in a **SQLite** database. Under a CLI-started server it lives at
`~/.mcp-coordinator/data/coordinator.db`, alongside `config.json`, `server.pid`,
and `logs/`. In Docker, mount a volume at the data directory so it survives
restarts, and set `COORDINATOR_DATA_DIR` explicitly (direct entry points otherwise
fall back to `./data` relative to the process cwd). Back up with
`mcp-coordinator server backup`. See [SQLite operations](./ops/sqlite-operations.md)
and [backup/restore](./ops/backup-restore.md).

## How do I put it behind TLS / HTTPS?

The coordinator serves plain HTTP and binds MQTT-TCP to `127.0.0.1` — **never
expose port 3100 directly**. Terminate TLS at a reverse proxy that also handles the
WebSocket upgrade for the `/mqtt` bridge. Ready-made examples:
[`examples/nginx-reverse-proxy/`](../examples/nginx-reverse-proxy/) (drop-in
`nginx.conf`) and [`examples/docker-compose/`](../examples/docker-compose/) (a full
stack with Caddy auto-TLS + GitHub OAuth). For JWT-secret rotation behind the
proxy, see [key rotation](./ops/key-rotation.md).

## Does it run on Bun?

**Phase 1 (Open + JWT) works on Bun** — that's how the single-file binary is built
(`bun build --compile`), using MQTT-over-WebSocket. **Phase 2 OAuth is Node-only**:
`bootPhase2` refuses to start on the Bun runtime (pino's transport and the
encryption/SQLite paths aren't Bun-safe). If you need OAuth, run the Node build
(npm or the `node:22-alpine` Docker image). See
[ARCHITECTURE.md](./ARCHITECTURE.md) and the
[Google OAuth runbook](./ops/enable-google-oauth-runbook.md).

## Where are the logs?

Structured [Pino](https://getpino.io/) JSON, one line per event, tagged by
component (`http`, `mcp`, `mqtt`, `auth`, `tokens`, `quota`, …). The daemon writes
to `~/.mcp-coordinator/logs/server.log`. Tail it with:

```bash
mcp-coordinator server logs -f        # follow
mcp-coordinator server logs -n 200    # last 200 lines
```

Set `LOG_LEVEL=debug` for more detail, or `NODE_ENV=development` for pretty
human-readable output. See [Structured Logging](../README.md#structured-logging).

## Can I run more than one coordinator at once?

Not against the same data directory. The coordinator keeps correctness-critical
state (rate-limit buckets, IdP membership cache, audit queue, sweeper
circuit-breaker) **in memory**, so two processes on one SQLite DB break those
guarantees. **Run exactly one coordinator process per data directory.** Horizontal
scaling (Redis-backed state + leader election) is planned for v1.0. See
[single-instance constraints](./ops/single-instance-constraints.md).
