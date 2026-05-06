# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes (latest minor) |

## Reporting a vulnerability

Email `gagnon_max11@hotmail.com` with details. Do not open a public issue for security reports.

We will acknowledge receipt within 7 days and provide a timeline for the fix or mitigation.

## Threat model

mcp-coordinator runs entirely on the developer's local machine. It binds an
HTTP server (default `127.0.0.1:3100`) and an embedded MQTT broker
(default `127.0.0.1:1883`). It is **not** designed to be exposed to the
public internet.

## Permission surface (by design)

This package is a **local MCP server**. The capabilities listed below are
intentional and necessary for the product to work — they are not
vulnerabilities.

| Capability             | Why it's needed                                                     |
| ---------------------- | ------------------------------------------------------------------- |
| `child_process.spawn`  | Launch the coordinator daemon (`server start --daemon`)             |
| `child_process.spawn`  | Open the dashboard URL in the user's browser (`mcp-coordinator dashboard`) |
| `child_process.execFile` | Read the Claude Code OAuth token from macOS Keychain (`security` CLI) |
| `fs.read*` / `fs.write*` | Persist config, PID file, daemon log, SQLite database under `~/.mcp-coordinator/` |
| `net.createServer`     | Bind the embedded MQTT TCP listener                                 |
| `http.createServer`    | Serve the MCP HTTP transport, REST API and dashboard                |
| `fetch`                | Anthropic OAuth quota endpoint only — `https://api.anthropic.com/api/oauth/usage` |
| `process.env.COORDINATOR_*` | Configuration (port, data dir, JWT secret when auth is enabled)  |

## Auditing tools and false-positive guidance

Static scanners (e.g. SafeSkill) flag patterns that look risky but are
benign in this codebase. The most common confusions:

### `db.exec()` is **not** `child_process.exec()`

Many scans report dozens of "Spawns child process" findings that point at
lines like `db.exec("DELETE FROM threads")` or
`raw.exec("PRAGMA journal_mode = WAL")`. Those are calls into
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3)'s prepared-statement
API. They never spawn a process — they execute a SQL statement against the
embedded SQLite database. All such calls in this repo (under `src/database.ts`,
`src/serve-http.ts`, `src/db-adapter.ts`) are SQL, not shell.

### `execFile` for Keychain access is shell-injection-safe

`src/quota/credential-reader.ts` uses `child_process.execFile` to call
`security find-generic-password` on macOS. `execFile` does **not** use a
shell — arguments are passed as a fixed array, never interpolated into a
command string, so they cannot be used for command injection. The args
list is hardcoded; no user input is forwarded.

### Crypto + HTTP imports

`crypto` is imported in `src/auth.ts` and `src/serve-http.ts` for JWT
signing (`jose`), `randomUUID()`, and `timingSafeEqual()`. These are
standard auth primitives, not data-exfiltration scaffolding.

### `Buffer.from(b64, "base64url")`

`src/serve-http.ts` decodes the payload of JWTs that **the server itself
just minted** so it can return the `exp` claim to the client. Inbound
token verification happens through `jose.jwtVerify()` with the configured
signing key — not through the local decode helper.

### Environment variables

All env-var reads use the `COORDINATOR_*` prefix and are read at startup
into local constants. Nothing is forwarded over the network. The complete
set of recognized env vars is documented in the README.

## Outbound network calls

The only outbound HTTP request the package can make is to
`https://api.anthropic.com/api/oauth/usage`, gated behind the optional
quota feature and only when an Anthropic OAuth token is present in the
user's Keychain. No telemetry, no analytics, no auto-update calls.
