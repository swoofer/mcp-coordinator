# README block — Docker

> Drop this section into `README.md` under a top-level `## Docker` heading
> (or merge into an existing "Deployment" section). Do not commit it as a
> standalone file once the README is updated.

## Docker

`mcp-coordinator` ships a production-ready multi-stage `Dockerfile` (alpine
based, ~150MB final image, runs as non-root uid 1001) and an example
`docker-compose.yml` for single-node deployments.

### Quick start (compose)

```bash
# Build and run with the bundled compose file
docker compose up -d

# Tail logs
docker compose logs -f coordinator

# Health check (the image's HEALTHCHECK hits this endpoint every 30s)
curl http://localhost:3100/health
# -> {"status":"ok","version":"0.3.0"}

# Stop (keep the volume)
docker compose down

# Stop and wipe SQLite + config
docker compose down -v
```

The dashboard is served at <http://localhost:3100/dashboard>, MCP at
`POST http://localhost:3100/mcp`, and the embedded MQTT broker at
`mqtt://localhost:1883`.

### Build the image manually

```bash
docker build -t mcp-coordinator:local .

docker run -d \
  --name mcp-coordinator \
  -p 3100:3100 \
  -p 1883:1883 \
  -v mcp-coordinator-data:/data \
  -e COORDINATOR_BIND=0.0.0.0 \
  --restart unless-stopped \
  mcp-coordinator:local
```

### Persistent data

The image declares `VOLUME /data` and points `COORDINATOR_DATA_DIR` at
`/data/data`. SQLite (`coordinator.db`) and the registration files live
there. Mount a named volume (recommended) or a host path:

```yaml
volumes:
  - mcp-coordinator-data:/data        # named volume (compose default)
  # - /srv/coordinator/data:/data     # bind mount — chown to uid 1001:1001
```

### Production hardening

The defaults are safe for a private network. Before exposing the
coordinator to untrusted traffic:

1. **Terminate TLS at a reverse proxy** (Caddy, Traefik, nginx). The
   coordinator speaks plain HTTP — never publish port `3100` directly.
2. **Enable JWT auth** by setting these env vars (see
   `docker-compose.yml` for the commented block):

   ```bash
   COORDINATOR_AUTH_ENABLED=true
   COORDINATOR_JWT_SECRET=<32+ char random string>
   COORDINATOR_REGISTRATION_SECRET=<shared secret for agent enrollment>
   COORDINATOR_ADMIN_SECRET=<shared secret for admin enrollment>
   COORDINATOR_JWT_EXPIRY=24h
   ```

   When auth is on, MQTT `CONNECT` also requires a JWT in the password
   field — anonymous MQTT clients are rejected.
3. **Restrict the MQTT port** (`1883`). Either keep it on a private
   network or front it with a TLS-terminating proxy (mqtts://).
4. **Pin a published image** instead of building from source by
   uncommenting `image:` and commenting out `build:` in
   `docker-compose.yml`.

### Health probe

The `Dockerfile` ships a `HEALTHCHECK` that probes
`http://127.0.0.1:3100/health` every 30s. Docker / Kubernetes report the
container as `unhealthy` after 3 consecutive failures (~90s). For
Kubernetes, prefer a native `livenessProbe` / `readinessProbe` against the
same endpoint and remove the Docker-level check via `--no-healthcheck`.
