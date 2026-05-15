# Incident response — compromised `COORDINATOR_JWT_SECRET`

This runbook covers detection, containment, eradication, recovery, and
forensics for a compromise of `COORDINATOR_JWT_SECRET`. The signing key
is the highest-value secret in the Phase 2 deployment: a holder can
forge access tokens for any user, any org, any scope, until the secret
is rotated and every issued token is invalidated.

Use this runbook when:

- The secret appears in a git commit, a CI log, a paste site, a
  Slack channel, an issue tracker, a public deployment manifest, or
  any other place outside the operator's secret manager.
- The container image, the host filesystem, or the env-var store is
  known or suspected to have been read by an unauthorised party.
- `auth.invalid_token` Tier 2 rates spike with reasons that suggest
  forged-rather-than-stale tokens (e.g., valid signature but
  unrecognised `jti`).
- A departing operator's access to the env-var store was not revoked
  before they left.

References:

- `docs/ops/key-rotation.md` — rotation mechanics (this runbook is its
  emergency invocation).
- `docs/ops/incident-refresh-leak.md` — refresh-token leak runbook;
  often co-occurs.
- `docs/security/threat-model.md` — Asset 1 (JWT signing key),
  residual risk #6.
- `src/auth/token-epoch.ts` — `bumpTokenEpochAllUsers`.
- `src/security/audit-events.ts` — Tier 1 audit events.
- `src/boot.ts` — env-var load + entropy assertion.

## 1. Detection

### Direct disclosure

The most common trigger is a human report: "I found the secret in
$LOCATION." Treat every such report as a confirmed leak until proven
otherwise — secrets do not unleak, and the cost of an unneeded
rotation is low compared to the cost of a missed real one.

### `auth.invalid_token` anomalies

```sql
SELECT strftime('%Y-%m-%d %H:00', occurred_at, 'unixepoch') AS hour,
       COUNT(*) AS invalid_tokens,
       COUNT(DISTINCT json_extract(meta_json, '$.ip')) AS distinct_ips
  FROM audit_log
 WHERE action = 'auth.invalid_token'
   AND occurred_at >= strftime('%s','now') - 7*86400
 GROUP BY hour
 ORDER BY hour DESC;
```

A baseline of 1-10 per hour is normal (stale browser tabs, clock
skew). A sustained spike with high distinct-IP diversity is unusual.

### Out-of-band signal

- Anthropic, GitHub, or another upstream notifies you of credential
  exposure.
- A monitoring tool (truffleHog, gitleaks) fires on the operator's
  repos or CI logs.
- A penetration test report identifies leakage paths.

## 2. Containment (immediate — minutes)

The objective is to make the leaked secret useless **right now**.
Containment has two pieces: rotate the signing key, and invalidate
every JWT minted under the old key.

### Step 2.1 — Rotate the secret

Follow the **Emergency rotation** path in `docs/ops/key-rotation.md`:

```sh
NEW_SECRET="$(openssl rand -base64 32)"
# update the env-var store with the new value
```

Do **not** simply restart and hope. The coordinator must boot with
the new value, and every user must be forced off the old key.

### Step 2.2 — Global epoch bump (before restart, if practical)

If you can SQL the database before restart, bump every user's
`token_epoch`. Any JWT minted with the old key has an older epoch
and is rejected immediately:

```sql
UPDATE users
   SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1);
```

This is the same operation `bumpTokenEpochAllUsers` (`src/auth/token-epoch.ts`)
performs. Emit the Tier 1 audit row to record it:

```sql
INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
VALUES (
  'recovery.token_epoch_global_bump',
  'ops:signing-key-leak',
  'system',
  '{"reason":"jwt_secret_leak","trigger":"manual","incident":"<ticket-id>"}',
  strftime('%s','now')
);
```

The `recovery.token_epoch_global_bump` event is reserved in
`src/security/audit-events.ts` line 30 specifically for this scenario.

### Step 2.3 — Restart the coordinator with the new secret

```sh
systemctl restart mcp-coordinator           # systemd
# or
docker compose restart coordinator          # docker compose
# or
kubectl rollout restart deployment/mcp-coordinator
```

Boot will:

1. Read `COORDINATOR_JWT_SECRET` (now the new value).
2. Run `assertSecretEntropy` (`src/auth/entropy.ts`) — fatal on
   weak secrets.
3. Build the JWT key registry with `kid: hs256-v1` pointing at the
   new key.
4. Reject every old-key JWT presented thereafter; emit
   `auth.invalid_token` Tier 2 events.

### Step 2.4 — Confirm forged tokens are rejected

Decode the header of any cached access cookie and verify the kid:

```sh
echo "<old-access-cookie>" | cut -d. -f1 | base64 -d | jq .
# Header still says {"alg":"HS256","kid":"hs256-v1","typ":"JWT"} —
# the kid does not change across rotations within v0.8.x. The
# secret behind kid hs256-v1 changed; the old token now MAC-fails.
```

Hit a protected endpoint with the old cookie:

```sh
curl -i --cookie "<old-access-cookie>" https://<coordinator>/api/me
# Expected: 401, and a new auth.invalid_token audit row.
```

## 3. Eradication (hours)

Now that the leaked secret is unusable, remove every other path of
compromise that may have been opened alongside it.

### Step 3.1 — Rotate the GitHub OAuth `client_secret`

`COORDINATOR_GITHUB_CLIENT_SECRET` is a separate secret read at boot
(`src/boot.ts` line 59). If the JWT secret was leaked from the same
location (env-var dump, `.env` commit, CI log), assume the GitHub
client_secret was leaked too.

1. Open the GitHub OAuth app settings:
   `https://github.com/organizations/<your-org>/settings/applications/<app-id>`.
2. Click **Generate a new client secret**.
3. Update `COORDINATOR_GITHUB_CLIENT_SECRET` in the env-var store.
4. Restart the coordinator.
5. Revoke the old secret in the GitHub UI (only after the coordinator
   is running with the new one).

### Step 3.2 — Audit activity during the compromise window

The compromise window starts at the earliest known time the secret
could have been read and ends at the moment of step 2.3 (restart with
the new secret).

```sql
-- All authenticated activity in the window.
SELECT occurred_at, action, actor_user_id, org_id, meta_json
  FROM audit_log
 WHERE occurred_at BETWEEN <window_start> AND <window_end>
   AND action NOT IN (
        'auth.invalid_token',     -- noisy, not actionable here
        'auth.refresh.idle_expired'
       )
 ORDER BY occurred_at ASC;
```

Look for:

- `auth.bootstrap.admin_assigned` rows that you did not authorise.
- `auth.service_token.issued` rows the operator did not initiate.
- Bulk activity from a single `actor_user_id` outside business hours.
- New `family_id` values for users who would not normally sign in
  during the window.

### Step 3.3 — Audit service tokens

Service tokens issued during the window are particularly dangerous:
they typically carry long TTLs and `admin` or `write` scopes.

```sql
SELECT r.jti,
       r.user_id,
       r.org_id,
       r.family_id,
       r.created_at,
       r.expires_at,
       r.revoked_at,
       json_extract(a.meta_json, '$.scope')   AS scope,
       json_extract(a.meta_json, '$.reason')  AS reason
  FROM refresh_tokens r
  LEFT JOIN audit_log a
         ON a.action = 'auth.service_token.issued'
        AND json_extract(a.meta_json, '$.jti') = r.jti
 WHERE r.family_id LIKE 'service:%'
   AND r.created_at BETWEEN <window_start> AND <window_end>
 ORDER BY r.created_at ASC;
```

Revoke every service token issued in the window — assume each one is
suspect:

```sql
UPDATE refresh_tokens
   SET revoked_at = strftime('%s','now'),
       revoked_reason = 'admin'
 WHERE family_id LIKE 'service:%'
   AND created_at BETWEEN <window_start> AND <window_end>
   AND revoked_at IS NULL;

INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
SELECT 'auth.service_token.revoked',
       'ops:signing-key-leak',
       org_id,
       json_object('jti', jti, 'reason', 'incident_signing_key_leak'),
       strftime('%s','now')
  FROM refresh_tokens
 WHERE family_id LIKE 'service:%'
   AND created_at BETWEEN <window_start> AND <window_end>
   AND revoked_reason = 'admin';
```

Operators who legitimately issued service tokens during the window
must re-issue them through the standard
`mcp-coordinator service-token issue` CLI in `cli/service-tokens.ts`
after the rotation is complete.

### Step 3.4 — Check for refresh chain anomalies during the window

Forgery is silent on its own — a forged JWT carries no refresh row.
But an attacker who used a forged token to *log in* via the
device-code flow would leave a normal `auth.login.success` row plus
its refresh family. Cross-reference Step 3.2 output with:

```sql
SELECT u.id, u.github_login, COUNT(DISTINCT r.family_id) AS new_families
  FROM users u
  JOIN refresh_tokens r ON r.user_id = u.id
 WHERE r.created_at BETWEEN <window_start> AND <window_end>
 GROUP BY u.id
HAVING COUNT(DISTINCT r.family_id) > 1
 ORDER BY new_families DESC;
```

For each user with anomalous family counts, run the family-lineage
queries in `docs/ops/incident-refresh-leak.md`.

## 4. Recovery

Goal: bring the system back to a clean operating state.

1. **Force re-authentication for all users.** Already accomplished by
   step 2.2 (global epoch bump). Verify:

   ```sql
   SELECT MIN(token_epoch), MAX(token_epoch), COUNT(*) FROM users;
   -- MIN should be >= the epoch bump timestamp from step 2.2.
   ```

2. **Notify users** that all sessions were invalidated and they need
   to re-authenticate. Mention the incident ID for reference.

3. **Re-issue service tokens** that were legitimately needed
   (cross-check step 3.3 against your operator runbook).

4. **Update operator runbooks** with the new `_ROTATED_AT` timestamp:

   ```sh
   echo "$(date -u +%FT%TZ) jwt_secret rotation (incident <ticket-id>)" \
     >> ops/key-rotation-history.log
   ```

5. **Verify the post-rotation health** of the auth system over the
   next 24 hours by watching:

   - `coordinator_auth_refresh_chain_revoked_total` — expect a short
     spike at restart, then back to baseline.
   - `auth.invalid_token` rate — expect a tail of unrecognised tokens
     for ~30 minutes as user clients catch up.
   - `auth.login.success` rate — expect a spike as users re-auth.

## 5. Forensics

After containment and eradication, build the incident-timeline document.

### Compromise window evidence

```sql
SELECT occurred_at, action, actor_user_id, org_id, meta_json
  FROM audit_log
 WHERE occurred_at BETWEEN <window_start> AND <window_end>
 ORDER BY occurred_at ASC;
```

Export to a CSV for the incident record:

```sh
sqlite3 ~/.mcp-coordinator/coordinator.db \
  ".mode csv" \
  ".headers on" \
  ".output incident-<id>-audit-window.csv" \
  "SELECT occurred_at, action, actor_user_id, org_id, meta_json \
     FROM audit_log \
    WHERE occurred_at BETWEEN <window_start> AND <window_end> \
    ORDER BY occurred_at ASC;"
```

### Verify the recovery rows were emitted

```sql
SELECT occurred_at, actor_user_id, meta_json
  FROM audit_log
 WHERE action = 'recovery.token_epoch_global_bump'
   AND occurred_at >= <window_start>
 ORDER BY occurred_at DESC
 LIMIT 5;
```

Each containment action in this runbook should have at least one
corresponding audit row in the database after recovery completes.

### Process-memory considerations

If the host was suspected compromised (not only the env-var store),
also collect:

- Process memory dumps if available (`gcore $(pgrep mcp-coordinator)`).
  Note: a dump contains the new secret too — treat the dump itself as
  Tier 1 sensitive material.
- Container image hash of the running coordinator (`docker inspect`).
  Confirm it matches the image you intended to deploy.
- The contents of `~/.mcp-coordinator/` at the time of incident.
  Snapshot before any further write operations.

## 6. Post-incident review

Schedule within 5 business days. Cover:

- **Leakage path**: where did the secret end up? Common paths:
  - Committed `.env` (use `git secret-scan`, `gitleaks` pre-receive).
  - CI environment dump (don't `printenv` in build steps).
  - Container metadata endpoint exposure (lock down `169.254.169.254`).
  - Dockerfile `ARG` leak via `docker history`.
  - Operator's shell history (`~/.bash_history`).
  - Shared Slack/Discord channels.

- **Detection latency**: how long between leak and detection? Add
  monitoring if the lag was > 15 minutes for at-rest secrets.

- **Secret manager**: was the secret stored in a real secret manager
  (Vault, AWS SM, GCP SM, Sealed Secrets, doppler)? If not, that is
  the highest-priority remediation. Plain env vars in `.env` files
  are insufficient for production.

- **Pre-commit hooks**: install `gitleaks`/`trufflehog` as a
  pre-commit hook on every operator workstation. Block, do not warn.

- **Privileged-access review**: who has read access to the env-var
  store? Are any of them no longer employed or no longer on the
  ops team? Revoke and rotate again.

- **HSM / KMS path**: see `docs/security/threat-model.md` residual
  risk #5. The long-term answer to "the env-var secret leaked" is
  to remove the env-var secret. This requires the asymmetric-signing
  migration tracked for v0.9+.

## Appendix — quick reference

| Step                                  | Command                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Generate new secret                   | `openssl rand -base64 32`                                                                   |
| Global epoch bump                     | `UPDATE users SET token_epoch=MAX(strftime('%s','now'),token_epoch+1)`                       |
| Record bump                           | Tier 1 audit row `recovery.token_epoch_global_bump`                                         |
| Restart coordinator                   | `systemctl restart mcp-coordinator` / `docker compose restart coordinator`                  |
| Verify old token rejected             | `curl -i --cookie "<old>" https://.../api/me` -> 401                                        |
| Rotate GitHub `client_secret`         | GitHub OAuth app settings -> Generate new client secret                                     |
| Audit window query                    | `SELECT ... FROM audit_log WHERE occurred_at BETWEEN <start> AND <end>`                     |
| Revoke service tokens in window       | `UPDATE refresh_tokens SET revoked_at=... WHERE family_id LIKE 'service:%' AND created_at...` |
| Cross-runbook reference               | `docs/ops/key-rotation.md`, `docs/ops/incident-refresh-leak.md`                             |
