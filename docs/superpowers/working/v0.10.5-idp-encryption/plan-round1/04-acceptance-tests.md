# Plan Round 1 — Acceptance + tests

**Verdict**: NEEDS-TIGHTENING

Plan is unusually thorough for test enumeration (T04, T06, T09, T10 all carry explicit case lists matching V3 PATCH 19). The architecture survives review. What's missing is mostly **operationalization**: acceptance criteria say "tests pass + coverage gate met + lint clean" boilerplate without specifying the commands, the thresholds aren't consistently scoped per-file across tasks, the cross-cutting `tests/helpers/encryption.ts` is documented but orphaned from any task's deliverable checklist, and a handful of test cases listed are not actually achievable inside vitest without harness work the plan does not call out.

## Findings

### 1. T03: INFRASTRUCTURE-GAP — `tests/helpers/encryption.ts` is unowned

**Issue**: Plan §"Test infrastructure (cross-cutting)" (line 580) says the helper is "created as part of T03 (encryption.ts companion)" — but T03's **Files touched** list (lines 137-145) does not include `tests/helpers/encryption.ts`, and its **Acceptance** does not mention it. T04, T06, T08-T11 all consume `makeTestEncryption()`. If T03 ships first without the helper, every dependent task either reinvents it (drift) or blocks. The helper also depends on `computeKeyFingerprint` which lives in T05 — so a strict reading makes the helper undeliverable in T03 anyway.

**Recommendation**: Either (a) add `tests/helpers/encryption.ts` to T05's **Files touched** (after `computeKeyFingerprint` exists) with explicit acceptance "T06+ can import `makeTestEncryption`, `withEncryptionEnv`, `selectIdpToken`", or (b) split out a tiny T05.5 "Test helpers" task. Also add to acceptance: "`grep -r 'new EnvelopeEncryption(' tests/` returns only the helper file."

### 2. T03/T04/T05: COVERAGE-GAP — per-file vitest threshold entries inconsistently required

**Issue**: T03 acceptance (line 175) says "100% coverage on both new files" and the impl summary (line 171) explicitly directs adding `vitest.config.ts` per-file threshold entries. T04 acceptance (line 213) and T05 acceptance (line 250) say "100% coverage on `src/security/...`" but do **not** direct the implementer to add the per-file threshold entry. Without the explicit entry, coverage might be 100% in CI run output but the gate won't enforce regression on later PRs.

**Recommendation**: Add to T04 and T05 implementation summary: "Add per-file `vitest.config.ts` coverage threshold entry at 100% statements/branches/functions/lines for the new file." Make this acceptance-checkable: "`grep envelope-encryption.ts vitest.config.ts` returns a thresholds entry."

### 3. T06: UNTESTABLE — "concurrent first-encrypt race" in vitest

**Issue**: Line 305: "Concurrent first-encrypt race: simulate two parallel `encrypt()` calls → both succeed, exactly one INSERT row." Vitest runs on a single event loop; better-sqlite3 calls are synchronous. "Parallel" here is a fiction — `Promise.all([provider.encrypt(...), provider.encrypt(...)])` interleaves nothing because there is no I/O suspension point inside the wrapped `encrypt`. The test will trivially pass against any implementation (including a broken one with no `INSERT OR IGNORE`) because the second `encrypt` always sees `fingerprintPersisted=true` by the time it runs. This is **tautological**.

**Recommendation**: Either (a) drop the test and rely on the SQL-level `INSERT OR IGNORE` correctness assertion ("call provider.encrypt directly without going through wrapper, then assert second `INSERT OR IGNORE` does not throw and row count stays at 1"), or (b) mark this as a `tests/integration/` test using worker_threads/child_process if the race genuinely needs proving, and call that out as harness work.

### 4. T06: VAGUE-ACCEPTANCE — "100% coverage on the new `src/boot.ts` lines"

**Issue**: Line 312 — `boot.ts` is a large existing file. "100% coverage on the new lines" is not enforceable by vitest's per-file threshold (it's a whole-file threshold). An implementer has no mechanical check for this acceptance.

**Recommendation**: Either (a) raise the file-level threshold (likely already 100% for boot.ts; verify) and acceptance becomes "boot.ts threshold remains 100%", or (b) extract encryption boot logic into `src/boot-encryption.ts` (a new file with its own 100% per-file threshold) — this is also cleaner separation. Recommend (b) — the encryption block is ~150 LOC of distinct concern.

### 5. T06: MISSING-TEST — branch matrix omits "encrypted_invalidated_tokens already exists" case

**Issue**: PATCH 10 creates `encryption_invalidated_tokens` with `IF NOT EXISTS`. The branch matrix (lines 284-298) doesn't test the second-override-run case: operator hits TOKEN_LOSS override, then re-runs (e.g. after restart with same broken state) — the stash table has prior rows. The PRIMARY KEY `(user_id, column_name, invalidated_at)` uses `CURRENT_TIMESTAMP` default — fast successive overrides could collide. Untested.

**Recommendation**: Add row #13 to matrix: "TOKEN_LOSS override runs twice (simulate via two `bootPhase2` invocations) → second run no-ops (no rows to stash) or appends with distinct timestamps. Verify INSERT does not throw on PK collision."

### 6. T06: VAGUE-ACCEPTANCE — "Existing boot tests unchanged behavior"

**Issue**: Line 313. T01 already added a deps signature change. T06 adds substantial new logic. "Existing tests unchanged" is observation-only, not verifiable. Implementer might quietly modify a test fixture and claim "unchanged behavior."

**Recommendation**: Acceptance: "`git diff main -- tests/unit/boot*.test.ts tests/integration/boot*.test.ts` shows only additions (no deletions or modifications) outside of newly-introduced encryption-related cases." Or commit-policy: "existing boot test files are not modified in T06's commit."

### 7. T07: MISSING-TEST — `COORDINATOR_ALLOW_KEY_ROTATION` not forwarded but plan has it elsewhere

**Issue**: T07 implementation summary (lines 330-334) lists 4 env vars to forward including `COORDINATOR_ALLOW_KEY_ROTATION`. T07 test cases (lines 338-340) mention only "the 3 other vars" plus the key itself = 4 total — count matches. But the acceptance (line 342) is just "tests pass". No assertion that grep of `cli/server/start.ts` shows all four `fwd()` lines and not more (drift detection). Also missing: assertion that the **fingerprint** env var (if it ever gets one) is not silently shadowed.

**Recommendation**: Acceptance: "All 4 `fwd()` invocations present; `grep -c 'fwd("COORDINATOR_' cli/server/start.ts` returns exactly the expected count (existing + 4)." Test the exact-set, not just the presence-of.

### 8. T08: DUPLICATE-TEST — fingerprint persistence verified twice

**Issue**: T06 test (line 304) asserts "Wrapped provider first encrypt: assert `system_config` row inserted + `encryption.config.loaded` audit emitted exactly once". T08 test (line 374) asserts "First successful login on fresh DB → `system_config.encryption.key_fingerprint` populated. 2nd login → no additional fingerprint row." Same invariant, two locations. If the wrapped-provider implementation changes (e.g. moved to a different module), both tests need updating; if only one is updated, the other passes for the wrong reason.

**Recommendation**: T08 should test "login produces enc:v1: row" only and *not* re-assert fingerprint persistence (T06 owns that). Add comment in T08 test referencing T06 as source of truth. Or — better — make T08's fingerprint test a single line: `expect(getStoredFingerprint(db)).toBe(expectedFingerprint)` consuming a helper, so the boot-side mechanism remains the single owner.

### 9. T09: MISSING-TEST — `bumpTokenEpoch` reuse not verified

**Issue**: PATCH 8 line 374: "implementation plan must verify and reuse" the existing `bumpTokenEpoch` helper. T09 test (line 403) asserts "`token_epoch` for the user incremented by exactly 1" — that proves the value moves but does NOT prove the existing helper is called (an implementer could write `db.exec("UPDATE users SET token_epoch = token_epoch + 1 ...")` inline, drifting from the canonical IdPTokenRevoked path). If the helper later changes (e.g. adds audit emission), the inline path silently diverges.

**Recommendation**: Either (a) acceptance: "`grep bumpTokenEpoch src/auth/refresh-rotation.ts` returns ≥1 match," or (b) write the test using `vi.spyOn(tokenEpochModule, 'bumpTokenEpoch')` and assert `toHaveBeenCalledWith(db, userId)`.

### 10. T09: MISSING-TEST — concurrent refresh during plaintext lazy-migration

**Issue**: T09 lazy-migration test (line 397) covers single-refresh upgrade. But two parallel refresh requests for the same user, when the row is still plaintext, both pass plaintext to IdP, both get new tokens, both try to UPDATE — last write wins, but **which** new ciphertext lands? Could leave the user's session bound to a ciphertext that's not the access token they hold. Round 1 C2 silent-downgrade flagged related concerns; this is the lazy-migration race variant.

**Recommendation**: Add test: "Two `Promise.all` refresh calls on plaintext row → both succeed without throwing; final row is `enc:v1:` and decrypts to one of the two new tokens; assert that the user_session's bearer token matches the persisted one (no orphan ciphertext)." If genuinely racy in production, escalate to T06 redesign with row-level lock.

### 11. T10: UNTESTABLE — "Real race" between two processes inside vitest

**Issue**: Line 442: "Real race (extension over C18): two parallel processes, second blocks on lock or exits 2." Vitest test files are not separate processes by default. Spawning two `node` subprocesses inside a vitest case requires (a) the migrate CLI as a buildable artifact at test time (it's tsx-compiled), (b) cross-platform PID-alive semantics that match production, (c) timing harness. Plan does not call out the test harness work or list `child_process.spawn` as a tool. Implementer will either skip this test (silent drop) or invent a flaky timing-based version.

**Recommendation**: Either (a) demote to "single-process simulation: manually open the lock with PID = `process.pid` via `fs.writeFileSync`, then invoke migrate, assert it short-circuits" (covers the lock-conflict logic but not real concurrency), or (b) add explicit task line item "T10.test-harness: `tests/helpers/spawn-migrate.ts` that runs the CLI in a subprocess with controlled env" and budget LOC. Either is fine — but be explicit.

### 12. T10: MISSING-TEST — `--force` audit emission

**Issue**: Test cases line 446: "Daemon running + `--force` → proceeds (with audit warning)". The "audit warning" parenthetical is not asserted — the plan never says the `--force` path must emit a specific audit event, what event, or what tier. PATCH 17 audit table doesn't include a `--force` event. Either it must exist (then add to PATCH 17 + assert here) or it doesn't (then drop the parenthetical from acceptance).

**Recommendation**: Decide: add `encryption.migration.forced` (tier 1) to PATCH 17 and test for it, OR remove "(with audit warning)" from the test description so acceptance doesn't reference an unimplemented signal.

### 13. T11: MISSING-TEST — `verify` exit codes not symbolically asserted

**Issue**: T11 test cases (lines 481-487) say "verify exit 0", "verify exit 2" — but the implementation refers to `cli/doctor.ts:877-880` convention (per Open question #5 line 630). No constant or shared enum is referenced. If the convention is hardcoded (`process.exit(2)`) at multiple sites, drift is inevitable. Open question #5 also flags an unresolved decision about "no encrypted rows yet" exit code.

**Recommendation**: (a) Resolve Open question #5 before T11 acceptance is finalized; record decision in T11 acceptance criteria with explicit code. (b) Add acceptance: "verify uses shared `EXIT_OK`/`EXIT_FATAL` constants (same source as `doctor.ts`), not magic numbers." Add a test case explicit for "no encrypted rows + key set" → asserts the agreed exit code.

### 14. T12: MISSING-TEST — `decrypt_failures_5m` semantics never tested

**Issue**: PATCH 12 says `decrypt_failures_5m` is "read from the prom counter (sliding 5-min window via prom-client's built-in rate or a separate ring buffer)." Two very different implementations — both pass "incremented by 1" check from T12 line 517. The 5-minute window semantic is not asserted. T12 test "Induce decrypt failure → counter incremented by 1" tests the counter, not the window. After 6 minutes the value should decay to 0 — never tested.

**Recommendation**: Either (a) drop the "5m" suffix and just expose the lifetime counter (let operators compute rate externally — Open question #6's posture is sensible), or (b) add test: "Induce failure; advance `vi.useFakeTimers()` by 5 minutes; assert `getEncryptionStatus().decrypt_failures_5m === 0`." Without one or the other, the field is theater.

### 15. T13: VAGUE-ACCEPTANCE — "No broken internal links"

**Issue**: Line 547. Plan says "`npm run docs:check` (if exists) clean" — the "(if exists)" parenthetical means the gate may or may not run. If it doesn't exist, acceptance is the implementer's eyeball judgment. Round 1 reviewers can't grade this.

**Recommendation**: Decide before T13 starts: either add a docs link check (markdown-link-check or similar) as a one-line script and require it pass, or remove the "no broken links" criterion entirely (defer to humans). Don't leave it as a maybe-gate.

### 16. T14: COVERAGE-GAP — `prepublishOnly` doesn't necessarily run new tests

**Issue**: T14 line 566: "Verify `prepublishOnly` passes (`npm run build && npm test`)." `npm test` likely runs vitest with the project's default config — but does it include `tests/integration/` files? The plan introduces many new integration tests (`oauth-callback-encrypted.test.ts`, `lazy-migration-tolerance.test.ts`, etc.) — if `npm test` is configured to run only `tests/unit/`, these never gate the release.

**Recommendation**: Acceptance: "Run `npm test 2>&1 | tee /tmp/test.log` and grep for each of the new test file names listed in T04–T12 — every file MUST appear with passing status. Document the count in the release PR description." Or modify `package.json` `test` script to ensure integration tests are included, as a separate prerequisite task before T14.

### 17. All tasks: VAGUE-ACCEPTANCE — "Lint clean" not bound to a command

**Issue**: Repeated in T01, T02, T03 acceptance ("Lint clean"). Project may have `npm run lint` or use a pre-commit hook or a husky config — unspecified. An implementer running `eslint src/` directly might miss config-level rules; CI lint job might pass while a specific rule fails locally.

**Recommendation**: Specify once in the plan preamble (line 3): "Acceptance check 'lint clean' = `npm run lint` exits 0." Then individual task acceptances inherit unambiguously.

---

## Summary

Highest-leverage fixes (do these first):
1. **#1 — assign helper file ownership** (cheap; unblocks half the plan).
2. **#3, #11 — drop or rewrite untestable concurrency cases** (prevents implementer fabrication).
3. **#8 — deduplicate fingerprint test** (clarifies ownership boundaries).
4. **#16 — verify `npm test` includes integration files** (release-blocking otherwise).
5. **#13 — resolve verify exit codes before T11 starts** (resolves Open question #5).

Lower priority but worth a revision pass: #2, #4, #5, #6, #9, #14, #17 (precision improvements; not blocking but make acceptance machine-checkable).
