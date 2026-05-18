# IdP token encryption — implementation plan v1

> **For agentic workers**: REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task is an atomic PR. Acceptance = all listed test files pass + lint clean + coverage gate met.

## Status

**Plan version**: v1 (initial draft, pre-review)
**Version target**: mcp-coordinator@0.10.5
**Date**: 2026-05-17
**Spec**: `docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md` (V2)
**Spec patches**: `docs/superpowers/specs/2026-05-17-idp-token-encryption-design-V3-patches.md`
**Review trail**: `docs/superpowers/working/v0.10.5-idp-encryption/round1/` (6 reviewers) + `round2/` (3 reviewers)

## Revisions

(Empty — initial draft. Each plan-review round adds a revision section here.)

## Plan structure

15 tasks across 6 phases. Phase ordering reflects dependencies; tasks within a phase may run sequentially or in parallel as noted.

```
Phase A — Foundation refactors           (T01-T02)   prep work, no crypto. Mergeable independently.
Phase B — Encryption primitives          (T03-T05)   pure modules + unit tests. Parallel after T03.
Phase C — Boot wiring                    (T06-T07)   integrate provider; daemon-spawn fix.
Phase D — Read/write integration         (T08-T09)   oauth-finalize + refresh-rotation use the provider.
Phase E — CLI                            (T10-T11)   operator tools.
Phase F — Observability + docs + ship    (T12-T14)   metrics, docs, release.
```

### Dependency DAG

```
T01 (system_config + boot deps inj) ─┬─→ T03 (encryption.ts)
                                     │      ├─→ T04 (envelope) ─┐
                                     │      └─→ T05 (master-key)─┴─→ T06 (boot integration) ─┬─→ T07 (start.ts fwd)
                                     │                                                        ├─→ T08 (oauth-finalize)
                                     │                                                        ├─→ T09 (refresh-rotation)
                                     │                                                        ├─→ T10 (CLI migrate)
                                     │                                                        ├─→ T11 (CLI verify+fp)
                                     │                                                        ├─→ T12 (observability)
                                     │                                                        └─→ T13 (docs)
T02 (provisionUser options) ─────────┴─→ T08 (oauth-finalize uses new signature)
                                          ├─→ also touches T10, T11 call-site doc

T13 ─→ T14 (release)
```

T01 + T02 can ship as separate small PRs immediately, decoupled from encryption work. T03 unblocks the rest.

### LOC budget (rough)

| Phase | Tasks | LOC (impl + tests) | PRs |
|---|---|---|---|
| A | T01-T02 | ~300 | 2 |
| B | T03-T05 | ~600 | 1-3 |
| C | T06-T07 | ~400 | 2 |
| D | T08-T09 | ~250 | 2 |
| E | T10-T11 | ~500 | 2 |
| F | T12-T14 | ~400 | 2 |
| **Total** | **15** | **~2450** | **11-13** |

---

# Phase A — Foundation refactors

These tasks reshape signatures and add a table. Zero encryption code. Mergeable independently; they unblock everything downstream.

## T01: `system_config` table + `bootPhase2` injectable deps

**Size**: ~150 LOC (DDL + bootPhase2 signature refactor + tests)
**Dependencies**: none
**Spec refs**: PATCH 5 (CREATE TABLE), PATCH 14 (bootPhase2 deps), PATCH 6 (placement)

**Files touched**:
- `src/database.ts` — add `CREATE TABLE IF NOT EXISTS system_config (...)` to the SCHEMA block.
- `src/boot.ts` — change `bootPhase2(opts)` to `bootPhase2(opts, deps?: BootPhase2Deps)` with default fallback to globals.
- `tests/unit/database-system-config.test.ts` (NEW) — assert table exists post-init; insert/select round-trip; PRIMARY KEY on `key`.
- `tests/unit/boot-deps-injection.test.ts` (NEW) — invoke `bootPhase2(opts, { db: inMemoryDb, env: synthEnv, logger: fakeLogger })`; assert deps used, no global access.

**Implementation summary**:
1. In `src/database.ts` SCHEMA, after existing table CREATEs:
   ```sql
   CREATE TABLE IF NOT EXISTS system_config (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
   );
   ```
2. In `src/boot.ts`, define `BootPhase2Deps` interface (optional fields). At top of `bootPhase2`, resolve each dep via `??` fallback to existing global access.
3. No `bootPhase2` callers change (deps default-undefined). Verify by running existing tests.

**Acceptance**:
- New test suite green.
- All existing tests still pass (signature is backward-compat).
- Coverage gate: no new uncovered lines in `boot.ts` (existing 100% threshold preserved).
- Lint clean.

---

## T02: `provisionUser` → options-object signature

**Size**: ~150 LOC (signature change + 3 call sites + existing tests updated)
**Dependencies**: none
**Spec refs**: PATCH 4 (signature)

**Files touched**:
- `src/auth/oauth-finalize.ts` — rewrite `provisionUser(...)` to `provisionUser(args: ProvisionUserArgs)`.
- `src/auth/oauth-callback.ts:366` — update call site.
- `src/auth/oauth-token.ts:229` — update call site.
- `tests/unit/oauth-finalize.test.ts` and any other tests that call `provisionUser` directly — update to options-object.

**Implementation summary**:
1. Define `ProvisionUserArgs` interface in `oauth-finalize.ts` (do NOT include `encryption` yet — that comes in T08; this PR is the pure refactor).
2. Refactor function body: `const { db, clock, idpUser, accessToken, allowlistOrg, providerName, idpRefreshToken } = args;`.
3. Update 3 callers to pass an object literal.
4. Grep verify zero remaining positional callers (use bash: `grep -rn "provisionUser(" src/ tests/`).

**Acceptance**:
- All existing tests pass unchanged in behavior.
- TypeScript compile clean (positional callers would fail loudly).
- Lint clean.
- This is a pure refactor — no behavior change.

---

# Phase B — Encryption primitives

Pure modules. Heavy unit testing. T03 unblocks T04 and T05 which can run in parallel.

## T03: `encryption.ts` interface + error classes + helpers

**Size**: ~200 LOC (types + 5 error classes + 2 helpers + tests)
**Dependencies**: none (does not depend on T01/T02)
**Spec refs**: V2 §B (interface), PATCH 1 (no change to interface but enables AAD), V2 §C (helpers)

**Files touched**:
- `src/security/encryption.ts` — extend with:
  - tightened `EncryptionContext` (column literal union + user_id required)
  - `EncryptionProvider` (remove `hmac`)
  - `PassthroughEncryption` (updated to new interface)
  - `DecryptionError` + 3 subclasses + `UnknownCipherVersion`
- `src/security/encrypt-nullable.ts` (NEW) — `encryptNullable` + `decryptNullable` helpers.
- `tests/unit/encryption-types.test.ts` (NEW) — error class instanceof chain; subclass identity.
- `tests/unit/encrypt-nullable.test.ts` (NEW) — NULL → null; `""` → null; non-empty → calls provider.exact.

**Implementation summary**:
1. Rewrite `src/security/encryption.ts`:
   ```typescript
   export interface EncryptionContext {
     org_id: string;
     column: "idp_access_token" | "idp_refresh_token";
     user_id: string;
   }
   export interface EncryptionProvider {
     encrypt(plaintext: string, context: EncryptionContext): string;
     decrypt(ciphertext: string, context: EncryptionContext): string;
   }
   export class PassthroughEncryption implements EncryptionProvider {
     encrypt(p: string, _ctx: EncryptionContext): string { return p; }
     decrypt(c: string, _ctx: EncryptionContext): string { return c; }
   }
   export class DecryptionError extends Error { ... }
   export class MalformedCiphertext extends DecryptionError { ... }
   export class DEKUnwrapFailed extends DecryptionError { ... }
   export class DataDecryptFailed extends DecryptionError { ... }
   export class UnknownCipherVersion extends Error { ... }
   ```
2. Create `src/security/encrypt-nullable.ts` with both helpers (per V2 §C).
3. Add per-file coverage threshold entries in `vitest.config.ts` for both new files (100%).

**Acceptance**:
- Test suites green.
- 100% coverage on both new files.
- `PassthroughEncryption.test.ts` (if exists) updated to new signature.
- Compile clean.

---

## T04: `envelope-encryption.ts` (AAD-bound, three-class errors, version-pinned)

**Size**: ~250 LOC (provider + AAD encoder + tests including swap matrix)
**Dependencies**: T03
**Spec refs**: V2 §B (provider), PATCH 1 (AAD length-prefixed), PATCH 13 (regex bounds)

**Files touched**:
- `src/security/envelope-encryption.ts` (NEW) — `EnvelopeEncryption` class.
- `tests/unit/envelope-encryption.test.ts` (NEW) — comprehensive tests.

**Implementation summary**:
1. Implement `EnvelopeEncryption` per V2 §B with PATCH 1 AAD encoding:
   - `aad()` private method returns length-prefixed binary Buffer (PATCH 1).
   - `encrypt`/`decrypt` call `cipher.setAAD(this.aad(ctx))` on the data layer.
   - `VERSION_RE = /^enc:v([1-9]\d{0,2}):/` (PATCH 13).
   - Three-class error routing per V2 §B.
   - DEK `fill(0)` in `finally`.
2. Constructor validates 32-byte master key with actionable error message.

**Test cases** (mandatory — exhaustive):
- Round-trip: plaintext in, plaintext out for a 200-byte token.
- Round-trip with binary content (NUL bytes, multi-byte UTF-8).
- Wrong master key: instantiate two providers with different keys, encrypt with A, decrypt with B → throws `DEKUnwrapFailed`.
- Wrong AAD swap matrix (3 cases — cross-row, cross-column, cross-user) → all throw `DataDecryptFailed`.
- Malformed base64url → throws `MalformedCiphertext`.
- Truncated ciphertext (< 88 bytes) → throws `MalformedCiphertext` with explicit length message.
- Unknown version (`enc:v2:...`) → throws `UnknownCipherVersion`.
- Out-of-range version (`enc:v0:...`, `enc:v1000:...`, `enc:v01:...`) → throws `MalformedCiphertext` (per PATCH 13 distinction).
- Passthrough on missing `enc:` prefix → returns input.
- Format injection forcing-function test (PATCH 1): demonstrate length-prefixed encoding does NOT collide on hostile `org_id` containing `|`.
- Deterministic decode of fixed test vectors (3-4 pinned `enc:v1:...` strings with known plaintext for regression).

**Acceptance**:
- All tests pass.
- 100% coverage on `src/security/envelope-encryption.ts`.
- Test file ~300 LOC.

---

## T05: `master-key.ts` utilities (decode + entropy + fingerprint)

**Size**: ~200 LOC (decode + entropy + fingerprint + helpers + tests)
**Dependencies**: T03
**Spec refs**: V2 §A (decode/entropy), PATCH 2 (refuse low entropy), PATCH 9 (HMAC fingerprint)

**Files touched**:
- `src/security/master-key.ts` (NEW) — exports `decodeMasterKey`, `shannonEntropyBitsPerByte`, `computeKeyFingerprint`.
- `tests/unit/master-key.test.ts` (NEW).

**Implementation summary**:
1. `decodeMasterKey(trimmed: string): Buffer` per V2 §A + PATCH 2 entropy refuse:
   - alphabet detection (hex/base64/base64url), refuse none-match.
   - Length check 32 bytes after decode.
   - Entropy: `< 3.0` throws, `3.0-4.5` warn via injected logger (`(logger?: pino.Logger)` second param).
2. `shannonEntropyBitsPerByte(key: Buffer): number` — standard Shannon entropy over byte frequencies.
3. `computeKeyFingerprint(masterKey: Buffer): string` — HMAC-SHA256 with label `"mcc-fingerprint-v1"`, 16 hex chars (PATCH 9).

**Test cases**:
- hex/base64/base64url accept paths.
- Wrong-length input rejected with clear message.
- `Buffer.alloc(32, 0xaa)` encoded as base64 → throws "catastrophically low entropy".
- Repeated 4-char pattern: warning logged but boot succeeds.
- Random 32-byte key: silent acceptance.
- `decodeMasterKey("   <key>   \n")` — trims whitespace, succeeds.
- `decodeMasterKey("not-a-valid-format-string")` → throws.
- Fingerprint stability: same key → same 16-hex output (deterministic).
- Fingerprint length: exactly 16 hex chars (64 bits).
- Fingerprint of two different keys → distinct outputs.

**Acceptance**:
- All tests pass.
- 100% coverage on `src/security/master-key.ts`.

---

# Phase C — Boot wiring

## T06: `bootPhase2` encryption integration

**Size**: ~350 LOC (boot integration + wrapped provider + guards + observability + tests with branch matrix)
**Dependencies**: T01, T03, T04, T05
**Spec refs**: V2 §D (guards), PATCH 6 (placement), PATCH 7 (wrapped provider), PATCH 10 (TOKEN_LOSS confirm), PATCH 11 (reminder + teardown), PATCH 3 (GLOB)

**Files touched**:
- `src/boot.ts` — add encryption integration block (placement: between current step 8 and step 9 per PATCH 6).
- `src/auth/context.ts` — add `encryptionProvider: EncryptionProvider` + `encryptionKeyFingerprint: string | null` to `AuthHandlerContext`.
- `tests/unit/boot-encryption-guards.test.ts` (NEW) — branch matrix.
- `tests/unit/boot-encryption-wrapper.test.ts` (NEW) — wrapped provider fingerprint persistence.

**Implementation summary**:
1. Load master key: read `deps.env.COORDINATOR_ENCRYPTION_KEY`, call `decodeMasterKey()` if present.
2. Compute fingerprint via `computeKeyFingerprint()`.
3. Strict-mode guards using `GLOB 'enc:v[0-9]*:*'` (PATCH 3):
   - Guard 1: encrypted rows + no key → throw `BootValidationError` unless `ALLOW_TOKEN_LOSS=1` AND `TOKEN_LOSS_CONFIRM` matches (PATCH 10).
     - On override: create `encryption_invalidated_tokens` table (PATCH 10), stash ciphertexts, NULL rows, emit per-user audit.
   - Guard 2: encrypted rows + key + storedFingerprint mismatch → throw unless `ALLOW_KEY_ROTATION=1`.
   - Backfill fingerprint to `system_config` if encrypted rows exist and storedFingerprint is null and key present.
4. Build wrapped provider per PATCH 7. Persistence on first encrypt via `INSERT OR IGNORE`.
5. Attach wrapped provider + fingerprint to `AuthHandlerContext`.
6. Plaintext warning + 24h reminder via pino logger (PATCH 11). Store interval handle in `Phase2Bootstrap.shutdown`.
7. Emit `encryption.config.loaded` audit at boot (tier 1).

**Test cases** (branch matrix per PATCH 17 + V2 testing section):

| # | hasEncryptedRows | key present | storedFingerprint | ALLOW_TOKEN_LOSS | TOKEN_LOSS_CONFIRM | ALLOW_KEY_ROTATION | Expected |
|---|---|---|---|---|---|---|---|
| 1 | false | false | n/a | n/a | n/a | n/a | OK boot, plaintext warning |
| 2 | false | true | null | n/a | n/a | n/a | OK boot, fingerprint will be written on first encrypt |
| 3 | true | true | match | n/a | n/a | n/a | OK boot |
| 4 | true | true | null | n/a | n/a | n/a | OK boot, fingerprint backfilled now |
| 5 | true | false | n/a | unset | n/a | n/a | throw BootValidationError |
| 6 | true | false | n/a | "1" | wrong | n/a | throw BootValidationError (confirm mismatch) |
| 7 | true | false | n/a | "1" | correct | n/a | NULLs rows + per-user audit + stash |
| 8 | true | true | mismatch | n/a | n/a | unset | throw BootValidationError |
| 9 | true | true | mismatch | n/a | n/a | "1" | OK boot, new fingerprint on first encrypt |
| 10 | n/a | true | n/a (low entropy key) | n/a | n/a | n/a | throw (entropy < 3.0) |
| 11 | n/a | true | n/a (medium entropy key) | n/a | n/a | n/a | OK with logger warn |
| 12 | n/a | true (malformed length) | n/a | n/a | n/a | n/a | throw decode error |

Plus:
- NODE_ENV=production + no key → assert ERROR-level log (spy on logger).
- NODE_ENV=development + no key → assert WARN-level log.
- 24h reminder: `vi.useFakeTimers(); vi.advanceTimersByTime(86_400_000); expect(logger[level]).toHaveBeenCalledTimes(2);` Re-advance to test multiple intervals.
- Wrapped provider first encrypt: assert `system_config` row inserted + `encryption.config.loaded` audit emitted exactly once.
- Wrapped provider Nth encrypt: assert no additional inserts (idempotent).
- Concurrent first-encrypt race: simulate two parallel `encrypt()` calls → both succeed, exactly one INSERT row in `system_config`.
- `Phase2Bootstrap.shutdown()` clears the reminder interval.
- `bootPhase2` is sync (`expect(bootPhase2(opts, deps)).not.toBeInstanceOf(Promise);` and TS type-check).
- DI wiring: `ctx.encryptionProvider instanceof <wrapped>` with key, `instanceof PassthroughEncryption` without.

**Acceptance**:
- All ~25 test cases pass.
- 100% coverage on the new `src/boot.ts` lines.
- Existing boot tests unchanged behavior.
- `Phase2Bootstrap` exports `keyFingerprint: string | null` and `shutdown` clears reminder.

---

## T07: `cli/server/start.ts` daemon-spawn env forwarding

**Size**: ~50 LOC (3 `fwd` lines + test + small doc note)
**Dependencies**: T06 (env vars defined)
**Spec refs**: V2 §"Daemon-spawn forwarding", PATCH 14

**Files touched**:
- `cli/server/start.ts` — add 3 `fwd(...)` lines.
- `tests/unit/cli-server-start-env-forwarding.test.ts` (NEW).

**Implementation summary**:
1. In `cli/server/start.ts:66-91` (the `childEnv` block), add:
   ```typescript
   fwd("COORDINATOR_ENCRYPTION_KEY", process.env.COORDINATOR_ENCRYPTION_KEY);
   fwd("COORDINATOR_ALLOW_TOKEN_LOSS", process.env.COORDINATOR_ALLOW_TOKEN_LOSS);
   fwd("COORDINATOR_TOKEN_LOSS_CONFIRM", process.env.COORDINATOR_TOKEN_LOSS_CONFIRM);
   fwd("COORDINATOR_ALLOW_KEY_ROTATION", process.env.COORDINATOR_ALLOW_KEY_ROTATION);
   ```

**Test cases**:
- Mock `child_process.spawn`; invoke `serverStart({ daemon: true })`; assert `spawn.mock.calls[0][2].env.COORDINATOR_ENCRYPTION_KEY === parentEnv.COORDINATOR_ENCRYPTION_KEY`.
- Same for the 3 other vars.
- When parent env var is undefined: assert child env does NOT contain the key (verify `fwd` skipping behavior).

**Acceptance**: tests pass, coverage preserved.

---

# Phase D — Read/write integration

## T08: `oauth-finalize.ts` internal — encrypt at write sites

**Size**: ~100 LOC (encrypt at INSERT + UPDATE + tests)
**Dependencies**: T02 (options-object signature), T03 (helpers), T06 (provider in context)
**Spec refs**: V2 §"DI wiring → oauth-finalize.ts"

**Files touched**:
- `src/auth/oauth-finalize.ts` — extend `ProvisionUserArgs` with `encryption: EncryptionProvider`; use `encryptNullable` at both bind sites (UPDATE line ~88-90, INSERT line ~107-119).
- `src/auth/oauth-callback.ts:366` — pass `encryption: ctx.encryptionProvider` in the args object.
- `src/auth/oauth-token.ts:229` — same.
- `tests/integration/oauth-finalize-encrypted.test.ts` (NEW) — login with encryption on, verify DB row is `enc:v1:`, verify first-encrypt fingerprint persistence.
- `tests/integration/oauth-callback-encrypted.test.ts` (NEW) — encrypted flow through browser callback (C6 gap).
- `tests/integration/oauth-token-encrypted.test.ts` (NEW) — encrypted flow through CLI grant (C6 gap).

**Implementation summary**:
1. Add `encryption: EncryptionProvider` to `ProvisionUserArgs`.
2. Inside `provisionUser`, for new user: compute `user_id` first, then construct `ctx_a = { org_id: allowlistOrg.org_id, column: "idp_access_token", user_id }` and `ctx_r` similarly, then bind with `encryptNullable(encryption, accessToken, ctx_a)` / `encryptNullable(encryption, idpRefreshToken, ctx_r)`.
3. For returning user: same pattern.
4. Update 2 callers (oauth-callback, oauth-token) to pass `encryption: ctx.encryptionProvider`.

**Test cases**:
- Login → `SELECT idp_access_token FROM users` returns string starting with `enc:v1:`.
- Login + decrypt with `selectIdpToken` helper → original token string.
- Login with `idpRefreshToken: null` → `idp_refresh_token` is SQL NULL (not encrypted empty).
- Login with `idpRefreshToken: ""` → `idp_refresh_token` is SQL NULL (PATCH C13).
- First successful login on fresh DB → `system_config.encryption.key_fingerprint` populated.
- 2nd login → no additional fingerprint row.

**Acceptance**: tests pass, coverage preserved, all 3 call sites exercised under encryption.

---

## T09: `refresh-rotation.ts` — read + write + sync error mapping

**Size**: ~150 LOC (SELECT extension + decrypt try/catch + write bind + tests)
**Dependencies**: T03, T06, T08
**Spec refs**: V2 §"DI wiring → refresh-rotation.ts", PATCH 8 (SELECT + sync error mapping)

**Files touched**:
- `src/auth/refresh-rotation.ts` — extend SELECT at line 547 to fetch `primary_org_id`; wrap decrypt in sync try/catch with `DecryptionError`/`UnknownCipherVersion` mapping to IdPTokenRevoked-equivalent (PATCH 8); use `encryptNullable` at UPDATE line ~607.
- `tests/integration/refresh-rotation-encrypted.test.ts` (NEW) — full round-trip + 3 explicit error-equivalence assertions.
- `tests/integration/lazy-migration-tolerance.test.ts` (NEW) — seed user with plaintext, refresh succeeds + becomes `enc:v1:` (C14 gap).

**Implementation summary**:
1. Update SELECT to `SELECT idp_access_token, idp_refresh_token, idp_provider, primary_org_id FROM users WHERE id = ?`.
2. After destructuring, wrap decrypt in try/catch per PATCH 8 — exact code shape provided in the spec patches.
3. On UPDATE (line ~607), use `encryptNullable(ctx.encryptionProvider, newAccess, ctx_a)` / `encryptNullable(...)`.

**Test cases**:
- Refresh with plaintext row in DB → succeeds, row becomes `enc:v1:` after the UPDATE.
- Refresh with `enc:v1:` row → decrypts, IdP call, re-encrypts. Round-trip equality.
- Refresh with `enc:v1:` row + provider has wrong key → throws `DEKUnwrapFailed` → mapped to IdPTokenRevoked path:
  - `encryption.decrypt.failed` audit emitted with `error_class: "DEKUnwrapFailed"`.
  - `auth.idp.token_revoked` audit emitted with `phase: "refresh_decrypt_failed"`.
  - Response: HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`.
  - `token_epoch` for the user incremented by exactly 1.
- Refresh with `enc:v99:` row → throws `UnknownCipherVersion` → same mapped path.
- Refresh with attacker-overwritten plaintext (was `enc:v1:`, now `garbage`) → no decrypt error (no prefix), passes garbage as bearer token to IdP, IdP 401 → existing IdPTokenRevoked path → re-auth (proves silent-downgrade attacker scenario is contained, C2 gap).

**Acceptance**: tests pass, coverage preserved.

---

# Phase E — CLI

## T10: `cli/encryption/migrate.ts` (encrypt + decrypt directions, CAS, lock)

**Size**: ~300 LOC (CLI + lock + batched migration + tests)
**Dependencies**: T03, T04, T05, T06
**Spec refs**: V2 §Migration CLI, PATCH 3 (GLOB), PATCH 15 (lock)

**Files touched**:
- `cli/encryption/index.ts` (NEW) — subcommand group factory.
- `cli/encryption/migrate.ts` (NEW).
- `cli/index.ts` — `program.addCommand(createEncryptionCommand())`.
- `tests/unit/cli-encryption-migrate.test.ts` (NEW).

**Implementation summary**:
1. Subcommand group: `program.command("encryption").addCommand(migrate).addCommand(verify).addCommand(fingerprint)`.
2. `migrate` accepts `--direction encrypt|decrypt`, `--batch-size N` (default 100), `--force`.
3. Check `getRunningCoordinatorPid()` (from `cli/server/backup.js`); refuse unless `--force`.
4. Acquire PID-in-content lock per PATCH 15.
5. Open DB via `loadConfig() + initDatabase()` (existing pattern from other CLIs).
6. Load encryption key via `decodeMasterKey()`; build `EnvelopeEncryption`.
7. Loop batches with GLOB filter per PATCH 3.
8. For each row: encrypt non-null non-empty values, UPDATE with CAS (`AND idp_*_token = ?` prior plaintext). 0 rows = log skip.
9. For decrypt direction: reverse — decrypt rows matching `GLOB 'enc:v[0-9]*:*'`, UPDATE with CAS on ciphertext.
10. Print final summary; release lock; exit 0/1/2 per `cli/doctor.ts` convention.

**Test cases**:
- Idempotent: run twice, second run no-ops.
- Mixed rows: 5 plaintext, 5 already enc:v1:, 5 null → encrypts 5, skips 10.
- Batch sizing: assert batch-size honored; `--batch-size 1` works.
- CAS skip when concurrent write: pre-mutate row between SELECT and UPDATE → 0 rows affected, logged skip, exit 1.
- Real race (extension over C18): two parallel processes, second blocks on lock or exits 2.
- Lock held by alive PID → exit 2 with "already running" message.
- Lock held by dead PID → stale-lock recovery succeeds.
- Daemon running + no `--force` → refuse with helpful message.
- Daemon running + `--force` → proceeds (with audit warning).
- Decrypt direction round-trip: encrypt then decrypt → values restored to original plaintext.
- `--direction=encrypt` followed by `--direction=decrypt` on same DB → final state == initial state.

**Acceptance**: tests pass, coverage preserved.

---

## T11: `cli/encryption/verify.ts` + `cli/encryption/fingerprint.ts`

**Size**: ~150 LOC (2 CLI commands + tests)
**Dependencies**: T05, T06
**Spec refs**: V2 §verify-semantics + V2 §fingerprint-semantics, PATCH 9 (16-hex consistency), PATCH 16

**Files touched**:
- `cli/encryption/verify.ts` (NEW).
- `cli/encryption/fingerprint.ts` (NEW).
- `cli/encryption/index.ts` — register both.
- `tests/unit/cli-encryption-verify.test.ts` (NEW).
- `tests/unit/cli-encryption-fingerprint.test.ts` (NEW).

**Implementation summary**:
1. `verify [--samples N]` (default N=10):
   - Loads key, computes fingerprint.
   - Reads `system_config.encryption.key_fingerprint`. If null and no enc rows: exit 0 ("no encrypted rows yet").
   - If stored present and mismatch: exit 2 with explicit fingerprint diff.
   - SELECTs N random rows with `GLOB 'enc:v[0-9]*:*'`, decrypts each.
   - Reports counts; exit 0 if all OK, 2 if any fail.
2. `fingerprint`:
   - Loads key from env (no DB access).
   - Validates.
   - Prints `computeKeyFingerprint(key)` (16 hex chars per PATCH 9) + newline.

**Test cases**:
- Fresh DB + key set: verify exit 0.
- Encrypted DB + correct key: verify exit 0 with counts.
- Encrypted DB + wrong key: verify exit 2, error message names both fingerprints.
- Mixed pass/fail (corrupted row injected): verify reports per-class counts, exit 2.
- fingerprint with valid key: prints exactly 16 hex chars + newline.
- fingerprint with missing key: clear error, exit 2.
- fingerprint runs without coordinator.db present (no DB needed).
- Same key always prints same fingerprint (deterministic).

**Acceptance**: tests pass, coverage preserved.

---

# Phase F — Observability + docs + ship

## T12: Metrics + audit events + `/health/ready` block + logger redact

**Size**: ~200 LOC (3 metrics + audit emission sites + readiness + redact + tests)
**Dependencies**: T03, T06, T09, T10
**Spec refs**: V2 §Observability, PATCH 12 (status not ready), PATCH 17 (tiers + user_id_hash)

**Files touched**:
- `src/observability/metrics.ts` — add 3 prom registries.
- `src/security/audit.ts` (or audit-helpers) — verify 5 new event types fit existing API.
- `src/http/health.ts` — extend readiness payload with `encryption` block; add `getEncryptionStatus()` accessor.
- `src/observability/logger.ts` — append `"*.idp_refresh_token"` to `REDACT_PATHS`.
- `tests/unit/encryption-observability.test.ts` (NEW) — metric emit + audit assertion per event.
- `tests/integration/health-ready-encryption.test.ts` (NEW) — readiness payload shape.

**Implementation summary**:
1. Register `coordinator_idp_encryption_enabled` (gauge), `coordinator_idp_decrypt_failures_total` (counter, label `error_class`), `coordinator_idp_plaintext_rows` (gauge).
2. Emit increments at the right sites: decrypt failure in refresh-rotation (T09), gauge set at boot (T06), plaintext rows updated by `encryption verify`/`migrate`.
3. Audit events per PATCH 17 table — wire at each emission point.
4. `getEncryptionStatus()` accessor: module-level getter set at boot from `Phase2Bootstrap`. Returns `{ enabled, key_source, key_fingerprint, decrypt_failures_5m }`. The `decrypt_failures_5m` reads the prom counter's current value (operators can compute 5m rate externally).
5. `handleHealthReady` adds the `encryption` block; default empty object when accessor not set (boot incomplete).

**Test cases**:
- Induce decrypt failure → `coordinator_idp_decrypt_failures_total{error_class="DataDecryptFailed"}` incremented by 1.
- Boot with key → `coordinator_idp_encryption_enabled` is 1; without → 0.
- Each of the 5 audit events emits with the correct tier and metadata shape.
- `user_id_hash` is deterministic HMAC (PATCH 17).
- GET /health/ready returns body with `status: "ready"` (not `ready: true`) and an `encryption` block matching the spec.
- `*.idp_refresh_token` in a log object is redacted to `[Redacted]`.

**Acceptance**: tests pass, coverage preserved.

---

## T13: Documentation

**Size**: ~600 LOC (5 files updated / created)
**Dependencies**: T06 (functionality settled)
**Spec refs**: V2 §References + §Threat model + V3 PATCH 18 (risks accepted)

**Files touched**:
- `README.md` — update Compliance matrix: mark "IdP token encryption at rest" as Shipped in v0.10.5.
- `.env.example` (repo root) — add `COORDINATOR_ENCRYPTION_KEY=` with comment.
- `examples/docker-compose/.env.example` — same + Docker secret note.
- `docs/onboarding-self-host.md` — section "Encryption" under "3. Configure environment"; gotcha entry for "decrypt errors after restore"; backup note about key escrow.
- `docs/ops/encryption-key-management.md` (NEW) — mirrors `docs/ops/key-rotation.md` for the JWT key. Covers: generation, rotation procedure (with explicit "plaintext on disk during decrypt-all step" warning per PATCH 18), backup of key+fingerprint, disaster recovery (ALLOW_TOKEN_LOSS path), verify CLI usage.
- `docs/security/threat-model.md` — update residual-risk section per V2 §Threat model coverage; close the IdP token gap.

**Implementation summary**: write the docs. No tests required (doc-only). Verify links resolve in rendered Markdown.

**Acceptance**:
- All listed files updated.
- `npm run docs:check` (if exists) clean.
- No broken internal links.

---

## T14: Release v0.10.5

**Size**: ~50 LOC (release-please config + CHANGELOG verify + version bump)
**Dependencies**: T01-T13
**Spec refs**: none

**Files touched**:
- `release-please-config.json` — verify v0.10.5 entry / let release-please bump.
- `CHANGELOG.md` — auto-generated; verify content under v0.10.5 covers: encryption feature, breaking changes (none — backward-compat), migration notes, env vars added.
- `package.json` — version bump.
- `package-lock.json` — auto-update.

**Implementation summary**:
1. Open release-please PR (the bot does this).
2. Manually augment CHANGELOG with operator-facing summary if release-please auto-content is too sparse.
3. Verify `prepublishOnly` passes (`npm run build && npm test`).
4. Merge → npm publish via CI.

**Acceptance**:
- Release-please PR merged.
- `mcp-coordinator@0.10.5` on npm.
- GitHub release published.

---

# Test infrastructure (cross-cutting)

This is NOT a task but a requirement that several tasks depend on:

## `tests/helpers/encryption.ts` (NEW)

Required by T04+, T06, T08-T11, T20.

```typescript
export function makeTestEncryption(): {
  provider: EnvelopeEncryption;
  key: Buffer;
  fingerprint: string;
} {
  const key = randomBytes(32);
  return {
    provider: new EnvelopeEncryption(key),
    key,
    fingerprint: computeKeyFingerprint(key),
  };
}

export function withEncryptionEnv<T>(key: Buffer, fn: () => T): T {
  const original = process.env.COORDINATOR_ENCRYPTION_KEY;
  process.env.COORDINATOR_ENCRYPTION_KEY = key.toString("base64");
  try { return fn(); }
  finally {
    if (original === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
    else process.env.COORDINATOR_ENCRYPTION_KEY = original;
  }
}

export function selectIdpToken(
  db: DatabaseAdapter,
  userId: string,
  column: "idp_access_token" | "idp_refresh_token",
  provider: EncryptionProvider,
): string | null {
  const row = db.prepare(`SELECT ${column}, primary_org_id FROM users WHERE id = ?`).get(userId) as any;
  if (!row || row[column] === null) return null;
  return decryptNullable(provider, row[column], { org_id: row.primary_org_id, column, user_id: userId });
}
```

Place this file early in implementation; created as part of T03 (encryption.ts companion).

---

# Open questions for plan review

1. **Phase A merge order**: T01 and T02 are independent; should they ship as 2 separate PRs or 1 combined? Recommendation: 2 separate (T02 touches many call sites, easier to review alone).
2. **T06 size**: 350 LOC + 25-test branch matrix. Is this too large for one PR? Could split into T06a (load + guards) and T06b (wrapped provider + reminder). Trade-off: splitting fragments coherent feature, but eases review.
3. **T13 doc PR**: ship before T14 release or as part of the same release commit? Recommend: T13 lands first as a doc PR; T14 release-please picks up the docs automatically.
4. **Coverage gate**: should we add a CI step that fails if any new file under `src/security/` doesn't have a vitest.config threshold entry? Defense in depth.
5. **`encryption verify` exit-code 2 on "no encrypted rows yet"**: spec says exit 0 in this case ("not an error"). Confirm vs `cli/doctor.ts:877-880` convention (exit 2 = fatal). Current plan: 0 = ok, including the "nothing to verify" case.
6. **`tests/perf/`**: do we need a perf regression test for `EnvelopeEncryption.encrypt()` to ensure it stays < 100µs? Spec says ~50µs. Recommendation: NO — encryption is not on a hot path; adding a perf test adds noise.
7. **Bun CI**: confirm the project's CI matrix already runs `bun test` on the full suite, or open a separate PR to add it. Plan assumes existing CI runs both runtimes; verify before T04.

---

# What was cut from the plan (vs what spec implies)

| Cut | Reason |
|---|---|
| Dedicated Bun integration test file | R2-test redundancy 1: CI matrix run of full suite covers it. Single focused base64url round-trip in T04 unit tests is enough. |
| `--compare` flag on `encryption fingerprint` | R2-Boot#10 deferred: `encryption verify` covers the comparison. |
| Per-PR coverage report comment | Out of scope: vitest threshold failure already blocks CI. |
| Rotation `--rotate --new-key` flag | Deferred to v0.10.6 per spec §Non-goals. |
| `COORDINATOR_ENCRYPTION_KEY_FILE` Docker secrets support | Deferred to v0.10.6 per V2 §Docker exposure. ~10 LOC future addition. |
| Bench perf test for encrypt/decrypt | Not on hot path. |

---

# Review request

This plan needs Round 1 plan review. Recommended reviewer lenses:
1. **Task atomicity**: are tasks the right size? Any that need splitting/merging?
2. **Dependency graph**: missing edges? Cycles? Wrong ordering?
3. **Missing tasks**: anything the spec mandates that has no task here?
4. **Over-engineered tasks**: anything that could be simpler?
5. **Acceptance criteria**: are they specific enough that an implementer knows when they're done?
6. **LOC budgets**: rough but should be in the right order of magnitude. Any obviously wrong?

After Round 1 plan review, apply patches; then ready for subagent-driven implementation.
