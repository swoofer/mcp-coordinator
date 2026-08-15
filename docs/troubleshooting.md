# Troubleshooting

First-line self-help for the most common `mcp-coordinator` failure modes.
Each entry is **symptom -> likely cause -> fix**. If none of these match,
open an issue on [GitHub](https://github.com/swoofer/mcp-coordinator/issues)
with the relevant log lines (`~/.mcp-coordinator/logs/server.log` in daemon
mode).

References:

- `docs/onboarding-self-host.md` -- full Phase 2 setup walkthrough
- `.env.example` -- environment-variable reference
- `docs/ops/key-rotation.md` -- JWT signing key rotation

Quick facts you will need below:

- Default HTTP port **3100**; default MQTT TCP port **1883**.
- Config/state dir: `~/.mcp-coordinator/` (PID file, logs, SQLite data).
- The HTTP server and MQTT broker both bind **`127.0.0.1`** (loopback), not
  `0.0.0.0`.

---

## 1. Port already in use (3100 or 1883)

**Symptom.** `server start` (or the daemon log) shows
`Error: listen EADDRINUSE: address already in use 127.0.0.1:3100` (or
`:1883`), and the process exits. In daemon mode the CLI still prints
`Coordinator started in background` -- the crash is only visible in
`~/.mcp-coordinator/logs/server.log`.

**Likely cause.** Both listeners fail closed on bind: the HTTP server
(`httpServer.listen(port, bindHost)`) and the embedded MQTT TCP broker
(`tcpServer.listen(tcpPort, "127.0.0.1")`) each reject on the `error` event,
so a busy port aborts boot. Usually a previous coordinator is still running,
or another service holds 3100/1883.

**Fix.** Point at free ports, or free the busy one:

```bash
# Move the HTTP port
mcp-coordinator server start --port 3200
# Move the MQTT TCP port
COORDINATOR_MQTT_TCP_PORT=1884 mcp-coordinator server start
```

To find and stop the current holder, use `mcp-coordinator server stop`
(see section 3) before re-launching, or inspect the port with `lsof -i :3100`
(macOS/Linux) / `netstat -ano | findstr :3100` (Windows).

---

## 2. Server won't start -- boot fails closed (OAuth / Phase 2)

These guards fire **only when `COORDINATOR_OAUTH_ENABLED=true`**. Phase 1
(the default) does not require them.

**Symptom: `secret entropy: ...`.** Boot aborts with e.g.
`secret entropy: contains dictionary word "changeme"`,
`secret entropy: all bytes identical`, or
`secret entropy: 74.2 bits estimated, minimum 128`.

- *Cause.* `assertSecretEntropy()` rejects `COORDINATOR_JWT_SECRET` (and a
  rotation `COORDINATOR_JWT_SECRET_PREV`, if set) below **128 bits** of
  estimated Shannon entropy, plus an explicit blocklist of dictionary words
  (`secret`, `password`, `changeme`, `default`, ...).
- *Fix.* Generate a real random secret:
  `export COORDINATOR_JWT_SECRET="$(openssl rand -base64 32)"`.

**Symptom: `BootValidationError: ... must be set`.** Boot aborts naming a
missing variable.

- *Cause.* With OAuth enabled, `COORDINATOR_JWT_SECRET` and
  `COORDINATOR_PUBLIC_URL` are required, and **at least one IdP provider**
  must be configured. Provider credentials are both-or-neither
  (`COORDINATOR_GITHUB_CLIENT_ID` + `..._CLIENT_SECRET`; Google client
  id/secret; the three `COORDINATOR_OIDC_*` vars together). A configured
  GitHub OAuth app also requires `COORDINATOR_GITHUB_ORG` (the membership
  allowlist).
- *Fix.* Set the full set for at least one provider -- see
  `docs/onboarding-self-host.md` and `.env.example`.

**Symptom: `OAuth (Phase 2) is not supported on the Bun runtime`.**

- *Cause.* The GitHub Releases binaries are Bun-compiled, but the auth/admin
  subsystem depends on `better-sqlite3` APIs absent from `bun:sqlite`. Boot
  fails fast rather than crashing later inside a request handler.
- *Fix.* Run the **Node** build (npm or the Docker image) when you need
  OAuth, or leave `COORDINATOR_OAUTH_ENABLED` unset on the standalone binary.

---

## 3. `server stop` says "no PID" or the server seems stuck

**Symptom: `No server PID file found. Is the server running?` (exit 1).**

- *Cause.* No `~/.mcp-coordinator/server.pid`. The server was never started
  via the CLI, or the file was already cleaned up.
- *Fix.* Confirm it is actually running (`curl -s localhost:3100/livez`); if
  it is, it was started outside the CLI -- stop it by its OS process.

**Symptom: `Server (PID N) is not running. Cleaning up PID file.`**

- *Cause.* A **stale PID file** -- the recorded process already exited
  (e.g. it crashed on an EADDRINUSE bind, or was `kill -9`'d). In daemon mode
  the PID file is written immediately when the child is spawned, so a child
  that dies during boot leaves the file pointing at a dead PID.
- *Fix.* Nothing to do -- `stop` removes the stale file for you. You can now
  start cleanly.

**Symptom: `Server did not stop gracefully. Sending SIGKILL.`**

- *Cause.* Graceful stop sends `SIGTERM`, then waits (default **5s**) for the
  ordered teardown -- Phase 2 audit drain, HTTP, MQTT, DB -- before
  escalating to `SIGKILL`. A slow audit/quota flush can exceed the grace
  window.
- *Fix.* Give it more time, or kill immediately:

```bash
mcp-coordinator server stop --timeout 30   # allow a slow audit flush
mcp-coordinator server stop --force        # SIGKILL now, no graceful shutdown
```

If all else fails, delete `~/.mcp-coordinator/server.pid` by hand and stop the
OS process directly.

---

## 4. MQTT client can't connect

The coordinator embeds an MQTT broker (Aedes). See the connection contract in
`docs/` for the full topic list. Common connection failures:

**Symptom: connection refused / times out from another machine or a LAN IP.**

- *Cause.* The TCP broker binds **`127.0.0.1` explicitly** (loopback only) --
  IPv6 (`::`) default binding was dropped because clients that resolve
  `localhost -> 127.0.0.1` would hang. It is not reachable off-host.
- *Fix.* Connect to `mqtt://127.0.0.1:1883` from the same host. For remote
  access, front the WebSocket endpoint (`ws://localhost:3100/mqtt`) with a
  reverse proxy that terminates TLS -- do not expose the raw port.

**Symptom: WebSocket handshake fails (browser / strict WS client).**

- *Cause.* The WS upgrade handler matches only the URL **path**
  (`/mqtt`); it does **not** negotiate an MQTT subprotocol. A client that
  sends `Sec-WebSocket-Protocol: mqtt` expects the server to echo it back,
  and strict clients fail the handshake when it does not.
- *Fix.* Connect to `ws://localhost:3100/mqtt` **without** requesting the
  `mqtt` subprotocol. Keep frames under the **1 MiB** cap.

**Symptom: CONNECT rejected (`MQTT auth rejected` in the log).**

- *Cause.* When `COORDINATOR_AUTH_ENABLED=true`, every CONNECT must carry a
  **Phase-1 JWT in the password field** (username is ignored); an empty
  password is rejected. Note a **Phase-2 OAuth token will not work for
  MQTT** -- the broker verifies only the Phase-1 HS256 secret.
- *Fix.* Mint a token with `POST /api/auth/register`
  (`{ agent_name, registration_secret }`, needs
  `COORDINATOR_REGISTRATION_SECRET`) and pass it as the CONNECT password:
  `mosquitto_sub -h 127.0.0.1 -p 1883 -u agent -P "$JWT" -t 'coordinator/default/#'`.
  With auth disabled (the default) connect anonymously, no credentials.

**Symptom: connected, subscribed, but no messages arrive.**

- *Cause.* The coordinator publishes **everything under a hardcoded org
  `default`** (`coordinator/default/...`); there is no per-org routing yet.
  Subscribing to any other org path -- or using a token whose `org` claim is
  not `default`, which the subscribe ACL then blocks -- receives nothing.
- *Fix.* Subscribe to `coordinator/default/#` (registration tokens already
  carry `org=default`, matching the publisher).

---

## 5. `/readyz` returns `not_ready` (503)

**Symptom.** `GET /readyz` returns HTTP **503** with
`{"status":"not_ready","checks":{...}}`. (`/livez` stays 200 -- it never
checks downstream deps, so orchestrators do not restart the pod over a
transient dependency blip.)

**Likely cause.** Only **`db`** and **`mqtt`** gate readiness (`tree_sitter`
and `git_cochange` are reported but optional). Look at the failing check:

- `checks.db.ok = false` -- the `SELECT 1` probe threw: DB handle closed, or
  the SQLite file is locked beyond `busy_timeout` (or not writable).
- `checks.mqtt.ok = false` with `error: "not connected"` -- the internal MQTT
  bridge is not connected to the embedded broker, typically because the
  broker failed to bind its TCP port (see section 1).

**Fix.** Inspect the failing check and its `error` string, then resolve the
underlying dependency -- free the MQTT port, or make the data directory
writable. `/readyz` flips back to `200 ready` once both are green.

---

## 6. 401 Unauthorized on HTTP / MCP / SSE

**Symptom.** REST or MCP requests return **401** with a
`WWW-Authenticate: Bearer realm="coordinator", error="invalid_token"` header.

**Likely cause.** `COORDINATOR_AUTH_ENABLED=true` requires a valid Bearer JWT
on protected routes; the token is missing, malformed, or expired. A common
gotcha: **EventSource/SSE cannot set headers**, so a browser `/api/events`
connection 401s unless the token is passed as a query param.

**Fix.**

- Send `Authorization: Bearer <jwt>` on REST/MCP calls.
- For SSE, pass the token in the URL: `GET /api/events?token=<jwt>`.
- Obtain a token via `POST /api/auth/register` (needs
  `COORDINATOR_REGISTRATION_SECRET`). If the token expired, register again.
- Scraping `/metrics`? That endpoint uses its own optional
  `COORDINATOR_METRICS_BEARER`, separate from agent tokens.

---

## 7. Docker: `pnpm: command not found` / Corepack

**Symptom.** Building your own image (or running `pnpm` locally) fails with
`pnpm: command not found` or a Corepack error, even though `packageManager`
is pinned in `package.json`.

**Likely cause.** **Node 25+ no longer bundles Corepack.** The provided
`Dockerfile` (Node 26 alpine) installs it explicitly before enabling it.

**Fix.** Install Corepack, then enable it so the pinned pnpm version is used:

```dockerfile
RUN npm install -g corepack@latest && corepack enable
```

Locally, run `corepack enable` once and let it resolve the right pnpm.

---

## 8. macOS: standalone binary won't open

**Symptom.** Running the downloaded binary shows *"cannot be opened because
the developer cannot be verified"*, or it is silently killed on first launch.

**Likely cause.** The release binaries are Bun-compiled and **ad-hoc signed**
(`codesign --sign -`), not notarized by Apple. Gatekeeper quarantines
unnotarized downloads and blocks the first run.

**Fix.** Clear the quarantine attribute, then run it:

```bash
xattr -d com.apple.quarantine ./mcp-coordinator
./mcp-coordinator --version
```

(Or right-click the binary in Finder and choose **Open** once to approve it.)
Two related macOS notes: OAuth is unsupported on this Bun binary (section 2),
and the Anthropic quota reader is macOS-only (it reads the Keychain; on
Linux/Windows the quota endpoint returns 503 fail-open).

---

## 8b. An agent shows as online after it died — or disappears while still working

`list_agents(online_only: true)`, `coordinator_status` and `wait_for_peers` all
report agents that are flagged online **and** have been seen recently.

"Seen" is refreshed by real work, not only by the explicit `heartbeat` tool:
`announce_work` and `post_to_thread` both count. An agent that has done none of
those for longer than the TTL drops out of the online list.

The TTL defaults to **900 seconds (15 minutes)** and is tunable:

```bash
COORDINATOR_AGENT_ONLINE_TTL_SECONDS=1800   # more patient
```

Two things this deliberately does *not* do:

- It never deletes or rewrites the row. `list_agents` without `online_only`,
  and the dashboard's agent list, still show the agent — this is a liveness
  filter, not a cull.
- It does not run a background sweeper, so there is nothing to coordinate in a
  multi-instance deployment. The filter is applied when you read.

If an agent vanishes mid-task, it is idle longer than the TTL between
coordination calls: raise the value, or have it call `heartbeat` periodically.

---

## 8c. `register_agent` fails with "already registered in org …"

**Symptom.** Registering an agent id that works fine in one org is rejected in
another:

```
agent id 'builder' is already registered in org 'acme'. Agent ids are globally
unique in this release, not per-org — choose a different id.
```

**Cause.** You are on a pre-v11 schema. The `agents` primary key was already
`(org_id, id)`, but a **global** UNIQUE index on `agents(id)` survived because
five foreign keys referenced `agents(id)` rather than the composite key — so
ids were effectively global. (Older still: the same situation surfaced as a raw
`UNIQUE constraint failed: agents.id`, naming neither the id nor the owning
org.)

**Fix.** Upgrade. Schema **v11** ([#231](https://github.com/swoofer/mcp-coordinator/issues/231))
rewrites those foreign keys as `(org_id, <col>) REFERENCES agents(org_id, id)`
and drops the global index: agent ids are now unique **within an org**, and two
orgs may both use `builder`. The migration runs automatically on first open. To
stay on the old schema, keep prefixing ids with the org (`acme-builder`).

Two things the upgrade can report:

- **`Cannot migrate to per-org agent ids (issue #231): rows reference agent ids
  that do not exist in 'agents' …`** — a row points at an agent absent from
  `agents`, so there is no org to re-parent it to. Such a database already
  violates the *current* foreign key. The migration refuses rather than delete
  your rows: it aborts, the DB stays at v10, and the message carries per-table
  counts. Back up the data directory, then re-create the missing agent rows or
  remove the orphaned ones, and restart.
- **A `migration.agent_fk_reparent` row in `audit_log`** — rows whose `org_id`
  disagreed with their agent's actual org (possible only because the old
  foreign key never checked it) were corrected. Informational, written once,
  with per-table counts in `metadata_json`.

---

## 8d. `claim-task` returns `success: false` with a `conflict` field

**Symptom.** A claim is refused even though the thread itself is unclaimed —
`claimed_by` is `null`, `assigned_to` is `null`, `status` is `"open"`:

```json
{ "success": false, "claimed_by": null, "assigned_to": null, "status": "open",
  "conflict": { "thread_id": "…", "files": ["src/shared.ts"] } }
```

**Cause.** Another agent already holds a **different** thread whose
`target_files` overlap yours. The claim CAS used to predicate on thread id
alone, so two agents could claim two different threads touching the same file
and both start editing it. The overlap guard closes that
([#258](https://github.com/swoofer/mcp-coordinator/issues/258)).

`conflict` names the thread holding the files and which files collided — the
other fields all look normal precisely because nothing is wrong with *your*
thread.

**Fix.** Nothing to repair: claim a different thread and come back. Clients that
already handle `success: false` by refetching need no change. One agent holding
two overlapping threads is still allowed — a single worker serializes itself.

---

## 9. Windows notes

- **`EBUSY` during tests.** A handful of Windows file-handle teardown flakes
  in the test suite are known and ignored per project convention -- they are a
  test-teardown artifact, not a runtime fault. Re-run the suite.
- **Data-directory permissions.** The POSIX `chmod 0600` on the SQLite file is
  skipped silently on native Windows; secure `~/.mcp-coordinator/data` with
  NTFS ACLs instead. Or run via the Docker image (Node on Debian slim).
</content>
</invoke>
