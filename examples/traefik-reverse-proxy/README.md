# Traefik reverse-proxy example

For operators who already run Traefik — the dominant reverse proxy in Docker
and Kubernetes shops — and want to add mcp-coordinator behind it rather than
introducing Caddy or nginx. This is the Traefik counterpart to
`examples/nginx-reverse-proxy/`: same TLS + WebSocket + SSE story, expressed
with a `docker-compose.yml` and container labels instead of a hand-written
server block.

Traefik terminates TLS (Let's Encrypt), routes your domain to the coordinator
on `:3100`, transparently upgrades the `/mqtt` WebSocket, and streams the
`/api/events` SSE feed. Port `3100` is **never** published to the host — it is
reachable only over the internal compose network, so every request must pass
through Traefik and its TLS.

Stack:

- `traefik` — `traefik:v3.3`. Owns ports 80 and 443, provisions certificates
  via the Let's Encrypt HTTP-01 challenge, redirects HTTP to HTTPS, and reads
  its routing from labels on the `coordinator` container.
- `coordinator` — pulls `ghcr.io/swoofer/mcp-coordinator:0.13.0`, listens on
  `:3100` inside the compose network with **no host port mapping**. Data lives
  in the `coordinator-data` named volume.

## Prerequisites

1. A public domain with A (and ideally AAAA) records pointing at this host.
   The Let's Encrypt HTTP-01 challenge needs port 80 reachable from the public
   internet.
2. A GitHub OAuth App (create at
   <https://github.com/settings/applications/new>):
   - Homepage URL: `https://coordinator.example.com`
   - Authorization callback URL:
     `https://coordinator.example.com/auth/callback`
3. Docker Engine 20.10+ and the Compose v2 plugin.

## Bring-up

```sh
cp .env.example .env
# edit .env: set COORDINATOR_PUBLIC_DOMAIN, ACME_EMAIL, COORDINATOR_PUBLIC_URL,
# the three GitHub OAuth fields, and a freshly generated JWT secret:
openssl rand -base64 32

docker compose config          # validate YAML + label interpolation
docker compose up -d           # start Traefik + coordinator
docker compose ps              # confirm both are up
docker compose logs -f traefik # watch ACME / certificate provisioning
```

Traefik requests a certificate on the first HTTPS request for the domain. Once
the `le` resolver reports the certificate obtained, the coordinator is reachable
at `https://<COORDINATOR_PUBLIC_DOMAIN>`.

## Why the compose+labels approach

Traefik can be driven by static + dynamic YAML files (`traefik.yml`) or by
container labels via the Docker provider. We use labels: the routing lives next
to the service it describes, there is one file to reason about, and adding the
coordinator to an existing Traefik instance is a copy-paste of the `labels:`
block. The Traefik container's own `command:` flags hold the static config
(entrypoints, the ACME resolver, timeouts).

## What each piece does

### TLS termination (`certificatesresolvers.le.acme.*`)

Traefik runs the ACME HTTP-01 challenge over the `web` (port 80) entrypoint and
stores the account key + issued certs in the `letsencrypt` named volume
(`/letsencrypt/acme.json`). The router's `tls.certresolver=le` label is what
actually triggers issuance for the domain. This replaces the nginx example's
`ssl_certificate` / `ssl_certificate_key` — nginx itself does no ACME, whereas
Traefik does it inline.

**Self-signed / bring-your-own-cert alternative:** drop the `le` resolver, mount
your cert + key, and point a dynamic-config `tls.certificates` entry (or a
`tls.stores.default`) at them. For local testing without a public domain,
generate a self-signed pair with `mkcert coordinator.example.com` and reference
it the same way. Traefik serves its own throwaway self-signed cert if a router
has `tls=true` but no usable certificate, which is enough to exercise the
WebSocket/SSE paths locally (clients must accept the untrusted cert).

### HTTP → HTTPS redirect

The `web.http.redirections` flags on the entrypoint 301 every plaintext request
to `websecure`. This mirrors the nginx example's second `server { listen 80; }`
block.

### WebSocket upgrade for `/mqtt`

The coordinator exposes the MQTT bridge as a WebSocket **on the same HTTP
server** — it listens for the HTTP `Upgrade` event and hands `/mqtt` (or
`$COORDINATOR_MQTT_WS_PATH`) to an embedded broker. **Traefik upgrades
WebSocket connections automatically**: when it sees `Connection: Upgrade` /
`Upgrade: websocket`, it switches the connection to a raw bidirectional tunnel.
There is no `location /mqtt` equivalent to write and no header dance to
configure — the single `Host()` router covers `/mqtt` along with everything
else. The raised `idleTimeout` (below) is what keeps a quiet WS connection from
being reaped.

Verify from outside:

```sh
# Any MQTT-over-WS client works; using mosquitto_sub with a wss:// broker:
mosquitto_sub -L wss://coordinator.example.com/mqtt -t 'some/topic' -d
# The handshake should return HTTP 101 Switching Protocols. A 404/400 means
# the path or the Upgrade headers aren't reaching the coordinator.
```

### SSE for `/api/events` (`responseForwarding.flushInterval`)

`/api/events` is a Server-Sent Events stream — the coordinator writes
`Content-Type: text/event-stream`, `Cache-Control: no-cache`, and holds the
connection open, emitting periodic keepalives. Two Traefik settings matter:

- `responseForwarding.flushInterval=1ms` on the service. Traefik already flushes
  `text/event-stream` responses immediately, but pinning a tiny interval
  guarantees no batching even if the content-type is not detected. This is the
  Traefik analogue of nginx `proxy_buffering off;` — without real-time flushing,
  clients see batched events arrive in chunks instead of streaming, and the MCP
  HTTP transport appears broken.
- `entrypoints.websecure.transport.respondingTimeouts.idleTimeout=86400s`. SSE
  (and the WebSocket) are long-lived by design; the default 180s idle timeout
  would drop a quiet connection. 24h is generous — the analogue of nginx
  `proxy_read_timeout 1d;`. Tune downward only with a specific reason.

Verify:

```sh
curl -N --cookie "..." https://coordinator.example.com/api/events
# Should stream `event:` / `data:` lines in real time, not one batched chunk.
```

### Never exposing 3100

The `coordinator` service has no `ports:` key, so Docker never binds 3100 on the
host. Traefik reaches it over the `internal` bridge network by container name.
`providers.docker.exposedbydefault=false` means only containers that opt in with
`traefik.enable=true` are routed at all.

### X-Forwarded-* headers

Traefik sets `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host`, etc.
automatically for the upstream. See the known limitation below.

## Known limitation: X-Forwarded-For and rate-limiting

Same caveat as the nginx example. The coordinator's per-IP rate limiter
currently keys on `req.socket.remoteAddress`, which behind Traefik is the
proxy's address on the internal network, not the real client. Per-IP limits
therefore collapse into a shared bucket.

Traefik forwards `X-Forwarded-For`, but the coordinator does not yet honor it
for the rate-limit key. Until that lands, either accept the limitation or move
rate-limiting into Traefik with a middleware:

```yaml
# Add to the coordinator's labels, then attach it to the router:
#   traefik.http.routers.coordinator.middlewares=coordinator-rl
- "traefik.http.middlewares.coordinator-rl.ratelimit.average=20"
- "traefik.http.middlewares.coordinator-rl.ratelimit.burst=40"
```

Traefik's rate-limit middleware keys on the real client IP (from the trusted
`X-Forwarded-For` chain) by default, so this actually protects against remote
brute-forcing — the recommended production workaround. Tune to taste; the
coordinator's own limits (`src/auth/rate-limit.ts`) are tighter on auth
endpoints than on general MCP traffic.

## Adding this to an existing Traefik instance

If you already run Traefik, you don't need the `traefik` service here at all.
Copy the `coordinator` service (image, `env_file`, `networks`, and the whole
`labels:` block) into your stack, make sure it shares a Docker network with your
Traefik, and confirm your Traefik has a `websecure` entrypoint and a
certificatesresolver named to match the `tls.certresolver` label (or rename the
label to your resolver).

## Troubleshooting

### Certificate never issues

- `dig +short coordinator.example.com` must return this host's public IP.
- Port 80 must be reachable from the public internet for the HTTP-01 challenge
  (`curl -v http://coordinator.example.com/` from outside — must hit Traefik).
- Watch `docker compose logs -f traefik` for `acme:` errors. Let's Encrypt
  rate-limits failures; while debugging, uncomment the staging `caserver` line
  in `docker-compose.yml`, then wipe the `letsencrypt` volume before switching
  back to production so the staging cert isn't served.

### `/mqtt` WebSocket fails to connect

- A `404` means Traefik routed but the coordinator didn't recognise the path —
  confirm `COORDINATOR_MQTT_WS_PATH` matches what the client requests.
- A response other than `101 Switching Protocols` on the handshake means the
  `Upgrade`/`Connection` headers aren't surviving — with a stock Traefik they
  are passed through automatically, so suspect an interfering middleware.

### SSE arrives in chunks

- Confirm the `responseForwarding.flushInterval` label is present on the
  service. If you forked the compose file and dropped it, restore it.

### Coordinator restart loop

Check `docker compose logs coordinator`: usually a too-short
`COORDINATOR_JWT_SECRET` (regenerate with `openssl rand -base64 32`), or missing
`COORDINATOR_GITHUB_*` vars while `COORDINATOR_OAUTH_ENABLED=true`.

## What this example does NOT include

- A Traefik dashboard/API (`--api.dashboard=true`). Off by default here so the
  admin surface isn't exposed; enable it behind auth on an internal entrypoint
  if you want it.
- DNS-01 challenges / wildcard certificates. Switch the resolver to a DNS
  provider if port 80 is closed or you need `*.example.com`.
- A docker-socket-proxy. The raw read-only socket mount is fine for a trusted
  single-host deploy; front it with a socket proxy on hardened hosts.
- Multi-node load balancing (out of scope for Phase 2's single-node
  coordinator).
