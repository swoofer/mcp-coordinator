# Round 2 review — Crypto / Security (V2 spec)

**Reviewer lens**: new AAD binding, error classes, fingerprint, strict-mode guards
**Spec under review**: docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md (V2)
**Overall verdict**: NEW-ISSUES-FOUND

V2 closes the catastrophic Round 1 gaps (AAD binding, fingerprint, strict-mode guards). The architecture is fundamentally sound. However, the patches introduce ~7 new issues, of which two are bugs in the new code paths (the `LIKE 'enc:v_:%'` glob is wrong; the auto-detect alphabet logic is incoherent for hex), and several are missing guard-rails on the new override switches and error discrimination.

---

## New issues (introduced by V2 patches)

### 1. `decodeMasterKey` ambiguity detection is broken for the hex case — MAJOR
**Where**: §A `decodeMasterKey`, lines 176–188.
**Issue**: Every 64-char hex string is *also* a 64-char base64url string. The hex alphabet `[0-9a-fA-F]` is a strict subset of the base64url alphabet `[A-Za-z0-9_-]`. The check
```ts
const isHex   = /^[0-9a-fA-F]{64}$/.test(trimmed);
const isB64u  = /^[A-Za-z0-9_-]{43}$/.test(trimmed);
```
does not actually collide on the length axis (43 vs 64), so in practice the regex disambiguation works *only because hex inputs are length 64 and base64url inputs are length 43*. The comment "auto-detect alphabet; refuse if ambiguous" is misleading — what's actually being detected is *length+alphabet*, not alphabet alone.

But there's a real collision case: a 64-char string of `[0-9a-fA-F]` *could* in principle be intended as base64 (the `isB64` regex matches `[A-Za-z0-9+/]{42,44}`). A 64-char hex string is **never** valid base64 by length (the regex caps at 44), so `isB64` won't match. Net: no functional ambiguity *today*.

The bug: the second-order test in `tests/unit/decode-master-key.test.ts` claims to test "ambiguous strings rejected (e.g. `0123456789abcdef…` is valid hex but no other alphabet)". That example is not ambiguous — it is hex-only. The test as described will not actually exercise the rejection branch because no real input can match more than one of (hex@64, b64@42-44, b64url@43). The "refuse if ambiguous" guard is dead code.

Worse: a user with a 43-char base64url key containing only `[0-9a-f]` would pass `isB64u` only (not `isHex` — wrong length). Fine. But a user who deliberately set `COORDINATOR_ENCRYPTION_KEY` to a 64-char string of repeated `'a'` (a passphrase-as-hex pattern) decodes as hex, gives a real 32-byte key (`aa…aa`), passes length, and *fails the entropy check* — but the entropy check is `warn`, not `throw` (line 200). So they boot with a key of 32 identical bytes. That is a soft warning, not a refusal. Round 1 explicitly accepted this (S3), but the threat-model note in the spec doesn't quantify how bad this is — `aa…aa` is a known plaintext to anyone, and `enc()` becomes deterministic-up-to-nonce.

**Recommendation**:
1. Delete the dead "ambiguity" claim from the code comment and from the test description. Document that the alphabet+length combination is unambiguous-by-construction and that's the real reason.
2. Tighten entropy check: refuse (`throw`) on entropy < 3.0 bits/byte (catastrophic), warn between 3.0 and 4.5. A 32-byte key of `aa…aa` has Shannon entropy 0 — should not boot.
3. Add a test case for `Buffer.alloc(32, 0xaa)` -> the spec MUST refuse this.

---

### 2. `LIKE 'enc:v_:%'` SQL glob does not match `enc:v10:` and beyond — MAJOR
**Where**: §D Strict-mode boot guards, lines 440 and 458–459. Also §Migration CLI line 612 (`NOT LIKE 'enc:v_:%'`).
**Issue**: SQLite `_` is a single-char wildcard. `'enc:v_:%'` matches exactly `enc:v0:…` through `enc:v9:…` but **not** `enc:v10:…`, `enc:v15:…`, etc.

For v0.10.5 this is harmless — only `v1` is written. But the consequences across the lifecycle of the spec are real:

- **Boot guard 1** (key absent + encrypted rows): if a future v0.13 rolls out `enc:v2:` and an operator downgrades back to v0.10.5 with a backup of a v0.13 DB without the key set, the SELECT returns 0 rows. Guard 1 misses. The daemon boots green. Then the spec's §B `decrypt()` sees `enc:v2:`, *throws `UnknownCipherVersion`* (good!), which is caught downstream as an `IdPTokenRevoked`-equivalent → silent mass logout. The exact scenario Round 1's C2/C8 set out to prevent.
- **Boot guard 2** (fingerprint mismatch): same hole — if rows are `enc:v10:`, the SELECT misses them, the guard never fires, and the wrong-key boot succeeds silently.
- **Migration CLI**: the encrypt-direction SELECT `WHERE idp_access_token NOT LIKE 'enc:v_:%'` would *re-encrypt* a row that's already `enc:v10:…` (treating it as plaintext) — corrupting the DB.

**Recommendation**: Use `LIKE 'enc:v%'` (any version), or better, `idp_access_token GLOB 'enc:v[0-9]*:*'` for stricter shape matching. Audit all SQL using `'enc:v_:%'` — there are at least 4 sites.

---

### 3. AAD `column` field cannot disambiguate when the same plaintext is written to a different column in a future spec — MAJOR (forward-compat)
**Where**: §B `aad()`, line 336; §Storage format line 136.
**Issue**: The AAD is `v1|${org_id}|${column}|${user_id}`. The version prefix `v1|` lets future code distinguish AAD formats, good. But:

(a) **Delimiter ambiguity**: `org_id` is a UUID in the current codebase and contains no `|`. But the spec doesn't *constrain* this — there is no schema-enforced "org_id MUST NOT contain `|`" anywhere. If a future column-encryption spec uses `team_name` or a user-controlled `tenant_slug` as part of the context, an attacker who controls a slug can construct `acme|column|userA|x|column|userB|` that collides with the AAD for a different (user, org, column) triple. Concretely: `v1|orgA|idp_access_token|user-with|in-id` parses identically (after concatenation) to `v1|orgA|idp_access_token|user-with-`-NULL+`|in-id`. Pipe is not a binding delimiter — it's a hint to humans.

(b) **No forward-compat hook for new column families**: when v0.11 adds `users.email` encryption with a different AAD shape (say `v2|${org_id}|${column}|${user_id}|${row_version}`), the `v1|`-prefixed AAD format is locked for backward compat with existing rows. Fine — but the spec does not say what `v2|` does or how `decrypt()` chooses. Today's code hard-codes `v1|` in `aad()`. If you ever need `v2|`, you have to fork `aad()` per column, which is a smell.

**Recommendation**:
1. Use a non-printable delimiter that is statically forbidden in any context field — e.g., `\x1f` (US Unit Separator). Or use a length-prefixed encoding: `aad = u8(v) || u16(len_org) || org_id || u16(len_col) || column || u16(len_user) || user_id`. This is what every binary protocol does and is parser-proof.
2. Document `org_id`, `column`, `user_id` MUST be ASCII-printable with no control bytes; add a runtime `assert` in `encrypt()` that rejects any field containing `\x00`–`\x1f` or `|`. Fail loudly on misuse rather than silently produce ambiguous AAD.
3. Pin a single source of truth for the AAD format: have `EncryptionContext` carry a `version` field that `aad()` uses to select the encoding (`aad_v1`, `aad_v2`). Today the `v1|` is hardcoded in the function body, which means changing the format = changing the function, which means changing v1 row decryptability. Decouple now.

---

### 4. Three-class error discrimination leaks structural info to attacker via timing/log channels — MINOR
**Where**: §B `decrypt()`, lines 268–331; §F audit event `encryption.decrypt.failed` with `error_class` label.
**Issue**: The three classes are correctly routed in the code (base64 fail → `Malformed`; wrap unwrap fail → `DEKUnwrapFailed`; data unwrap fail → `DataDecryptFailed`). No malformed input leaks as `DataDecryptFailed`. Good.

But:
- The audit log records `error_class` per failure. An attacker with read access to audit logs (e.g., a low-priv operator) can distinguish "this ciphertext is structurally valid but doesn't decrypt under the current key" (`DEKUnwrapFailed`) from "this row was tampered with" (`DataDecryptFailed`). For an attacker probing whether their tampering survives the AAD check, this is a direct oracle.
- The metric label `error_class` similarly exposes this distribution to anyone with Prometheus read.
- Constant-time: GCM tag verification in `node:crypto` is constant-time. The branch between `DEKUnwrapFailed` and `DataDecryptFailed` is not — the wrap step happens first, so a wrap failure short-circuits without touching the data. An attacker who can submit chosen ciphertexts and measure response time can distinguish "wrap valid, data invalid" from "wrap invalid" by latency (one AES-GCM op faster). For the current threat model (DB-write attacker, not network-timing attacker on the auth flow), this is not exploitable, but it should be noted.

**Recommendation**:
1. Lower the granularity of the *exported* signal: metric stays at counter-with-class (operators need it for debugging), but the audit event should emit only "decrypt_failed" with the class in an *operator-restricted* metadata field (tier 2+, not the default tier).
2. Document in threat-model that the three-class distinction is observable to operators (acceptable) but should not be exposed to user-visible HTTP responses. Verify §E reads "treat identically to IdPTokenRevoked" — yes, this is done at the call site. Keep it that way.

---

### 5. Key fingerprint at 32 bits has meaningful collision probability and a length-extension straw-man — MINOR
**Where**: §Boot architecture diagram line 75 (`sha256(masterKey).slice(0,8)` — 4 bytes); §CLI fingerprint line 659 (`slice(0,16)` — 8 bytes).
**Issue**:
(a) **Inconsistency**: the boot diagram fingerprint is 8 hex chars (4 bytes = 32 bits). The CLI `fingerprint` subcommand emits 16 hex chars (8 bytes = 64 bits). These will not compare equal as strings. Either the CLI emits more than is stored, or operators will be confused. Pick one length and use it everywhere.

(b) **32-bit collision**: at 32 bits, birthday collision is ~2^16 = 65k keys before a 50% chance. An operator with ~100 keys across environments has a ~10^-6 collision chance — fine. But two random 32-byte keys colliding on a 32-bit fingerprint accidentally is ~1 in 4 billion, which means in the field, eventually, someone will hit it. The fingerprint is meant to be a *negative* check (refuse boot on mismatch), so a false negative (mismatch missed) is worse than a false positive. Use 64 bits (16 hex) everywhere.

(c) **HMAC vs SHA-256**: SHA-256 of a 32-byte key is not length-extensible (length-extension attacks on SHA-256 require the attacker to know the original length and the digest of a prefix, which here is the entire key — no extension is possible). Using HMAC-SHA256 with a fixed context string ("fingerprint-v1") would be defense-in-depth and key-separation-clean, but it's not security-critical. Worth a one-line change for hygiene.

(d) **Information leak**: 32–64 bits of `sha256(key)` does not allow recovery of the key by any known method (would require a preimage attack on SHA-256). Safe to log.

**Recommendation**:
1. Make boot fingerprint and CLI fingerprint the same length: **16 hex chars (64 bits)**.
2. Switch to `hmac("sha256", "mcc-fingerprint-v1", masterKey).slice(0, 16)` for key separation. The label "mcc-fingerprint-v1" lets you change the derivation later without colliding with old fingerprints.
3. When refusing boot on fingerprint mismatch, log both stored and current as the full 16 hex chars (do not truncate further) so the operator can grep their secret manager.

---

### 6. `COORDINATOR_ALLOW_TOKEN_LOSS=1` is irreversibly destructive and the spec gives it only an env-var trigger — MAJOR
**Where**: §D Guard 1 override, lines 449–461.
**Issue**: Setting `COORDINATOR_ALLOW_TOKEN_LOSS=1` and starting the daemon NULLs every `enc:v_:` row. No backup is taken first. No confirmation prompt. An operator who pastes the env var into the wrong shell (or sets it in a forgotten `docker-compose.override.yml`) loses every IdP token in the DB on next start.

Compare with the rotation override: `COORDINATOR_ALLOW_KEY_ROTATION=1` is also irreversible-ish (old rows become unreadable, users re-auth) but the rows themselves are preserved (until they get overwritten by re-auth). The TOKEN_LOSS path is strictly more destructive.

Also: the spec gives no logging of *which rows* will be nulled before nulling them. After the fact, the audit event records counts but not user_ids — no audit trail for "which user just got logged out".

**Recommendation**:
1. Require a second confirmation env var: `COORDINATOR_ALLOW_TOKEN_LOSS=1` AND `COORDINATOR_TOKEN_LOSS_CONFIRM=I_UNDERSTAND_THIS_NULLS_<N>_ROWS` where `<N>` matches the actual count. Daemon computes the count, refuses if the confirm value doesn't match. Operator must run with TOKEN_LOSS=1 once (refuses, prints the required confirm value with N), then re-run with both. This is the pattern Postgres uses for `DROP DATABASE` in some tooling.
2. Before nulling, copy the to-be-nulled rows to an `encryption_invalidated_tokens` audit table with `(user_id, column, ciphertext, invalidated_at, reason)`. Operator can grep this table to see who got logged out. Optional: keep the ciphertext so a key-recovery later still allows manual unlock. (Or omit the ciphertext if the threat-model objects.)
3. Mandatory: also write an audit event per user_id, not just one event for the whole batch.

---

### 7. Key rotation procedure transits through plaintext on disk — MINOR (acknowledged but under-emphasized)
**Where**: §Migration & rollback runbook, "Key rotation (NOT online — requires daemon stop)", lines 720–732.
**Issue**: Step 3 is `encryption migrate --direction=decrypt` — every IdP token is written back to disk as plaintext. The DB now contains plaintext IdP tokens until step 5 finishes. If the host is compromised during this window (minutes to hours depending on user count), the attacker gets all tokens cleartext.

This is acknowledged implicitly (the runbook says "Total downtime: seconds to minutes") but the **window of cleartext exposure** is not called out as a risk. Operators reading this will not understand they are degrading the security posture during the rotation.

**Recommendation**:
1. Add an explicit warning in the runbook: "During steps 3–5, the DB contains plaintext IdP tokens. Ensure the host filesystem is not accessible during this window (network-isolate the host, or perform rotation in a maintenance window with no DB backups taken)."
2. Add a section "Risks accepted" entry: "Key rotation procedure transits plaintext through DB; mitigation = operator runs rotation in maintenance mode, no backup snapshots during the window."
3. Future v0.10.6 should support "online" rotation via DEK re-wrap (re-encrypt only the wrapped DEK per row, not the data — the spec already says this is the future design). Add a forward-pointer.

---

### 8. `enc:v\d+:` parser accepts unbounded version numbers and pathological inputs — NIT
**Where**: §B `decrypt()` line 230 `const VERSION_RE = /^enc:v(\d+):/`.
**Issue**: `\d+` matches any number of digits. `enc:v00000000001:` parses as version `"00000000001"` and the `if (version !== "1")` check on line 275 fails (string comparison), throws `UnknownCipherVersion`. Fine in practice — but:
- `enc:v0:` (which is "invalid" per the spec) is treated as unknown-version and throws. Defensible.
- A row of the form `enc:v999999999999999999999999999999:base64stuff` triggers the same throw. No DoS risk since the regex is anchored and bounded by input length, but the error message embeds the version string verbatim — if logs are HTML-rendered anywhere, this is a tiny injection vector.

**Recommendation**: tighten regex to `/^enc:v([1-9]\d{0,2}):/` (versions 1–999, no leading zeros). Throws `MalformedCiphertext` for anything else (not `UnknownCipherVersion`). Distinguishes "this is a future version we don't speak" from "this is garbage".

---

### 9. `Buffer.fill(0)` zeroization may be optimized away by V8 — NIT
**Where**: §B lines 263 (`dek.fill(0)`) and 329 (`finally { dek.fill(0); }`).
**Issue**: Spec accepts process-memory leakage as out-of-scope (correctly). But the spec explicitly *calls out* zeroization. V8 cannot trivially elide `Buffer.fill(0)` because `Buffer` is a `Uint8Array` backed by external memory (allocated outside the V8 heap for large buffers, or in an `ArrayBuffer` for small ones); the JIT does not have escape analysis to prove the fill is dead. Empirically `dek.fill(0)` does write zeros. Good.

However: the *intermediate buffers* are not zeroed. `cipherData.update(plaintext, "utf8")` returns a `Buffer` that is concatenated into `ciphertext`; `Buffer.concat` allocates a new buffer. The intermediate `update()` output and the `final()` output are unzeroed `Buffer` instances that become GC-eligible after the function returns. Same for `wrappedDek`, `nonceData`, `tagData`. These are not the master key, but they include the DEK ciphertext and the plaintext-AES-GCM output — bit-for-bit the encrypted payload, which is fine on disk anyway.

More importantly: **the `plaintext` string argument** is a JS string, immutable, interned in the heap, with no way to zeroize. The plaintext IdP token sits in the V8 heap forever until GC, regardless of what we do with buffers.

**Recommendation**:
1. Drop the zeroization claim or scope it down: zeroizing the DEK after wrap and after unwrap is meaningful only because the DEK is a long-term-ish secret across the function lifetime; the plaintext is unmitigable in JS.
2. Document this honestly in §Risks accepted: "DEK is zeroized after use; plaintext IdP tokens persist in V8 heap as immutable strings until GC."
3. The current `finally { dek.fill(0); }` is correct; no code change needed. Just don't oversell it.

---

### 10. Boot guard sequencing race: fingerprint write is non-atomic with first encrypt — MINOR
**Where**: §D, line 480–482 (fingerprint backfill); §Boot diagram step 2.
**Issue**: The backfill `INSERT INTO system_config (key, value) VALUES (?, ?)` for an existing-encrypted-rows-but-no-stored-fingerprint case runs *during boot*, before the daemon accepts requests. So no concurrency. Good.

But consider: a v0.10.4 → v0.10.5 upgrade where the operator (a) sets the key, (b) starts the daemon, (c) immediately the daemon writes the fingerprint via the backfill clause, (d) the daemon crashes between INSERT and COMMIT (no explicit transaction wrapping in the spec). Now the fingerprint is half-written. Better-sqlite3 auto-commits per statement, so this is actually atomic — the INSERT either lands or doesn't. Safe.

The real race is during the first encrypt write of a fresh deploy: §D line 478 says "Fresh key, no prior fingerprint: store on first encrypt (handled in EnvelopeEncryption call site)." But the call site doing this is not specified in the spec. Two concurrent first-login requests could both detect `storedFingerprint === null` and both try `INSERT`. The second INSERT throws on PRIMARY KEY constraint (assuming `system_config.key` is PK; not specified). If unhandled, the second login fails.

**Recommendation**:
1. Specify the INSERT location: in `EnvelopeEncryption.encrypt()` itself, or in `encryptNullable()`, or in `provisionUser()`. My vote: in `bootPhase2` defensively on first encrypted row detection (already proposed by line 480), AND use `INSERT OR IGNORE` (SQLite) at all sites. Single-line change.
2. Confirm `system_config.key` is PRIMARY KEY or UNIQUE — the spec defers to the existing schema (`src/database.ts`) — should be verified before the implementer codes against it.
3. Wrap the fingerprint-write + first-row-encrypt in a single transaction if possible (defense in depth — if encrypt succeeds but fingerprint write fails, the next boot will think a fingerprint was never written and silently set it to a *new* key's fingerprint, breaking guard 2).

---

### 11. `migration_lock.lock` file semantics differ between Windows and POSIX — NIT
**Where**: §Migration CLI line 610 "Acquires a file lock (`{data_dir}/migration.lock`, fail-if-exists)".
**Issue**: "Fail-if-exists" is implementable on both via `O_EXCL | O_CREAT` (POSIX) / `wx` flag in Node (`fs.openSync(path, "wx")`). Cross-platform OK.

But the spec says "Lock file is removed on clean exit; stale lock requires manual `rm`." On Windows, if the CLI process crashes while holding the file handle open, the lock file persists *and* may have a non-deletable handle if any other process is mid-read. On POSIX, an `unlink` while held just makes it inaccessible to new openers but the holder retains the handle.

The bigger issue: the lock file does not protect against the daemon writing. The spec says "Refuses to start if `getRunningCoordinatorPid()` returns a PID and `--force` not passed." So the model is "stop the daemon, run CLI". Fine. But two CLI invocations *and* `--force` would race past the daemon check; the file lock catches them. Document that `--force` does NOT bypass the file lock.

**Recommendation**:
1. Explicitly document: `--force` bypasses the daemon-PID check, not the file lock. To bypass the file lock, manually `rm migration.lock`. The two are separate.
2. Use a PID-in-content lock (write `process.pid` into the lock file), and on second-CLI startup, check whether that PID is still alive — if not, take over the lock. This auto-recovers from crashes without manual `rm`.
3. On Windows, prefer `fs.openSync(path, "wx")` + write PID + close handle (so the file is a marker, not a handle-held lock). This works identically on both platforms.

---

## Summary of severity

- MAJOR (3): #1 (decode ambiguity / weak entropy), #2 (LIKE underscore wildcard), #3 (AAD delimiter), #6 (TOKEN_LOSS missing confirmation).
- MINOR (4): #4 (error-class oracle), #5 (fingerprint length/HMAC), #7 (rotation plaintext window), #10 (fingerprint write race).
- NIT (3): #8 (version regex bounds), #9 (zeroization theatre), #11 (lock file cross-platform).

## What V2 got right (no further action)

- **AAD binding** mechanically — `setAAD` called on both encrypt and decrypt, AAD includes column → cross-row/cross-column swap is closed (modulo issue #3's delimiter concern).
- **Three-error-class routing** — `MalformedCiphertext` (base64 decode) → `DEKUnwrapFailed` (wrap GCM tag) → `DataDecryptFailed` (data GCM tag) are correctly routed and cannot be confused. No information leak from malformed input being mis-classified.
- **Forward-compat parser** — unknown `enc:v\d+:` throws rather than passing through, closing the C2/C17 silent-downgrade scenario (modulo issue #2's SQL glob hole).
- **`encryptNullable` semantics for `""`** — empty → NULL is safe because `refresh-rotation.ts:577` already uses truthy check `if (idpAccessToken && ...)`. I spot-checked: line 600 uses `idpRefreshToken !== null` which is the one site sensitive to `""` vs `null`, but the helper normalizes both at the storage boundary, so the read returns `null` consistently. Safe.
- **Boot-guard composition** — guards 1 + 2 + 3 cover the silent-key-swap and silent-restore-without-key scenarios from Round 1. The verify-after-restore edge case (operator runs `verify` with OLD key and finds sample-decryptable rows, falsely concluding the key is correct) is mitigated by the fingerprint check in `verify` (§verify-semantics, line 650 "If mismatch with stored: exit 2"). Verify will refuse on fingerprint mismatch *before* it tries to decrypt sample rows. Good.
- **Sync `loadMasterKey()`** — closes C3 cleanly.
- **`MasterKeyProvider` removal** — YAGNI applied correctly.
- **Daemon-spawn env forwarding** — C9 closed; the explicit `fwd(...)` line is the right fix.
