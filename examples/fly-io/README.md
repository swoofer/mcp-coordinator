# Fly.io example: coordinator on a persistent volume

Deploy `mcp-coordinator` to [Fly.io](https://fly.io) as a single
machine backed by a Fly volume. Fly terminates TLS at its edge and
gives you a `https://<app>.fly.dev` URL for free; the SQLite database
lives on a volume that survives deploys and restarts.

This is the lowest-friction way to get a real, internet-facing
coordinator. Fly's per-machine volume model fits SQLite exactly — one
machine, one disk, no clustering.

The deployment runs the prebuilt image
`ghcr.io/swoofer/mcp-coordinator` (pinned in `fly.toml`). You don't
build anything locally.

## Prerequisites

1. A Fly.io account and the `flyctl` CLI installed and authenticated
   (`fly auth login`). A payment method on file is required even for
   free-tier-sized machines.
2. A GitHub OAuth App (needed while `COORDINATOR_OAUTH_ENABLED=true`).
   Create one at <https://github.com/settings/applications/new> with:
   - Homepage URL: `https://<app>.fly.dev`
   - Authorization callback URL:
     `https://<app>.fly.dev/auth/callback`
   You won't know `<app>` until after `fly launch`, so you can create
   the OAuth App after step 1 below and edit the URLs then.

## Deploy

### 1. Claim an app name (no deploy yet)

```sh
cd examples/fly-io
fly launch --no-deploy
```

Answer **yes** to "copy configuration to the new app?" so Fly uses the
provided `fly.toml`. Pick an app name and region when prompted, or edit
`app` and `primary_region` in `fly.toml` afterward. `--no-deploy` stops
Fly from booting a machine before the volume and secrets exist.

Also set `COORDINATOR_PUBLIC_URL` in `fly.toml`'s `[env]` to your real
`https://<app>.fly.dev` origin (or a custom domain) — the coordinator
refuses to serve over `http://` on a non-localhost origin and issues
`Secure` cookies against this value.

### 2. Create the persistent volume

The volume name **must** match `[mounts].source` in `fly.toml`
(`coordinator_data`). Create it in the same region as the app:

```sh
fly volumes create coordinator_data --region iad --size 1
```

`--size 1` is 1 GB, plenty for the SQLite DB and easily free-tier
friendly; grow later with `fly volumes extend`. This volume holds
`/data`, and the coordinator writes `coordinator.db` (plus the JWKS
rotation state and registration files) under `/data/data`
(`COORDINATOR_DATA_DIR`). **If this volume is lost, all sessions,
service tokens, audit logs, and refresh-token families are gone** —
back it up before upgrades (see below).

### 3. Set secrets

Secrets are stored encrypted by Fly and injected as env vars at
runtime — never commit them to `fly.toml`. Generate strong values:

```sh
fly secrets set \
  COORDINATOR_JWT_SECRET="$(openssl rand -base64 32)" \
  COORDINATOR_GITHUB_CLIENT_SECRET="<from your GitHub OAuth App>" \
  COORDINATOR_ENCRYPTION_KEY="$(openssl rand -base64 32)"
```

- `COORDINATOR_JWT_SECRET` — required; must be ≥32 bytes of entropy.
  The coordinator refuses to boot with a short or default-looking
  secret.
- `COORDINATOR_GITHUB_CLIENT_SECRET` — required while
  `COORDINATOR_OAUTH_ENABLED=true`. Its matching *client ID* is not a
  secret and goes in `fly.toml`'s `[env]`.
- `COORDINATOR_ENCRYPTION_KEY` — encrypts OAuth IdP tokens at rest in
  `coordinator.db`. Optional but recommended; without it those tokens
  are stored in plaintext and an ERROR is logged at boot.

Setting secrets before the first deploy means the machine boots once,
already configured.

### 4. Deploy

```sh
fly deploy
```

Fly pulls the pinned image, attaches the `coordinator_data` volume at
`/data`, and starts one machine. Watch it come up:

```sh
fly status          # machine should be started + passing checks
fly logs            # boot composer + migration output
```

Once the `/health` check passes, the coordinator is live at
`https://<app>.fly.dev`. Smoke-test it:

```sh
curl -sS https://<app>.fly.dev/health    # 200 once ready, 503 while booting
```

## Persistence and TLS notes

- **The volume must persist `coordinator.db`.** `fly deploy` replaces
  the machine's root filesystem on every release, but the
  `coordinator_data` volume mounted at `/data` is reattached, so the
  database and JWKS state carry across deploys and restarts. Losing the
  volume means losing all state — treat it as the source of truth.
- **Keep a single machine.** A Fly volume binds to one machine in one
  region. `fly.toml` sets `min_machines_running = 1` and
  `auto_stop_machines = "off"` so the coordinator never scales to zero
  and always has its disk. Do not add machines expecting shared
  state — this is a single-node deployment.
- **Fly handles TLS.** The edge terminates HTTPS and forwards plain
  HTTP to `:3100` inside the machine; `force_https = true` redirects
  any `http://` request to `https://`. You do not run Caddy, nginx, or
  certbot here — compare with `../docker-compose/` (Caddy auto-TLS) and
  `../nginx-reverse-proxy/` if you'd rather own the front-end.
- **MQTT goes over WebSocket, not raw TCP.** The embedded MQTT broker
  binds `1883` to `127.0.0.1` inside the machine and is intentionally
  not published as a Fly service. Agents that use MQTT connect over the
  WebSocket bridge — `wss://<app>.fly.dev/mqtt` — which rides the same
  HTTPS service and inherits Fly's TLS. Plain-TCP `:1883` is reachable
  only from inside the machine.

## Backups

Snapshot the volume before an upgrade. Fly takes automatic daily
snapshots, but an explicit one before a risky change is cheap
insurance:

```sh
fly volumes list                          # note the volume ID (vol_...)
fly volumes snapshots create <vol_id>     # on-demand snapshot
fly volumes snapshots list <vol_id>       # confirm it exists
```

Restore by creating a new volume from a snapshot
(`fly volumes create coordinator_data --snapshot-id <snap_id>`) and
redeploying.

## Upgrading

Bump the pinned tag in `fly.toml`:

```toml
[build]
  image = "ghcr.io/swoofer/mcp-coordinator:0.13.1"
```

Then `fly deploy`. The volume reattaches to the new machine, so the DB
survives the upgrade. For automatic patch bumps within a minor series
use the moving tag `:0.13`; avoid `:latest` in production.

## What this example does NOT include

- A custom domain. Add one with `fly certs add coordinator.example.com`
  and point a CNAME at `<app>.fly.dev`, then update
  `COORDINATOR_PUBLIC_URL` and the GitHub OAuth callback URL.
- Multi-region or multi-machine HA. The coordinator is single-node;
  the volume model enforces that here.
- Metrics scraping. The coordinator exposes Prometheus metrics on
  `/metrics`; scrape it over the private Fly network from another app.
