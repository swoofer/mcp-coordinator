# Incident response — suspected refresh-token theft

This runbook covers detection, triage, containment, eradication, and
recovery for a suspected refresh-token leak. Use it when:

- A user reports their account behaving as if logged in from an
  unfamiliar location.
- Metrics show a sudden spike in `coordinator_auth_refresh_chain_revoked_total`
  or `coordinator_auth_refresh_suspicious_replay_total`.
- Audit log shows `auth.refresh.chain_revoked` rows with reason
  `reuse_detected` or `suspicious_replay`.

References:

- `src/auth/refresh-rotation.ts` — rotation + reuse detection.
- `src/security/audit-events.ts` — Tier 1 audit event names.
- `src/observability/metrics.ts` — Prometheus counters
  (`coordinator_auth_refresh_chain_revoked_total`,
   `coordinator_auth_refresh_suspicious_replay_total`).
- `src/auth/token-epoch.ts` — `bumpTokenEpoch` for user-level
  invalidation.
- `cli/service-tokens.ts` — admin CLI (service tokens; refresh-token
  revocation is SQL-only in Phase 2).
- `docs/security/threat-model.md` — Asset 3 (refresh_tokens).
- `docs/ops/incident-signing-key-leak.md` — escalate here if the
  refresh leak co-occurs with a JWT secret leak.

## 1. Detection signals

### Metrics

Prometheus scrape of `/metrics`:

```
coordinator_auth_refresh_chain_revoked_total{reason="reuse_detected"}
coordinator_auth_refresh_chain_revoked_total{reason="suspicious_replay"}
coordinator_auth_refresh_chain_revoked_total{reason="admin"}
coordinator_auth_refresh_suspicious_replay_total
```

Alerting suggestion: a sustained rate of more than 1 `reuse_detected`
per minute over 10 minutes is anomalous outside of a release rollout.
A single `suspicious_replay` event is high-signal — investigate.

### Audit log (Tier 1)

```sql
SELECT occurred_at,
       actor_user_id,
       org_id,
       json_extract(meta_json, '$.reason')      AS reason,
       json_extract(meta_json, '$.family_id')   AS family_id,
       json_extract(meta_json, '$.jti')         AS jti,
       json_extract(meta_json, '$.parent_jti')  AS parent_jti
  FROM audit_log
 WHERE action IN (
        'auth.refresh.chain_revoked',
        'auth.refresh.suspicious_replay'
       )
   AND occurred_at >= strftime('%s','now') - 86400
 ORDER BY occurred_at DESC;
```

### User reports

Triage every report that mentions:

- "I was logged out unexpectedly" (could be epoch bump from another
  operator; correlate with `recovery.token_epoch_global_bump`).
- "Activity I didn't do".
- "Login from $UNKNOWN_LOCATION".

## 2. Triage

Goals: identify the affected user(s), the suspect family, and the
window of compromise.

### Resolve a single audit row to a user

```sql
SELECT u.id, u.github_login, u.email, u.idp_subject
  FROM users u
  JOIN refresh_tokens r ON r.user_id = u.id
 WHERE r.family_id = '<family_id from audit>'
 LIMIT 1;
```

### Enumerate the family lineage

```sql
SELECT jti,
       parent_jti,
       created_at,
       revoked_at,
       revoked_reason,
       replay_count,
       consumer_fingerprint
  FROM refresh_tokens
 WHERE family_id = '<family_id>'
 ORDER BY created_at ASC;
```

A healthy family has a strictly linear `parent_jti` chain with at most
one row whose `revoked_at` is null. A compromised family has:

- Multiple rows whose `parent_jti` is the same (fork point — the reuse
  that triggered detection).
- A `replay_count` above 0 on the offending row.
- `consumer_fingerprint` that flip-flops between two distinct values
  (legitimate session and attacker).

### Pinpoint the compromise window

```sql
SELECT MIN(created_at) AS earliest,
       MAX(revoked_at) AS latest
  FROM refresh_tokens
 WHERE family_id = '<family_id>';
```

The compromise window is from the legitimate `created_at` of the
forked row to the `revoked_at` set by chain revocation.

### Look for lateral movement

Did the attacker mint other sessions for the same user?

```sql
SELECT family_id,
       MIN(created_at) AS family_started,
       COUNT(*)         AS rows_in_family,
       MAX(revoked_reason) AS terminal_reason
  FROM refresh_tokens
 WHERE user_id = '<user_id>'
   AND created_at >= <compromise_window_start>
 GROUP BY family_id
 ORDER BY family_started ASC;
```

Each `family_id` is a separate session. Multiple families starting
within the compromise window is a strong indicator of lateral movement.

### Correlate with login activity

```sql
SELECT occurred_at,
       json_extract(meta_json, '$.ip')          AS ip,
       json_extract(meta_json, '$.user_agent')  AS ua,
       json_extract(meta_json, '$.provider')    AS provider
  FROM audit_log
 WHERE actor_user_id = '<user_id>'
   AND action = 'auth.login.success'
   AND occurred_at >= <compromise_window_start>
 ORDER BY occurred_at DESC;
```

Compare to the user's normal IP/UA pattern. A login from an
unrecognised IP block during the window is a containment-trigger.

## 3. Containment

Goal: invalidate every session the attacker could be holding.

### Revoke a specific token family

```sql
UPDATE refresh_tokens
   SET revoked_at = strftime('%s','now'),
       revoked_reason = 'admin'
 WHERE family_id = '<family_id>'
   AND revoked_at IS NULL;
```

Emit the matching Tier 1 audit row by hand (the manual UPDATE bypasses
the audit emitter):

```sql
INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
VALUES (
  'auth.refresh.chain_revoked',
  '<user_id>',
  '<org_id>',
  '{"family_id":"<family_id>","reason":"admin","trigger":"incident-runbook"}',
  strftime('%s','now')
);
```

### Force a user-wide logout (recommended)

Bump the user's token epoch — every JWT currently issued for the user
is rejected on next use:

```sql
UPDATE users
   SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)
 WHERE id = '<user_id>';

INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
VALUES (
  'auth.logout.global',
  '<user_id>',
  '<org_id>',
  '{"reason":"incident_refresh_leak","trigger":"manual"}',
  strftime('%s','now')
);
```

This is the same effect as calling `bumpTokenEpoch(db, userId)` in
`src/auth/token-epoch.ts`. There is no admin CLI for user logout in
Phase 2; SQL is the live path. (`mcp-coordinator service-token revoke`
in `cli/service-tokens.ts` is **service-token-only** and does not
affect user refresh sessions.)

### Revoke all of a user's refresh tokens

```sql
UPDATE refresh_tokens
   SET revoked_at = strftime('%s','now'),
       revoked_reason = 'admin'
 WHERE user_id = '<user_id>'
   AND revoked_at IS NULL;
```

Pair this with the epoch bump above. The bump invalidates access
tokens; the UPDATE blocks any refresh attempt with a stolen token.

### HTTP-side: logout-all endpoint

If the coordinator is reachable and the operator wants an
HTTP-mediated logout, `POST /api/auth/logout-all` (dispatched by
`src/auth/logout.ts`) performs the same epoch bump plus refresh
revocation in a single transaction with proper audit emission. This is
the preferred path when the affected user is already authenticated to
the admin console.

## 4. Eradication

Goal: ensure the attacker cannot regain access through the same
foothold.

### Rotate the GitHub OAuth grant out-of-band

If the attacker had `idp_access_token` access (see
`docs/security/threat-model.md` Asset 6 — plaintext storage residual
risk), they can call GitHub directly for the user's authorised scopes.
Have the user:

1. Visit `https://github.com/settings/applications`.
2. Find the coordinator's OAuth app.
3. Revoke access.
4. Re-authorise through the coordinator's login flow on next use.

This step is **mandatory** if the database file was suspected to be
exfiltrated, not just an in-flight token. Until v0.7.5 ships
encryption at rest, the operator must assume `idp_access_token`
columns are exposed under any DB read access.

### Verify no admin assignments were tampered with

```sql
SELECT occurred_at, actor_user_id, meta_json
  FROM audit_log
 WHERE action IN (
        'auth.bootstrap.admin_assigned',
        'auth.admin.bootstrapped'
       )
   AND occurred_at >= <compromise_window_start>
 ORDER BY occurred_at DESC;
```

If the user was an admin during the window, audit which records they
touched:

```sql
SELECT action, occurred_at, meta_json
  FROM audit_log
 WHERE actor_user_id = '<user_id>'
   AND occurred_at BETWEEN <compromise_window_start> AND strftime('%s','now')
 ORDER BY occurred_at ASC;
```

## 5. Recovery

Goal: restore the user to normal operation.

1. Have the user re-authenticate via the standard GitHub OAuth login
   flow (`/api/auth/login`).
2. Confirm a new family was created with a single live row:

   ```sql
   SELECT family_id, COUNT(*) AS rows
     FROM refresh_tokens
    WHERE user_id = '<user_id>'
      AND revoked_at IS NULL
    GROUP BY family_id;
   ```

   Expected: exactly one family with one row.

3. Issue any service tokens the user had on the previous session
   (audit + re-issue manually — Phase 2 does not migrate service
   tokens across epoch bumps).
4. Document the incident in the operator's incident-tracking system
   with the audit-row IDs referenced.

## 6. Lessons learned

Schedule a post-incident review within 5 business days. Cover:

- **Detection latency.** Time from compromise to the first
  `chain_revoked` or `suspicious_replay` audit row. Target: under
  10 minutes once the attacker uses the stolen token.
- **Lateral movement.** Any other user accounts that interacted with
  the compromised user during the window. Re-run the family-lineage
  query for each.
- **Token storage on the client side.** Was the leak from a
  compromised browser, a leaked tmux/screen session, a developer's
  laptop backup? Update the operator's onboarding to discourage that
  vector.
- **MFA on GitHub.** Confirm the user's GitHub account has MFA
  enabled and a hardware key registered. The coordinator delegates
  identity to GitHub; the coordinator cannot enforce MFA itself in
  Phase 2.
- **Audit-log retention.** Default Tier 1 retention is 365 days
  (`audit_retention_days`). If the incident spans more than 365 days
  of history, the forensic trail is partial — operators with longer
  retention obligations should raise this value before an incident,
  not during one.

## Appendix — quick reference

| Action                           | Command                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| Revoke a family                  | `UPDATE refresh_tokens SET revoked_at=…, revoked_reason='admin' WHERE family_id='…'` |
| Force user re-auth               | `UPDATE users SET token_epoch=MAX(strftime('%s','now'),token_epoch+1) WHERE id='…'` |
| HTTP user logout-all             | `POST /api/auth/logout-all` (handler: `src/auth/logout.ts`)             |
| List active families for user    | See triage SQL above                                                    |
| Identify family from a jti       | `SELECT family_id FROM refresh_tokens WHERE jti='…'`                    |
| Tier 1 metric                    | `coordinator_auth_refresh_chain_revoked_total`                          |
| Tier 1 audit action              | `auth.refresh.chain_revoked`, `auth.refresh.suspicious_replay`          |
