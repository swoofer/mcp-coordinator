# docker-compose example: coordinator + Caddy auto-TLS

This directory contains a working full-stack deployment of
mcp-coordinator behind a Caddy reverse proxy that provisions TLS
certificates automatically via Let's Encrypt.

Stack:

- `coordinator` -- runs `npx mcp-coordinator@latest server start` on
  `node:22-alpine`. Listens on `:3000` inside the compose network.
  Data lives in the `coordinator-data` named volume.
- `caddy` -- terminates TLS, proxies HTTP/1.1 + HTTP/2 + SSE to the
  coordinator. Persists certs and ACME state in the `caddy-data` and
  `caddy-config` named volumes.

Bring-up time after DNS records propagate: under 5 minutes.

## Prerequisites

1. A public domain with A (and ideally AAAA) records pointing at this
   host. Caddy needs ports 80 and 443 reachable from the public
   internet for the HTTP-01 / TLS-ALPN-01 ACME challenges.
2. A GitHub OAuth App. Create one at
   <https://github.com/settings/applications/new> with:
   - Homepage URL: `https://coordinator.example.com`
   - Authorization callback URL:
     `https://coordinator.example.com/auth/callback`
3. Docker Engine 20.10+ and the Compose v2 plugin.

## Bring-up

```sh
cp .env.example .env
# edit .env: fill in COORDINATOR_PUBLIC_DOMAIN, COORDINATOR_PUBLIC_URL,
# the three GitHub OAuth fields, and a freshly generated JWT secret:
openssl rand -base64 32

docker compose config         # validate YAML
docker compose up -d          # start both services
docker compose ps             # confirm both healthy
docker compose logs -f caddy  # watch TLS provisioning
```

Caddy will request a certificate on first start. Once you see
`certificate obtained successfully` in the Caddy logs, the
coordinator is reachable at `https://<COORDINATOR_PUBLIC_DOMAIN>`.

## Port-binding notes

Caddy binds 80 and 443 on the host. If another process already holds
those ports, Caddy will fail to start. Either stop the conflicting
process or remap (e.g. `"8080:80", "8443:443"`) and front this stack
with another reverse proxy. Note that ACME HTTP-01 requires the
challenge to be reachable on port 80 over the public internet, so
remapping breaks Caddy's automatic TLS unless you use a different
challenge type (DNS-01).

## Healthcheck behavior

The coordinator service has a Docker healthcheck against
`http://localhost:3000/healthz` every 30 s. The endpoint returns 200
once the DB migration and boot composer finish; before that it
returns 503. Caddy waits for `depends_on` ordering only, not the
healthcheck status, so Caddy may briefly proxy to a not-yet-ready
coordinator on a cold start. The coordinator returns 503 with
`Retry-After` in that window.

## Volume backup procedure

The two volumes that matter:

- `coordinator-data` -- the SQLite database (`coordinator.db`) and
  the JWKS rotation state. Lose this and you lose all sessions,
  service tokens, audit logs, and refresh-token families.
- `caddy-data` -- the ACME account key plus issued certificates.
  Losing it forces re-issuance on next start, which is fine but
  counts against Let's Encrypt rate limits (50 certs / week / domain).

To snapshot before an upgrade:

```sh
docker compose stop
docker run --rm \
  -v mcp-coordinator-new_coordinator-data:/data \
  -v "$(pwd):/backup" \
  alpine tar czf /backup/coordinator-data-$(date +%F).tar.gz -C /data .
docker compose start
```

Replace `mcp-coordinator-new_coordinator-data` with the actual volume
name printed by `docker volume ls`. Restore by reversing the tar.

## Troubleshooting

### Caddy can't provision TLS

Symptoms: Caddy logs `acme: error: ... unable to get challenge`.

Checks:

1. `dig +short coordinator.example.com` returns this host's public IP.
2. Inbound 80 reachable: `curl -v http://coordinator.example.com/`
   from outside the network -- must hit Caddy, not a captive portal
   or upstream firewall.
3. No rate-limit hit. Let's Encrypt allows 5 failures per account per
   hour. Wait, or switch to the staging endpoint by adding
   `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`
   in a `{}` global block in the Caddyfile.

### Coordinator restart loop

Symptoms: `docker compose ps` shows coordinator restarting.

Likely causes (visible in `docker compose logs coordinator`):

1. `COORDINATOR_JWT_SECRET too short / low entropy` -- generate a new
   one with `openssl rand -base64 32` and put it in `.env`.
2. `GitHub OAuth not configured` -- ensure all three GH_* env vars
   are set when `COORDINATOR_OAUTH_ENABLED=true`.
3. Database lock -- if you mounted the volume read-only by mistake.

### SSE chunks instead of streaming

Symptoms: clients see batched events with multi-second gaps.

The Caddyfile sets `flush_interval -1` on the reverse_proxy block.
If you forked the Caddyfile and removed that line, restore it. The
upstream MCP HTTP transport requires real-time SSE flushing.

## Upgrading

The image is `node:22-alpine` and the coordinator is pulled via
`npx mcp-coordinator@latest` at container start. To upgrade to a new
coordinator release:

```sh
docker compose restart coordinator
```

That re-runs `npx`, which fetches the latest published version. To
pin a specific version, edit the `command:` in docker-compose.yml.

## What this example does NOT include

- Log shipping to an external system (use Caddy's `log {}` directive
  to add a file sink, then mount a log volume and ship from there)
- Metrics export (the coordinator exposes Prometheus metrics on
  `/metrics`; scrape from another container on the `internal` network)
- Multi-node clustering (out of scope for Phase 2)
