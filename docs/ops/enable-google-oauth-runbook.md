# Operations — Enabling Google sign-in (Phase 2 OAuth)

Set up "Sign in with Google" for humans (web UI) plus agent/service-token
issuance, on either a fresh Phase 2 deployment or an existing GitHub one.
GitHub is **not** required — a Google-only deployment is fully supported.

This is a task-focused quick start. For deeper reference see:

- [`idp-providers.md`](../idp-providers.md) — per-provider details (Google `hd` allowlist, id_token verification).
- [`../onboarding-self-host.md`](../onboarding-self-host.md) — first-time Phase 2 bring-up (admin bootstrap, cookies, entropy).
- [`feature-flag-rollout.md`](./feature-flag-rollout.md) — `COORDINATOR_OAUTH_ENABLED` rollout.
- [`upgrade-phase1-to-phase2.md`](./upgrade-phase1-to-phase2.md) — migrating an existing Phase 1 JWT deployment.

---

## 0. Prerequisites & decisions

| Item | Notes |
|---|---|
| **Google Workspace vs personal Gmail** | The allowlist matches the Workspace hosted-domain (`hd`) claim. Personal `@gmail.com` accounts have no `hd` and are **denied**. Google sign-in requires a Google Workspace domain. |
| **Runtime: Node, not Bun** | Phase 2 is hard-disabled on the Bun runtime. Run the **Node** build (Docker image `node:22-alpine`, or `npm`), not a Bun release binary. |
| **JWT secret entropy** | `COORDINATOR_JWT_SECRET` must have ≥128 bits of entropy or Phase 2 refuses to boot. Generate with `openssl rand -base64 32`. |
| **Public HTTPS** | `COORDINATOR_PUBLIC_URL` must be `https://` (session cookies are `__Host-`, always `Secure`). Terminate TLS at a reverse proxy; never expose port 3100 directly. |

---

## 1. Create the Google OAuth client (GCP)

1. **Google Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID.**
2. Configure the **OAuth consent screen** first:
   - **Internal** if every user is in the same Workspace (recommended — no Google review).
   - **External** otherwise (requires publishing / test users).
   - Scopes: nothing to add — the coordinator requests `openid email profile` (non-sensitive).
3. **Application type: `Web application`.**
4. **Authorized redirect URIs** — exactly:
   ```
   https://coordinator.example.com/api/auth/oauth/callback
   ```
   (`${COORDINATOR_PUBLIC_URL}/api/auth/oauth/callback` — shared across all IdPs)
5. Copy the **Client ID** and **Client Secret**.

---

## 2. Configure the environment

Minimal Google-only Phase 2 config (secrets via your secret manager, never committed):

```bash
COORDINATOR_OAUTH_ENABLED=true
COORDINATOR_PUBLIC_URL=https://coordinator.example.com
COORDINATOR_JWT_SECRET=<openssl rand -base64 32>          # >=128 bits entropy

# Google (both required together)
COORDINATOR_GOOGLE_CLIENT_ID=<from step 1>
COORDINATOR_GOOGLE_CLIENT_SECRET=<from step 1>

# Workspace-domain allowlist bootstrap: seeds an orgs row on
# allowlist_idp_org_id so the FIRST Google sign-in can match an org and
# become admin. No manual SQL needed.
COORDINATOR_GOOGLE_WORKSPACE_DOMAIN=example.com

# Recommended in production: encrypt IdP tokens at rest (else stored plaintext
# + ERROR log at boot). Must differ from the JWT secret.
COORDINATOR_ENCRYPTION_KEY=<openssl rand -base64 32>
```

Notes:
- **No GitHub credentials required.** At least one IdP provider must be configured; Google alone satisfies that. Boot fails closed with a clear error if none is set.
- `COORDINATOR_GOOGLE_WORKSPACE_DOMAIN` set without Google configured is a fail-closed boot error.
- Phase 1 JWT (`COORDINATOR_AUTH_ENABLED`) and Phase 2 can coexist — leave existing Phase 1 agent tokens working during a transition. See `upgrade-phase1-to-phase2.md`.
- Env vars are visible to `docker inspect`; pass secrets via a Docker/Kubernetes secret.

---

## 3. Deploy & persist state

- Run the Node image; expose `3100` (HTTP: MCP + REST + SSE + dashboard) and `1883` (MQTT TCP) behind your reverse proxy.
- **The `/data` volume must be persistent** — it holds `coordinator.db` (`+ -wal`/`-shm`) with all users, orgs, refresh tokens and sessions. Losing it loses all accounts. Writable by UID 1001.
- On first boot the schema migrates automatically (idempotent). If you're upgrading an existing Phase 1 deployment, follow `upgrade-phase1-to-phase2.md` (back up `coordinator.db` first).

---

## 4. Verify

```bash
mcp-coordinator doctor --phase2
```
Runs 8 probes (public URL, discovery doc, sqlite, JWT entropy, audit queue, sweeper, …). Note: `doctor --phase2` validates GitHub creds only; it does not probe Google creds — verify Google via a real sign-in below.

1. **Human login:** open `https://coordinator.example.com/auth/login`. With only Google configured this redirects straight to Google (no picker). Sign in → session cookie set.
2. **First admin:** the first OAuth sign-in becomes admin atomically. Confirm:
   ```sql
   SELECT id, email, role FROM users WHERE role = 'admin';   -- one row
   ```
   and `GET /api/auth/me` with the session cookie.
3. **Admin UI:** `https://coordinator.example.com/dashboard/admin.html` (session cookie + `role='admin'`).

---

## 5. Issue agent / service tokens

Once you have an admin, mint a long-lived service token for agents/runners:

```bash
mcp-coordinator service-token issue \
  --server https://coordinator.example.com \
  --admin-token "$COORDINATOR_ADMIN_TOKEN" \
  --user  <user-id> \
  --org   <org-id> \
  --scope write \
  --ttl   30d \
  --reason "production runner"
```
- Prints `jti`, `access_token`, `expires_at`. **The token is shown once.**
- `list` / `revoke --jti <jti>` to manage them.
- The CLI's default `--server` is `http://localhost:3000` — always pass the real URL.

---

## Environment reference (Phase 2 + Google)

| Variable | Role | Default |
|---|---|---|
| `COORDINATOR_OAUTH_ENABLED` | Phase 2 master switch | `false` |
| `COORDINATOR_PUBLIC_URL` | JWT issuer + OAuth redirect_uri + cookie scope (https) | — (required) |
| `COORDINATOR_JWT_SECRET` | Signing secret (≥128 bits entropy) | — (required) |
| `COORDINATOR_GOOGLE_CLIENT_ID` / `_SECRET` | Google provider (both together) | — |
| `COORDINATOR_GOOGLE_WORKSPACE_DOMAIN` | Seeds `orgs.allowlist_idp_org_id` for the first Google admin | — |
| `COORDINATOR_GITHUB_CLIENT_ID` / `_SECRET` / `_ORG` | GitHub provider — optional; ORG required only if the App is configured | — |
| `COORDINATOR_ENCRYPTION_KEY` | Encrypt IdP tokens at rest (≠ JWT secret) | — (plaintext otherwise) |

Full annotated reference: [`.env.example`](../../.env.example).
