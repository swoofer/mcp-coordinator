# Plan Round 1 — Missing tasks / spec coverage

**Verdict**: GAPS-EXIST
**Items checked**: 52
**Missing**: 9
**Redundant**: 3

## Scope

Mapped every requirement called out in the plan-review brief (V2 + V3 PATCH list + Round 2 test gaps + env/docs) against the 14 tasks in `2026-05-17-idp-encryption-plan.md`. Findings below.

## Coverage matrix

### V2 architectural requirements

| Spec requirement | Task | Status |
|---|---|---|
| `system_config` CREATE TABLE | T01 | ✅ |
| `EncryptionContext` tightened (literal-union column, user_id required) | T03 | ✅ |
| `EncryptionProvider` interface (hmac removed) | T03 | ✅ |
| `PassthroughEncryption` updated to new interface | T03 | ✅ |
| `DecryptionError` + 3 subclasses + `UnknownCipherVersion` | T03 | ✅ |
| `EnvelopeEncryption` with AAD binding | T04 | ✅ |
| `encryptNullable` + `decryptNullable` helpers | T03 | ✅ |
| `decodeMasterKey` with entropy refuse + warn | T05 | ✅ |
| `computeKeyFingerprint` (HMAC, 16 hex) | T05 | ✅ |
| Boot guard 1 (encrypted rows + no key) | T06 | ✅ |
| Boot guard 2 (fingerprint mismatch) | T06 | ✅ |
| Boot guard 3 (backfill fingerprint when null + encrypted rows) | T06 | ✅ |
| `bootPhase2(opts, deps?)` injectable | T01 | ✅ |
| Wrapped provider with first-encrypt fingerprint persistence | T06 | ✅ |
| `AuthHandlerContext.encryptionProvider` + `keyFingerprint` | T06 | ✅ |
| Plaintext warning (ERROR in prod) + 24h reminder + teardown | T06 | ✅ |
| `/health/ready` encryption block | T12 | ✅ |
| `provisionUser` options-object signature | T02 | ✅ |
| 3 `provisionUser` call sites updated (oauth-finalize, oauth-callback, oauth-token) | T02 / T08 | ✅ |
| `refresh-rotation.ts` SELECT extension for `primary_org_id` | T09 | ✅ |
| `refresh-rotation.ts` sync decrypt try/catch + error mapping + bumpTokenEpoch + 401 response | T09 | ✅ |
| `oauth-finalize.ts` use encryption at INSERT + UPDATE | T08 | ✅ |
| `cli/server/start.ts` env forwarding (3 vars — actually 4 in plan) | T07 | ⚠️ Plan forwards 4 vars; spec lists 3. See Note A. |
| CLI `encryption migrate` (encrypt direction) with CAS + lock | T10 | ✅ |
| CLI `encryption migrate --direction=decrypt` | T10 | ✅ |
| CLI `encryption verify` with sampling | T11 | ✅ |
| CLI `encryption fingerprint` | T11 | ✅ |
| PID-based lock with auto-recovery | T10 | ✅ |
| Prom metrics (3) | T12 | ✅ |
| Audit events (5) with tier pinning + user_id_hash | T12 | ✅ |
| Logger redact list extension (`*.idp_refresh_token`) | T12 | ✅ |
| Test helpers `makeTestEncryption`, `withEncryptionEnv`, `selectIdpToken` | "Test infra" section | ⚠️ Not a numbered task — see Missing #1. |
| Coverage thresholds in `vitest.config.ts` for new files | T03 / T04 / T05 acceptance criteria | ⚠️ Mentioned T03 only ("both new files"); T04 + T05 acceptance say "100% coverage" but don't explicitly add `vitest.config.ts` entry. See Missing #2. |

### V3 patches

| Spec requirement | Task | Status |
|---|---|---|
| PATCH 1 length-prefixed AAD | T04 | ✅ |
| PATCH 3 GLOB pattern — boot guard 1 | T06 | ✅ |
| PATCH 3 GLOB pattern — boot guard 2 | T06 | ⚠️ Implicit via "guards" — not enumerated as separate site. |
| PATCH 3 GLOB pattern — `ALLOW_TOKEN_LOSS` override UPDATE | T06 | ⚠️ Implicit. PATCH 10 stash flow uses GLOB but plan doesn't call it out. |
| PATCH 3 GLOB pattern — migrate SELECT | T10 | ✅ |
| PATCH 3 audit step ("grep codebase for `enc:v_:` or `enc:v1:` literal") | (none) | ❌ MISSING |
| PATCH 6 specific bootPhase2 step ordering (steps 9-13) | T06 | ⚠️ Plan says "placement: between current step 8 and step 9 per PATCH 6" — single line, no enumeration of new steps 9/10/11/12/13. |
| PATCH 8 SELECT extension at refresh-rotation.ts:547 for primary_org_id | T09 | ✅ |
| PATCH 10 `encryption_invalidated_tokens` stash table | T06 | ✅ |
| PATCH 10 per-user audit + count-based confirm | T06 | ✅ (test row 7 in branch matrix) |
| PATCH 13 version regex bounds (`/^enc:v([1-9]\d{0,2}):/`) | T04 | ✅ |
| PATCH 15 PID-in-content lock + stale recovery + SIGINT cleanup | T10 | ⚠️ Lock + stale recovery captured; SIGINT/SIGTERM cleanup handler NOT mentioned. See Missing #3. |
| PATCH 17 audit tier pinning | T12 | ✅ |
| PATCH 17 HMAC user_id_hash with label `mcc-audit-pseudonym-v1` | T12 | ⚠️ Plan says "user_id_hash is deterministic HMAC (PATCH 17)" — label not pinned. |

### .env.example + Docker

| Spec requirement | Task | Status |
|---|---|---|
| `.env.example` (repo root) updated | T13 | ✅ |
| `examples/docker-compose/.env.example` updated | T13 | ✅ |
| Docker secret note documented (env vars visible to `docker inspect`) | T13 | ✅ |

### Docs

| Spec requirement | Task | Status |
|---|---|---|
| `docs/onboarding-self-host.md` updated | T13 | ✅ |
| `docs/security/threat-model.md` updated | T13 | ✅ |
| `docs/ops/encryption-key-management.md` created | T13 | ✅ |
| README compliance matrix update | T13 | ✅ |

### Round 2 test gaps (PATCH 19 + R2 synthesis)

| Spec requirement | Task | Status |
|---|---|---|
| C2 silent-downgrade attacker scenario test | T09 | ✅ (test bullet 5) |
| C5 DI wiring direct assertion test (`instanceof EnvelopeEncryption` vs `Passthrough`) | T06 | ✅ (last bullet of test cases) |
| C6 oauth-callback encrypted integration test | T08 | ✅ |
| C6 oauth-token encrypted integration test | T08 | ✅ |
| C9 daemon-spawn env-forwarding test | T07 | ✅ |
| C11 ERROR-level prod log + setInterval timer test (`vi.useFakeTimers`) | T06 | ✅ |
| C14 lazy-migration-tolerance test | T09 | ✅ |
| C15 metrics + audit emission tests | T12 | ✅ |
| C18 real concurrent-write CAS race | T10 | ✅ |
| C19 parallel migrators lock test | T10 | ✅ |
| AAD format-injection forcing-function test | T04 | ✅ |
| V2: first-encrypt fingerprint persistence assertion | T06 / T08 | ✅ (covered in both — see Redundancy #1) |
| V2: `/health/ready` encryption block test | T12 | ✅ |
| V2: `bootPhase2` sync type-level check | T06 | ✅ |

---

## Missing items

### 1. Test helpers (`tests/helpers/encryption.ts`) not anchored to a numbered task — BLOCKING
**Spec ref**: V2 §Test fixtures, V3 PATCH 19 ("**Required infrastructure** for all encryption-aware tests"), Round 2 synthesis "Test infrastructure" gap.
**Symptom**: Plan mentions the helpers in a footnote section ("Test infrastructure (cross-cutting)") and says "created as part of T03 (encryption.ts companion)", but T03's "Files touched" list does NOT include `tests/helpers/encryption.ts`. T08, T09, T10, T11 all depend on `selectIdpToken` / `makeTestEncryption` / `withEncryptionEnv` but no task formally owns them.
**Recommendation**: Add `tests/helpers/encryption.ts` to T03's "Files touched" list and acceptance ("helper exports `makeTestEncryption`, `withEncryptionEnv`, `selectIdpToken`"). Without this anchoring, the helpers may slip past CI.

### 2. `vitest.config.ts` coverage thresholds for `envelope-encryption.ts` and `master-key.ts` — BLOCKING
**Spec ref**: V2 §Testing "Coverage threshold note" — "Add per-file threshold entries for `src/security/envelope-encryption.ts`, `src/security/encrypt-nullable.ts`, and the new error classes. CI will hard-fail without this."
**Symptom**: T03 acceptance says "Add per-file coverage threshold entries in `vitest.config.ts` for both new files (100%)" — covers `encryption.ts` + `encrypt-nullable.ts`. T04 and T05 acceptance say "100% coverage on `src/security/envelope-encryption.ts`" / `master-key.ts` but do NOT mandate the `vitest.config.ts` threshold entry. The 100% coverage achieved during the PR will silently degrade if no threshold pins it.
**Recommendation**: Add to T04 acceptance: "Add `src/security/envelope-encryption.ts` to vitest.config.ts per-file threshold map at 100%." Same for T05 (`master-key.ts`).

### 3. Lock-file SIGINT/SIGTERM cleanup handler — BLOCKING
**Spec ref**: V3 PATCH 15 — "On SIGINT/SIGTERM: cleanup handler removes lock".
**Symptom**: T10 implementation summary says "release lock; exit 0/1/2" but does not enumerate the signal-handler hook. A Ctrl-C during a long migration leaves a stale lock keyed to a now-dead PID. Auto-recovery on next run is fine, but PATCH 15 explicitly requires the handler.
**Recommendation**: Add to T10 implementation summary step 10: "Register `process.on('SIGINT'|'SIGTERM')` cleanup that unlinks the lock file before exit." Add test case: "SIGINT during migration → lock removed."

### 4. PATCH 3 codebase grep / audit step — NICE-TO-HAVE (but high-value)
**Spec ref**: V3 PATCH 3 — "Audit step: implementer MUST grep the codebase for any other `enc:v_:` or `enc:v1:` string-prefix usage and convert."
**Symptom**: Plan has no task that owns this audit. T06 covers the 2 boot-guard SELECT sites + the TOKEN_LOSS UPDATEs implicitly via the stash flow. T10 covers the migrate SELECT. But if a stray `LIKE 'enc:v_:%'` is added in another future PR (e.g., the doctor command, a metrics exporter), nothing catches it.
**Recommendation**: Add to T06 OR T10 acceptance: "Grep `src/ cli/` for any literal `LIKE 'enc:v_:%'` or `enc:v_:` string-prefix usage; none remain outside test files." One-liner, prevents drift.

### 5. PATCH 6 explicit step-numbering update in `bootPhase2` — NICE-TO-HAVE
**Spec ref**: V3 PATCH 6 — "V3 mandates step numbering in the spec's Architecture diagram. The implementation plan task that touches `bootPhase2` must add these steps in this order: 9. encryption key load, 10. boot guards, 11. build wrapped provider, 12. context compose (was 9), 13. return Phase2Bootstrap."
**Symptom**: T06 places integration "between current step 8 and step 9 per PATCH 6" — single line. Doesn't enumerate the 5 new substeps or their ordering. An implementer could collapse "load key + guards + wrap" into one chunk that puts the wrapped-provider construction before the guards run, breaking guard 2's fingerprint comparison.
**Recommendation**: Expand T06 implementation summary into 5 enumerated substeps matching PATCH 6 (load key → guards → wrap → context compose → return Phase2Bootstrap).

### 6. PATCH 17 HMAC label `mcc-audit-pseudonym-v1` not pinned — NICE-TO-HAVE
**Spec ref**: V3 PATCH 17 — "`user_id_hash = createHmac("sha256", "mcc-audit-pseudonym-v1").update(user_id).digest("hex").slice(0,16)`. Same HMAC key separation pattern as fingerprint."
**Symptom**: T12 test case says "`user_id_hash` is deterministic HMAC (PATCH 17)" — doesn't pin the label string. Two implementers could pick different labels and the test would still pass.
**Recommendation**: Add to T12 implementation summary: "user_id_hash uses HMAC-SHA256 with label `mcc-audit-pseudonym-v1`, sliced to 16 hex." Test: assert exact label produces exact output for a known input.

### 7. `tests/perf/bench-refresh-rotation.ts` fixture preservation — NICE-TO-HAVE
**Spec ref**: V2 §DI wiring → Test fixtures — explicitly lists this file as one that "continues to work unchanged" (exercises lazy-path).
**Symptom**: Plan does not call out preservation of this fixture. T09 changes refresh-rotation.ts SELECT to include `primary_org_id` — depending on how the bench fixture stubs the row, it could break.
**Recommendation**: Add to T09 acceptance: "Existing `tests/perf/bench-refresh-rotation.ts` still runs (lazy plaintext path preserved)."

### 8. Decoded master-key buffer zeroization after fingerprint computation — NICE-TO-HAVE
**Spec ref**: V2 §Risks accepted "No key zeroization on shutdown (documented; v0.10.6 follow-up)" — explicitly deferred. But the in-`decodeMasterKey` intermediate buffer is not the same as the long-lived master-key buffer.
**Symptom**: Not strictly required by spec (deferred to v0.10.6). Plan is correctly silent. Listing as NICE-TO-HAVE only to confirm the omission is intentional.
**Recommendation**: No action; intentionally deferred per spec.

### 9. Plan task numbering inconsistency: "T20" reference — NICE-TO-HAVE
**Spec ref**: N/A — internal plan error.
**Symptom**: Plan "Test infrastructure" section says helpers are "Required by T04+, T06, T08-T11, **T20**." There is no T20 (plan has T01-T14).
**Recommendation**: Editorial fix — strike "T20" reference.

---

## Redundant items

### 1. First-encrypt fingerprint persistence test — assigned to both T06 and T08
**Sites**:
- T06 test bullets: "Wrapped provider first encrypt: assert `system_config` row inserted + `encryption.config.loaded` audit emitted exactly once."
- T08 test bullets: "First successful login on fresh DB → `system_config.encryption.key_fingerprint` populated."
**Canonical owner**: **T06** — it's an assertion on the wrapped-provider behavior, which is T06's responsibility. T08 should drop this case (the integration test there should just assert the row is `enc:v1:`); the boot unit test in T06 is the precise oracle.

### 2. GLOB pattern verification — implicit at multiple guard sites
**Sites**: T06 mentions GLOB once ("Strict-mode guards using `GLOB 'enc:v[0-9]*:*'` (PATCH 3)"); T10 mentions it for migrate SELECT.
**Canonical owner**: Each task owns its own SQL. Not strictly redundant but the plan should add an explicit acceptance bullet in T06 that BOTH guard SELECTs AND the TOKEN_LOSS UPDATE use GLOB (per Missing #4 above).

### 3. Coverage 100% requirement — repeated 3 times for `src/security/`
**Sites**: T03 acceptance, T04 acceptance, T05 acceptance all state 100% coverage. This is correct (each task owns its files), but the `vitest.config.ts` threshold-entry obligation is only stated once (T03). See Missing #2.
**Canonical owner**: Each task owns its file's coverage; T03/T04/T05 each should pin its own `vitest.config.ts` entry. Not actually redundant — just non-uniform.

---

## Notes

**Note A — `cli/server/start.ts` forwards 4 vars, not 3**: T07 forwards `COORDINATOR_ENCRYPTION_KEY`, `COORDINATOR_ALLOW_TOKEN_LOSS`, `COORDINATOR_TOKEN_LOSS_CONFIRM`, `COORDINATOR_ALLOW_KEY_ROTATION` — 4 vars. The plan-review brief says "3 vars" matching V2 §"Daemon-spawn forwarding" (which lists 3); V3 PATCH 10 added the 4th (`COORDINATOR_TOKEN_LOSS_CONFIRM`). Plan correctly includes all 4. The review brief's "3 vars" is stale against V3 — plan is correct.

## Summary

Architecture coverage is comprehensive. The 3 BLOCKING gaps are mechanical:
1. Anchor `tests/helpers/encryption.ts` to T03's Files-touched.
2. Pin `vitest.config.ts` threshold entries in T04 + T05 acceptance.
3. Add SIGINT/SIGTERM cleanup handler to T10.

The 6 NICE-TO-HAVE items are precision improvements that prevent implementer drift but do not block correct implementation. No major architectural holes; no missing tasks at the phase level.
