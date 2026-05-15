# nginx reverse-proxy example

For operators who already run nginx and want to add mcp-coordinator
behind it rather than introducing Caddy or another front-end. The
provided `nginx.conf` is a single `server {}` block plus an HTTP-to-
HTTPS redirect; drop it into `conf.d/` or `sites-available/` and
adapt the certificate paths and `server_name`.

The coordinator itself runs unchanged on `127.0.0.1:3000` (or wherever
your systemd unit / Docker run command binds it). nginx terminates
TLS, forwards everything, and handles the WebSocket upgrade for the
MQTT bridge path.

## Install

```sh
sudo cp nginx.conf /etc/nginx/conf.d/coordinator.conf
# edit server_name and ssl_certificate paths
sudo nginx -t          # syntax check; must pass before reload
sudo nginx -s reload   # apply without dropping connections
```

The `nginx -t` check fails if the certificate files don't exist or
the syntax is invalid. Always run it before `-s reload`.

## What each block does

### `listen 443 ssl http2;`

HTTP/2 over TLS. The coordinator's static assets are small enough
that HTTP/2 multiplexing matters less than for general sites, but
it's free with this directive and helps the dashboard's many small
fetches.

### `proxy_set_header X-Forwarded-*`

Forwards the client IP and original scheme to the coordinator. This
is conventional but see the known limitation below regarding
rate-limiter scope.

### `proxy_buffering off;`

CRITICAL for Server-Sent Events. The MCP HTTP transport uses SSE for
streaming tool responses; if nginx buffers, clients see batched
events arrive in chunks instead of streaming, and long-running tools
will hit `proxy_read_timeout` before the first byte reaches the
client. Without this directive the coordinator's MCP HTTP transport
will appear broken.

### `proxy_read_timeout 1d; proxy_send_timeout 1d;`

SSE connections are long-lived by design. The coordinator sends
periodic keepalive comments, but the connection itself stays open
for the duration of a session. 24 h is generous; tune downward only
if you have a specific reason.

### `location /mqtt`

The MQTT-over-WebSocket bridge requires the standard nginx WebSocket
upgrade dance: `proxy_http_version 1.1`, `Upgrade` and `Connection`
headers passthrough. Without these, the WebSocket handshake fails
with HTTP 400 and the bridge silently can't connect.

### `proxy_cookie_path / /;` and `proxy_pass_request_headers on;`

Ensures the `__Host-coordinator_session` cookie (and the CSRF
double-submit cookie) round-trip untouched. The `__Host-` prefix
requires Secure + no Domain attribute + Path=/, all of which the
coordinator already emits; nginx must not rewrite them.

## Known limitation: X-Forwarded-For and rate-limiting

The coordinator's per-IP rate limiter currently keys on
`req.socket.remoteAddress`. When nginx sits in front, that value is
always `127.0.0.1` (the local nginx side of the loopback connection),
so per-IP rate limits effectively become a single shared bucket
across all clients.

We forward `X-Forwarded-For` from this config for forward
compatibility, but the coordinator does not yet honor it for the
rate-limit key. Until that refactor lands, you have two options:

1. Accept the limitation. The rate limiter still protects against a
   single abusive process running on the coordinator host, just not
   against a remote attacker brute-forcing through nginx.
2. Move the rate-limiting to nginx itself with `limit_req_zone` /
   `limit_req`. This is the recommended workaround for production.
   Example:

   ```nginx
   limit_req_zone $binary_remote_addr zone=coordinator_rl:10m rate=20r/s;
   # then in `location /`:
   limit_req zone=coordinator_rl burst=40 nodelay;
   ```

   Tune `rate` and `burst` to taste; the coordinator's own limits
   (in `src/auth/rate-limit.ts`) are tighter on auth endpoints than
   on the general MCP traffic.

This will be revisited in a future release that teaches the
coordinator to honor a trusted-proxy chain and pull the real client
IP from the X-Forwarded-For tail.

## Testing the config

```sh
# After editing the server_name and cert paths:
sudo nginx -t

# Should print:
#   nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
#   nginx: configuration file /etc/nginx/nginx.conf test is successful

# Reload (zero downtime):
sudo nginx -s reload

# End-to-end smoke test:
curl -sS https://coordinator.example.com/healthz
# Should print: ok

# SSE check (depends on having a valid auth cookie):
curl -N --cookie "..." https://coordinator.example.com/mcp/sse
# Should stream `event:` and `data:` lines in real time, not in a
# single batched chunk.
```

## What this example does NOT include

- TLS certificate provisioning. Use certbot, acme.sh, or your
  organisation's existing PKI. nginx itself doesn't do ACME.
- HTTP/3 (QUIC) listener. Add `listen 443 quic;` once you have a
  recent nginx with the QUIC module and an `Alt-Svc` advertisement
  scheme worked out.
- Load balancing multiple coordinator instances. Phase 2 ships a
  single-node coordinator; multi-node is later.
