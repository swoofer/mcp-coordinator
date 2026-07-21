# systemd service example

For operators running mcp-coordinator as a long-lived service on a bare VM
(Hetzner, DigitalOcean, EC2, a home server…) rather than in Docker. This
unit runs the coordinator as a dedicated non-root user, restarts it on
failure, and streams logs to journald — no `--daemon`, no PID files, no log
rotation to manage yourself.

Files in this directory:

| File | Installs to | Purpose |
|---|---|---|
| `mcp-coordinator.service` | `/etc/systemd/system/` | the unit definition |
| `env.example` | `/etc/mcp-coordinator/env` | `COORDINATOR_*` config + secrets |

## Install

```sh
# 1. Install the coordinator itself (global npm bin on PATH).
sudo npm install -g mcp-coordinator@latest
command -v mcp-coordinator          # note the absolute path (e.g. /usr/bin/mcp-coordinator)

# 2. Create a dedicated, unprivileged service account with no login shell.
sudo useradd --system --home /var/lib/mcp-coordinator \
             --shell /usr/sbin/nologin mcp-coordinator

# 3. Create the persistent data directory (systemd also enforces this via
#    StateDirectory=, but pre-creating it is harmless and explicit).
sudo install -d -o mcp-coordinator -g mcp-coordinator -m 0750 /var/lib/mcp-coordinator

# 4. Install the environment file (root-owned, group-readable by the service).
sudo install -d -m 0755 /etc/mcp-coordinator
sudo install -m 0640 -g mcp-coordinator env.example /etc/mcp-coordinator/env
sudo editor /etc/mcp-coordinator/env     # set PORT / COORDINATOR_DATA_DIR / auth

# 5. Install the unit. If `command -v` in step 1 was NOT /usr/bin/mcp-coordinator,
#    edit ExecStart= to match before copying.
sudo cp mcp-coordinator.service /etc/systemd/system/

# 6. Enable + start (enable = start on boot, --now = start right away too).
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-coordinator
```

Verify:

```sh
systemctl status mcp-coordinator        # should show "active (running)"
curl -fsS http://127.0.0.1:3100/health  # coordinator health endpoint
```

> **Global bin vs. source checkout.** `ExecStart` must be an **absolute
> path** — systemd does not search `$PATH`. The unit ships with
> `/usr/bin/mcp-coordinator`; if your global bin lives elsewhere (e.g.
> `/usr/local/bin`), fix the path. Running from a `git` checkout instead?
> Use the commented alternative in the unit:
> `ExecStart=/usr/bin/node /opt/mcp-coordinator/dist/cli/index.js server start`.

## Logs

The server logs to stdout/stderr, which journald captures — there is no log
file to rotate.

```sh
journalctl -u mcp-coordinator -f          # follow live
journalctl -u mcp-coordinator --since "1 hour ago"
journalctl -u mcp-coordinator -p err      # errors only
```

## Restart-on-failure

`Restart=on-failure` with `RestartSec=5` brings the service back 5 seconds
after any non-zero exit or crash. `StartLimitBurst=5` / `StartLimitIntervalSec=60`
stop a genuine crash-loop from hammering the host — after 5 failures in 60s
the unit enters `failed` and stays down until you fix the cause and run
`systemctl reset-failed mcp-coordinator && systemctl start mcp-coordinator`.

Test it: `sudo systemctl kill -s SIGKILL mcp-coordinator`, then watch
`systemctl status` show it come back within ~5s. (A clean `systemctl stop`
is exit 0, so it does **not** trigger a restart — that is intended.)

## Security hardening

The unit ships with defense-in-depth directives. What each buys you:

- **`User=` / `Group=mcp-coordinator`** — never runs as root; a compromise is
  confined to an account that owns nothing but its data dir.
- **`NoNewPrivileges=true`** — the process and its children can never gain
  privileges via setuid/setgid binaries.
- **`ProtectSystem=strict`** — the entire filesystem is read-only except the
  paths explicitly granted below.
- **`StateDirectory=mcp-coordinator`** — the one writable location:
  `/var/lib/mcp-coordinator`, auto-created and chowned to the service user
  (mode 0750). Keep `COORDINATOR_DATA_DIR` pointed here.
- **`ProtectHome=true`, `PrivateTmp=true`, `PrivateDevices=true`** — no view
  of `/home`, a private `/tmp`, and no raw device access.
- **`CapabilityBoundingSet=` / `AmbientCapabilities=` (both empty)** — drops
  every Linux capability. Ports 3100 and 1883 are both >1024, so the service
  never needs `CAP_NET_BIND_SERVICE`.
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`** — only the socket
  families Node actually uses (HTTP + MQTT + local sockets).
- **`SystemCallFilter=@system-service`** — allow-list of syscalls typical of
  a network service; anything exotic returns `EPERM`.
- Plus `ProtectKernel*`, `ProtectControlGroups`, `RestrictNamespaces`,
  `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077`.

If a hardening directive ever blocks a feature you need, `systemd-analyze
security mcp-coordinator` scores the unit and shows exactly which knob to
relax.

## Terminate TLS at a reverse proxy — do not expose 3100 directly

The coordinator speaks plain HTTP and, by default, binds **loopback only**
(`COORDINATOR_BIND=127.0.0.1`). Keep it that way. Put nginx, Caddy, or
Cloudflare Tunnel in front to terminate TLS and forward to
`127.0.0.1:3100`; never open port 3100 to the internet and never point
public DNS at it. See [`../nginx-reverse-proxy/`](../nginx-reverse-proxy/)
for a ready-to-adapt config. Enabling OAuth (`COORDINATOR_OAUTH_ENABLED`)
additionally **requires** an `https://` `COORDINATOR_PUBLIC_URL`, which is
the proxy's job — see [`docs/onboarding-self-host.md`](../../docs/onboarding-self-host.md).

The embedded MQTT broker on 1883 is likewise loopback-bound by default;
expose it only over a VPN/LAN you trust, never the public internet.
