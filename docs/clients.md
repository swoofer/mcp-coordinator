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

## Connecting with authentication enabled

The snippets above carry no credentials. That is right for a daemon on loopback
and wrong for anything else. With `COORDINATOR_AUTH_ENABLED=true` the client has
to present a token, and MCP clients do that with a **static header** — not with
an OAuth handshake.

Issue the token first: [usage.md](./usage.md#team-setup-with-jwt-internet-facing)
covers generating the secrets and calling `POST /api/auth/register`. What follows
is only the client half.

**Claude Code** takes it in one command — no config file to edit, no flag to
unlock:

```bash
claude mcp add --transport http coordinator https://coordinator.example.com/mcp \
  --header "Authorization: Bearer <token>"
```

The hand-written equivalent is the `headers` key in
[usage.md step 4](./usage.md#team-setup-with-jwt-internet-facing).

**Claude.ai** accepts the same header under `static_headers` — `authorization` is
on Anthropic's allowlist of forwardable headers — but that field is a **beta you
have to request**, not something a standard workspace can switch on.

**Keep authentication enabled if you tunnel.** Publishing a loopback daemon
through ngrok, a Cloudflare tunnel or a Tailscale funnel puts the whole 26-tool
surface on the public internet, writes included. The header is the only thing
between it and anyone who guesses the URL.

### Why a client says it cannot register

```
Status: ✘ Failed to connect
Issue: Incompatible auth server: does not support dynamic client registration
```

That message is accurate, and it is not a daemon misconfiguration you can fix.
A spec-compliant MCP client tries to discover an OAuth authorization server and
register itself against it. **The coordinator is a relying party, not an
authorization server.** It signs you in *to* an IdP — GitHub, Google, or your own
OIDC provider — and has no authorization endpoint of its own to send a client to.
`/auth/login` drives the IdP's endpoint and replaces the caller's OAuth
parameters with its own, so no third-party client can complete a code flow
against it.

Setting the header removes the question rather than answering it: when
`Authorization` is already present, the client performs no discovery at all.

### Which token

Two kinds work. Which one you want depends on how the daemon is configured.

**A Phase 1 agent token** — `COORDINATOR_AUTH_ENABLED=true`, issued by
`POST /api/auth/register`. The simplest option, and the only one if you have not
turned OAuth on. It expires per `COORDINATOR_JWT_EXPIRY` (24 h by default), so
plan on rotating it.

**A Phase 2 service token** — `COORDINATOR_OAUTH_ENABLED=true`, issued with
`mcp-coordinator service-token issue`. Built for non-interactive callers, and it
lasts up to 90 days (`SERVICE_TOKEN_MAX_TTL_S`, a hard ceiling you cannot raise
by configuration), which is what makes it the better fit for CI.

One thing to know before you lean on it: the `--scope` you pass is validated when
the token is minted and then **never enforced on a request**. A `--scope read`
token can write. That is
[#313](https://github.com/swoofer/mcp-coordinator/issues/313), open — until it
closes, treat every service token as full access regardless of its scope.

> **On older builds, no Phase 2 token authenticates over `Bearer` at all.**
> Until [#322](https://github.com/swoofer/mcp-coordinator/pull/322) the Bearer
> path only reached the Phase 2 verifier when Phase 1 verification *threw*, which
> it never does in production — both phases derive their key from the same
> `COORDINATOR_JWT_SECRET`. Every Phase 2 token was rejected
> `v0.6 token rejected: upgrade required`, and only cookie-bearing browser
> clients could authenticate. If you see that message, upgrade; no configuration
> works around it.

### Routes that look promising and are not

Recorded so they do not get reopened:

- **Device flow (RFC 8628).** The coordinator implements one and advertises a
  `device_authorization_endpoint`. No Claude client consumes it — RFC 8628 is
  absent from the MCP authorization spec and from the connector documentation.
  This is the most tempting dead end precisely because the code already exists.
- **Pre-registering a client** (`--client-id` / `--callback-port`). Skips the
  registration step, but redirect and code issuance are unchanged — and the
  coordinator never issues a code.
- **`client_credentials`.** Anthropic's connector documentation states that a
  pure machine-to-machine grant is not supported; every connection requires user
  consent.
- **Running authless behind a tunnel.** It does connect. It also exposes all 26
  tools, writes included, with no authentication whatsoever.

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
| Claude Code | HTTP | `mcp-coordinator init` targets this directly; the snippet goes in the project's `.mcp.json`. For an authenticated daemon, `claude mcp add --header` is ungated — see [above](#connecting-with-authentication-enabled). |
| Claude.ai | HTTP | Remote connector: needs a publicly reachable URL, and `static_headers` for the token — that field is a beta you have to request. |
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
| "does not support dynamic client registration" | The coordinator is a relying party, not an authorization server — there is nothing for the client to register against. Set a static `Authorization` header instead: [Connecting with authentication enabled](#connecting-with-authentication-enabled). |
| "v0.6 token rejected: upgrade required" | A Phase 2 token (service token, OAuth access token) in a `Bearer` header, on a build predating [#322](https://github.com/swoofer/mcp-coordinator/pull/322). Upgrade, or use a Phase 1 agent token. |
| "not carrying auth claims" | The MCP session was closed or swept after idling past `COORDINATOR_MCP_SESSION_TTL_MS` (default 30 min). Reconnect the client. |
| Agents do not see each other | Almost always two different `COORDINATOR_DATA_DIR` values. |

More in [troubleshooting.md](./troubleshooting.md).
