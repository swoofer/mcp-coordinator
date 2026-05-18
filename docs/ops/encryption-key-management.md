# Operations — encryption key management

This runbook describes how operators generate, store, verify, rotate,
and recover the master key that protects IdP tokens at rest in
mcp-coordinator v0.10.5+.

References:

- `src/security/master-key.ts` — `decodeMasterKey`,
  `computeKeyFingerprint`, entropy check.
- `src/security/envelope-encryption.ts` — `EnvelopeEncryption`
  provider (AES-256-GCM envelope around a per-row DEK).
- `src/boot-encryption.ts` — `loadEncryptionKey`,
  `runEncryptionGuards`, `buildWrappedProvider`.
- `cli/encryption/migrate.ts` — `mcp-coordinator encryption migrate`.
- `cli/encryption/verify.ts` — `mcp-coordinator encryption verify`.
- `cli/encryption/fingerprint.ts` — `mcp-coordinator encryption fingerprint`.
- `docs/onboarding-self-host.md` — Encryption section + restore gotchas.
- `docs/security/threat-model.md` — STRIDE coverage.
- `docs/ops/key-rotation.md` — JWT signing-secret rotation (the
  related-but-separate procedure).
- `docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md`
  (V2) + `*-V3-patches.md` — design spec.

> **v0.10.5 scope.** Encryption-at-rest covers `users.idp_access_token`
> and `users.idp_refresh_token` only. KMS / `_FILE`-sourced keys and
> online rotation are NOT in v0.10.5; see "What's NOT in v0.10.5"
> below.

## Overview

### What is encrypted

- `users.idp_access_token` — the OAuth IdP access token, sealed with
  AES-256-GCM via an envelope (per-row DEK wrapped under the master key).
- `users.idp_refresh_token` — same, for the IdP refresh token.

Ciphertexts are stored as a single TEXT cell prefixed with `enc:v1:`
followed by base64url-encoded `(wrapped_DEK || nonce || tag || ct)`.
AAD is bound to `org_id || column_name || user_id`, so a DB-write
attacker cannot swap a ciphertext between rows or columns.

### What is NOT encrypted

The following remain plaintext in `coordinator.db`:

- All other user columns (display name, primary org, login id, etc.).
- File paths, plan text, audit metadata, threads / sessions tables.
- Refresh-token server-side state (the JWT itself, not its IdP backing).

For defense in depth on the rest of the row, use **OS-level encryption
on the data directory** (LUKS / dm-crypt / BitLocker / APFS encrypted
volume). The application layer only protects what is named above.

### Operator's responsibility

The master key (`COORDINATOR_ENCRYPTION_KEY`) is **not** stored in the
database, in any backup tarball, or in any audit row. Losing the key
while keeping the encrypted DB means losing every encrypted IdP token —
affected users will be forced to re-authenticate. You MUST:

1. Store the key in a secret manager (Vault, AWS Secrets Manager,
   Kubernetes Secret, GCP Secret Manager, etc.).
2. Back up the key independently of the DB backup, and on a different
   blast-radius (different account / different operator).
3. Record the 16-hex-char key fingerprint alongside each DB backup so
   you can identify which key opens which backup (see "Fingerprint and
   recognition").

## Key generation

The master key is 32 bytes. The accepted on-disk encodings are:

| Encoding   | Length | Generator                                          |
| ---------- | ------ | -------------------------------------------------- |
| base64     | 44     | `openssl rand -base64 32` (**preferred**)          |
| hex        | 64     | `openssl rand -hex 32`                             |
| base64url  | 43     | `head -c 32 /dev/urandom \| basenc --base64url -w0` |

Whitespace is trimmed before decoding. The format is auto-detected by
length + alphabet (`src/security/master-key.ts:decodeMasterKey`).

```sh
openssl rand -base64 32
```

Example output (do **not** use this value — it is now public):

```
xqgX9XwLm0pYn0LDRSPpL5Y3vXxJzRrx0Hk1jjkqB1Y=
```

### Length and entropy enforcement

`decodeMasterKey` rejects keys that do not decode to exactly 32 bytes:

```
COORDINATOR_ENCRYPTION_KEY must decode to exactly 32 bytes (got <N>).
Use: openssl rand -base64 32
```

It also runs a Shannon-entropy check (bits per byte; a uniformly
random 32-byte key scores ~5 by chance and approaches 8 on average):

- `< 3.0 bits/byte` → **rejected** with
  `COORDINATOR_ENCRYPTION_KEY has catastrophically low entropy (...). Not a random key — looks like a constant, passphrase, or test fixture.`
- `3.0 - 4.5 bits/byte` → **warned** (likely a passphrase or a
  user-typed string; will boot, but is not actually random).
- `>= 4.5 bits/byte` → silent.

If your generator output trips the warning, replace it. Do not
silence the log; it indicates the key is not what AES-256 needs.

## Storage

### Env var (v0.10.5 — only supported source)

The daemon reads `COORDINATOR_ENCRYPTION_KEY` from the process
environment. There is no `_FILE` variant in v0.10.5 (see "What's NOT
in v0.10.5"). Set it in your secret manager and inject at process
start time.

```
COORDINATOR_ENCRYPTION_KEY=<paste output of: openssl rand -base64 32>
```

### Docker / Kubernetes exposure

Env vars are **visible** to anyone with `docker inspect` on the
container or `kubectl get pod -o yaml` on the pod. Mitigations:

- **Docker**: prefer a **Docker secret** mounted as a file, then
  source it into the env at container entrypoint (planned first-class
  support via `COORDINATOR_ENCRYPTION_KEY_FILE` — v0.10.6+; for now
  the entrypoint shim is on you).
- **Kubernetes**: use a **Secret** mounted as an env var via
  `envFrom: secretRef:`. This is no better than a plain env var
  against `kubectl get pod -o yaml`, but RBAC on the Secret itself
  limits who can read it.
- **Avoid plain `.env` files in production.** They get checked in,
  rsync'd, or left readable to the wrong UID.

### Daemon spawn (`server start --daemon`)

When you run `mcp-coordinator server start --daemon`, the parent
process forwards exactly four encryption-related env vars to the
detached child (`cli/server/start.ts`):

- `COORDINATOR_ENCRYPTION_KEY`
- `COORDINATOR_ALLOW_TOKEN_LOSS`
- `COORDINATOR_TOKEN_LOSS_CONFIRM`
- `COORDINATOR_ALLOW_KEY_ROTATION`

No further configuration is needed for daemon mode. The override vars
should be unset in the parent's environment after each one-shot use
(see the rotation and disaster-recovery procedures below).

## Fingerprint and recognition

The 16-hex-char (64-bit) key fingerprint is:

```
HMAC-SHA256(key="mcc-fingerprint-v1", msg=masterKey).digest("hex").slice(0, 16)
```

(`src/security/master-key.ts:computeKeyFingerprint`.)

It is non-reversible (HMAC, not a hash of the key itself), domain-
separated by the `mcc-fingerprint-v1` label, and short enough to read
aloud or paste into a backup manifest.

### Print the fingerprint of the env key (no DB needed)

```sh
mcp-coordinator encryption fingerprint
```

Output is just the 16-hex-char fingerprint on stdout, exit 0. Exit 2
on missing or malformed `COORDINATOR_ENCRYPTION_KEY` with the failure
message on stderr.

### Compare with the stored fingerprint (DB needed)

The first successful encrypt operation persists the fingerprint into
`system_config` at key `encryption.key_fingerprint`
(`src/boot-encryption.ts:buildWrappedProvider`). You can either query
that row directly:

```sh
sqlite3 ~/.mcp-coordinator/coordinator.db \
  "SELECT value FROM system_config WHERE key='encryption.key_fingerprint'"
```

…or use the higher-level verify command (which also samples actual
rows; see next section):

```sh
mcp-coordinator encryption verify
```

### Backup-manifest practice

Whenever you snapshot `coordinator.db`, write the current fingerprint
into a manifest beside it:

```sh
mcp-coordinator encryption fingerprint > backup/coordinator-$(date +%F).fingerprint
cp data/coordinator.db backup/coordinator-$(date +%F).db
```

On restore, an operator who has multiple keys in the secret manager
can pick the right one by running `mcp-coordinator encryption
fingerprint` against each candidate and matching against the manifest
— **without** ever trying to boot the daemon and risking a
fingerprint-mismatch refusal.

## Migration commands

### Lazy migration (default)

When `COORDINATOR_ENCRYPTION_KEY` is set, existing plaintext rows are
encrypted **on next write**: the OAuth-finalize and refresh-rotation
code paths call the wrapped encryption provider, which seals the new
value. Inactive users may remain plaintext indefinitely — this is
acceptable because they will re-authenticate on their next login,
which triggers a write.

For most deployments lazy migration is sufficient. The force-encrypt
path below exists for operators who need to flush every row before a
known-good backup, a security audit, or a downgrade dress rehearsal.

### Force-encrypt every plaintext row

```sh
mcp-coordinator encryption migrate --direction encrypt
```

Behavior (`cli/encryption/migrate.ts`):

- **Daemon-running guard.** If the coordinator daemon is running, the
  command refuses with `Coordinator daemon is running (PID <pid>).
  Stop it first, or pass --force.` Exit 2.
- **Lock.** Acquires a PID-in-content lock at
  `{dataDir}/migration.lock`. If a previous run died and left a stale
  lock, it auto-recovers. If a live PID still holds it: `Migration
  lock held by alive PID <pid> (<path>). Wait or kill the process.`
  Exit 2.
- **Idempotent.** Rows already prefixed with `enc:vN:` are counted
  toward `already_done` and skipped. Re-running on a fully-migrated
  DB reports `changed=0, already_done=<N>`.
- **Batched** (default 100 rows per transaction; tune with
  `--batch-size N`). Each row update uses a compare-and-swap on the
  current value to avoid clobbering a concurrent write (the daemon
  is supposed to be down, but the CAS protects against the
  `--force` case as well).
- **Output** on success:
  ```
  Migration encrypt: scanned=<N>, changed=<C>, already_done=<A>, skipped_cas=<S>, null_skipped=<K>
  ```

Exit codes:

- `0` — success.
- `1` — success but at least one CAS skip (a concurrent write
  beat the migrator; re-run to converge).
- `2` — refused or fatal config error.

### Decrypt back to plaintext

```sh
mcp-coordinator encryption migrate --direction decrypt
```

Identical guards (daemon stop, lock, CAS). Required for two cases:

1. **Downgrade to v0.10.4** (which does not understand the `enc:v1:`
   prefix and would treat the value as the literal IdP token).
2. **Key rotation step 3**, where you decrypt under the OLD key
   before re-encrypting under the NEW key.

### Common flags

- `--direction encrypt|decrypt` (default `encrypt`).
- `--batch-size <n>` (default 100).
- `--force` — override the daemon-running guard. Use only when you
  are sure the daemon is healthy under concurrent writes (the CAS
  path will skip rows the daemon mutated, not corrupt them).

## Verification

### Print fingerprint only (no DB access)

```sh
mcp-coordinator encryption fingerprint
```

Use this from the host where the env var is set, even before the
daemon has booted. Exit 0 on success; exit 2 on
missing/malformed key.

### Verify sampled rows decrypt (DB required)

```sh
mcp-coordinator encryption verify [--samples N]
```

Behavior (`cli/encryption/verify.ts`):

1. Loads the env key, decodes it, computes the current fingerprint.
2. Reads the stored fingerprint from
   `system_config.encryption.key_fingerprint`.
3. **Fast-fail** on mismatch:
   `Fingerprint mismatch: stored=<X> current=<Y>`. Exit 2. No rows
   sampled.
4. Otherwise samples `N` random encrypted rows (default 10,
   `ORDER BY RANDOM()`).
5. For each `idp_access_token` and `idp_refresh_token` column on the
   sampled rows, attempts decryption and bucketises:

   - **decryptable** — actually decrypted.
   - **dek_fail** — `DEKUnwrapFailed` (master key cannot unwrap the DEK).
   - **data_fail** — `DataDecryptFailed` (DEK unwrapped but data tag failed).
   - **malformed** — `MalformedCiphertext` (e.g., `enc:v01:` or
     truncated blob).
   - **unknown_version** — version digit outside the range the
     binary understands (currently v1; range v1-v999 reserved).
   - **plaintext** — no `enc:v` prefix; the row is awaiting lazy
     migration.
   - **null** — column is NULL.

6. Output:
   ```
   Verification OK: <D> rows decrypted, <P> plaintext (lazy-migration pending), <K> null
   current fingerprint:  <hex16>
   stored fingerprint:   <hex16>
   counts: decryptable=<D> dek_fail=<X> data_fail=<X> malformed=<X> unknown_version=<X> plaintext=<P> null=<K>
   ```

Exit codes:

- `0` — all sampled rows decrypted **OR** no encrypted rows present
  yet (fresh install with the env key set but lazy migration not yet
  triggered prints `No encrypted rows present yet (this is OK for
  fresh installs)`).
- `2` — at least one sampled row failed to decrypt **OR** fingerprint
  mismatch **OR** missing/malformed `COORDINATOR_ENCRYPTION_KEY`.

Run `verify` after every restore, every key rotation, and as a
post-deploy smoke test in CI.

## Key rotation (NOT online — requires daemon stop)

> **Sensitive window.** This procedure transits plaintext IdP tokens
> through `coordinator.db` between steps 3 and 5. The host MUST be
> considered sensitive for the duration: schedule a maintenance
> window with no concurrent backups running, no untrusted users on
> the host, and ideally no external network reachability. Treat the
> downgraded DB as you would a plaintext-token deployment.

1. **Backup the current DB** (with the old key still active):

   ```sh
   cp data/coordinator.db backup/coordinator-pre-rotation.db
   mcp-coordinator encryption fingerprint > backup/coordinator-pre-rotation.fingerprint
   ```

2. **Stop the daemon.**

   ```sh
   mcp-coordinator server stop
   ```

3. **Decrypt all rows** with the OLD `COORDINATOR_ENCRYPTION_KEY`
   still in the env:

   ```sh
   mcp-coordinator encryption migrate --direction decrypt
   ```

   After this completes, **every `enc:v1:` row is now plaintext on
   disk**. The next step is time-sensitive.

4. **Swap the master key** in your secret manager / `.env`. Replace
   `COORDINATOR_ENCRYPTION_KEY` with the NEW value. Either:

   - Manually clear the stored fingerprint:
     ```sh
     sqlite3 data/coordinator.db \
       "DELETE FROM system_config WHERE key='encryption.key_fingerprint'"
     ```
     …so the next encrypt-write writes the new fingerprint cleanly; **or**
   - Boot with `COORDINATOR_ALLOW_KEY_ROTATION=1`, which causes
     `runEncryptionGuards` to delete the stored row and emit a
     Tier-1 `encryption.key.rotation_begin` audit (preferred — it is
     audited). Unset the var after the boot that performs the swap.

5. **Re-encrypt all rows** with the NEW key:

   ```sh
   mcp-coordinator encryption migrate --direction encrypt
   ```

   The wrapped provider persists the new 16-hex fingerprint into
   `system_config.encryption.key_fingerprint` on its first write.

6. **Start the daemon.**

   ```sh
   mcp-coordinator server start
   ```

7. **Verify.**

   ```sh
   mcp-coordinator encryption fingerprint    # should print the new fp
   mcp-coordinator encryption verify         # exit 0 + decryptable count
   ```

8. **Securely discard the OLD key** from your secret manager once
   you are satisfied with verification on the new key. Many secret
   managers version values automatically; deletion of the old
   version is the safest end-state.

### Downtime budget

Encryption is ~50µs per row on commodity hardware; decrypt is
symmetric. A 10 000-user deployment finishes a full re-encrypt in
well under a second of wall-clock CPU. Add database commit cost
(default 100-row transactions) and the wall-clock cost of stopping
and starting the daemon. Realistic total: seconds to a few minutes.

## Disaster recovery

### Scenario A: lost master key (no backup of key)

The daemon refuses to boot with:

```
Database contains encrypted IdP token rows but COORDINATOR_ENCRYPTION_KEY
is not set. Either set the key, or set COORDINATOR_ALLOW_TOKEN_LOSS=1 +
COORDINATOR_TOKEN_LOSS_CONFIRM=I_UNDERSTAND_THIS_NULLS_<N>_ROWS to NULL
the encrypted rows (users will be forced to re-authenticate). If you
restored from a backup, recover the original key first.
```

`<N>` is the actual row count of users with at least one encrypted
column.

**Option A (preferred): restore the key from a sibling backup.**

The 16-char fingerprint in
`system_config.encryption.key_fingerprint` identifies which key in
your secret manager opens this DB. For each candidate key:

```sh
COORDINATOR_ENCRYPTION_KEY=<candidate> mcp-coordinator encryption fingerprint
```

Match against the stored fingerprint (or the manifest you wrote at
backup time). Once you find the right one, restart the daemon —
boot succeeds.

**Option B (last resort): NULL the encrypted rows.**

1. Read the row count `<N>` from the refusal message (or query
   directly: `SELECT COUNT(*) FROM users WHERE idp_access_token GLOB
   'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*'`).
2. Set **both** env vars:
   ```sh
   export COORDINATOR_ALLOW_TOKEN_LOSS=1
   export COORDINATOR_TOKEN_LOSS_CONFIRM=I_UNDERSTAND_THIS_NULLS_<N>_ROWS
   ```
   (Replace `<N>` with the actual count. The boot guard rejects
   wrong counts with: `COORDINATOR_ALLOW_TOKEN_LOSS=1 is set but
   COORDINATOR_TOKEN_LOSS_CONFIRM does not match the required
   value.`)
3. Start the daemon. On boot, `runEncryptionGuards`:
   - Creates `encryption_invalidated_tokens` if missing.
   - Copies every encrypted ciphertext into that stash table (keyed
     `user_id, column_name, invalidated_at`, with `reason =
     "key_absent_token_loss_allowed"`).
   - NULLs `idp_access_token` and `idp_refresh_token` on the
     affected user rows.
   - Emits a per-user Tier-1 `encryption.token.invalidated` audit row
     (`metadata.user_id_prefix` = first 8 chars; `reason` =
     `key_absent_token_loss_allowed`).
4. **Unset both env vars** before the next boot. They are one-shot
   confirmations; leaving them set is a footgun.
5. Affected users will be redirected to the IdP OAuth flow on their
   next refresh attempt.

### Scenario B: wrong master key (fingerprint mismatch)

The daemon refuses to boot with:

```
Database was encrypted with a different key (stored fingerprint=<X>,
current key fingerprint=<Y>). Either restore the correct key, or set
COORDINATOR_ALLOW_KEY_ROTATION=1 to begin rotation. Existing rows
encrypted with the old key will become unreadable; affected users
will be forced to re-authenticate.
```

1. **Preferred**: identify the correct key (fingerprint `<X>`) in
   your secret manager and restart. Use `mcp-coordinator encryption
   fingerprint` to confirm match before restart.
2. **If the correct key is unrecoverable**: treat this as Scenario A
   above, but use `COORDINATOR_ALLOW_KEY_ROTATION=1` (which clears
   the stored fingerprint and emits an
   `encryption.key.rotation_begin` audit). Existing `enc:v1:` rows
   will then be unreadable under the new key — they are not NULLed
   here but they will fail decryption when the daemon tries to use
   them. In practice you should also run an explicit decrypt
   migration (or NULL the rows via Scenario A) so the state is
   clean. Document operator approval first; this loses data.

### Scenario C: recovering from `encryption_invalidated_tokens`

If the original key is recovered **after** running the
`ALLOW_TOKEN_LOSS` path, the stashed ciphertexts can be decrypted
out-of-band. They are stored as full `enc:v1:` blobs, so the
recovery script needs the EnvelopeEncryption provider and the
original AAD context (`org_id`, `column`, `user_id`):

```sql
SELECT
  s.user_id,
  s.column_name,
  s.ciphertext,
  s.invalidated_at,
  u.primary_org_id
FROM encryption_invalidated_tokens s
JOIN users u ON u.id = s.user_id
ORDER BY s.invalidated_at;
```

For each row, in a one-off script:

```ts
import { EnvelopeEncryption } from "mcp-coordinator/dist/security/envelope-encryption.js";
import { decodeMasterKey } from "mcp-coordinator/dist/security/master-key.js";

const provider = new EnvelopeEncryption(decodeMasterKey(process.env.COORDINATOR_ENCRYPTION_KEY!));
const plaintext = provider.decrypt(row.ciphertext, {
  org_id: row.primary_org_id,
  column: row.column_name,
  user_id: row.user_id,
});
```

In most cases the recovered tokens will have expired at the IdP by
the time you find the key — users will need to re-authenticate
anyway. Keep the stash for forensic / audit purposes regardless;
there is no automatic cleanup in v0.10.5.

## Backup and restore

- **Backup.** `mcp-coordinator server backup` tarballs
  `coordinator.db`, which contains the encrypted rows as stored.
  The master key is **NOT** in the backup. Store it independently.
- **Restore.** `mcp-coordinator server restore` is unchanged from
  earlier versions; restored DBs simply contain whatever ciphertexts
  were in the source. After restore, the daemon will refuse to boot
  unless either (a) the same `COORDINATOR_ENCRYPTION_KEY` from the
  backup-time deployment is in the env, or (b) one of the
  disaster-recovery overrides above is set.
- **Best practice — write a manifest at backup time** so future
  operators can match the backup to the correct key without
  guessing:

  ```sh
  mcp-coordinator server backup > backup/coordinator-$(date +%F).tar
  mcp-coordinator encryption fingerprint > backup/coordinator-$(date +%F).fingerprint
  ```

  At restore time, the operator compares the fingerprint manifest
  against `mcp-coordinator encryption fingerprint` for each
  candidate key in the secret manager **before** attempting to
  start the daemon. This avoids triggering the boot-refusal path
  on a wrong-key attempt (which is recoverable but noisy in audit).

## Bun runtime

All encryption code uses `node:crypto` (`createCipheriv`,
`createDecipheriv`, `randomBytes`, `createHmac`), which Bun
implements compatibly. The coordinator runs under Bun in production
deployments that prefer it. The test suite (vitest) runs under
Node; a Bun-specific CI matrix is a planned follow-up. No source-
level changes are required to run the encryption path under Bun.

## What's NOT in v0.10.5

The following are deliberately out of scope for v0.10.5 and tracked
for later releases:

- **Online key rotation.** Rotation requires a daemon stop and
  transits plaintext through the DB. See "Key rotation" above for
  the supported procedure.
- **KMS-backed master key.** HashiCorp Vault, AWS KMS, GCP KMS, and
  Azure Key Vault sourcing of the master key are roadmap items. In
  v0.10.5 the only source is the `COORDINATOR_ENCRYPTION_KEY`
  process env var.
- **`COORDINATOR_ENCRYPTION_KEY_FILE`.** First-class file-based
  injection (for Docker secrets / Kubernetes file-mounted secrets)
  is planned for v0.10.6+. Until then, source the file into the env
  in your container entrypoint.
- **Encryption of other plaintext columns** (file paths, plan text,
  audit metadata, threads, sessions). Apply OS-level encryption to
  the data directory for defense-in-depth coverage of those values.
- **Automatic stash cleanup.** Rows in
  `encryption_invalidated_tokens` are retained indefinitely for
  forensic recovery; operators may DELETE them by hand once
  recovery is no longer needed.

## Open gaps tracked for later releases

- A `mcp-coordinator encryption status` subcommand reporting
  current fingerprint, stored fingerprint, row counts by state
  (encrypted / plaintext / null), and stash-table size at a glance.
- Periodic background re-encrypt for plaintext rows (today only
  lazy on next write or explicit `migrate --direction encrypt`).
- Per-column key separation (today one master key wraps all DEKs;
  per-org or per-column subkeys via HKDF are a roadmap item).

## Closed in v0.10.5

- Envelope encryption of IdP tokens (`src/security/envelope-encryption.ts`). ✓
- Master-key decode + entropy floor + warning band
  (`src/security/master-key.ts:decodeMasterKey`). ✓
- 16-hex-char fingerprint via HMAC-SHA256, label `"mcc-fingerprint-v1"`
  (`computeKeyFingerprint`). ✓
- Boot guards (encrypted-rows-but-no-key refusal; fingerprint
  mismatch refusal) and `ALLOW_TOKEN_LOSS` / `ALLOW_KEY_ROTATION`
  overrides (`src/boot-encryption.ts:runEncryptionGuards`). ✓
- Migration / verify / fingerprint CLI subcommands
  (`cli/encryption/`). ✓
- PID-in-content migration lock at `{dataDir}/migration.lock`
  (auto-recovers stale). ✓
- Stash table `encryption_invalidated_tokens` for forensic
  recovery after `ALLOW_TOKEN_LOSS`. ✓
- Daemon-spawn env forwarding of the four encryption-related vars
  (`cli/server/start.ts`). ✓
