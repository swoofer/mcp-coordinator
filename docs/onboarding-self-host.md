# Self-host setup walkthrough (Phase 2)

This guide walks you from zero to a running Phase 2 coordinator with GitHub
OAuth. It assumes you are deploying `mcp-coordinator` v0.8.0 or later as a
single-instance self-hosted service.

If you are upgrading an existing v0.7.x deployment, read
`docs/ops/upgrade-phase1-to-phase2.md` first -- the migration is
non-destructive but you should understand the column renames before flipping
the Phase 2 flag.

References:

- `.env.example` -- full environment-variable reference
- `docs/security/threat-model.md` -- STRIDE-by-asset analysis
- `docs/ops/key-rotation.md` -- JWT signing key rotation
- `docs/ops/upgrade-phase1-to-phase2.md` -- v0.7.0 -> v0.8.0 migration
- CHANGELOG v0.8.0 -- shipped surface area

## Outcome

After completing this guide you will have:

1. A running coordinator listening on `${COORDINATOR_PUBLIC_URL}`
2. A GitHub OAuth app wired to the coordinator's callback URL
3. A bootstrap admin user (you)
4. Working `/healthz`, `/health/ready`, and `/api/auth/me` endpoints
5. Phase 1 endpoints (threads, sessions, MQTT, MCP) still operational

## Prerequisites

- **Node.js >=20** (the codebase uses `AbortSignal.timeout`, `crypto.timingSafeEqual`,
  and other Node 20+ primitives; older versions will not boot)
- **A GitHub organization** (free tier is fine; the read:org scope works
  on any plan)
- **A public hostname** for production OR a localhost URL for development
- **TLS termination** for any non-localhost deployment (nginx, Caddy,
  Cloudflare Tunnel, etc.)

### OS-specific notes

The coordinator is pure Node and runs anywhere Node 20+ runs.

- **Linux / macOS**: install Node via `nvm` or your package manager. SQLite
  is bundled (`better-sqlite3` native module). The DB file is `chmod 0600`
  on POSIX (v0.7.0 behavior preserved).
- **Windows (native)**: install Node via the installer or Chocolatey. The
  POSIX chmod is skipped silently -- secure the data directory via NTFS
  ACLs instead.
- **Windows (Docker)**: see the `Dockerfile` at the repo root. The image
  runs Node 20 on Debian slim; mount `./data` as a volume.

## 1. Install

```bash
npm install -g mcp-coordinator@latest
mcp-coordinator --version    # should print 0.8.0 or later
```

Alternatively, run from a checkout:

```bash
git clone https://github.com/swoofer/mcp-coordinator.git
cd mcp-coordinator
npm ci
npm run build
node dist/cli.js --version
```

## 2. Create the GitHub OAuth app

Visit https://github.com/settings/applications/new (for a personal app) or
`https://github.com/organizations/${YOUR_ORG}/settings/applications/new`
(for an org-owned app -- recommended in production).

Fill in:

- **Application name**: `mcp-coordinator (self-hosted)` or similar
- **Homepage URL**: your `COORDINATOR_PUBLIC_URL` (e.g.
  `https://coordinator.example.com`)
- **Authorization callback URL**:
  `${COORDINATOR_PUBLIC_URL}/api/auth/oauth/callback`
- **Enable Device Flow**: check this box if you intend to support
  `mcp-coordinator login` from headless / CI environments
  (RFC 8628 device flow via `POST /api/auth/oauth/device_authorization`)

After creation:

1. Copy the **Client ID**
2. Click **Generate a new client secret**, then copy the secret immediately
   (GitHub displays it once)

Required GitHub OAuth scopes (the coordinator requests these automatically):

- `read:user` -- profile info for IdpUserInfo
- `user:email` -- primary verified email
- `read:org` -- list of org memberships for allowlist enforcement

## 3. Configure environment

Copy the template:

```bash
cp .env.example .env
```

Edit `.env` and set, at minimum:

```
COORDINATOR_OAUTH_ENABLED=true
COORDINATOR_PUBLIC_URL=https://coordinator.example.com
COORDINATOR_JWT_SECRET=<paste output of: openssl rand -base64 32>
COORDINATOR_GITHUB_CLIENT_ID=<from step 2>
COORDINATOR_GITHUB_CLIENT_SECRET=<from step 2>
COORDINATOR_GITHUB_ORG=<your-org-login>
```

Optional but recommended for production:

```
COORDINATOR_AUDIT_RETENTION_DAYS=365          # SOC 2 alignment
COORDINATOR_AUDIT_TIER2_RETENTION_DAYS=90
COORDINATOR_REFRESH_RETENTION_DAYS=180
COORDINATOR_SESSION_IDLE_TIMEOUT=15m          # for regulated workloads
COORDINATOR_METRICS_BEARER=<paste output of: openssl rand -hex 32>
```

### JWT secret entropy

The boot path runs an entropy check on `COORDINATOR_JWT_SECRET`:

- Length must be >=32 bytes
- Rejects all-same-byte strings (e.g. `aaaa...`)
- Rejects dictionary words (e.g. `password`, `secret`)
- Rejects strings whose Shannon entropy is below the threshold

Always generate via a cryptographic RNG. `openssl rand -base64 32` and
`head -c 32 /dev/urandom | base64` both work.

### HTTPS expectation

The coordinator refuses to set the `Secure` flag on session cookies over
plain HTTP. For local development with `http://localhost`, this is fine
(loopback is treated as secure). For any other `http://` host, you must
set `COORDINATOR_INSECURE_COOKIES=true` -- but the strong recommendation
is to put a TLS-terminating reverse proxy in front instead.

## 4. First boot

```bash
mcp-coordinator server start
```

On first boot the coordinator:

1. **Validates env** -- missing required Phase 2 vars cause an explicit
   refusal with the offending variable named (T29)
2. **Derives keys via HKDF-SHA256** -- domain-separated subkeys for JWT
   signing, CSRF tokens, identifier hashing, and HMAC binding (T08b)
3. **Runs schema migration** -- v7 -> v8 column renames + new tables,
   idempotent so subsequent boots are no-ops (T01a)
4. **NR12 restore detection** -- if `audit_log` timestamps lag wall-clock
   by more than 5 minutes the boot refuses unless `COORDINATOR_ALLOW_RESTORE=true`
   (then bumps the global `token_epoch`)
5. **Starts the sweeper** -- 60s cadence over 6 retention tables (T28)
6. **Opens the HTTP server** -- on `PORT` (default 3100)
7. **Logs `Phase 2 boot: enabled`** at INFO level

Watch the log for:

```
INFO  Phase 2 boot: enabled
INFO  config.boot tier=1 outcome=ok
INFO  HTTP listening on :3100
INFO  sweeper started cadence=60s
```

The `config.boot` row is a Tier 1 audit entry. You can verify:

```sql
SELECT action, tier, outcome, ts FROM audit_log
WHERE action = 'config.boot'
ORDER BY ts DESC LIMIT 1;
```

## 5. Bootstrap admin

The FIRST user to sign in via OAuth automatically becomes admin (T16b
atomic check -- concurrent first-time logins resolve to exactly one
admin per V4 FIX 24).

1. Browse to `${COORDINATOR_PUBLIC_URL}/auth/login`
2. Click "Authorize on GitHub" and approve the requested scopes
3. Land on `/auth/success` with a session cookie set

Verify your role:

```sql
SELECT id, idp_provider, role FROM users;
-- expect exactly one row with role = 'admin'
```

Or via API (the cookie set by the OAuth callback is read by Scenario 5
in `authenticateRequest`):

```bash
curl --cookie "__Host-coordinator_session=<copy from devtools>" \
  https://coordinator.example.com/api/auth/me
# {"user_id": "...", "org": "...", "role": "admin", ...}
```

Subsequent users become `role = 'member'` until an admin promotes them:

```sql
UPDATE users SET role = 'admin' WHERE id = ?;
```

## 6. Verify

Three checks confirm the deployment is healthy:

```bash
# Liveness probe (always 200 if the process is up)
curl -i https://coordinator.example.com/healthz

# Readiness probe (200 only when DB + sweeper + audit queue are healthy)
curl -i https://coordinator.example.com/health/ready

# Userinfo (200 with your user record, 401 without a valid session)
curl -i --cookie "<session-cookie>" \
  https://coordinator.example.com/api/auth/me
```

`/health/ready` returns 503 when any of the following is true:

- The sweeper circuit-breaker is open (>=5 consecutive errors)
- The Tier 2 audit queue depth is >80% of the 10K cap
- The SQLite DB is unreachable
- The server is draining (SIGTERM received)

## Common gotchas

### "HTTP vs HTTPS" -- Secure cookies refused

Symptom: `/auth/login` works but `/api/auth/me` returns 401 with no cookie
in the request.

Cause: the browser dropped the `__Host-coordinator_session` cookie because
the `Secure` flag is set but the connection is `http://`.

Fix: put TLS in front (recommended), or for local dev set
`COORDINATOR_INSECURE_COOKIES=true` AND use `localhost` as the public URL.

### Weak JWT secret rejected at boot

Symptom: boot exits with `COORDINATOR_JWT_SECRET fails entropy validation`.

Cause: the value is too short, too repetitive, or contains a dictionary word.

Fix: regenerate via `openssl rand -base64 32`. The check exists because
HS256 JWTs are only as strong as the secret -- low-entropy secrets are
brute-forceable offline.

### GitHub org membership not visible

Symptom: OAuth succeeds but `/api/auth/me` returns 403 with
`{"error": "org_membership_required"}`.

Cause: your GitHub org membership is set to "Private" in
`github.com/settings/organizations`, and the `read:org` scope did not pick
it up.

Fix: set membership visibility to "Public" for that org, OR ensure the
OAuth authorization screen granted `read:org` (re-authorize if needed).

### `/auth/login` returning 429

Symptom: too many login attempts trigger
`{"error": "rate_limit_exceeded"}` with 429.

Cause: the per-IP login rate limit (30/min). Mostly hit by automated bots
probing the endpoint.

Fix: investigate the source via:

```sql
SELECT actor_ip, COUNT(*) FROM audit_log
WHERE action = 'auth.login.attempt' AND ts > strftime('%s','now') - 3600
GROUP BY actor_ip ORDER BY 2 DESC LIMIT 20;
```

The limit is intentional and tuned to interactive humans.

### Bootstrap admin "stuck" as member

Symptom: you sign in expecting `admin` but `/api/auth/me` reports `member`.

Cause: another user signed in before you (race), claiming the bootstrap.

Fix: promote via SQL:

```sql
UPDATE users SET role = 'admin' WHERE id = '<your_user_id>';
```

There is only ONE bootstrap admin per deployment. All subsequent users
land as `member` regardless of order.

### Restore-from-backup boot refused

Symptom: after restoring `data/coordinator.db` from backup, the coordinator
refuses to start with `restore detected; set COORDINATOR_ALLOW_RESTORE=true`.

Cause: NR12 protection. The restored DB may be a fork from the cluster's
audit timeline, and refresh tokens issued post-restore would otherwise be
indistinguishable from live ones.

Fix: set `COORDINATOR_ALLOW_RESTORE=true`, boot ONCE (which bumps the
global `token_epoch` and invalidates every refresh token in circulation),
then unset the variable before the next boot.

## Docker / Kubernetes

A reference `Dockerfile` and `docker-compose.yml` ship at the repo root.
Mount `./data` as a volume so the SQLite DB survives container restarts:

```yaml
services:
  coordinator:
    image: mcp-coordinator:0.8.0
    env_file: .env
    ports: ["3100:3100"]
    volumes:
      - ./data:/app/data
```

Production Kubernetes manifests (StatefulSet + PersistentVolumeClaim +
Ingress) are deferred to a follow-up release; the `examples/` directory
ships them when available.

## Service tokens for CI

For non-interactive callers (CI, deploy bots, monitoring), issue a long-lived
service token instead of using OAuth:

```bash
mcp-coordinator service-token issue \
  --user <admin_user_id> \
  --org <org_id> \
  --scope read \
  --ttl 30d \
  --reason "GitHub Actions CI -- deploy.yml"
```

The 90-day TTL ceiling is hardcoded (V4 §5.5). Reason field requires >=10
characters and is preserved in the audit trail. Service tokens are
DB-verified on every request (admin force-revoke takes effect immediately,
overriding the §9.5 trust-signature path).

## Backup

Daily snapshots of `data/coordinator.db` are sufficient for disaster recovery:

```bash
cp data/coordinator.db backup/coordinator-$(date +%F).db
```

Restore procedure: stop the coordinator, copy the backup over the live
file, set `COORDINATOR_ALLOW_RESTORE=true`, start, then unset the variable
before the next restart. See "Restore-from-backup boot refused" above.

## Next steps

- Read `docs/security/threat-model.md` to understand the STRIDE coverage
- Scrape `/metrics/auth` with Prometheus (29 auth metrics catalogued in
  the CHANGELOG observability section)
- Configure `pino` log shipping -- the codebase has 16 redact paths
  pre-configured (V4 §11.3) so credentials never reach stdout
- Plan the v0.9.0 upgrade -- the deferred items list in CHANGELOG v0.8.0
  shows what is coming
