# Round 1 synthesis — IdP token encryption spec

**Date**: 2026-05-17
**Reviews synthesized**: 01-security-crypto, 02-codebase-consistency, 03-ops-deployment, 04-contrarian-cuts, 05-edge-cases, 06-typescript-api
**Total findings**: ~110 numbered items
**Convergence**: high (3+ reviewers found the same root cause in 8 places)
**Outcome**: spec V2 rewrite + addition of new tasks; ~70% of findings accepted, 30% rejected or modified

---

## Convergent findings (3+ reviewers converged)

| # | Issue | Reviewers | Severity | Decision |
|---|---|---|---|---|
| C1 | `EncryptionContext` accepted but not bound as GCM AAD → cross-row/column ciphertext swap | Sec#1, Edge#20, TS#5 | MAJOR | ACCEPT — bind `org_id‖column‖user_id` as AAD |
| C2 | Plaintext-passthrough on decrypt = permanent silent downgrade. Attacker can overwrite ciphertext with plaintext; restore-without-key emits `enc:v1:…` blob as bearer token to IdP | Sec#2, Edge#10/#11/#17, Ops#3 | CRITICAL | ACCEPT — refuse boot when `enc:v1:` rows exist and key absent or fingerprint mismatch; strict-mode after first encrypted write |
| C3 | `bootPhase2` is sync; `MasterKeyProvider.load()` returns Promise. Spec snippet won't compile | TS#1, Edge#3 | CRITICAL | ACCEPT — make provider load sync (env reads are sync). Defer async interface until KMS lands |
| C4 | `require("node:crypto")` in ESM module → runtime crash | Sec implicit, Codebase#5/#12, TS#2 | CRITICAL | ACCEPT — fix to ESM import |
| C5 | `AuthHandlerContext` has no `encryptionProvider` field; `provisionUser` takes no ctx; spec's "passed via existing context" is false | Codebase#2, TS#3 | CRITICAL | ACCEPT — explicit DI section in V2; enumerate signature changes |
| C6 | Spec misses 2 of 3 `provisionUser` call sites (oauth-callback:366, oauth-token:229) | Codebase#3 | MAJOR | ACCEPT — enumerate all call sites |
| C7 | Silent master-key swap → half-encrypted-half-different-key DB, irrecoverable | Sec#15, Edge#8, Ops#9 | CRITICAL | ACCEPT — persist key fingerprint in DB, boot-check, refuse with override |
| C8 | Backup/restore is unaware of encryption; restore-without-key boots green + silent mass logout | Ops#3, Edge#10 | CRITICAL | ACCEPT — boot-time check (`enc:v1:` rows exist + no key → refuse) |
| C9 | `server start --daemon` does not forward `COORDINATOR_ENCRYPTION_KEY` to child | Ops#1 | CRITICAL | ACCEPT — add `fwd(...)` line + assert at boot |
| C10 | `.env.example` not updated; Docker `env_file` exposes key via `docker inspect` | Ops#11 | MAJOR | ACCEPT — update both `.env.example`; document Docker exposure |
| C11 | Boot warning at WARN level invisible in production log aggregators | Ops#2 | MAJOR | ACCEPT — promote to ERROR in `NODE_ENV=production`; surface in `/health/ready`; re-log every 24h |
| C12 | NULL token at write site silently encrypted as string `"null"` (or runtime throw) | Edge#1 | CRITICAL | ACCEPT — `encryptNullable` helper + mandate at call sites |
| C13 | Empty-string token: undefined round-trip semantics | Edge#2 | MAJOR | ACCEPT — normalize `""` → `null` at write sites |
| C14 | Existing test fixtures write plaintext directly → break under encryption | Edge#19, Codebase#13 | MAJOR | ACCEPT — fixtures keep plaintext writes (exercise lazy-migration path); add `selectIdpToken(db, userId, provider)` test helper |
| C15 | No metrics, no audit events for encryption lifecycle | Ops#7/#8 | MAJOR | ACCEPT (trimmed) — add 3 metrics + 3 audit events, skip the rest |
| C16 | No typed `DecryptionError` → call sites do broad catch | TS#4 | MAJOR | ACCEPT — define + export typed error |
| C17 | Forward-compat: v0.10.5 reading `enc:v2:` falls into passthrough → bearer-token corruption | Edge#17 | MAJOR | ACCEPT — `decrypt()` recognizes any `enc:v\d+:` prefix; unknown version throws `UnknownCipherVersion` (not passthrough) |
| C18 | Migration race with live writes overwrites freshly-refreshed tokens | Edge#6 | MAJOR | ACCEPT — migration UPDATE uses CAS (`AND idp_*_token = ?` with exact prior plaintext) |
| C19 | Two parallel migrator processes both update rows | Edge#7, Ops#5 | MAJOR | ACCEPT — refuse with daemon up unless `--force`; PID file lock for parallel CLI |
| C20 | CLI naming inconsistent with existing `server <subcommand>` pattern | Ops#14, Codebase#6 | MAJOR | ACCEPT — `mcp-coordinator encryption migrate \| verify \| fingerprint` |
| C21 | Coverage thresholds 100% on `src/security/` will block PR | Codebase#11 | MAJOR | ACCEPT — note in spec; add per-file thresholds |

## Single-reviewer findings — ACCEPTED

| # | Issue | Reviewer | Decision |
|---|---|---|---|
| S1 | `enc:v1:` prefix is forgeable — DoS via byte-flip forces user re-auth | Sec#3 | ACCEPT — bind AAD (covered by C1); rate-limit forced re-auth path |
| S2 | Format ambiguity: 64-char string valid as both hex and base64 | Sec#4 | ACCEPT — reject ambiguous; auto-detect alphabet (`+/=` vs `-_` vs hex digits) AND reject if matches multiple |
| S3 | No master-key entropy validation; passphrase accepted silently | Sec#5 | ACCEPT — soft Shannon-entropy check at load (`< 4.5 bits/byte` → log warning, do not reject) |
| S4 | No key zeroization | Sec#6 | DEFER — document acceptance in threat model; add zeroize-on-shutdown as v0.10.6 follow-up |
| S5 | `hmac()` uses master key directly — key separation violation | Sec#7 | ACCEPT — CUT `hmac()` from `EncryptionProvider` interface (unused). Re-introduce with HKDF when a caller needs it |
| S6 | Decrypt error message reveals which user — targeting primitive | Sec#8 | ACCEPT — log user-id hash prefix, not raw id |
| S7 | Future `--rotate --new-key=<x>` flag = key on argv (footgun) | Sec#9 | ACCEPT — document constraint: rotation key MUST be env var or stdin, never argv |
| S8 | No audit log of crypto operations or key load | Sec#10 | ACCEPT — covered by C15 |
| S9 | `MasterKeyProvider` concurrent load race undefined | Sec#11 | RESOLVED — making load sync (C3) and inlining (per contrarian Cut#2 partial accept) removes the concern |
| S10 | Migration batch holds plaintext in memory | Sec#12 | ACCEPT — zero buffers in finally block, batch logs counts only |
| S11 | Nonce reuse risk across instances sharing master key | Sec#13 | DOCUMENT — operational bound: safe up to ~2^32 wraps; rotate before that. Not enforced. |
| S12 | `verify-encryption-key` chosen-ciphertext oracle (weak) | Sec#14 | ACCEPT-AS-IS — local shell access is already higher trust |
| S13 | No `min-version` config knob for future ciphertext downgrade defense | Sec#15 | DEFER — slot in V3 of spec; no env knob in v0.10.5 |
| CB1 | Line numbers in spec slightly off | Codebase#4 | ACCEPT — correct to actual bind lines (90, 119) |
| CB2 | `tests/integration/` is sparse; `cli-*` test prefix convention | Codebase#10 | ACCEPT — rename test paths to match convention |
| CB3 | Coverage threshold (covered by C21) | Codebase#11 | — |
| CB4 | Bench/test fixtures write `users.idp_access_token` directly — keep as plaintext | Codebase#13 | ACCEPT — covered by C14 |
| CB5 | `*.idp_refresh_token` not in logger redact list | Codebase#14 | ACCEPT — one-line addition to `src/observability/logger.ts:REDACT_PATHS` |
| CB6 | `db-adapter.Statement.get()` returns `unknown`, casts needed | Codebase#15 | ACCEPT — note in implementation plan |
| O1 | Key rotation procedure is "forced re-auth", not rotation | Ops#4 | ACCEPT — rename section + explicit "rotation deferred to v0.10.6" + add `--decrypt-all` for rollback symmetry |
| O2 | Migration crash mid-batch resumability | Ops#5 | ACCEPT — exit codes 0/1/2 documented; CAS handles partial state |
| O3 | Encryption status not in `/health/ready` | Ops#6 | ACCEPT — add `encryption` block to readiness payload (non-blocking) |
| O4 | Metrics + audit (covered by C15) | Ops#7/#8 | — |
| O5 | Key fingerprint CLI (covered by C7) | Ops#9 | ACCEPT — add `mcp-coordinator encryption fingerprint` |
| O6 | Multi-instance footgun | Ops#10 | ACCEPT — document single-writer constraint; fingerprint check (C7) prevents most disasters |
| O7 | `.env.example` + Docker (covered by C10) | Ops#11 | — |
| O8 | Malformed env-var boot UX | Ops#12 | ACCEPT — specify `decodeKey()` semantics (trim, alphabet check, explicit error) |
| O9 | Bun metrics verification | Ops#13 | ACCEPT — covered by C14 test changes |
| O10 | CLI grouping (covered by C20) | Ops#14 | — |
| O11 | Rollback story without CLI | Ops#15 | ACCEPT — add `mcp-coordinator encryption migrate --direction=decrypt` |
| O12 | Doc gaps vs `docs/onboarding-self-host.md` | Ops#16 | ACCEPT — enumerate doc updates in V2 |
| O13 | `verify-encryption-key` exit-code 2 ambiguity | Ops#17 | ACCEPT — align with `cli/doctor.ts` (0=ok, 1=warnings, 2=fatal) |
| E1 | Race-condition guards (covered by C18/C19) | Edge#4,#6,#7 | — |
| E2 | Token plaintext literally starts with `enc:v1:` (prefix collision) | Edge#5 | ACCEPT — switch prefix to NUL-byte-prefixed `\x00mcc:v1:` OR keep `enc:v1:` but require post-prefix to be valid base64url **with** AAD check (legacy plaintext starting with prefix → AAD fails → handled as MalformedCiphertext, distinct from DecryptFailed) |
| E3 | `verify-encryption-key` checks one row only (key-rotation false positive) | Edge#9 | ACCEPT — sample 10 random rows; report `{decryptable, undecryptable, plaintext}` counts |
| E4 | Differentiate three decrypt error classes (MalformedCiphertext, DEKUnwrapFailed, DataDecryptFailed) | Edge#12 | ACCEPT — three subclasses of `DecryptionError`; distinct log lines + metrics labels |
| E5 | VACUUM after migration grows DB | Edge#14 | ACCEPT — one-line note in spec migration section |
| E6 | Bun base64url version verification | Edge#15 | ACCEPT — specify minimum Bun ≥1.0.20; round-trip assertion in test |
| E7 | Decrypt-fail forces re-auth — what exactly does that mean at the call-site level? | Edge#21 | ACCEPT — spec says "treat identically to `IdPTokenRevoked`": same audit, same response, same `token_epoch` bump |
| T1 | Hard-coded batch size 100 | TS#8 | ACCEPT — top-of-file const + `--batch-size` flag |
| T2 | Bun `Buffer.toString('base64url')` validation | TS#10 | ACCEPT — covered by E6 |
| T3 | `column` should be literal union not `string` | TS#12 | ACCEPT — tighten type |
| T4 | `EnvelopeEncryption` constructor error message non-actionable | TS#13 | ACCEPT — match `EnvVarMasterKeyProvider` style |
| T5 | Boot comma-operator ternary | TS#14 | ACCEPT — replace with if/else block |
| T6 | `Buffer.concat` type-safety with mixed string/Buffer | TS#15 | ACCEPT — add unit test with NUL-byte plaintext to prove binary-safe end-to-end |

## Contrarian cuts — ACCEPTED

| # | Cut | Decision |
|---|---|---|
| Cut#2 | `MasterKeyProvider` interface | PARTIAL — drop interface, inline env-var read in boot. Re-introduce when 2nd impl exists. |
| Cut#5 | `verify-encryption-key` CLI | REJECT — keep, but enrich per Edge#9 + Ops#9. CLI is operator's pre-flight tool. |
| Cut#6 | `hmac()` method | ACCEPT — drop from `EncryptionProvider`. Re-introduce with HKDF when needed (per Sec#7). |
| Cut#7 | Bun dedicated integration test | PARTIAL — don't add a full integration file; add `tests/unit/envelope-bun.test.ts` with Buffer round-trip + verify CI runs full suite under Bun |
| Cut#8 | Fail-soft → fail-loud at boot | PARTIAL ACCEPT — fingerprint check at boot (C7) is fail-loud for the wrong-key class. Runtime per-row fail-soft for bit-rot. Both correct. |
| Cut#11 | 6 tasks → 2 PRs | REJECT — with C1–C21 additions, scope expanded; tasks become 8-10, ship as 1 release (v0.10.5) but multiple PRs |

## Contrarian cuts — REJECTED

| # | Cut | Reason |
|---|---|---|
| Cut#1 | Envelope encryption (per-row DEK) | REJECT — envelope is +30 LOC for: standard pattern auditors recognize; future rotation trivial (re-wrap DEKs, no data re-encrypt); foundation for per-org keys. |
| Cut#3 | `EncryptionContext` parameter | REJECT — once we bind it as AAD (C1), it is load-bearing. Tighten type instead (T3). |
| Cut#4 | `enc:v1:` versioning | REJECT — Edge#17 shows forward-compat matters. One regex check. |
| Cut#9 | Boot warning | REJECT — keep, promote to ERROR in production (C11). |
| Cut#10 | Require env var, no plaintext fallback | REJECT — v0.10.5 is patch-level; don't break existing deployments. Mark v0.11.0 milestone to require. |
| Cut#12 | 400-line spec → 150 | REJECT — spec will grow to ~600 with all accepted patches. Concision is right ideal; the spec section growth is justified by the threat-model gaps we found. |

---

## Decisions that change spec architecture

1. **`MasterKeyProvider` interface dropped**. Inline env-var read in boot. ~6 lines.
2. **`hmac()` removed from `EncryptionProvider` interface**. Re-add with HKDF when needed.
3. **`EncryptionContext` becomes load-bearing** (bound as AAD). Tighten `column` to literal union.
4. **Sync provider**. `loadMasterKey(): Buffer` not Promise.
5. **Strict mode introduced**: if `enc:v1:` rows exist in DB and the boot env state contradicts (no key, or fingerprint mismatch), boot fails closed.
6. **Key fingerprint persisted in DB** (new `system_config` row or column).
7. **CLI namespace**: `mcp-coordinator encryption {migrate, verify, fingerprint}` (matches `server` pattern).
8. **Forward-compat versioning**: `decrypt()` matches `enc:v\d+:`, unknown → throw `UnknownCipherVersion`.
9. **Three-class `DecryptionError`**: `MalformedCiphertext`, `DEKUnwrapFailed`, `DataDecryptFailed`.
10. **Daemon-spawn forwarding** (`cli/server/start.ts`).
11. **Test fixtures stay plaintext** (exercise lazy path); new `selectIdpToken` test helper for assertions on decrypted values.

## New scope items (not in original spec)

- Update `cli/server/start.ts` to forward env var
- Update `src/observability/logger.ts` redact list
- Persist key fingerprint at first encrypted write
- Boot-time guards: `enc:v1:` rows + missing key → refuse; `enc:v1:` rows + fingerprint mismatch → refuse
- Compare-and-swap migration UPDATE
- PID-file lock for migration CLI
- `/health/ready` payload extension
- 3 prom metrics + 3 audit events
- `selectIdpToken` test helper + decryption-aware test pattern
- Two `.env.example` files
- `docs/ops/encryption-key-management.md` mirroring `key-rotation.md`
- `docs/onboarding-self-host.md` updates
- Coverage threshold entries in `vitest.config.ts`

## Spec V2 structure (target)

```
1. Summary
2. Revision history (V1 → V2 changes, link to round1)
3. Why column-level not whole-DB (3 bullets, kept)
4. Goals + non-goals
5. Architecture (boot, write, read, migrate, restore)
6. Storage format (enc:v1: + AAD binding)
7. Components
   a. Master-key load (inline, sync)
   b. EnvelopeEncryption (with AAD, three error classes)
   c. Strict-mode guards (boot checks)
   d. Key fingerprint persistence
8. DI wiring (AuthHandlerContext, provisionUser signature, all call sites)
9. Migration (lazy + CLI + CAS + lock)
10. CLI commands (encryption {migrate, verify, fingerprint, migrate --decrypt})
11. Operational config (all env vars + Docker note)
12. Migration & rollback runbook
13. Test plan (with fixture-handling pattern)
14. Observability (metrics + audit + readiness)
15. Threat model coverage (what closes / what remains)
16. Risks accepted (zeroization, multi-instance, nonce bound)
17. References
```

Target length: 500-650 lines. Worth the cost: catches the C1–C21 gaps before code.

## Round 2 needed?

YES — after V2 spec is written, do a focused Round 2 with 3 reviewers:
- Crypto reviewer: did AAD binding and three-error-class refactor introduce new attack surface?
- Boot/lifecycle reviewer: did strict-mode guards + fingerprint + daemon-spawn forwarding compose cleanly?
- Test-coverage reviewer: are all 21 convergent issues actually testable in the proposed test plan?

If Round 2 is clean, proceed to implementation plan.
