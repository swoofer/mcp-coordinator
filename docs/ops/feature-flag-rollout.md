# Operations — `COORDINATOR_OAUTH_ENABLED` Rollout

This runbook walks through enabling Phase 2 OAuth on an existing
Phase 1 deployment, validating the cutover, and rolling back if the
smoke test fails.

References:

- `src/boot.ts:50-129` — `bootPhase2()` env validation + composition.
- `src/serve-http.ts` — runtime branch on `COORDINATOR_OAUTH_ENABLED`.
- `src/auth/entropy.ts` — `assertSecretEntropy` (≥128 bits required).
- `src/security/audit-events.ts` — `config.boot` Tier 1 reservation.
- `docs/ops/upgrade-phase1-to-phase2.md` — broader upgrade guide.
- `docs/onboarding-self-host.md` — green-field setup walkthrough.

## TL;DR

Phase 2 is feature-flagged behind `COORDINATOR_OAUTH_ENABLED`. With the
flag unset (or `false`), the v0.8.x binary behaves identically to
v0.7.0 — Phase 1 endpoints, Phase 1 JWT acceptance, no new cookies, no
new routes. Flipping the flag activates `bootPhase2()`
(`src/boot.ts:50`), which validates 5 required env vars, asserts JWT
secret entropy, runs NR12 restore detection, and starts the sweeper +
audit queue. The flip itself is a process restart with the env updated;
rollback is unsetting the env and restarting.

## Pre-flip checklist

- [ ] **OAuth app created at GitHub** with callback URL
      `${COORDINATOR_PUBLIC_URL}/auth/callback`. The hostname must
      match `COORDINATOR_PUBLIC_URL` exactly or the IdP callback
      will reject the redirect.
- [ ] **`COORDINATOR_JWT_SECRET` set to ≥32 random bytes** (≥128 bits
      of entropy). `bootPhase2()` calls
      `assertSecretEntropy(..., MIN_JWT_SECRET_BITS=128)` at
      `src/boot.ts:70` and refuses boot on weak values. Generate via:

      ```sh
      openssl rand -hex 32
      ```

- [ ] **`COORDINATOR_GITHUB_CLIENT_ID` + `COORDINATOR_GITHUB_CLIENT_SECRET`** set
      from the GitHub OAuth app you created above.
- [ ] **`COORDINATOR_GITHUB_ORG`** set to a real GitHub org login the
      operator belongs to. Users not in this org cannot log in (audit
      row `auth.login.denied.not_in_org`).
- [ ] **`COORDINATOR_PUBLIC_URL`** points to a reachable HTTPS endpoint.
      `http://` non-localhost is rejected at boot unless
      `COORDINATOR_INSECURE_COOKIES=true` is also set
      (`src/boot.ts:155-164`).
- [ ] **Backup taken**:

      ```sh
      cp data/coordinator.db backup/pre-phase2-$(date +%Y%m%dT%H%M%S).db
      ```

      See `docs/ops/backup-restore.md` for the canonical snapshot
      procedure.
- [ ] **Schema migration verified** by running the v0.8.0 binary once
      with the flag UNSET — the schema migrates to user_version=8
      without activating Phase 2 surfaces. See
      `docs/ops/upgrade-phase1-to-phase2.md`.

WARNING: do not skip the entropy check by editing
`MIN_JWT_SECRET_BITS`. Phase 2's threat model assumes the JWT secret
has ≥128 bits of effective entropy
(`docs/security/threat-model.md` Asset 1).

## Flip procedure

### 1. Set the env var

In your env-var store (Vault / AWS Secrets Manager / Kubernetes Secret
/ `.env`):

```sh
COORDINATOR_OAUTH_ENABLED=true
```

Keep all other Phase 1 env vars unchanged.

### 2. Restart the coordinator

```sh
systemctl restart mcp-coordinator    # systemd
# OR
kubectl rollout restart deploy/mcp-coordinator   # k8s
```

### 3. Confirm boot succeeded

Check the boot log for the Phase 2 activation marker and the
synchronously-written `config.boot` Tier 1 audit row:

```sh
sqlite3 data/coordinator.db <<'SQL'
.mode column
.headers on
SELECT created_at, action, outcome,
       json_extract(metadata_json, '$.public_url') AS public_url,
       json_extract(metadata_json, '$.github_org') AS github_org
FROM audit_log
WHERE action = 'config.boot'
ORDER BY created_at DESC LIMIT 1;
SQL
```

Expected: a row with `created_at` matching the restart, the
`public_url` and `github_org` you configured. This row is emitted by
`src/boot.ts:112-115`.

### 4. Probe the endpoints

```sh
curl -fsS http://localhost:8765/healthz                              # Phase 1 liveness, expect 200
curl -fsS http://localhost:8765/.well-known/oauth-authorization-server | jq .   # expect JSON metadata
```

Both must succeed. If `/.well-known/oauth-authorization-server` 404s,
the flag did NOT activate Phase 2 — re-check env vars and restart
order.

## Smoke test

### Interactive login

1. Open `https://${COORDINATOR_PUBLIC_URL}/auth/login` in a browser.
2. Expect a `302` redirect to GitHub.
3. Authorise on GitHub (must be a member of `COORDINATOR_GITHUB_ORG`).
4. Expect to land on `/auth/success`.
5. Confirm the user was provisioned with the bootstrap admin role:

   ```sh
   sqlite3 data/coordinator.db \
     "SELECT id, github_login, role FROM users
      ORDER BY created_at DESC LIMIT 1;"
   ```

   The very first user to complete the OAuth flow is auto-promoted to
   `admin` (audit row `auth.admin.bootstrapped` +
   `auth.bootstrap.admin_assigned`). Subsequent users default to
   `member`.

### Audit trail

```sh
sqlite3 data/coordinator.db <<'SQL'
SELECT created_at, action, outcome
FROM audit_log
WHERE action IN (
  'config.boot',
  'auth.login.success',
  'auth.admin.bootstrapped',
  'auth.bootstrap.admin_assigned',
  'auth.user.created'
)
ORDER BY created_at DESC LIMIT 10;
SQL
```

Expected: one `config.boot` row from step 3 + the full chain for the
first interactive login.

### Metrics scrape

```sh
curl -s http://localhost:8765/metrics/auth | grep -E \
  'coordinator_auth_login_(success|attempts)_total'
```

The Phase 2 Prometheus registry is served on a separate path
(`/metrics/auth`) — Phase 1 metrics remain on `/metrics`. See
`src/observability/metrics.ts:1-9` for the rationale.

## Rollback

If the smoke test fails or production behaviour regresses, the rollback
is **just unsetting the env var and restarting**. Phase 1 behaviour
re-engages because `src/boot.ts:51` short-circuits on
`!opts.enabled` and the runtime never composes the Phase 2 surfaces.

### 1. Unset the env var

```sh
unset COORDINATOR_OAUTH_ENABLED
# OR set it to "false" in your env-var store
```

### 2. Restart

```sh
systemctl restart mcp-coordinator
```

### 3. Verify Phase 1 has re-engaged

```sh
# Phase 2 routes inactive:
curl -i http://localhost:8765/auth/login                 # expect 404
curl -i http://localhost:8765/.well-known/oauth-authorization-server   # expect 404

# Phase 1 unaffected:
curl -fsS http://localhost:8765/healthz                  # expect 200
curl -fsS http://localhost:8765/metrics                  # expect Phase 1 Prometheus output
```

NOTE: the database schema remains at `user_version = 8` after rollback.
The new tables (`oauth_state`, `service_tokens`, `refresh_tokens`,
`audit_log`, ...) are inert — no code paths read or write them when the
flag is off. The `tests/backcompat/` suite proves this is a true
no-behaviour-change rollback.

WARNING: any sessions issued during the Phase 2 window will be
unusable after rollback (Phase 1 has no cookie-session handler). Users
must re-authenticate via the Phase 1 path. This is acceptable for a
rollback event but does mean rolling back is **disruptive** to
already-logged-in users.

## Verification checklist post-rollback

- [ ] `/auth/login` returns 404.
- [ ] `/auth/callback` returns 404.
- [ ] `/.well-known/oauth-authorization-server` returns 404.
- [ ] `/healthz` returns 200.
- [ ] `/metrics` continues to expose Phase 1 metrics.
- [ ] `/api/announce` and other Phase 1 endpoints accept Phase 1 JWTs.
- [ ] No new `config.boot` rows in `audit_log` since the rollback.
- [ ] No `coordinator_*` Phase 2 metric series in the Prometheus
      registry (`/metrics/auth` returns 404 when Phase 2 is off).

## Failure modes

- **Entropy assertion failure on flip**: `bootPhase2()` throws
  `BootValidationError: COORDINATOR_JWT_SECRET has insufficient
  entropy`. Regenerate with `openssl rand -hex 32` and restart.

- **`COORDINATOR_PUBLIC_URL` validation failure**: `http://` non-
  localhost requires `COORDINATOR_INSECURE_COOKIES=true`. The
  validation lives at `src/boot.ts:141-165`.

- **NR12 restore-detection refusal**: if the DB was restored from an
  old backup and `audit_log` is > 5 min stale, boot refuses with a
  message instructing to set `COORDINATOR_ALLOW_RESTORE=true`. See
  `docs/ops/backup-restore.md`.

- **First-user race**: if two users complete the OAuth flow within
  the same second, only one is promoted to admin (the SQL is keyed on
  `role = 'admin' NOT EXISTS`). The losing user is provisioned as a
  member; promote them manually if needed (see
  `docs/ops/access-review.md`).
