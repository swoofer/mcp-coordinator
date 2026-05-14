# Operations — `COORDINATOR_JWT_SECRET` rotation

This runbook describes the planned and emergency rotation procedure for
the JWT signing secret used by mcp-coordinator Phase 2 authentication.

References:

- `src/boot.ts` — env-var load + entropy assertion at boot.
- `src/auth/jwt-keys.ts` — `buildJwtKeyRegistry`, `ACCEPTED_KIDS`.
- `src/auth/entropy.ts` — `assertSecretEntropy`.
- `src/auth/token-epoch.ts` — `bumpTokenEpoch` / `bumpTokenEpochAllUsers`.
- `src/security/audit-events.ts` — `config.key_rotation` Tier 1 audit
  reservation.
- `SECURITY.md` — disclosure policy.
- `docs/security/threat-model.md` — Asset 1 (JWT signing key).

> **Phase 2 caveat — `_PREV` overlap support is not yet implemented.**
> The procedure below documents the **intended** rotation flow with a
> verify-only previous secret during the cutover window. The current
> implementation of `buildJwtKeyRegistry(currentSecret)` in
> `src/auth/jwt-keys.ts` accepts only a single secret. Reading the
> `COORDINATOR_JWT_SECRET_PREV` and
> `COORDINATOR_JWT_SECRET_PREV_ROTATED_AT` env vars and wiring them
> through to the registry as `kid: hs256-v0` verify-only is a planned
> **v0.8.x patch**. Until that patch ships, secret rotation is an
> "emergency" rotation only: every user is signed out at the instant of
> swap (the documented emergency procedure below). Planned rotations
> should be scheduled for low-traffic windows and announced to users.

## When to rotate

| Trigger                                                     | Procedure                                              |
| ----------------------------------------------------------- | ------------------------------------------------------ |
| Scheduled rotation (every 12 months recommended)            | Planned rotation (requires `_PREV` overlap patch)      |
| Suspected secret leak                                       | Emergency rotation (this runbook + incident runbook)   |
| Departing operator with prior env-var access                | Emergency rotation                                     |
| Migration to a new secret-manager backend                   | Planned rotation                                       |
| Recovery from compromise (`docs/ops/incident-signing-key-leak.md`) | Emergency rotation + global epoch bump          |

## Pre-flight

Confirm you have:

1. Console access to the coordinator host or container runtime.
2. Permission to read/write the env-var store (Vault, AWS Secrets
   Manager, Kubernetes Secret, `.env` file, etc.).
3. The ability to restart the coordinator process.
4. Database read access (for verifying the audit trail post-rotation).

Verify the current build:

```sh
mcp-coordinator --version
```

Confirm the auth flag is on:

```sh
echo "$COORDINATOR_OAUTH_ENABLED"   # expected: true
```

## Generating a new secret

The secret must satisfy the 128-bit entropy floor enforced by
`assertSecretEntropy` (`src/auth/entropy.ts`). A 32-byte random string
is the conventional choice:

```sh
openssl rand -base64 32
```

Example output (do **not** use this value — it is now public):

```
xqgX9XwLm0pYn0LDRSPpL5Y3vXxJzRrx0Hk1jjkqB1Y=
```

Store the value in your secret manager, do **not** commit it to git,
and verify the entropy floor locally:

```sh
node -e 'const {assertSecretEntropy}=require("./dist/auth/entropy.js"); \
  assertSecretEntropy(Buffer.from(process.argv[1],"utf8"),128); \
  console.log("ok")' \
  "$(printf %s "<new-secret>")"
```

## Planned rotation (requires `_PREV` overlap patch — v0.8.x)

This is the **intended** procedure once `buildJwtKeyRegistry` accepts
both the current and previous secrets. Today this section is a forward
specification; the emergency procedure below is the live path.

1. **Pre-position the old secret as `_PREV`.** In the env-var store,
   add:

   ```sh
   COORDINATOR_JWT_SECRET_PREV=<the secret currently in COORDINATOR_JWT_SECRET>
   COORDINATOR_JWT_SECRET_PREV_ROTATED_AT=2026-05-13T14:00:00Z
   ```

   The `_ROTATED_AT` timestamp marks when the **prev** key was retired
   from signing. The coordinator uses this to alert operators when the
   overlap window has exceeded `refresh_TTL` (the prev key can be
   removed safely at that point).

2. **Swap `COORDINATOR_JWT_SECRET` to the new value.**

3. **Restart the coordinator.** On startup, `bootPhase2` in
   `src/boot.ts` calls `assertSecretEntropy` on the **new** value and
   passes both secrets to a (future) overlap-aware
   `buildJwtKeyRegistry(currentSecret, prevSecret)`. The registry then
   exposes:

   - `kid: hs256-v1` — current, used for signing **and** verification.
   - `kid: hs256-v0` — previous, verify-only. Any JWT presented with
     this `kid` validates against the prev secret. New tokens are
     **always** minted with `hs256-v1`.

4. **Emit the `config.key_rotation` Tier 1 audit event.** Reserved in
   `src/security/audit-events.ts` line 33. The boot path is the
   intended emitter:

   ```jsonc
   {
     "action": "config.key_rotation",
     "tier": 1,
     "meta": {
       "prev_kid": "hs256-v0",
       "current_kid": "hs256-v1",
       "prev_rotated_at": "2026-05-13T14:00:00Z"
     }
   }
   ```

   **Today this row is not emitted.** Until the v0.8.x patch ships,
   manually insert an audit row to record the rotation:

   ```sql
   INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
   VALUES (
     'config.key_rotation',
     'ops:rotation-runbook',
     'system',
     '{"prev_kid":"hs256-v0","current_kid":"hs256-v1","prev_rotated_at":"2026-05-13T14:00:00Z","note":"manual until v0.8.x"}',
     strftime('%s','now')
   );
   ```

5. **Wait `refresh_TTL` (default 30 days).** Every refresh token still
   bound to the old key will be rotated forward on its next use; when
   the rotation lands, the new token is signed with `hs256-v1` and the
   old `hs256-v0`-bound refresh row is revoked atomically. After
   `refresh_TTL` elapses, no live token references the prev key.

   To bypass the wait — for example because the rotation is in
   response to a suspected leak — proactively run a global epoch bump:

   ```sh
   sqlite3 ~/.mcp-coordinator/coordinator.db \
     "UPDATE users SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1)"
   ```

   This is the same operation `bumpTokenEpochAllUsers`
   (`src/auth/token-epoch.ts`) performs. Every user is forced to
   re-authenticate on their next request.

6. **Remove `_PREV` env vars.**

   ```sh
   unset COORDINATOR_JWT_SECRET_PREV
   unset COORDINATOR_JWT_SECRET_PREV_ROTATED_AT
   ```

7. **Restart the coordinator** one more time. The registry now exposes
   only `hs256-v1`. Any straggling token signed with the old key is
   rejected and the user is forced to re-authenticate.

8. **Audit verification.**

   ```sql
   SELECT occurred_at, actor_user_id, meta_json
   FROM audit_log
   WHERE action = 'config.key_rotation'
   ORDER BY occurred_at DESC
   LIMIT 5;
   ```

## Emergency rotation (Phase 2 live path)

Use this when you cannot wait for the overlap window — typically
during a suspected secret leak (see
`docs/ops/incident-signing-key-leak.md`).

1. **Generate the new secret.**

   ```sh
   NEW_SECRET="$(openssl rand -base64 32)"
   ```

2. **Update the env-var store** with the new value of
   `COORDINATOR_JWT_SECRET`. Do **not** populate the `_PREV` vars in
   Phase 2 — they are not consumed.

3. **Force-bump every user's token epoch before restart**, so any
   refresh attempt with a token signed under the old key is rejected
   by the epoch check rather than by signature failure (cleaner
   audit trail):

   ```sql
   -- ~/.mcp-coordinator/coordinator.db
   UPDATE users
     SET token_epoch = MAX(CAST(strftime('%s','now') AS INTEGER), token_epoch + 1);
   ```

4. **Emit the recovery audit row** so the global bump is recorded
   (Tier 1 `recovery.token_epoch_global_bump`):

   ```sql
   INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
   VALUES (
     'recovery.token_epoch_global_bump',
     'ops:emergency-rotation',
     'system',
     '{"reason":"jwt_secret_rotation","trigger":"manual"}',
     strftime('%s','now')
   );
   ```

5. **Restart the coordinator.** Boot validates the new secret via
   `assertSecretEntropy` and builds the registry with `hs256-v1`
   pointing at the new key only. Old JWTs fail signature verification
   and emit Tier 2 `auth.invalid_token` rows on use.

6. **Notify users.** Every active session is invalidated; they will be
   redirected to the GitHub OAuth flow on their next request.

7. **Record the rotation in the operator runbook** (paper-trail) and
   in audit:

   ```sql
   INSERT INTO audit_log (action, actor_user_id, org_id, meta_json, occurred_at)
   VALUES (
     'config.key_rotation',
     'ops:emergency-rotation',
     'system',
     '{"mode":"emergency","note":"single-key swap, no overlap"}',
     strftime('%s','now')
   );
   ```

## Post-rotation verification

After either rotation mode, verify:

1. **Boot succeeded with the new secret.** Tail the coordinator log
   for the boot banner; an entropy failure manifests as a fatal log
   line containing the substring `assertSecretEntropy`.

2. **New tokens carry the new kid.** Fetch any current access cookie
   and decode its header (no signature check needed for the header):

   ```sh
   echo "<access-cookie>" | cut -d. -f1 | base64 -d | jq .
   # expected: {"alg":"HS256","kid":"hs256-v1","typ":"JWT"}
   ```

3. **Old-token attempts log `auth.invalid_token`.**

   ```sql
   SELECT COUNT(*) FROM audit_log
   WHERE action = 'auth.invalid_token'
     AND occurred_at >= strftime('%s','now') - 3600;
   ```

   A spike immediately after rotation is expected; the rate should
   decay as users re-authenticate.

4. **No `auth.refresh.chain_revoked` storm.** A small spike for
   in-flight refreshes is normal; a sustained storm indicates clients
   are looping. Check the `coordinator_auth_refresh_chain_revoked_total`
   metric over the rotation window.

## Roll back

If the new secret is rejected at boot:

1. Restore the previous value of `COORDINATOR_JWT_SECRET` from the
   secret manager's version history.
2. Restart the coordinator.
3. The global epoch bump in step 3 of emergency rotation is
   irreversible — every user must re-authenticate even after rollback.
   This is acceptable: it preserves the invariant that an epoch never
   moves backward.
4. Investigate why the new secret failed entropy: it must be at least
   128 bits, base64 or base64url, and not match the pattern checks
   in `src/auth/entropy.ts` (no repeated bytes, no low-entropy
   keyboard runs).

## Open gaps tracked for v0.8.x

- `buildJwtKeyRegistry` does not accept a previous secret. See
  `docs/security/threat-model.md` residual risk #6.
- The boot path does not emit `config.key_rotation` automatically.
  Manual SQL insertion is required as documented above.
- No CLI subcommand exists for rotation. The operator runs `openssl`,
  edits the env-var store, and restarts the coordinator by hand.
- A future `mcp-coordinator key-rotation status` command will report
  the active kid set, the `_PREV_ROTATED_AT` timestamp, and the count
  of unrotated refresh tokens.
