# Usage guide

Detailed walkthroughs for running mcp-coordinator. The [README](../README.md) covers the 30-second start; this doc covers the recipes you reach for second.

- [Solo developer — multiple Claude Code sessions](#solo-developer--multiple-claude-code-sessions)
- [Team setup — shared coordinator on LAN](#team-setup--shared-coordinator-on-lan)
- [Team setup with JWT (internet-facing)](#team-setup-with-jwt-internet-facing)
- [Telling Claude to use the coordinator](#telling-claude-to-use-the-coordinator)
- [End-to-end example — two Claudes coordinating](#end-to-end-example--two-claudes-coordinating)
- [Running multiple coordinators on the same machine](#running-multiple-coordinators-on-the-same-machine)
- [Push vs polling](#push-vs-polling)
- [Logs and debugging](#logs-and-debugging)
- [Removing the integration](#removing-the-integration)

---

## Solo developer — multiple Claude Code sessions

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

## Team setup — shared coordinator on LAN

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

## Team setup with JWT (internet-facing)

For internet-facing or multi-tenant deployments, enable JWT auth. Full step-by-step:

**Step 1 (host) — generate secrets**

```bash
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

Front the server with TLS via nginx/Caddy/etc. for internet exposure. Local LAN can use plain HTTP.

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

**Step 5 (each teammate) — run `init --write-claude-md`** to scaffold project instructions, OR add the coordination section to an existing `CLAUDE.md`.

**Step 6 (each teammate) — verify**: `mcp-coordinator doctor --host coordinator.example.com --port 443` should show all checks green from any laptop.

**Token rotation**: tokens expire per `COORDINATOR_JWT_EXPIRY` (default 24h). Refresh via `POST /api/auth/refresh` with the current Bearer token. The admin can revoke a specific agent via `POST /api/auth/revoke` (admin token required).

For OAuth-based deployments (GitHub/Google/OIDC), see [docs/onboarding-self-host.md](./onboarding-self-host.md).

## Telling Claude to use the coordinator

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

The dashboard shows live who's doing what; the SQLite database persists threads across sessions; conflicts are detected before code is written.

## Push vs polling

Vanilla Claude Code talks to mcp-coordinator over MCP (HTTP/stdio request-response). It **does not subscribe to MQTT**. That means events the coordinator publishes on MQTT (`coordinator/consultations/new`, etc.) are not auto-delivered to a Claude Code session — Claude has to **poll** the coordinator to discover new activity. The polling pattern is:

- `announce_work` returns the thread ID immediately if a conflict is detected — that's the most important checkpoint
- After that, periodic calls to `coordinator_status` / `list_threads` / `get_thread_updates` surface new posts on threads you're a participant in
- The CLAUDE.md scaffolded by `mcp-coordinator init --write-claude-md` instructs Claude to do exactly this polling

If you want **real-time push** (every coordination event interrupting Claude between turns instead of waiting for a poll), use [essaim](https://github.com/swoofer/essaim). essaim ships an agent-loop wrapper that subscribes to the MQTT broker and injects events into the turn flow automatically. mcp-coordinator alone supports the polling model — which is sufficient for most use cases (2-3 Claude sessions on a small team) and zero-config to set up.

## End-to-end example — two Claudes coordinating

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

## Running multiple coordinators on the same machine

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

## Logs and debugging

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

## Removing the integration

Symmetric to `init`, the `uninstall` command undoes what was added without touching anything you wrote yourself.

```bash
# Remove coordinator from a project's .mcp.json AND strip its section from CLAUDE.md
mcp-coordinator uninstall --mcp-config ~/my-repo --claude-md ~/my-repo

# Wipe the global config dir (~/.mcp-coordinator/) entirely — config + data + logs + pid file
mcp-coordinator uninstall --purge          # asks for confirmation
mcp-coordinator uninstall --purge --force  # skip the prompt, useful in scripts
```

`--mcp-config <path>` reads `<path>/.mcp.json`, removes only the `coordinator` server entry (other servers untouched), and deletes the file if it ends up empty. `--claude-md <path>` removes only the block delimited by the `mcp-coordinator:coordination-section` sentinels (rendered as HTML comments around the section) — it never touches text you authored. Combine flags as needed; if the resulting `CLAUDE.md` is empty, it's deleted.

To remove the npm package itself: `npm uninstall -g mcp-coordinator`.
