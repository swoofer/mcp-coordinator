# IdP token encryption plan — V2 patches

**Date**: 2026-05-17
**Status**: V2 patches — supersedes specific sections of plan V1
**Supersedes**: `2026-05-17-idp-encryption-plan.md` V1
**Plan review trail**: `docs/superpowers/working/v0.10.5-idp-encryption/plan-round1/` (4 reviewers)
**Synthesis**: `docs/superpowers/working/v0.10.5-idp-encryption/plan-round1/00-SYNTHESIS-PLAN.md`
**Read order**: V1 plan first (overall shape + context), then this patches doc (task splits + edge fixes + precision).

## Purpose

Plan Round 1 (4 reviewers) found 46 issues against V1. Most are mechanical: 14 tasks should be 19 (5 splits + 1 merge + 2 extracts), several dependency edges are wrong, several acceptance criteria are imprecise. Architecture is sound.

V2 is patches-doc style (not full rewrite). The V1 plan body remains the authoritative description of each task; this doc patches the task list, the DAG, the acceptance criteria, and adds 5 new tasks that didn't exist in V1.

---

## PATCH 1 — Preamble: bind acceptance commands

**Supersedes**: V1 implicit "lint clean" / "tests pass" / "100% coverage" phrasing throughout.

Add to plan preamble (immediately after the existing introduction):

```
## Acceptance command bindings

Throughout this plan, the following acceptance phrases bind to specific commands:

- **"tests pass"** = `npm test` exits 0 AND no test prints `SKIP` for any newly-added file.
- **"lint clean"** = `npm run lint` exits 0.
- **"coverage gate met"** = `npm test` exits 0 with `--coverage`; vitest's per-file threshold for the task's touched files reaches 100% statements/branches/functions/lines.
- **"compile clean"** = `npm run build` exits 0.
- **"integration tests included"** = `npm test 2>&1 | tee /tmp/run.log; grep -c "tests/integration/" /tmp/run.log` returns the count expected by the task (each task lists its own count).

Each task's acceptance criteria inherit these unless explicitly overridden.

## Exit-code convention for new CLI commands

All `mcp-coordinator encryption *` commands follow `cli/doctor.ts` convention:
- **0** — success (including "no work to do" — e.g. `verify` on a fresh DB with no encrypted rows)
- **1** — warnings (operator should review output but no fatal failure — e.g. `migrate` skipped some rows due to CAS race)
- **2** — fatal (config error, wrong key, lock held by alive PID, etc.)

If `cli/doctor.ts` exports shared `EXIT_OK`/`EXIT_WARN`/`EXIT_FATAL` constants, import and reuse. Otherwise define them in `cli/encryption/exit-codes.ts` (small new file shared across encryption CLIs).

## Open questions — RESOLVED

V1 Open Question #5 (verify exit codes) — RESOLVED above (0 incl. no-rows-yet, 1 warnings, 2 fatal).
V1 Open Question #6 (perf test for encrypt) — REJECTED: no perf test (not on hot path).
V1 Open Question #4 (CI step for missing threshold) — DEFERRED: see PATCH 9.
V1 Open Question #1, #2, #3 — see new task layout below.
```

---

## PATCH 2 — New task layout (19 tasks, 6 phases)

**Supersedes**: V1 §"Plan structure" + §"Dependency DAG" + §"LOC budget".

V1 had 14 tasks. V2 has 19 after applying the Round-1 splits/merges/extracts.

### Tasks at a glance

```
Phase A — Foundation (parallel)
  T01   system_config + bootPhase2 deps inj             (~150 LOC)
  T02   provisionUser options-object refactor            (~150 LOC)
  T12a  Logger redact `idp_refresh_token`                (~20 LOC)

Phase B — Encryption primitives
  T03   encryption.ts types + helpers + error classes    (~200 LOC)
  T04   envelope-encryption.ts                           (~250 LOC)
  T04b  Wire-format regression vectors                   (~50 LOC)
  T05   master-key.ts (decode + entropy + fingerprint)   (~200 LOC)
  T05b  tests/helpers/encryption.ts                      (~80 LOC)

Phase C — Boot wiring (sequential)
  T06a  Load + guards + daemon env forwarding            (~200 LOC, T07 folded)
  T06b  Wrapped provider + first-encrypt persistence     (~120 LOC)
  T06c  Plaintext reminder + shutdown teardown           (~80 LOC)

Phase D — Read/write integration (parallel)
  T08   oauth-finalize.ts encrypt at write               (~100 LOC)
  T09   refresh-rotation.ts read + write + error map     (~150 LOC)

Phase E — CLI
  T10a  PID-in-content lock utility                      (~100 LOC)
  T10b  encryption migrate command                       (~200 LOC)
  T11   encryption verify + fingerprint commands         (~150 LOC)

Phase F — Observability + docs + ship
  T12b  Metrics + audit events                           (~120 LOC)
  T12c  /health/ready encryption block                   (~60 LOC)
  T13a  Reference doc updates                            (~150 LOC)
  T13b  docs/ops/encryption-key-management.md runbook    (~450 LOC)
  T14   Release v0.10.5                                  (procedure)

TOTAL: 19 tasks (T07 deleted via fold; T05b/T10a/T13b/T12a/T12c/T04b extracted)
TOTAL LOC: ~2450 (same as V1)
Average PR: ~120 LOC (was ~200)
Largest PR: 250 LOC (T04, T10b after split)
```

### Dependency DAG (V2)

```
T01 ──→ T06a
T02 ──→ T08
T03 ─┬─→ T04 ──→ T04b
     │      └─→ T05b
     ├─→ T08, T09, T10b, T11, T12b, T12c
     │
T04 ─┴─→ T05b, T06b, T08
T05 ──→ T05b, T06a
T05b ──→ T06b, T08, T09, T10b, T11, T12b, T12c
T06a ──→ T06b ──→ T06c
T06b ──→ T08, T09
T08 ──→ T09, T11, T12b
T10a ──→ T10b ──→ T11
T12b ──→ T12c
T13a, T13b, T11, T12c ──→ T14

(T12a, T13a, T13b are otherwise unconstrained — parallelizable anywhere after T03)
```

No cycles. Critical path: T01 → T03 → T04 → T05b → T06a → T06b → T08 → T09 → T12b → T13b → T14 (11 PRs).

### Recommended merge sequence (3-4 days wall-clock)

```
Day 1:  T01, T02, T03, T05, T12a            (5 PRs land)
Day 2:  T04, T05b, T13a                     (3 PRs)
Day 3:  T06a, T06b, T06c, T08               (4 PRs sequential)
        T04b, T10a, T13b                    (3 PRs parallel)
Day 4:  T09, T10b, T11, T12b, T12c          (5 PRs)
        T14                                 (release)
```

---

## PATCH 3 — T05b (NEW): test helpers

**Inserts**: NEW task between T05 and T06a.

```markdown
## T05b: tests/helpers/encryption.ts

**Size**: ~80 LOC (helper module + helper self-tests)
**Dependencies**: T03 (uses EncryptionContext + EncryptionProvider + decryptNullable), T04 (instantiates EnvelopeEncryption), T05 (uses computeKeyFingerprint)
**Spec refs**: V2 §Test fixtures, V3 PATCH 19

**Files touched**:
- `tests/helpers/encryption.ts` (NEW) — exports `makeTestEncryption`, `withEncryptionEnv`, `selectIdpToken`.
- `tests/unit/helpers-encryption.test.ts` (NEW) — self-tests each helper.

**Implementation summary**:
1. `makeTestEncryption()` returns `{ provider: EnvelopeEncryption, key: Buffer, fingerprint: string }`.
2. `withEncryptionEnv(key, fn)` sets `COORDINATOR_ENCRYPTION_KEY=base64(key)` for the duration of `fn`; restores on finally.
3. `selectIdpToken(db, userId, column, provider)` SELECTs the encrypted column + `primary_org_id`, calls `decryptNullable` with the right context.

**Acceptance**:
- All helper self-tests pass.
- Coverage gate met (per-file threshold added in this PR).
- `grep -r "new EnvelopeEncryption(" tests/` returns matches only inside `tests/helpers/encryption.ts` (drift detection: no test should instantiate provider directly).
- Lint clean.
```

---

## PATCH 4 — Split T06 into T06a / T06b / T06c

**Supersedes**: V1 §T06 entirely.

V1's T06 mixed five logical changes. V2 splits them into three sequential PRs.

### T06a: Load + guards + daemon env forwarding

```markdown
## T06a: Master-key load + boot guards + daemon-spawn forwarding

**Size**: ~200 LOC (decode-key call site + GLOB guards + stash table + T07 folded)
**Dependencies**: T01 (system_config + boot deps), T05 (decodeMasterKey + computeKeyFingerprint), T05b (test helpers)
**Spec refs**: V2 §D guards, V3 PATCH 3 (GLOB), PATCH 6 (placement), PATCH 10 (TOKEN_LOSS confirm + stash), PATCH 14 (deps inject)

**Files touched**:
- `src/boot-encryption.ts` (NEW) — extracted boot logic for per-file coverage gate (AC1).
- `src/boot.ts` — call into `src/boot-encryption.ts` at step 9-10 placement.
- `cli/server/start.ts` — add 4 `fwd()` lines for encryption env vars (T07 folded).
- `tests/unit/boot-encryption-guards.test.ts` (NEW) — branch matrix.
- `tests/unit/cli-server-start-env-forwarding.test.ts` (NEW) — env-forwarding test.
- `vitest.config.ts` — add per-file threshold for `src/boot-encryption.ts` at 100%.

**Implementation summary**:
1. Create `src/boot-encryption.ts` exporting `initEncryption(deps): { provider: EncryptionProvider, fingerprint: string | null, shutdown: () => void }`.
2. Inside: call `decodeMasterKey(deps.env.COORDINATOR_ENCRYPTION_KEY)` if set; compute fingerprint.
3. Strict-mode guards (PATCH 3 GLOB pattern, PATCH 10 TOKEN_LOSS flow):
   - Guard 1 (encrypted rows present, no key): refuse unless `ALLOW_TOKEN_LOSS=1` + matching `TOKEN_LOSS_CONFIRM`; on override, CREATE `encryption_invalidated_tokens` IF NOT EXISTS, stash ciphertexts, NULL rows, emit per-user audit.
   - Guard 2 (encrypted rows + key + fingerprint mismatch): refuse unless `ALLOW_KEY_ROTATION=1`.
   - Guard 3 (encrypted rows + key + null storedFingerprint): backfill fingerprint.
4. Return `{ provider, fingerprint, shutdown }` — wrapped provider and reminder are T06b/T06c.
5. `cli/server/start.ts:72-91`: add 4 `fwd("COORDINATOR_ENCRYPTION_KEY", ...)` + 3 more for the 3 override vars.
6. Codebase grep audit (PATCH 3 audit step): `grep -rn "LIKE 'enc:v_:%'" src/ cli/` MUST return only this PR's removals; `grep -rn "enc:v[0-9]" src/ cli/` returns expected sites only.

**Test cases — branch matrix**:

| # | hasEnc | key | storedFP | ALLOW_TL | TL_CONFIRM | ALLOW_KR | Expected |
|---|---|---|---|---|---|---|---|
| 1 | false | absent | n/a | n/a | n/a | n/a | OK; warn level=production→error, dev→warn |
| 2 | false | present | null | n/a | n/a | n/a | OK; fingerprint will be written by T06b's wrapped provider |
| 3 | true | present | match | n/a | n/a | n/a | OK |
| 4 | true | present | null | n/a | n/a | n/a | OK; backfill fingerprint now |
| 5 | true | absent | n/a | unset | n/a | n/a | throw BootValidationError |
| 6 | true | absent | n/a | "1" | wrong | n/a | throw (confirm mismatch) |
| 7 | true | absent | n/a | "1" | correct | n/a | NULL rows + stash + per-user audit |
| 8 | true | present | mismatch | n/a | n/a | unset | throw |
| 9 | true | present | mismatch | n/a | n/a | "1" | OK; storedFP cleared (T06b will set new) |
| 10 | n/a | low-entropy (<3.0) | n/a | n/a | n/a | n/a | throw |
| 11 | n/a | medium-entropy (3.0-4.5) | n/a | n/a | n/a | n/a | OK + warn |
| 12 | n/a | malformed length | n/a | n/a | n/a | n/a | throw decode error |
| 13 | true | absent | n/a | "1" | correct | n/a | run twice — second is idempotent (no rows left); stash row PK does not collide (distinct timestamps OR `INSERT OR IGNORE`) |

Plus:
- `cli/server/start.ts` env-forwarding test: mock `child_process.spawn`; assert each of the 4 vars present in `childEnv` when set in parent; absent when parent has none. `grep -c 'fwd("COORDINATOR_' cli/server/start.ts` returns expected count (existing + 4 = N).
- `bootPhase2` is sync: `expect(bootPhase2(opts, deps)).not.toBeInstanceOf(Promise)`.

**Acceptance**:
- All 13 branch matrix rows pass + forwarding test passes.
- Coverage gate met for `src/boot-encryption.ts` (100% per-file threshold added in this PR).
- Codebase grep: zero `LIKE 'enc:v_:%'` outside test files.
- `grep -c 'fwd("COORDINATOR_' cli/server/start.ts` returns exactly expected count.
- `git diff main -- tests/unit/boot-restore-check.test.ts tests/unit/boot-validation.test.ts` shows zero deletions/modifications (only additions allowed to existing boot tests).
- Lint clean, compile clean.
```

### T06b: Wrapped provider + first-encrypt persistence

```markdown
## T06b: Wrapped provider + first-encrypt fingerprint persistence

**Size**: ~120 LOC (wrapper + AuthHandlerContext wiring + tests)
**Dependencies**: T03, T04, T05b, T06a
**Spec refs**: V2 §D, V3 PATCH 7

**Files touched**:
- `src/boot-encryption.ts` — extend with wrappedProvider factory.
- `src/boot.ts` — wire wrappedProvider into AuthHandlerContext.
- `src/auth/context.ts` — add `encryptionProvider`, `encryptionKeyFingerprint`.
- `tests/unit/boot-encryption-wrapper.test.ts` (NEW).
- `tests/unit/boot-di-wiring.test.ts` (NEW).

**Implementation summary**:
1. In `src/boot-encryption.ts`, add `buildWrappedProvider(rawProvider, db, keyFingerprint, fingerprintPersisted): EncryptionProvider`. On `encrypt()`, if not persisted, `INSERT OR IGNORE INTO system_config` + emit `encryption.config.loaded` audit (tier 1) + set persisted=true.
2. Wire into `AuthHandlerContext` at boot.ts:235 area.

**Test cases**:
- First `encrypt()` call: `system_config.encryption.key_fingerprint` populated; `encryption.config.loaded` audit emitted exactly once.
- 2nd, 3rd, Nth `encrypt()` calls: no additional INSERTs, no additional audits.
- Single-process simulated race: call `encrypt()` directly twice in sequence on a fresh DB — both succeed; row count in `system_config` is exactly 1 (proves `INSERT OR IGNORE` works).
- DI wiring: with key set, `ctx.encryptionProvider` is the wrapped provider (constructed); without key, it is `PassthroughEncryption`. Assert via `instanceof` and behavioral round-trip.
- `Phase2Bootstrap.encryptionKeyFingerprint` matches the computed value when key set; null when key absent.

**Acceptance**:
- All tests pass.
- Coverage gate met (boot-encryption.ts stays at 100%).
- No duplication of fingerprint-persistence assertion in T08 (canonical owner is this PR).

NOTE on the V1 concurrent-race test: dropped. Vitest's single-event-loop semantics make `Promise.all([encrypt(), encrypt()])` deterministic; the test was tautological. The `INSERT OR IGNORE` correctness is sufficient via the sequential test.
```

### T06c: Plaintext reminder + shutdown teardown

```markdown
## T06c: Plaintext warning + 24h reminder + shutdown teardown

**Size**: ~80 LOC (logger reminder + interval handle + teardown + tests)
**Dependencies**: T06a (provider chosen), T06b (Phase2Bootstrap structure)
**Spec refs**: V2 §E, V3 PATCH 11

**Files touched**:
- `src/boot-encryption.ts` — extend with reminder interval + teardown registration.
- `src/boot.ts` — wire `shutdown()` returned from `initEncryption()` into `Phase2Bootstrap.shutdown`.
- `tests/unit/boot-encryption-reminder.test.ts` (NEW).

**Implementation summary**:
1. When key absent: bootLogger[level] one-shot at boot + setInterval every 86_400_000ms with same message.
2. `level` = `error` if `NODE_ENV=production`, else `warn`.
3. Store interval handle in returned `shutdown()`.
4. `Phase2Bootstrap.shutdown()` calls `clearInterval(handle)`.

**Test cases** (`vi.useFakeTimers()`):
- `NODE_ENV=production` + no key: spy on logger, assert `.error(...)` called immediately + once per 24h advance.
- `NODE_ENV=development` + no key: same with `.warn(...)`.
- With key set: no reminder registered (assert spy never called after the first audit boot event).
- `Phase2Bootstrap.shutdown()` clears interval (advance fake time post-shutdown, assert no further logs).
- Multiple bootPhase2 invocations in tests don't leak intervals (call shutdown between each).

**Acceptance**:
- All tests pass.
- Lint clean.
- Coverage gate met.
```

---

## PATCH 5 — T04b (NEW): wire-format regression vectors

**Inserts**: NEW task after T04.

```markdown
## T04b: Pinned wire-format test vectors

**Size**: ~50 LOC (1 test file + 3-4 pinned vectors)
**Dependencies**: T04
**Spec refs**: V2 §Testing (regression vectors), V3 PATCH 1 (AAD format)

**Files touched**:
- `tests/unit/envelope-encryption-vectors.test.ts` (NEW) — hand-computed `enc:v1:...` strings + expected plaintexts under a fixed test key (`Buffer.alloc(32, 0xaa)` — wait, that fails entropy check; use `Buffer.from("0123456789abcdef0123456789abcdef", "utf8")` or a published test vector).

**Implementation summary**:
1. Pick a fixed 32-byte key with high entropy (do NOT use `0xaa` repeated — would fail entropy check at integration but is fine inside a unit test where the key is passed directly to `new EnvelopeEncryption()`, bypassing `decodeMasterKey`).
2. Generate 3-4 ciphertexts for known plaintexts under this key + known `EncryptionContext` triples.
3. Hand-record the resulting `enc:v1:...` strings (or write a one-shot generator script and commit its output).
4. Tests: `expect(provider.decrypt(VECTOR_1, CONTEXT_1)).toBe(PLAINTEXT_1)`.

**Acceptance**:
- All vectors decrypt to expected plaintext.
- Any future change to AAD encoding, format prefix, byte order, etc. breaks these tests loudly.
- This file is the canary. PR-time review for any change here is mandatory.
```

---

## PATCH 6 — Split T10 into T10a / T10b

**Supersedes**: V1 §T10.

### T10a: PID-in-content lock utility

```markdown
## T10a: PID-in-content lock utility (reusable)

**Size**: ~100 LOC (utility + tests including 2-process spawn test)
**Dependencies**: none (pure Node, no encryption code)
**Spec refs**: V3 PATCH 15

**Files touched**:
- `cli/lib/pid-lock.ts` (NEW) — exports `acquireLock(path): LockHandle`, `releaseLock(handle)`, `isPidAlive(pid): boolean`.
- `tests/unit/pid-lock.test.ts` (NEW).

**Implementation summary**:
1. `acquireLock(path)`:
   - `fs.openSync(path, "wx")` — atomic create.
   - On EEXIST: read PID from file, `isPidAlive(pid)`. If alive: throw `LockHeldError` with PID. If dead: `unlinkSync` + retry once.
   - Write `process.pid` to the file, close handle.
2. `releaseLock(handle)` — `unlinkSync(handle.path)`.
3. `isPidAlive(pid)` — `try { process.kill(pid, 0); return true; } catch { return false; }`. Cross-platform.

**Test cases**:
- Acquire on non-existent path → succeeds; lock file contains current PID.
- Acquire when lock held by current process → throws `LockHeldError`.
- Acquire when lock held by dead PID → succeeds (stale recovery); lock now contains current PID.
- Acquire when lock held by alive PID (spawn `child_process.fork('do-nothing.js')`, take lock in child, try in parent) → throws.
- `releaseLock` removes file.

**Acceptance**:
- All tests pass on both Windows + POSIX (CI matrix).
- Lint clean, coverage 100%.
- Spawn-based test verified to actually fork a child (not single-process simulation).
```

### T10b: encryption migrate command (using T10a)

```markdown
## T10b: encryption migrate command (encrypt + decrypt directions)

**Size**: ~200 LOC (CLI + batched migration + CAS + SIGINT cleanup + tests)
**Dependencies**: T03, T04, T05, T05b, T06b, T10a
**Spec refs**: V2 §Migration CLI, V3 PATCH 3 (GLOB), PATCH 10 (NULL semantics)

**Files touched**:
- `cli/encryption/index.ts` (NEW) — subcommand group factory.
- `cli/encryption/migrate.ts` (NEW).
- `cli/index.ts` — register `encryption` subcommand group.
- `tests/unit/cli-encryption-migrate.test.ts` (NEW).

**Implementation summary**:
1. Subcommand `encryption migrate [--direction encrypt|decrypt] [--batch-size N] [--force]`.
2. Use `cli/server/backup.ts` (note: `.ts` not `.js`) `getRunningCoordinatorPid()` — refuse unless `--force`.
3. Acquire lock via T10a's `acquireLock({data_dir}/migration.lock)`.
4. **Register SIGINT/SIGTERM cleanup handler** (per PATCH 15): `process.on('SIGINT'|'SIGTERM', () => { releaseLock(handle); process.exit(130); })`.
5. Encrypt direction: GLOB-filtered SELECT + per-row UPDATE with CAS.
6. Decrypt direction: reverse — find `enc:v[0-9]*:*` rows, decrypt, UPDATE with CAS on ciphertext.
7. Final summary; release lock on clean exit.

**Test cases**:
- Idempotent: re-run = no-op.
- Mixed rows (5 plain + 5 enc + 5 null) → 5 encrypted, 10 skipped/none.
- `--batch-size 1` works.
- CAS skip when pre-mutated row → 0 rows affected, logged skip, exit 1.
- Real two-process race (uses T10a spawn helper): second process exits 2 with `LockHeldError` text.
- Lock held by dead PID → stale recovery (covered by T10a).
- Daemon running + no `--force` → refuse.
- Daemon running + `--force` → proceeds. (NOTE: no audit event emitted; V1 plan said "with audit warning" — DROPPED, no event was added to PATCH 17.)
- Decrypt direction round-trip: encrypt then decrypt → state == original.
- **SIGINT cleanup**: send SIGINT mid-migration (spawn child, send signal); lock file removed; exit code 130.

**Acceptance**:
- All tests pass (spawn-based tests run on CI matrix).
- Coverage gate met.
- Lint clean.
```

---

## PATCH 7 — Split T12 into T12a / T12b / T12c

**Supersedes**: V1 §T12.

### T12a: Logger redact `idp_refresh_token` (PARALLEL-anywhere after T03)

```markdown
## T12a: Logger redact `idp_refresh_token`

**Size**: ~20 LOC (1-line addition + regression test)
**Dependencies**: none (can ship as Phase A hotfix)
**Spec refs**: V2 §Logger redaction, V3 PATCH (none — pre-existing convention)

**Files touched**:
- `src/observability/logger.ts:22` — append `"*.idp_refresh_token"` to `REDACT_PATHS`.
- `tests/unit/logger-redact.test.ts` — extend if exists, or new file.

**Implementation summary**: one-line addition. Test: log an object with `{user: {idp_refresh_token: "secret"}}`, assert serialized output contains `"[REDACTED]"` (not `[Redacted]` — case matches existing convention).

**Acceptance**: redact assertion passes; existing redact tests unchanged.

(Can be merged as a hotfix to v0.10.4 if needed — it's a PII-leak defense-in-depth fix unrelated to the encryption feature.)
```

### T12b: Metrics + audit events

```markdown
## T12b: Metrics + audit events

**Size**: ~120 LOC (3 metrics + 5 audit events + emission sites + tests)
**Dependencies**: T03, T05, T05b, T06b, T08, T09, T10b
**Spec refs**: V2 §Observability, V3 PATCH 17

**Files touched**:
- `src/observability/metrics.ts` — register 3 metrics.
- `src/security/audit.ts` — verify API compat (no changes likely needed).
- Various emission sites: `src/boot-encryption.ts` (encryption.config.loaded), `src/auth/refresh-rotation.ts` (encryption.decrypt.failed), `cli/encryption/migrate.ts` (encryption.migration.completed), etc.
- `tests/unit/encryption-observability.test.ts` (NEW).

**Implementation summary**:
1. Register `coordinator_idp_encryption_enabled` (gauge), `coordinator_idp_decrypt_failures_total` (counter, label `error_class`), `coordinator_idp_plaintext_rows` (gauge — updated by `encryption verify`/`migrate`, NOT real-time).
2. Each of the 5 audit events per PATCH 17 emitted at the right site with `tier` pinned.
3. **HMAC label pinned**: `user_id_hash = createHmac("sha256", "mcc-audit-pseudonym-v1").update(user_id).digest("hex").slice(0,16)`. Same label across all sites. Add to a shared helper `src/security/audit-pseudonym.ts` exporting `pseudonym(user_id): string`.

**Test cases**:
- Each of 5 audit events: emit with correct tier and metadata shape. Assert label `mcc-audit-pseudonym-v1` produces exact known output for known input.
- Decrypt failure increments `coordinator_idp_decrypt_failures_total{error_class="DataDecryptFailed"}` by 1.
- Boot with key: gauge `_enabled` = 1; boot without: = 0.
- `bumpTokenEpoch` reuse: `vi.spyOn(tokenEpochModule, 'bumpTokenEpoch')`, assert `toHaveBeenCalledWith(db, userId)` after decrypt failure.

**Acceptance**:
- All tests pass.
- HMAC pseudonym label appears in audit metadata (`grep -c 'mcc-audit-pseudonym-v1' src/security/`).
- Lint clean.
```

### T12c: /health/ready encryption block

```markdown
## T12c: /health/ready encryption block

**Size**: ~60 LOC (accessor + readiness extension + integration test)
**Dependencies**: T06b (provider context), T12b (counter source)
**Spec refs**: V2 §E, V3 PATCH 12

**Files touched**:
- `src/http/health.ts` — extend readiness payload; add `getEncryptionStatus()` accessor pattern.
- `tests/integration/health-ready-encryption.test.ts` (NEW).

**Implementation summary**:
1. Module-level `_encryptionStatus: { enabled, key_source, key_fingerprint, decrypt_failures_total } | null` set at boot via `setEncryptionStatus(...)`; readable via `getEncryptionStatus()`.
2. In `handleHealthReady`, add `encryption` block to payload. Default to empty object if accessor returns null (boot incomplete).
3. **NOTE**: V1 said `decrypt_failures_5m`. V2 drops the `_5m` suffix — field is `decrypt_failures_total` (lifetime counter). Operators compute rate externally via prom-client query. This avoids implementing a sliding-window ring buffer for marginal value.

**Test cases**:
- GET /health/ready with key set: body has `status: "ready"` (NOT `ready: true`) + `encryption: { enabled: true, key_source: "env", key_fingerprint: <16 hex>, decrypt_failures_total: 0 }`.
- GET /health/ready without key: body has `encryption: { enabled: false, key_source: "absent", key_fingerprint: null, decrypt_failures_total: 0 }`.
- Induce a decrypt failure: counter in payload increments.

**Acceptance**: tests pass, lint clean.
```

---

## PATCH 8 — Split T13 into T13a / T13b

**Supersedes**: V1 §T13.

### T13a: Reference doc updates

```markdown
## T13a: Reference doc updates

**Size**: ~150 LOC across 4 files
**Dependencies**: T06c (final naming settled)
**Spec refs**: V2 §References

**Files touched**:
- `README.md` — Compliance matrix: mark IdP encryption Shipped in v0.10.5.
- `.env.example` (repo root) — add `COORDINATOR_ENCRYPTION_KEY=` entry.
- `examples/docker-compose/.env.example` — same + Docker secret note.
- `docs/onboarding-self-host.md` — Encryption section under §3 Configure environment + gotcha entry for "decrypt errors after restore" + backup note.
- `docs/security/threat-model.md` — close residual-risk on IdP credentials.

**Acceptance**: files updated; manual rendering check in PR review.
```

### T13b: docs/ops/encryption-key-management.md runbook

```markdown
## T13b: docs/ops/encryption-key-management.md (runbook)

**Size**: ~450 LOC (new file)
**Dependencies**: T06c, T11 (CLI semantics settled)
**Spec refs**: V2 §Migration & rollback runbook, V3 PATCH 14 (plaintext-on-disk window)

**Files touched**:
- `docs/ops/encryption-key-management.md` (NEW) — mirror `docs/ops/key-rotation.md` structure.

**Content**:
- Key generation (`openssl rand -base64 32`).
- Storage (env vs Docker secret; `docker inspect` exposure note).
- Backup-the-key (fingerprint alongside DB backup).
- Migration runbook (`encryption migrate`).
- Verification runbook (`encryption verify`, `encryption fingerprint`).
- Key rotation runbook with explicit **"during steps 3-5, DB contains plaintext IdP tokens on disk"** warning (V3 PATCH 18 risk).
- Disaster recovery: `ALLOW_TOKEN_LOSS=1` procedure including `TOKEN_LOSS_CONFIRM` value derivation.
- Recovery from `encryption_invalidated_tokens` table (manual SQL).

**Acceptance**: file created; operator-mindset review pass.
```

---

## PATCH 9 — Dependency edge corrections

**Supersedes**: V1 §Dependency DAG.

Apply these edge corrections to the new V2 DAG (PATCH 2):

| Edge | V1 | V2 | Reason |
|---|---|---|---|
| T07 → T06 | present | (T07 deleted, folded into T06a) | T07 was false-dep on T06 (PATCH 4) |
| T05 → T03 | present | dropped | T05 (master-key.ts) only uses `node:crypto`, not T03's types (Dep-graph#4) |
| T11 → T10 | absent | added | T11 verify happy-path tests need encrypted rows; T10 migrate creates them (Dep-graph#2) |
| T09 → T02 | implicit (via T08) | explicit | Documentation clarity; T09 may be implemented by a different agent who reads only T09 (Dep-graph#3) |
| T12 → T08 | absent | added | Metrics integration test needs the write site to exercise (Dep-graph#7) |
| Test helpers | T03 footnote | T05b owns | T05b uses `computeKeyFingerprint` from T05 (Atomicity#7, Missing#1, Acceptance#1) |

External-dep corrections:
- `cli/server/backup.js` → `cli/server/backup.ts` (file extension typo)
- `[Redacted]` → `[REDACTED]` (existing logger censor convention)
- 3 env vars → 4 env vars in `cli/server/start.ts` forwarding (V3 PATCH 10 added `TOKEN_LOSS_CONFIRM`)

---

## PATCH 10 — vitest.config.ts per-file thresholds (PRE-STUB in T03)

**Supersedes**: V1 §T03 acceptance (covers only T03 files).

**Reason**: V1 had T03 own coverage threshold entries for only its files. T04/T05 acceptance said "100% coverage" but didn't direct adding the per-file entry — silent drift risk. Plus the shared edit hotspot in `vitest.config.ts` produces merge conflicts when 5 PRs each append.

**Pre-stub approach**: In T03, add the threshold-map block with **stub entries** for all forthcoming files, with TODO comments. Later PRs fill in numbers without structural conflicts.

**T03 acceptance addition**:
```markdown
- Extend `vitest.config.ts` coverage.thresholds.perFile with stub entries:
    "src/security/encryption.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
    "src/security/encrypt-nullable.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
    "src/security/envelope-encryption.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T04
    "src/security/master-key.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T05
    "src/security/audit-pseudonym.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T12b
    "src/boot-encryption.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T06a
    "tests/helpers/encryption.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T05b
    "cli/lib/pid-lock.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T10a
    "cli/encryption/migrate.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T10b
    "cli/encryption/verify.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T11
    "cli/encryption/fingerprint.ts": { statements: 100, branches: 100, functions: 100, lines: 100 }, // TODO T11
```

Each later task (T04, T05, T05b, T06a, T10a, T10b, T11, T12b) just removes its TODO comment when its file lands at 100%.

---

## PATCH 11 — T08: fingerprint persistence test removed (canonical owner is T06b)

**Supersedes**: V1 §T08 test bullet "First successful login on fresh DB → `system_config.encryption.key_fingerprint` populated. 2nd login → no additional fingerprint row."

Drop that test bullet from T08. The wrapped provider's persistence invariant is T06b's responsibility; T06b's unit test is the canonical oracle. T08's integration test only needs to assert "login produces enc:v1: row" + uses `selectIdpToken` helper to verify decryption.

This eliminates redundancy and makes the wrapped-provider mechanism the single owner of the persistence behavior.

---

## PATCH 12 — T09: additions

**Supersedes**: V1 §T09 acceptance and test list.

Additions:

1. **Test fixture preservation note**: add acceptance bullet "Existing `tests/perf/bench-refresh-rotation.ts` still runs unchanged (lazy plaintext path preserved)."

2. **`bumpTokenEpoch` reuse assertion**: add test bullet "Use `vi.spyOn(tokenEpochModule, 'bumpTokenEpoch')`; after decrypt failure, assert `toHaveBeenCalledWith(db, userId)`. Alternative acceptance: `grep -c bumpTokenEpoch src/auth/refresh-rotation.ts` returns ≥1."

3. **Concurrent refresh during plaintext lazy-migration**: add test bullet "Two `Promise.all` refresh calls on a plaintext row (interleaved at SELECT/UPDATE boundary via manual orchestration) → both succeed; final row is `enc:v1:`; user_session's bearer token matches the persisted ciphertext (no orphan)." If genuine concurrency proves impossible in vitest, demote to documented limitation.

---

## PATCH 13 — T11: exit codes pinned

**Supersedes**: V1 §T11 acceptance.

Addition:
- `verify` exit codes pinned (per preamble): 0 = ok (including "no encrypted rows yet"), 1 = warnings (some rows un-verifiable), 2 = fatal (wrong key, fingerprint mismatch).
- If `cli/doctor.ts` exports `EXIT_OK`/`EXIT_FATAL` constants: import + reuse. Otherwise create `cli/encryption/exit-codes.ts` (small new file).
- Acceptance addition: `grep -E 'process\.exit\((0|1|2)\)' cli/encryption/` matches no inline numerals (all exits go through constants).
- Test: "no encrypted rows + key set" → exit 0 (resolves Open Q #5).

---

## PATCH 14 — T14: release verification

**Supersedes**: V1 §T14 acceptance.

Add pre-release verification step:
```bash
npm test 2>&1 | tee /tmp/v0.10.5-release-test.log
grep -c "tests/integration/" /tmp/v0.10.5-release-test.log
# Expected: at least <N> integration test files exist, all passing.
# <N> is the count of NEW integration test files introduced across T08, T09, T10b, T12b, T12c.
```

Document the actual count in the release PR description so reviewers can verify the gate.

Also: confirm T13a + T13b have both merged BEFORE approving the release-please PR.

---

## Summary of changes from V1

| Area | V1 | V2 |
|---|---|---|
| Task count | 14 | 19 |
| T06 | 350 LOC monolith | T06a + T06b + T06c (3 sequential) |
| T04 | 250 LOC | T04 + T04b (regression vectors split) |
| T10 | 300 LOC | T10a (lock utility) + T10b (migrate) |
| T12 | 200 LOC | T12a (redact) + T12b (metrics) + T12c (/health) |
| T13 | 600 LOC | T13a (refs) + T13b (runbook) |
| T07 | standalone | folded into T06a |
| Test helpers | T03 footnote | T05b owned |
| boot.ts encryption code | inline | extracted to `src/boot-encryption.ts` (testability + per-file coverage) |
| Acceptance commands | "lint clean" | `npm run lint`, `npm test`, etc. pinned in preamble |
| vitest threshold management | T03 only | pre-stubbed in T03, filled by each task |
| Exit codes | "use cli/doctor convention" | explicit 0/1/2 mapping in preamble |
| `decrypt_failures_5m` | sliding window (untested) | `decrypt_failures_total` lifetime counter |
| T07 → T06 edge | present | removed (T07 folded) |
| T05 → T03 edge | present | removed (false dep) |
| T11 → T10 edge | absent | added (verify happy-path) |
| T12 → T08 edge | absent | added (metrics integration) |
| TOKEN_LOSS branch matrix | 12 rows | 13 rows (added re-run idempotency) |
| Fingerprint test | T06 + T08 (duplicate) | T06b only (canonical) |
| SIGINT cleanup | missing | added to T10b |
| HMAC pseudonym label | not pinned | `mcc-audit-pseudonym-v1` pinned in T12b |
| Open Q #5 | unresolved | resolved (exit codes) |
| Open Q #6 | unresolved | resolved (drop _5m) |
| Open Q #1, #2, #3 | unresolved | resolved (separate PRs; T06 split; T13 separate then release) |

## Next steps

1. ✅ Plan V2 patches doc written (this file).
2. Begin implementation. Phase A first (T01, T02, T03, T05, T12a in parallel).
3. Use `subagent-driven-development` skill per the plan preamble.
4. Each PR pulls T#'s acceptance into its description.
5. Resolve T11→T10 dep at PR time (T11 PR opens after T10b merges).
