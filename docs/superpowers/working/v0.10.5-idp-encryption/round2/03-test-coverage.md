# Round 2 review — Test coverage (V2 spec)

**Overall verdict**: GAPS-EXIST
**Issues with no clear test**: 11 (C2-partial, C5, C6, C9, C11, C15, C18-partial, C19-partial, plus 5 V2-addition gaps that bleed across these)
**Redundant tests**: 2

The V2 test table (§Testing → "Test files") covers the crypto core, the helper, the CLI subcommands, the boot guards, and one happy-path integration. What it does **not** explicitly cover: the silent-downgrade attacker scenario (plaintext-over-ciphertext), DI wiring assertions, the 3 enumerated `provisionUser` call sites, the daemon-spawn env forwarding, the ERROR-level prod log + 24h re-log timer, metrics/audit emission assertions, the round-trip property of `migrate --decrypt`, AAD format injection, and the readiness payload. Several map "loosely" to listed files but with no scenario specified. Test-infrastructure: the spec specifies a `selectIdpToken` helper but never specifies a **`makeTestEncryption()` fixture-key factory** — every test file will reinvent one. Boot-guard tests must spawn a child process or be carefully refactored to make `bootPhase2` invokable in-process; the spec is silent on which.

---

## Mapping: convergent issues → tests

| Issue | Test file | Coverage |
|---|---|---|
| C1 (AAD binding) | `envelope-encryption.test.ts` | PARTIAL — "wrong-AAD throws `DataDecryptFailed`" listed, but spec doesn't enumerate the three swap scenarios (cross-row / cross-column / cross-user). GAP for explicit swap-and-decrypt-fail matrix. |
| C2 (silent downgrade) | `boot-encryption-guards.test.ts` (restore-without-key half only) | PARTIAL — covers "key absent + enc rows → refuse". MISSING: "attacker overwrites enc:v1: row with plaintext at rest → daemon serves what?" scenario. With current spec the read-path returns plaintext as-is — no test asserts whether that's caught or audited. |
| C3 (sync boot) | (none) | GAP — no test asserts `bootPhase2` remains sync. Could be a type-level test or a `expect(bootPhase2(...)).not.toBeInstanceOf(Promise)` smoke test. |
| C4 (ESM require) | N/A | OK — compile-time error, lint covers. |
| C5 (DI wiring) | `oauth-finalize-encrypted.test.ts` (implicit) | GAP — no test explicitly asserts `ctx.encryptionProvider instanceof EnvelopeEncryption` at handler invocation. The integration test would fail if DI broke, but only as a side-effect; a direct context-shape test is cheaper and clearer. |
| C6 (3 call sites) | `oauth-finalize-encrypted.test.ts` | GAP — only oauth-finalize is exercised. The two other call sites (`oauth-callback.ts:366`, `oauth-token.ts:229`) have no encryption-on integration test in the table. |
| C7 (key swap) | `boot-encryption-guards.test.ts` | OK — "guard 2 fingerprint mismatch refuses; ALLOW_KEY_ROTATION=1 proceeds" listed. |
| C8 (restore without key) | `boot-encryption-guards.test.ts` | OK — "guard 1 key absent + enc rows refuses; ALLOW_TOKEN_LOSS=1 NULLs+audits" listed. |
| C9 (daemon-spawn fwd) | (none) | GAP — no test in the V2 table targets `cli/server/start.ts` env forwarding. This is the silent-plaintext-on-daemon footgun; needs an explicit assertion. |
| C10 (.env.example) | N/A | OK — doc-only. |
| C11 (boot warning in prod) | (none) | GAP — `boot-encryption-guards.test.ts` doesn't list NODE_ENV=production ERROR-level assertion, nor the 24h `setInterval` re-log. |
| C12 (NULL handling) | `encrypt-nullable.test.ts` | OK — "NULL → null" listed. |
| C13 (empty string) | `encrypt-nullable.test.ts` | OK — "empty → null" listed. |
| C14 (fixtures stay plaintext) | (none — only documented) | GAP — spec says fixtures continue to work; no regression test that boots the daemon with `COORDINATOR_ENCRYPTION_KEY` set AND runs a plaintext-fixture-seeded test through a refresh to prove the lazy-path tolerance. Without this, the moment someone tightens the read path, all 8 listed fixture-using tests silently fail. |
| C15 (metrics + audit) | (none) | GAP — neither the unit nor integration test lines mention asserting `coordinator_idp_decrypt_failures_total` increments or `encryption.decrypt.failed` audit emission. |
| C16 (DecryptionError class) | `envelope-encryption.test.ts` | OK — three error classes named in the scope line. |
| C17 (UnknownCipherVersion) | `envelope-encryption.test.ts` | OK — "unknown version throws `UnknownCipherVersion`" listed. |
| C18 (migration CAS) | `cli-encryption-migrate.test.ts` | OK — "CAS skip when concurrent write detected" listed. (But: see Gap #7 — no test of the actual write-during-migrate race; the listed test likely just pre-mutates the row before UPDATE.) |
| C19 (parallel migrators) | `cli-encryption-migrate.test.ts` | OK — "lock file held → exit 2" listed. |
| C20 (CLI under `encryption`) | `cli-encryption-{migrate,verify,fingerprint}.test.ts` | OK — three files cover the subcommands. |
| C21 (coverage threshold) | (none) | GAP — no CI-level test that runs `vitest --coverage` and asserts the new files hit threshold. Caught at CI but spec should call it out as a required CI gate, not a unit test. |

### V2 additions

| Feature | Coverage |
|---|---|
| Key fingerprint write at first encrypt | GAP — `boot-encryption-guards.test.ts` covers boot-time fingerprint behaviour but no test asserts that the first successful `encrypt()` from a fresh-key DB actually inserts the `system_config` row. |
| Strict-mode guards refuse + override | OK — `boot-encryption-guards.test.ts`. |
| `encryption migrate --direction=decrypt` round-trip | PARTIAL — listed as "decrypt direction round-trips" but unclear whether it's a full `encrypt → decrypt → same plaintext` symmetric test or just exit-code coverage. IMPROVE scope. |
| `encryption verify` sample-N-rows logic | OK — `cli-encryption-verify.test.ts` (mixed pass/fail counts). |
| `encryption fingerprint` CLI output format | OK — `cli-encryption-fingerprint.test.ts`. |
| AAD format injection (org_id containing `\|`) | GAP — no test for `org_id="evil|column|other"` collision. AAD is unparsed string concat, so a malicious org_id could in theory produce the same AAD as a different (org, column, user) triple. Needs either a delimiter-escape test or an explicit "we accept this risk because org_id is server-controlled" doc. |
| Decrypt-failure → `IdPTokenRevoked`-equivalent | PARTIAL — `refresh-rotation-encrypted.test.ts` mentions "decrypt failure surfaces as `IdPTokenRevoked`-equivalent path" but doesn't enumerate: same audit code? same `token_epoch` bump? same HTTP response shape? IMPROVE — split into 3 sub-assertions. |
| Periodic plaintext-reminder `setInterval` | GAP — no test, and `setInterval` with 24h delay is hard to test without `vi.useFakeTimers()`. Spec should call this out. |
| `/health/ready` encryption block | GAP — no test in the V2 table targets the readiness payload shape (`encryption.enabled`, `key_fingerprint`, `decrypt_failures_5m`). |

---

## Gaps

### 1. C2 (silent downgrade attacker scenario): no test
**What's missing**: spec covers "restore without key → boot refuses" but not "attacker with DB-write replaces enc:v1: row with plaintext while daemon is running → read path returns the plaintext blob as the bearer token". Per `decrypt()` semantics: no `enc:v_:` prefix → return as-is. That's plaintext-by-construction; what the test must assert is what the **caller** does with it (refresh-rotation should treat any value as opaque until IdP rejects it — likely no observable diff, but the test pins the behaviour).
**Suggested test**: `tests/integration/refresh-rotation-encrypted.test.ts` add: "given a row with valid `enc:v1:` ciphertext is overwritten in-place with arbitrary plaintext, refresh proceeds and IdP returns 401 → user is forced to re-auth via the normal `IdPTokenRevoked` path; no crash."

### 2. C5 (DI wiring): no direct assertion
**What's missing**: a test that asserts `ctx.encryptionProvider` is the correct concrete type when key is set vs. unset.
**Suggested test**: add `tests/unit/boot-di-wiring.test.ts` — "given `COORDINATOR_ENCRYPTION_KEY` set, `bootPhase2` produces a context with `encryptionProvider instanceof EnvelopeEncryption`; without, `instanceof PassthroughEncryption`".

### 3. C6 (3 provisionUser call sites): only 1 covered
**What's missing**: integration tests for the browser-callback and CLI-grant paths under encryption.
**Suggested test**: add `tests/integration/oauth-callback-provisioning-encrypted.test.ts` and `tests/integration/oauth-token-grant-encrypted.test.ts` mirroring the oauth-finalize test. Or extend the existing one to parametrise over all 3 call sites.

### 4. C9 (daemon-spawn env forwarding): no test
**What's missing**: an assertion that `cli/server/start.ts` includes `COORDINATOR_ENCRYPTION_KEY` (and the two override vars) in `childEnv`.
**Suggested test**: add `tests/unit/cli-server-start-env-forwarding.test.ts` — mock the child-spawn; assert `childEnv.COORDINATOR_ENCRYPTION_KEY === parentEnv.COORDINATOR_ENCRYPTION_KEY`. Cheap, catches the most dangerous regression in the spec.

### 5. C11 (ERROR-level log in production): no test
**What's missing**: assertion that boot with no key emits ERROR-level audit log when `NODE_ENV=production`, WARN otherwise, and registers the 24h reminder timer.
**Suggested test**: extend `boot-encryption-guards.test.ts` with two cases — `NODE_ENV=production` → spy on logger, assert `.error(...)` call; non-prod → `.warn(...)`. For the `setInterval`: `vi.useFakeTimers(); vi.advanceTimersByTime(86_400_000); expect(logger.error).toHaveBeenCalledTimes(2)`.

### 6. C14 (plaintext fixtures regression-test): no test
**What's missing**: a "meta-test" that proves the read path tolerates plaintext under encryption-enabled boot. Without it, the 8 listed plaintext-using tests are themselves the only proof — and they don't run with `COORDINATOR_ENCRYPTION_KEY` set.
**Suggested test**: `tests/integration/lazy-migration-tolerance.test.ts` — boot daemon with key set, seed a user row with plaintext tokens, perform a refresh, assert: (a) no decrypt error, (b) post-refresh row is `enc:v1:`-prefixed.

### 7. C15 (metrics + audit emission): no test
**What's missing**: assertions that each of the 3 metrics and 5 audit events actually emit at the right moments.
**Suggested test**: extend `envelope-encryption.test.ts` (or new `tests/unit/encryption-observability.test.ts`) — induce a decrypt failure, assert `coordinator_idp_decrypt_failures_total{error_class="DataDecryptFailed"}` incremented by 1 and `encryption.decrypt.failed` audit emitted with the right user_id hash + column.

### 8. C18 (migration CAS — real race): IMPROVE scope
**What's missing**: the listed test almost certainly does a pre-mutation, not a real concurrent write. A proper test needs to interleave a SELECT and an UPDATE around the CAS.
**Suggested test**: in `cli-encryption-migrate.test.ts` add: "given migrate has SELECTed plaintext T1 for row R, before its UPDATE runs the daemon refreshes R to T2; CAS UPDATE affects 0 rows; migration logs skip; row's final value is `encrypt(T2)`, not `encrypt(T1)`."

### 9. C19 (parallel migrators): IMPROVE
**What's missing**: "lock file held → exit 2" tests a static lock. The real concern is two processes racing to acquire. Use `fs.openSync(path, 'wx')`-style atomic create; test by spawning two children concurrently.
**Suggested test**: spawn 2 migrate subprocesses with the same data_dir; assert one exits 0/1 and the other exits 2 with "lock held" message.

### 10. V2: key fingerprint first-write
**What's missing**: no test that asserts `system_config.encryption.key_fingerprint` is populated after the first successful `EnvelopeEncryption.encrypt()` against a fresh DB.
**Suggested test**: `tests/integration/oauth-finalize-encrypted.test.ts` add post-condition: `SELECT value FROM system_config WHERE key='encryption.key_fingerprint'` equals `sha256(masterKey).slice(0,8)`.

### 11. V2: AAD format injection
**What's missing**: no test for `EncryptionContext` fields containing the `|` delimiter.
**Suggested test**: `tests/unit/envelope-encryption.test.ts` add: "given org_id='a|idp_access_token|b' and user_id='c' produces same AAD bytes as (org='a', column='idp_access_token', user='b|...|c') → assert decrypt with the second context succeeds with ciphertext from the first context, demonstrating the collision. Then either (a) document as accepted risk, or (b) require delimiter-escape and update spec." This is a forcing-function test that will either change the spec or accept the risk explicitly.

### 12. V2: `/health/ready` encryption block
**What's missing**: no test asserts the JSON shape of the new `encryption` block.
**Suggested test**: `tests/integration/health-ready-encryption.test.ts` — boot daemon with key set, GET `/health/ready`, assert `body.encryption = { enabled: true, key_source: 'env', key_fingerprint: <8-char hex>, decrypt_failures_5m: 0 }`.

### 13. V2: periodic reminder `setInterval`
**What's missing**: covered above in Gap #5.

### 14. V2: decrypt-failure → IdPTokenRevoked equivalence: IMPROVE
**What's missing**: the listed integration test asserts the path runs, but not the exact equivalence. Spec promises "same audit, same response, same `token_epoch` bump".
**Suggested test**: in `refresh-rotation-encrypted.test.ts` split into three explicit assertions: (a) audit event code matches the `IdPTokenRevoked` path's code, (b) HTTP response body matches byte-for-byte, (c) `token_epoch` value before/after differs by exactly 1.

### 15. Test infrastructure: no fixture-key factory specified
**What's missing**: every test file that needs a working `EnvelopeEncryption` will reinvent `randomBytes(32)`. The spec should mandate `tests/helpers/encryption.ts` exporting `makeTestEncryption(): { provider: EnvelopeEncryption; key: Buffer; fingerprint: string }` and `withEncryptionEnv(fn)` for tests that need the env var set.
**Suggested addition**: extend the §Testing section with a "Test helpers" subsection listing the required fixtures.

### 16. Test infrastructure: how to test fail-loud boot guards
**What's missing**: `bootPhase2` throwing `BootValidationError` is hard to test in-process if the test runner has already booted. Spec doesn't say whether boot tests run via a child-process invocation, via a refactored `bootPhase2` that takes injectable `db` + `env`, or via `vi.isolateModules`.
**Suggested addition**: spec should commit to one approach. Recommendation: refactor `bootPhase2` to accept `(deps: { db, env, logger })` so tests pass synthetic env objects and assert thrown errors — no child process, faster, deterministic.

---

## Redundancies

### 1. `envelope-bun.test.ts` vs. CI matrix run
**Why redundant**: the contrarian-cut note says "Buffer round-trip + verify CI runs full suite under Bun". If CI runs the full suite under Bun, then `envelope-encryption.test.ts` already exercises the Buffer round-trip under Bun. A dedicated `envelope-bun.test.ts` is only useful if it pins a specific Bun-vs-Node divergence (e.g. base64url alphabet). Otherwise it's a one-line check that adds maintenance cost.
**Suggested action**: keep ONE test in `envelope-bun.test.ts` — a focused `Buffer.from(x, 'base64url').toString('base64url')` round-trip on a vector that previously had Bun issues. Drop the "same encrypt→decrypt result Node↔Bun" line; that's what CI matrix does for free.

### 2. `cli-encryption-fingerprint.test.ts` "no DB access" assertion
**Why redundant**: testing that a function doesn't touch the DB by mocking the DB module is brittle and doesn't catch the real concern (would the CLI work without `coordinator.db` existing?). The "fails on missing key with clear message" assertion already covers the meaningful behaviour.
**Suggested action**: replace "no DB access" with "runs successfully when `{data_dir}/coordinator.db` does not exist" — same intent, observable behaviour.
