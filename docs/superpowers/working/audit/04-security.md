# Security Audit — mcp-coordinator

**Score: 4/10** — Adequate for the documented localhost threat model, but multiple sharp edges become critical the moment teams follow the README's own "shared LAN" path.

## Concrete concerns

### 1. MQTT broker has zero authentication or authorization (CRITICAL)
`src/mqtt-broker.ts` instantiates Aedes with no `authenticate`, `authorizePublish`, `authorizeSubscribe`, or `authorizeForward` handler. Grep returned **zero matches** for any of these in the broker file. Any TCP client that can reach port 1883 can connect with arbitrary `client_id`, subscribe to `coordinator/#` (reading every announce, every thread, every agent ID), and publish forged `coordinator/consultations/.../messages` to spoof posts from other agents. The README itself documents `COORDINATOR_BIND=0.0.0.0` for "Team setup" (README line 316) — the moment a user follows that, the broker is fully open on the LAN.

### 2. JWT auth does NOT cover the MQTT WebSocket transport
`startEmbeddedMqttBroker` is registered as a generic HTTP `upgrade` handler (`mqtt-broker.ts:100-105`) on the same HTTP server that gates `/mcp` and `/api/*` with `authenticateRequest`. The upgrade path bypasses that gate entirely — there is no JWT check before `wss.handleUpgrade()`. README claims the WS path is "firewall-friendly" but never warns it's an unauthenticated bridge straight to the broker, even when `COORDINATOR_AUTH_ENABLED=true`.

### 3. Registration secret is logged with client IP on every failure
`serve-http.ts:524`: `authLog.warn({ agent_name, ip: req.socket.remoteAddress }, "Invalid registration secret")`. While the secret value itself isn't logged, repeated `agent_name` + IP attempts allow an attacker to brute-force the shared secret offline (no rate limiting — see #4) and the daemon log at `~/.mcp-coordinator/logs/server.log` becomes a high-value target. README also instructs users to share `REGISTRATION_SECRET` "via team channel" (README line 470) with no mention of rotation.

### 4. No rate limiting anywhere — auth endpoints are brute-forceable
Grep for `rate.?limit|throttle|max.?conn` across `src/` returned only matches in `quota-cache.ts` (the *outbound* Anthropic 429 handler). `/api/auth/register` accepts unlimited POSTs against `safeEqual(registration_secret, REGISTRATION_SECRET)` — `timingSafeEqual` prevents timing leaks but does nothing against a 10k-req/sec dictionary attack. Same for the MQTT TCP socket: an attacker can open thousands of sockets and exhaust file descriptors.

### 5. No input validation on `announce_work` payloads
`serve-http.ts:146-149` destructures `target_files`, `depends_on_files` directly into the consultation engine and SQLite without checking type, length, or count. An authenticated agent (or anyone on an unauthenticated deploy) can send `target_files: [<10MB string>]` or 100k entries — these get JSON-stringified into the `threads` table, broadcast over MQTT, and re-parsed by every connected agent. This is a trivial DoS amplifier and a memory-pressure attack vector.

### 6. Self-host = self-secure with no hardening guidance
SECURITY.md says "not designed to be exposed to the public internet" but README walks the user through *exactly that* (`COORDINATOR_BIND=0.0.0.0`, "front the server with TLS via nginx/Caddy"). No mTLS option, no IP allowlist, no fail2ban hint, no `aedes` auth example. Users will deploy this on cloud VMs.

### 7. Aedes 1.x dependency surface unaudited
`package.json` pins `aedes: ^1.0.2`. No `npm audit` evidence in repo, no SBOM, no Dependabot config visible. Aedes' history includes DoS-class CVEs in MQTT packet parsers — caret range will pull future minors but a pinned audit baseline is missing.

### 8. No security audit log
SQLite has a `revoked_agents` table but no `auth_events` / `security_log`. Failed auths only hit the rotating Pino log. No record of who registered when, no token issuance trail, no session-open audit trail beyond `mcpLog.info`.

## Hardening recommendations

1. **Wire Aedes auth handlers to the same JWT** — implement `broker.authenticate = (client, username, password, cb) => verifyToken(password.toString())` and gate the WS upgrade on `Authorization` header before `wss.handleUpgrade`. Without this, JWT on `/mcp` is security theater.
2. **Add rate limiting + payload caps** — `express-rate-limit`-equivalent on `/api/auth/*` (5 req/min/IP), and a `MAX_TARGET_FILES=100` / `MAX_FIELD_LEN=4096` validator before `consultation.announceWork()`. Reject early with 413/422.
3. **Default-deny network exposure** — refuse to start when `COORDINATOR_BIND=0.0.0.0` AND `COORDINATOR_AUTH_ENABLED!=true`, AND add a startup warning when MQTT TCP port is reachable on a non-loopback interface. Ship a `dependency-review.yml` GitHub Action and pin Aedes to an exact version with documented CVE review.

DONE — `C:\Users\gagno\projet\mcp-coordinator-new\docs\superpowers\working\audit\04-security.md`
