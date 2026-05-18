# Round 2 synthesis — IdP token encryption spec V2

**Date**: 2026-05-17
**Reviews synthesized**: 01-crypto-v2, 02-boot-lifecycle, 03-test-coverage
**Total findings**: ~36 numbered items (10 crypto + 15 boot + 11 test)
**Outcome**: V3 patches doc (`2026-05-17-idp-token-encryption-design-V3-patches.md`) — supersedes specific sections of V2

## What V2 got right

Round 2 confirms V2's architectural choices are sound:
- AAD binding is mechanically correct (modulo delimiter — see R2-1).
- Three-error-class routing is correct (no leak between classes).
- Forward-compat parser rejects unknown versions (modulo regex bounds).
- `encryptNullable` semantics for empty string are safe at downstream call sites.
- Boot-guard composition closes silent-key-swap + silent-restore-without-key.
- Sync `loadMasterKey()` keeps `bootPhase2` sync — C3 closed cleanly.
- `MasterKeyProvider` removal — YAGNI applied correctly.
- Daemon-spawn env forwarding — C9 closed.

V2 does NOT need a structural rewrite. V3 is mechanical patches.

## CRITICAL + MAJOR findings → V3 patches

### Mechanical bugs (would break implementation)

| # | Issue | Reviewer | V3 fix |
|---|---|---|---|
| R2-1 | `LIKE 'enc:v_:%'` misses `enc:v10:` etc. — 4 sites (boot guard 1, guard 2, migrate, doctor) | Crypto#2 | Use `GLOB 'enc:v[0-9]*:*'` (SQLite GLOB is stricter than LIKE) at all 4 sites |
| R2-2 | `provisionUser` 7th param collision (`encryption` vs existing `idpRefreshToken?`) | Boot#2 (CRITICAL) | Refactor to **options-object signature** — self-documenting, fixes existing positional fragility |
| R2-3 | `system_config` table doesn't exist — needs CREATE TABLE not ALTER | Boot#1 | Add `CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)` to `src/database.ts` migration block |
| R2-4 | Boot guard ordering: spec says step 2-3 (top of boot) but `audit()` requires `initAuditQueue` (step 7) and guards need `performRestoreCheck` (step 5) to run first | Boot#3 | V3 specifies exact placement: between current step 8 and step 9 of `bootPhase2` |
| R2-5 | `decryptNullable` needs `org_id` for AAD reconstruction but SELECT at `refresh-rotation.ts:547` doesn't fetch `primary_org_id` | Boot#15 | Spec extends SELECT to include `primary_org_id`; all read sites enumerated |
| R2-6 | Decrypt-failure throws sync from `decryptNullable`; bypasses existing async try/catch in refresh-rotation; spec's "treat like IdPTokenRevoked" wiring needs explicit code shape | Boot#11 | V3 provides the wrapping pattern verbatim |
| R2-7 | Fingerprint persistence placement is ambiguous (provider? helper? call site? boot?) | Boot#8 | V3 specifies: wrap the provider in `bootPhase2` with a side-effect-bearing `encrypt` that writes the fingerprint on first call. Keeps `EnvelopeEncryption` pure. |
| R2-8 | `setInterval` uses non-existent `audit.log()` API + no teardown hook | Boot#6 | V3 uses `createLogger()` (pino) for the reminder; interval handle stored + cleared in `Phase2Bootstrap.shutdown` |
| R2-9 | `decodeMasterKey` ambiguity check is dead code; entropy < 3.0 should refuse (currently `0xaa…aa` passes with only a warn) | Crypto#1 | V3 removes ambiguity claim from comments + strengthens entropy: refuse `< 3.0 bits/byte`, warn `3.0-4.5` |
| R2-10 | AAD `|` delimiter is not injection-proof (org_id/column/user_id not constrained) | Crypto#3 | V3 switches to **length-prefixed encoding**: `u8(version) \|\| u16be(len_org) \|\| org_id \|\| u16be(len_col) \|\| column \|\| u16be(len_user) \|\| user_id`. Parser-proof. |
| R2-11 | `COORDINATOR_ALLOW_TOKEN_LOSS=1` irreversibly NULLs all encrypted tokens with no confirmation | Crypto#6 | V3 requires second env var `COORDINATOR_TOKEN_LOSS_CONFIRM=I_UNDERSTAND_THIS_NULLS_<N>_ROWS` matching actual count. First boot prints required value + N; second boot proceeds. Per-user audit row + ciphertext stashed in `encryption_invalidated_tokens` for recovery. |
| R2-12 | `/health/ready` JSON shape uses `ready` but actual payload uses `status` | Boot#7 | V3 corrects example; specifies `getEncryptionStatus()` accessor pattern |
| R2-13 | Fingerprint length inconsistent (8 hex at boot, 16 hex in CLI) | Crypto#5 | V3 standardizes: **16 hex chars (64 bits)** everywhere. Switch to HMAC-SHA256 with label `"mcc-fingerprint-v1"` for key separation. |

### Documentation / clarity patches

| # | Issue | Reviewer | V3 fix |
|---|---|---|---|
| R2-14 | Key rotation runbook under-emphasizes plaintext-on-disk window during decrypt-all step | Crypto#7 | V3 adds explicit "during steps 3-5 of rotation, DB contains plaintext IdP tokens" warning + risk-accepted entry |
| R2-15 | Boot SELECT scan acceptable but spec should note it | Boot#4 | V3 adds one-sentence note |
| R2-16 | Daemon-spawn forwarding phrasing: "silently runs plaintext" is partly mitigated by guards on existing-enc DB | Boot#5 | V3 tweaks language |
| R2-17 | Coverage threshold for `src/boot.ts` requires enumerating ~12 boot-guard branch cases | Boot#13 | V3 lists the case matrix in test plan |
| R2-18 | Audit events need `tier` pinning | Boot#14 | V3 adds tier per event |

### MINOR / NIT findings — accept selectively

| # | Issue | Decision |
|---|---|---|
| R2-19 | Error-class oracle (audit + metrics expose `error_class`) | ACCEPT — keep metric (operator needs it), document acceptance |
| R2-20 | Version regex bounds `\d+` accepts huge numbers | ACCEPT — tighten to `/^enc:v([1-9]\d{0,2}):/` (versions 1-999, no leading zeros) |
| R2-21 | Zeroization theatre — plaintext string in V8 heap unmitigable | ACCEPT — V3 docs honestly: DEK zeroized; plaintext is JS-string-immutable |
| R2-22 | Lock file Windows semantics | ACCEPT — V3 uses PID-in-content lock; auto-recovers from stale lock if PID dead |
| R2-23 | `--compare` flag for `encryption fingerprint` | DEFER — `encryption verify` already does it; cut for v0.10.5 |
| R2-24 | `getRunningCoordinatorPid` accessibility | ACCEPT — one-line clarification: `ensureConfigDir()` from `cli/config.ts` |
| R2-25 | First-encrypt INSERT race (concurrent first-login) | ACCEPT — V3 uses `INSERT OR IGNORE` |

## Test coverage gaps → implementation plan

The Round 2 test-coverage review surfaced 11 GAPs + 2 redundancies + 2 test-infrastructure gaps. **None require spec changes** — they require implementation-plan task enumeration. The V3 patches add a single section: **"Test plan additions"** listing the 11 gaps. The actual test files get created in implementation tasks.

Specifically captured in V3:
- C2 silent-downgrade attacker scenario (refresh-rotation integration test)
- C3 sync boot type-level check
- C5 DI wiring direct assertion
- C6 oauth-callback + oauth-token encrypted integration
- C9 `cli/server/start.ts` env-forwarding test
- C11 ERROR-level prod log + setInterval timer test (vi.useFakeTimers)
- C14 lazy-migration-tolerance regression test
- C15 metrics + audit emission assertions
- C18 real concurrent-write race for migrate CAS
- AAD format injection forcing-function test
- V2: `/health/ready` encryption block test
- V2: first-encrypt fingerprint persistence assertion
- Test infrastructure: `makeTestEncryption()` + `withEncryptionEnv()` helpers
- Test infrastructure: `bootPhase2` refactored to accept injectable deps `(deps: { db, env, logger })` for fail-loud guard testing

## Architectural decisions changed by R2

1. **AAD encoding**: pipe-delimited string → length-prefixed binary. Parser-proof.
2. **provisionUser signature**: positional 7-param → options object. Self-documenting.
3. **Fingerprint derivation**: SHA-256 prefix → HMAC-SHA256 with label, 16 hex chars.
4. **TOKEN_LOSS override**: single env var → two env vars + per-user audit + ciphertext stash table.
5. **Fingerprint persistence**: ambiguous "first encrypt" → explicit provider-wrapper in `bootPhase2`.
6. **SQL prefix match**: `LIKE 'enc:v_:%'` → `GLOB 'enc:v[0-9]*:*'`. 4 sites.
7. **system_config**: assumed-existing → explicit CREATE TABLE in `src/database.ts`.
8. **Boot ordering**: top-of-boot → after step 8 (initPhase2Auth), before step 9 (context compose).
9. **bootPhase2 testability**: monolithic → `(deps: { db, env, logger })` injectable.

## Round 3 needed?

NO. V3 patches are mechanical and well-scoped. The remaining risk is:
- Implementation-plan-level details (test specifics, file ordering, LOC budgets per PR) — caught in plan review (Round 1 plan).
- Operational nuance (real-world deployment quirks, KMS demand, BYOK) — caught in field feedback after v0.10.5 ships.

Skipping Round 3 saves ~2-3 hours and ~200k tokens. Plan review will catch downstream issues. If the plan review surfaces V3-architectural concerns, revisit the spec.

## What changed vs Round 1

| Round 1 (V1 → V2) | Round 2 (V2 → V3) |
|---|---|
| Architectural rewrite — closed catastrophic gaps | Mechanical patches — closed wrong-but-plausible-implementation traps |
| 6 reviewers, ~110 findings | 3 reviewers, ~36 findings |
| Many new sections added (AAD, strict-mode, fingerprint, three-class errors) | Section-targeted edits (SQL, signatures, schemas, placements) |
| V2 spec grew from ~330 to ~700 lines | V3 patches doc: ~400-500 lines, supersedes specific V2 sections |

## Path forward

1. Write `2026-05-17-idp-token-encryption-design-V3-patches.md` (this round).
2. Update task list: spec done → implementation plan.
3. Implementation plan (`docs/superpowers/plans/2026-05-17-idp-encryption-plan.md`) — atomic tasks with file paths, LOC, dependencies, acceptance.
4. Round 1 plan review (4 reviewers: task atomicity / dependency graph / missing tasks / over-engineered tasks).
5. Apply plan patches.
6. Implement.
