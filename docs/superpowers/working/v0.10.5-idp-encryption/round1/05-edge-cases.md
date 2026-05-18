# Round 1 review — Edge cases

**Reviewer lens**: weird states, race conditions, "what if" scenarios
**Spec under review**: docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md
**Overall verdict**: GAPS-EXIST

The cryptographic design is sound (AES-256-GCM envelope, per-row DEK, auth-tagged, versioned prefix). The gaps are almost entirely in the operational and integration surface: NULL/empty handling at call sites, concurrent write races, lazy-migration semantics, key-misconfiguration detection, boot ordering vs. async key load, and a complete absence of operator-facing diagnostics when things go subtly wrong. A handful of these are CRITICAL-by-default (silent corruption / silent plaintext fallback) and should be addressed before the spec is implementation-frozen.

The spec also under-specifies behavior at exactly the boundary you have to get right: the moment a token transitions through encrypt/decrypt. Empty string, NULL, and "looks-like-prefix" cases are not enumerated. The `EnvelopeEncryption.encrypt()` signature is `(plaintext: string, ...)` — that is a type-system silence that hides three different runtime behaviors in the call sites today.

## Edge cases

### 1. NULL token at write path is silently encrypted as the string "null" — CRITICAL
**Steps**:
1. An IdP (e.g., Google with `access_type=online`) returns an access token but no refresh token.
2. `oauth-finalize.ts:88` UPDATE binds `refreshTokenValue` which can be `null` (already nullable in schema; see `oauth-finalize.ts:70-73`).
3. With the spec's prescribed change ("wrap both token values with `encryptionProvider.encrypt(...)` before bind"), the call becomes `encryptionProvider.encrypt(refreshTokenValue, ctx)` where `refreshTokenValue: string | null`.
4. `EnvelopeEncryption.encrypt(plaintext: string, ...)` declares non-null, but at runtime `String(null)` → `"null"`, or TypeScript silently passes `null` and `Buffer.from(null, "utf8")` throws.
**What goes wrong**: Either (a) the literal 4-byte UTF-8 string `"null"` gets encrypted and stored as a valid `enc:v1:...` blob — on read it decrypts to the string `"null"` and is then used as a bearer token against the IdP, which 401s in a way that is **indistinguishable from token revocation** and triggers the refresh path on a `"null"` refresh token; or (b) a runtime crash inside oauth-finalize 500s the login. Both are bad; (a) is worse because it corrupts the row irreversibly.
**Recommendation**: Spec must explicitly state: "if input is `null` or `undefined`, callers MUST bypass the encryption provider and bind SQL `NULL` directly." Add a thin helper `encryptNullable(provider, value, ctx): string | null` and prescribe its use at all four call sites. Add a unit test that asserts `encrypt(null as any)` throws loudly rather than producing a valid blob.

### 2. Empty-string token round-trip is undefined behavior — MAJOR
**Steps**:
1. A misbehaving IdP returns `access_token: ""` (or some future provider implementation initializes the field eagerly to `""`).
2. `encryptionProvider.encrypt("", ctx)` runs: `cipherData.update("", "utf8")` → empty Buffer, `cipherData.final()` → empty Buffer, ciphertext length 0.
3. The blob still has 88 bytes of header (wrappedDek + nonceData + tagData). Decrypt returns `""`.
**What goes wrong**: Technically it works — but the spec never says it should. There is no test for it. Worse, downstream code (`refresh-rotation.ts:577`: `if (idpAccessToken && idpProvider && recheckSupported)`) treats `""` as falsy and `null` as falsy identically — so an empty-string decrypted token silently disables the membership recheck. Operators have no way to tell a "DEK round-tripped successfully to empty string" from "row is plaintext empty string from a legacy bug".
**Recommendation**: Spec should add: "empty string in is empty string out; callers MUST treat `""` as semantically equivalent to NULL at the IdP layer and prefer storing NULL." Add a normalization helper at write sites that converts `""` → `null` *before* the encrypt step. Add a unit test for empty-string round-trip.

### 3. Boot race: `bootPhase2` is synchronous, `EnvVarMasterKeyProvider.load()` returns Promise — CRITICAL
**Steps**:
1. The spec's Boot wiring (§C) writes `new EnvelopeEncryption(await new EnvVarMasterKeyProvider().load())`.
2. `bootPhase2` in `src/boot.ts` is a **synchronous** function (`export function bootPhase2(opts): Phase2Bootstrap | null`, no `async`). It returns the wired `AuthHandlerContext` immediately.
3. There is nowhere in the existing boot sequence to `await` the key provider without making `bootPhase2` async, which is a breaking signature change.
**What goes wrong**: Either (a) the spec quietly assumes `bootPhase2` will be refactored to async — which is a non-trivial caller-side change and is not called out in §C; or (b) the implementer wires it synchronously by accident (e.g., reads `process.env` directly without the provider), bypassing the `MasterKeyProvider` abstraction the spec mandates for future KMS support; or (c) the implementer does `EnvVarMasterKeyProvider().loadSync()`-style refactor of the interface, defeating the async contract that exists specifically for future KMS providers.
**Recommendation**: Spec must explicitly state: "`bootPhase2` becomes `async`. All callers of `bootPhase2` must be updated. The provider is awaited *before* `wireAuthRoutes` is called, so no request can ever reach a call site with a half-initialized provider." Add a test asserting that `MasterKeyProvider.load()` MAY be async and is awaited.

### 4. Concurrent refresh writes race on the same user row — MAJOR
**Steps**:
1. Two concurrent MCP clients for the same user both trigger `refresh-rotation` simultaneously (e.g., two browser tabs, or a browser tab + an IDE).
2. Both fetch the same `enc:v1:<old>` token, both call the IdP refresh endpoint, both get **different** new tokens (most IdPs invalidate the old refresh on use; others issue parallel ones).
3. Both `UPDATE users SET idp_access_token = ?, idp_refresh_token = ? WHERE id = ?` (`refresh-rotation.ts:606-613`) — last writer wins. The losing writer's refresh token is now orphaned at the IdP and revoked at next use.
**What goes wrong**: This race exists today with plaintext tokens, but encryption changes nothing AND the spec does not flag it. After encryption, the row containing the losing writer's encrypted token is also lost — which means we cannot even forensically recover by reading the plaintext. The spec should at minimum acknowledge this is not a regression but is also not solved.
**Recommendation**: Out of scope to fix, but the spec should explicitly say "encryption does not change the existing concurrent-refresh race semantics. See [issue]/[deferred work]." Add a `WHERE idp_refresh_token = ?` (old value) compare-and-swap to UPDATE in a follow-up. Currently the spec is silent.

### 5. Token plaintext literally starts with `"enc:v1:"` — MAJOR
**Steps**:
1. An OIDC provider operator names a custom token format that begins with `enc:v1:` (extremely unlikely for real IdPs but possible for testing fixtures, mock servers, contract-test stubs).
2. On UPDATE, the value is encrypted normally → stored as `enc:v1:<base64>` (no collision).
3. On read of a **pre-encryption-era row** that happens to begin with `enc:v1:`, the decrypt path (`envelope-encryption.ts:153`) skips passthrough and tries to decrypt actual user data as base64url ciphertext.
4. `Buffer.from(rest, "base64url")` succeeds (any string that happens to be ≥1 valid base64url char succeeds; invalid chars are silently dropped on Node, throw on Bun strict mode).
5. `createDecipheriv` fails authentication tag check → throws.
**What goes wrong**: Per spec §D, decrypt errors return `null` and force re-auth — so the user is silently logged out with a generic error and a "wrong key?" log line. Operator sees a spurious "MASTER KEY CANNOT DECRYPT" alert in production. Worse, in lazy-migration mode this row will never be encrypted because the migrator skips `LIKE 'enc:v1:%'`.
**Recommendation**: Use a prefix that is **statistically impossible** in any real OAuth token: `\x00enc:v1:` (leading NUL byte — SQLite TEXT stores it; OAuth tokens never contain NUL) or a longer magic like `mccenc:v1:` ("mcp-coordinator encryption"). Document the choice. Add a test asserting "a plaintext value that begins with the prefix triggers a clear `MalformedCiphertext` error distinct from `DecryptionFailed`, and is detectable in the migrator."

### 6. Migration race: lazy migration vs. concurrent refresh writes — MAJOR
**Steps**:
1. Operator runs `mcp-coordinator migrate-idp-tokens` while the daemon is live.
2. Migrator reads a batch of 100 user rows, gets `idp_access_token = "ya29.plaintext..."` (legacy plaintext).
3. Before migrator's UPDATE commits, the daemon's refresh-rotation path runs for that same user, writes `enc:v1:<new_token>`.
4. Migrator's UPDATE fires with `enc:v1:<encrypted_old_token>` — overwrites the daemon's new token.
**What goes wrong**: The user's freshly-refreshed access token is silently replaced with the encrypted version of the old (now-revoked-at-IdP) token. On next refresh attempt the IdP returns 401, the refresh path runs, but the refresh-token-encrypted-from-old-state may also be stale → user forced into full re-login.
**Recommendation**: Migrator must use a compare-and-swap: `UPDATE users SET idp_access_token = ? WHERE id = ? AND idp_access_token = ?` (bind the exact plaintext value the migrator read). If 0 rows affected, skip and log. Spec should mandate this and add a test simulating concurrent write during batch processing.

### 7. Two parallel `migrate-idp-tokens` processes — MAJOR
**Steps**:
1. Operator runs the migration in tmux, walks away, comes back, forgets, runs it again from a second shell.
2. Both processes read the same batch of 100 plaintext rows.
3. Process A encrypts and writes `enc:v1:<A_blob>`. Process B encrypts the **same plaintext** with a different random DEK → produces `enc:v1:<B_blob>` and writes it.
4. After B's commit, A's batch is unreadable but B's encryption is valid. Net: data is fine but wasted work and tx contention.
**What goes wrong**: With SQLite WAL mode (confirmed in `database.ts:323`), writers serialize but each batch tx still completes — no corruption, but the migrator may produce confusing progress logs ("encrypted 1500 rows" when 750 were double-counted). If the spec ever adds a `--rotate` flag (deferred per §Rotation), running two rotators in parallel WILL corrupt rows depending on read-write ordering.
**Recommendation**: `migrate-idp-tokens` should acquire an advisory lock by inserting a sentinel row into a `migration_lock` table (or using `BEGIN IMMEDIATE` + a sentinel UPDATE) and refusing to start if another process holds it. Spec must call out this requirement explicitly before `--rotate` lands.

### 8. Master key swapped between two daemon starts — silent half-corruption — CRITICAL
**Steps**:
1. Day 1: Operator sets `COORDINATOR_ENCRYPTION_KEY=<keyA>`, daemon runs for a week, accumulates 500 encrypted rows.
2. Day 8: Operator rotates env vars in their secret manager, fat-fingers `COORDINATOR_ENCRYPTION_KEY=<keyB>` (typo, or wrong secret promoted).
3. Daemon restarts. `EnvVarMasterKeyProvider.load()` validates 32-byte length — passes (keyB is well-formed, just wrong). Boot succeeds.
4. First user login: writes are encrypted with keyB. Existing rows encrypted with keyA cannot be decrypted (auth tag fails).
5. Per spec §D: decrypt errors are logged at ERROR + user is forced to re-auth. Users re-login one-by-one. Within hours, the entire user table is mixed keyA/keyB ciphertexts.
6. Operator notices the spike in re-logins, investigates, swaps env back to keyA. Now the keyB rows are unreadable.
**What goes wrong**: Silent slow-motion data loss. By the time the operator realizes, half the rows are encrypted with keyA and half with keyB. There is no way to recover without both keys, and no way for the system to even *know* this is happening.
**Recommendation**: Spec MUST add a key fingerprint check at boot:
- Persist a `key_id` to a `system_config` row (HMAC-SHA256 of the master key, first 8 bytes hex). On boot, compute fingerprint of `COORDINATOR_ENCRYPTION_KEY`, compare against stored value. If different AND there are existing `enc:v1:` rows: **refuse to boot** with a clear message. Override via `COORDINATOR_ENCRYPTION_KEY_ROTATED=true`.
- This is the operational equivalent of the existing `COORDINATOR_ALLOW_RESTORE` pattern already in `boot.ts:378`.
- Without this, the spec's `verify-encryption-key` CLI is an *opt-in* check that operators will skip; the boot check is fail-closed.

### 9. `verify-encryption-key` only checks one row, race vs. concurrent writes — MINOR
**Steps**:
1. Operator runs `verify-encryption-key` during a key-rotation window where some rows are old-key and some are new-key (per #8 above, this is exactly the state to detect).
2. Per spec §E: SELECTs the **first** encrypted row, decrypts. Returns OK if that one row decrypts.
3. The "first row" (by SQLite's natural order, likely ROWID) happens to be a new-key row → OK exit. Operator considers verification passed. Old-key rows are silently broken.
**What goes wrong**: False positive on key-correctness. The CLI conveys more confidence than the check warrants.
**Recommendation**: `verify-encryption-key` should sample at least N (e.g., 10) rows spread across the table (e.g., `SELECT ... ORDER BY RANDOM() LIMIT 10`) and report success/failure counts. Or, simpler: scan all rows and report `{decryptable, undecryptable, plaintext}` counts. Spec should specify the sampling strategy.

### 10. Backup restore on a daemon without the original key — silent breakage — CRITICAL
**Steps**:
1. Production daemon at site A: key=keyA, encrypted DB backed up nightly.
2. Disaster, restore to site B from backup. Operator at site B does not have keyA (offsite key escrow lost, or the operator who set up site A is gone).
3. Operator at site B starts the daemon WITHOUT `COORDINATOR_ENCRYPTION_KEY` set.
4. Per spec §C: boot logs a warning, falls back to `PassthroughEncryption`. Daemon comes up green.
5. Per spec `EnvelopeEncryption.decrypt()` §B: with the passthrough provider, `decrypt()` literally returns the input string. So when refresh-rotation reads `enc:v1:<base64>`, it passes that **as the bearer token** to the IdP.
6. IdP returns 401 universally. All users re-auth. Their new tokens are stored as plaintext (passthrough). The old encrypted refresh tokens are now lost.
**What goes wrong**: Silent loss of all stored refresh tokens. The damage is bounded (users re-login) but the spec does not flag this and an operator running a fire-drill restore will not know to look. The boot warning is the only signal and is easy to miss in log volume.
**Recommendation**: At boot, if `COORDINATOR_ENCRYPTION_KEY` is **unset** AND the DB contains ≥1 row with `idp_access_token LIKE 'enc:v1:%'`: **refuse to boot** with: "DB contains encrypted rows but no encryption key is set. Either provide the original key, or run `mcp-coordinator clear-encrypted-tokens` to invalidate them (users re-auth)." This is the dual of #8 and similarly fail-closed.

### 11. Decrypt path returns ciphertext as plaintext on passthrough — see #10 — CRITICAL
*(Folded into #10. The mechanism — `PassthroughEncryption.decrypt(c) { return c; }` — is the same bug surface. The spec assumes passthrough is only ever paired with plaintext rows; this assumption is violated whenever encryption is turned off after being on.)*

### 12. Corrupted ciphertext from disk-bit-rot or partial write — MINOR
**Steps**:
1. SQLite page partially corrupted (filesystem error, single-bit flip in WAL).
2. `enc:v1:<base64>` deserializes but auth tag check fails on either DEK unwrap or data decrypt.
3. Per spec §D: log ERROR + user_id, return null, force re-auth.
**What goes wrong**: This is the spec's documented behavior, so it works as designed. BUT: the error path is shared with #8 (wrong-key) and #5 (false-positive-prefix). Operator sees "MASTER KEY CANNOT DECRYPT user X" and cannot distinguish bit-rot from misconfig from prefix collision.
**Recommendation**: Differentiate three error classes in the decrypt path and log each distinctly:
- `MalformedCiphertext` (base64 decode fail or wrong length) → likely prefix collision on legacy data.
- `DEKUnwrapFailed` (outer GCM tag fail) → wrong master key (operator config).
- `DataDecryptFailed` (inner GCM tag fail, outer OK) → likely bit-rot (master key is correct, DEK decoded, just the data is corrupt).
Spec should mandate this three-way split and add a test per class.

### 13. SQLite WAL mode + base64url TEXT — no concerns confirmed — NIT
**Confirmed**: `database.ts:323` sets `journal_mode = WAL`. The `enc:v1:` payload is ASCII (base64url is `[A-Za-z0-9_-]`) so the SQLite TEXT column has zero encoding concerns. No NUL bytes, no UTF-8 normalization edge cases. **No action.**

### 14. `VACUUM` after migration — confirmed safe, but spec should mention it — NIT
**Steps**: Operator runs `VACUUM` after `migrate-idp-tokens` to reclaim space (plaintext rows were shorter; encrypted rows are longer, so VACUUM may free up nothing or grow the DB — confusing).
**What goes wrong**: Nothing functionally, but operators will be surprised that "encrypting tokens made the DB bigger" (true: ~145 bytes overhead per row per spec §Storage). Spec mentions overhead but not the VACUUM-after-migration pattern.
**Recommendation**: Add a one-line note to §Migration: "After `migrate-idp-tokens`, DB size will increase by ~290 bytes per user (both columns). VACUUM is not required and will not reclaim space."

### 15. `base64url` encoding on Bun's Buffer — CONFIRM NEEDED — MINOR
**Steps**:
1. Per spec §Goals, Bun runtime must work.
2. `envelope-encryption.ts` uses `blob.toString("base64url")` and `Buffer.from(str, "base64url")`.
3. Bun's `Buffer` implements most Node encodings, but `base64url` support history is non-uniform across Bun versions.
**What goes wrong**: On older Bun (<1.0), `base64url` may fall back to `base64` (URL-unsafe chars `+/=` instead of `-_`). Round-trip works locally, but cross-runtime — encrypt on Node, decrypt on Bun, or vice-versa — silently corrupts. Probability low; mcp-coordinator likely pins Bun ≥1.x.
**Recommendation**: Spec testing section lists `tests/integration/bun-encryption.test.ts`. Explicitly test: "encrypt under Node, write to disk; read from disk, decrypt under Bun. Round-trip must succeed." And specify minimum Bun version (≥1.0.20 has confirmed base64url Buffer support).

### 16. Process kill between encrypt() and INSERT/UPDATE commit — NIT
**Steps**:
1. `oauth-finalize` encrypts the token, kernel kills the process before `db.prepare(...).run(...)` commits.
2. Encrypted blob exists in JS heap, dies with the process. No DB state mutated.
**What goes wrong**: Nothing — DB tx never committed, user just re-tries login. The plaintext token is held in memory for the encrypt() duration (~50µs per spec). Memory exposure is identical to before (token was already in memory pre-encryption). **No action.**

### 17. Forward compatibility: future `enc:v2:` read by current v0.10.5 code — MAJOR
**Steps**:
1. v0.10.6 ships `enc:v2:` (maybe a different cipher, AES-256-SIV).
2. Operator rolls back to v0.10.5 (maybe canary failed). v0.10.5 reads `enc:v2:<blob>`.
3. `EnvelopeEncryption.decrypt()` only checks `startsWith("enc:v1:")` — `enc:v2:` does NOT start with that prefix, so the passthrough branch fires: returns the literal `"enc:v2:<base64>"` as the access token. → IdP 401 → re-auth.
**What goes wrong**: Same silent-passthrough-as-bearer-token failure mode as #10. The rollback path is silently broken.
**Recommendation**: Spec must add: "decrypt() recognizes any `enc:vN:` prefix where N is any digit string. If N is unknown to this version, throw `UnknownCipherVersion` (NOT passthrough). The error handling path (re-auth) is correct, but the failure mode is explicit, not silent." Add a test: `decrypt("enc:v99:abc", ctx)` throws.

### 18. Logger redaction — `log.error("decrypt failed", { user_id })` could be over-redacted — NIT
**Steps**: Spec §D says "logged at ERROR level with the user id". If the daemon's logger has a generic PII-redaction layer (some operators add one for compliance), `user_id` may be redacted to `[REDACTED]`, making the log useless for triage.
**What goes wrong**: Operator cannot correlate the decrypt failure to a specific user without DB access. Probability low (mcp-coordinator doesn't ship with such a layer today) but worth flagging.
**Recommendation**: Spec should specify the log field key (e.g., `user_id` — already canonical in the codebase) so the redaction layer (if any) can be configured to whitelist it. NIT-level.

### 19. Existing test fixtures expect plaintext tokens — MAJOR
**Steps**:
1. `tests/unit/oauth-finalize.test.ts`, `refresh-rotation-happy.test.ts`, `refresh-rotation-reuse.test.ts`, `oauth-callback-provisioning.test.ts` (10 test files confirmed via grep) all assert on `idp_access_token` directly read from SQL.
2. When encryption is enabled in test fixtures, these assertions will see `enc:v1:<base64>` instead of the expected plaintext literal.
**What goes wrong**: Most tests will start failing on the encryption-enabled CI lane. Spec §Testing lists *new* tests but does not address the migration of existing tests.
**Recommendation**: Spec should explicitly say: "existing tests will run with `PassthroughEncryption` to preserve current assertions. A new test lane runs the suite with `EnvelopeEncryption` and an instance-helper that decrypts before asserting." OR: "Existing tests will be updated to use a `selectIdpToken(db, userId)` helper that decrypts via the test's encryption provider, so they work under both modes." Pick one; don't leave it implicit.

### 20. `EncryptionContext` is passed but ignored — silent integrity gap — MINOR
**Steps**: Per spec §B, `_context: EncryptionContext` is unused in v0.10.5. The crypto blob does NOT bind to `org_id` or `column`. So a stored ciphertext from `idp_access_token` could theoretically be swapped into `idp_refresh_token` (or vice-versa) by an attacker with DB write access — and would decrypt cleanly.
**What goes wrong**: Defense-in-depth weakness. Not a confidentiality break (attacker already has DB write), but the spec's interface design implies binding that isn't there.
**Recommendation**: Either (a) actually use `context` as GCM AAD (`cipherData.setAAD(Buffer.from(JSON.stringify(context)))`) — small change, real value, future-compatible with per-org/per-column keys; or (b) explicitly document "context is ignored in v1, will be bound as AAD starting v2; rotating to v2 requires migration." Currently it's neither — the unused parameter signals false rigor.

### 21. Decrypt returns null forces re-auth — but the user is mid-session — MINOR
**Steps**: Per spec §D, decrypt failure on `refresh-rotation` returns null and "forces re-auth". The user has a valid mcp-coordinator session JWT in their cookie (separate from the IdP token) and is mid-MCP-call.
**What goes wrong**: Spec is ambiguous about what "force re-auth" means at the call-site level. Does the current MCP call 401? Does the user get redirected? Does the session JWT get invalidated (bump token_epoch)? The current `refresh-rotation.ts` paths handle IdP-revoked separately — the spec needs to specify exactly which existing branch decryption failures fall into.
**Recommendation**: Spec should explicitly state: "decrypt failure is treated identically to `IdPTokenRevoked` — same audit event, same response code, same `token_epoch` bump policy." Or whatever the chosen policy is. Currently it's a behavioral hole.

## Headline gaps to fix before implementation

1. **NULL/empty handling at call sites** (#1, #2): the spec's "wrap with `encryptionProvider.encrypt(...)`" gloss is wrong for the actual nullable columns.
2. **Boot async-ness** (#3): `bootPhase2` is sync, the provider is async. Caller refactor is not addressed.
3. **Silent key-misconfiguration paths** (#8, #10): need fail-closed boot checks dual to the existing `COORDINATOR_ALLOW_RESTORE` pattern.
4. **Migration race vs. live writes** (#6, #7): compare-and-swap UPDATE + advisory lock.
5. **Forward-compat passthrough silently treats `enc:v2:` as plaintext** (#17).
6. **Existing test fixtures break** (#19): spec doesn't address the migration path.
