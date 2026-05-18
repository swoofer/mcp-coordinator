# Round 1 review — Contrarian / Cuts

**Reviewer lens**: YAGNI, anti-over-engineering, minimum viable design
**Spec under review**: docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md
**Overall verdict**: OVER-ENGINEERED
**Proposed cuts that would save effort**: 11 items

---

## Summary

The actual job is: "encrypt 2 TEXT columns with AES-256-GCM, key from env." That's ~80 lines of code and 3 tests. The spec proposes ~200 LOC, 6 tasks, 7 tests, two CLI commands, two abstraction layers (`MasterKeyProvider`, `EncryptionContext`), envelope encryption with per-row DEKs, and a versioned wire format — for **2 columns that hold at most a few hundred rows in any plausible self-hosted mcp-coordinator deployment**. Several pieces are forward-compat scaffolding for features no one has asked for ("future per-org/per-column key derivation", "future cipher upgrades", "future KMS"). The author has even pre-admitted multiple parameters are unused. That's a tell. Cut them.

The spec also leans on the v0.7-v0.10 pattern of accumulating auth/security abstractions. A small daemon does not need a `MasterKeyProvider` SPI; it needs `process.env.COORDINATOR_ENCRYPTION_KEY`.

---

## Cuts proposed

### 1. Envelope encryption (per-row DEK) — SIMPLIFY

**What's there now**: Per-row random 32-byte DEK, encrypted with master key, prepended to ciphertext. 60 bytes of wrapped-DEK overhead per row, plus more code, plus two AES ops per encrypt/decrypt.

**What's wrong**: Envelope encryption earns its keep when (a) you have many rows and want to rotate the master key without re-encrypting all data, or (b) you talk to a KMS where the master never leaves an HSM and per-DEK calls amortize. Neither applies here. Master key sits in `process.env` in the same process that does the AES. Rotation in v0.10.5 is explicitly "redeploy + invalidate all tokens" (spec §Rotation). So the DEK indirection buys literally nothing operationally in v0.10.5 — it's pure premature abstraction motivated by a v0.10.6+ rotation feature that may never ship.

A single AES-256-GCM call with `key = HKDF(masterKey, "idp-token-v1")` and a per-row 12-byte random nonce is **just as secure** (GCM is safe up to 2^32 random nonces per key, and we'll have ~thousands of writes per key lifetime, not billions). Half the code, half the ciphertext overhead, one AES op instead of two.

**Alternative**:
```ts
encrypt(pt: string): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", this.key, nonce);
  const ct = Buffer.concat([c.update(pt, "utf8"), c.final()]);
  return "enc:" + Buffer.concat([nonce, c.getAuthTag(), ct]).toString("base64url");
}
```

**Trade-off**: Lose the theoretical ability to rotate the master key without touching ciphertexts later. But the spec already says v0.10.5 rotation = nuke all tokens and force re-auth. When real online rotation lands in v0.10.6+, switch to envelope then — it's a transparent format upgrade behind the `enc:vN:` prefix that the spec already plans for. **Don't pay today for a feature that's already deferred.**

---

### 2. `MasterKeyProvider` interface — CUT

**What's there now**: An interface with one implementation (`EnvVarMasterKeyProvider`) for a v0.10.5 that the spec explicitly says is env-only ("KMS / file key sources — Not on the roadmap").

**What's wrong**: Classic SPI-for-one-impl over-engineering. The interface has zero callers outside the boot path. There is no second implementation planned for this release. The `envVarName` constructor parameter is also dead — nothing ever overrides it.

**Alternative**: Inline in boot.ts:
```ts
const raw = process.env.COORDINATOR_ENCRYPTION_KEY;
if (!raw) { ...passthrough... }
const key = decodeKey(raw);
if (key.length !== 32) throw new Error("...");
```
~6 lines. Add the interface the day a second source actually exists.

**Trade-off**: Lose the "look how testable and pluggable we are" feeling. Gain: don't ship dead abstraction. When KMS arrives (if ever), extracting an interface from one usage is a 10-minute refactor.

---

### 3. `EncryptionContext` parameter — CUT

**What's there now**: `encrypt(plaintext, context)` where context = `{ org_id, column }`. Spec explicitly says: *"v0.10.5 ignores it (single master key for all rows)"*.

**What's wrong**: The author has documented that the parameter is dead weight in this release. Every call site has to construct `{ org_id: user.primary_org_id, column: "idp_access_token" }` for a parameter that gets `_context: EncryptionContext` (prefixed underscore — even the implementation flags it as unused). This is noise in the call sites and creates a fake API contract that will be wrong when v2 actually arrives (we don't know yet what context per-org derivation will need; speculating now will likely guess wrong).

**Alternative**: `encrypt(plaintext: string): string`. Add context the day a second implementation needs it. YAGNI.

**Trade-off**: A future per-org-key migration will have to touch call sites to add the parameter. That's ~4 call sites total. Acceptable.

---

### 4. `enc:v1:` versioning — SIMPLIFY (keep prefix, drop the version)

**What's there now**: `enc:v1:<base64url>` prefix, with the v1/v2 versioning rationale being "future cipher upgrades."

**What's wrong**: We don't know what v2 looks like. AES-256-GCM is the boring industry-standard answer for at-rest symmetric encryption and isn't going anywhere this decade. When/if a v2 actually arrives, the migration story will dominate; one extra byte in the prefix won't matter. Meanwhile, `v1` is committing us to a format we may regret (e.g. if we drop envelope per cut #1, the "v1" name no longer matches whatever historical context).

**Alternative**: Use `enc:` as the marker for "this is encrypted, route through decryptor." When a second format truly arrives, switch to `enc1:` / `enc2:` then. Even simpler: a fixed magic byte at the start of the blob. The plaintext-detection job ("does this row need migration?") only needs *a* marker, not a versioned one.

**Trade-off**: If v2 ever ships, we add the version then and write a one-time migration. Same effort as today, just deferred until we have actual requirements.

---

### 5. `verify-encryption-key` CLI command — CUT

**What's there now**: A CLI that loads the master key, fetches one encrypted row, tries to decrypt, prints OK/FAIL.

**What's wrong**: This is "we built it because we could." Real verification happens automatically on the first refresh-rotation call after boot. If the key is wrong, the daemon logs ERROR with the user id (spec §D), forces re-auth, and the operator notices instantly. The CLI duplicates this behavior in a less integrated way. Operators don't run pre-flight checks for one env var; they `docker compose up` and watch logs.

Worse: the command **returns exit code 2 ("cannot verify") when no encrypted rows exist yet** — i.e., for every fresh deployment, the verification tool can't verify. Useless in the most common case.

**Alternative**: Cut entirely. If you really want a smoke test, add a one-line health check that encrypts+decrypts a known plaintext at boot — zero CLI surface, zero docs, zero tests.

**Trade-off**: One less CLI command to document, test, and maintain. Operators who really want to test can `docker exec` and run a 3-line node snippet.

---

### 6. `hmac()` method on the provider — CUT (from this PR)

**What's there now**: `hmac(value, _context)` on `EnvelopeEncryption`, with an inline comment: *"Not used for IdP tokens; required by interface contract."*

**What's wrong**: If it's not used, don't ship it. "Required by interface contract" is the wrong direction of reasoning — the interface should reflect what callers need, not what implementations preemptively offer. The non-goals section explicitly says "HMAC / searchable encryption — Not needed; we never query by token value."

**Alternative**: Remove `hmac` from `EncryptionProvider` and from this class. When a future column needs deterministic HMAC indexing, add the method and the contract together with a real caller.

**Trade-off**: None for this release.

---

### 7. Bun integration test — DEFER (or convert to a CI matrix run)

**What's there now**: `tests/integration/bun-encryption.test.ts` — *"same suite but under Bun, confirms no native deps regression."*

**What's wrong**: The whole implementation uses `node:crypto`, which is a Bun built-in. There are zero native dependencies introduced by this PR (that's literally the design rationale vs SQLCipher). A dedicated Bun integration test for "we didn't add native deps" is testing a non-claim. If CI already runs the test suite under both Node and Bun (it should, given the project supports both), this test is redundant. If CI doesn't, the fix is "run the suite under Bun in CI", not "write a Bun-specific encryption test."

**Alternative**: Skip the dedicated Bun encryption test. If CI is single-runtime today, add `bun test` to the workflow matrix in a separate 5-line PR — that catches Bun regressions everywhere, not just in encryption.

**Trade-off**: Marginal; the unit tests already exercise the only Bun-relevant code paths.

---

### 8. Fail-soft on decrypt error (return null, force re-auth) — RECONSIDER (lean fail-loud for the daemon)

**What's there now**: Decrypt failure logs ERROR, returns `null`, forces user re-auth. Daemon stays up.

**What's wrong**: This is the wrong trade-off for an operator-run daemon. Two failure modes are equally treated:
1. *One row corrupted* (disk bit flip, partial write) — fail-soft is correct.
2. *Wrong master key configured* (operator typo, rotated env, restored from backup) — fail-soft means **every single user silently gets re-auth'd**, master key never gets fixed, and the operator only notices when they look at the error log days later (or never).

Case 2 is the more likely real-world failure. A daemon that limps along forcing all users to re-login is worse than one that refuses to start until the operator notices the misconfiguration. The "coordination feature doesn't depend on auth tokens" rationale is weak — if auth is broken, the coordination is happening unauthenticated or to the wrong users, which is worse than downtime.

**Alternative**: On *boot*, do a single decrypt of one known row (or sentinel); fail loud if it doesn't work. On *runtime*, fail-soft per row is fine for genuine per-row corruption. This separates the two cases cleanly.

**Trade-off**: One extra boot check, ~10 lines. Strictly more correct behavior in the most likely failure case.

---

### 9. Boot warning when env var is unset — SIMPLIFY (make it once per N hours, or upgrade to a startup banner)

**What's there now**: `log.warn("IdP tokens stored plaintext. Set COORDINATOR_ENCRYPTION_KEY ...")` at boot.

**What's wrong**: Single boot-time `warn` lines get drowned in startup noise and filtered out by aggregation. Operators who didn't set the env var are exactly the ones who aren't reading boot logs carefully. Either commit to making this loud (banner, repeated periodically, surfaced in a `/health` endpoint) or accept that one line won't change behavior and cut it.

**Alternative (lighter)**: One-line note in README and the changelog. Operators who care will set the var.

**Alternative (louder)**: Surface "encryption: off" in `GET /health` JSON. Then dashboards and uptime probes can alert on it. That's actually useful.

**Trade-off**: One-line warnings are theater. Either remove or productize.

---

### 10. Backward compat with plaintext rows — RECONSIDER (require the env var, fail loud)

**What's there now**: When env var is unset, `PassthroughEncryption` writes plaintext, reads plaintext. Existing v0.10.4 deployments keep working unchanged.

**What's wrong**: This is a defensible choice for a v1.0 product with thousands of deployments. mcp-coordinator is a small open-source daemon at v0.10.x — semver minor bumps are *allowed* to require config changes, and the v0.10.x line has been adding new env vars every release. Shipping with `PassthroughEncryption` as a real production code path means: (a) two implementations of the provider to test, (b) the "is it on or off" state machine in boot.ts, (c) the plaintext-prefix backward-compat branch in `decrypt`, (d) the boot warning, (e) the silent-misconfiguration failure mode in cut #8. All of that exists to support deployments that didn't read the upgrade notes.

**Alternative**: Require `COORDINATOR_ENCRYPTION_KEY` at v0.10.5. Boot fails loud if missing, with a one-line "generate with `openssl rand -base64 32`" message. Plaintext code path deleted. Migration tool still handles existing plaintext rows on read (one-way, encrypt-on-next-read).

**Trade-off**: Mildly breaking change for existing operators. But the upgrade is trivial (one env var) and it permanently eliminates the misconfiguration class of bugs. Given the project's release cadence and adoption stage, this is the right time to make this call.

---

### 11. The 6-task breakdown — SIMPLIFY to 2 PRs (or one)

**What's there now**: Not visible in the spec but referenced in the prompt — 6 tasks for ~200 LOC.

**What's wrong**: With cuts #1-#3 applied, the actual implementation is:
- 1 file: `src/security/idp-encryption.ts` (~40 LOC: encrypt + decrypt + key load).
- 1 boot.ts edit (~5 LOC).
- 4 call site edits in oauth-finalize.ts + refresh-rotation.ts (~10 LOC).
- 1 migration CLI (~50 LOC).
- 3 tests (round-trip, wrong-key, plaintext passthrough on read).

That's a single afternoon's work and a single PR. Splitting into 6 tasks is process overhead that exceeds the implementation cost.

**Alternative**:
- **PR 1**: core encryption + boot wiring + call sites + unit tests. (1 day)
- **PR 2**: `migrate-idp-tokens` CLI + its tests. (half day, can ship in same release or the next)

**Trade-off**: Less ceremony, faster review cycle, less context-switching.

---

### 12. The 400-line spec — SIMPLIFY

**What's there now**: 330 lines of spec for ~200 LOC of code.

**What's wrong**: The spec is doing two jobs: (a) document what gets built, (b) justify why this scope and not whole-DB SQLCipher. Job (b) is already done in the v0.7.5 spec and the 3-bullet rationale at the top is sufficient. The rest reads like an RFC for a multi-team project, not a one-author one-week change. Sections like "Why base64url" (one sentence of defense-in-depth), "Performance impact" (microbenchmarks for a path called once per hour per user), and "Threat model coverage" (correctly belongs in `docs/security/threat-model.md`, not duplicated here) are all making the spec longer than the code.

**Alternative**: Keep §Summary, §Goals/Non-goals, §Storage format (it's load-bearing), §Components A+B (just the code blocks), §Call sites, §Migration, §Testing. Cut §Why this scope (link to other spec), §Why base64url, §Performance impact, §Threat model coverage (link out). Target: 150 lines.

**Trade-off**: Spec is faster to review, easier to keep in sync with code, fewer places where doc drifts from reality.

---

## Test cuts (bonus)

From the 7 proposed tests, here's what's actually load-bearing:

- **KEEP**: `envelope-encryption.test.ts` round-trip + wrong-key + plaintext-passthrough. This is the only test that matters.
- **KEEP**: `master-key.test.ts` length-validation + bad-encoding rejection (or merge into the encryption test).
- **KEEP**: `migrate-idp-tokens.test.ts` idempotent + mixed rows. (One test, not three.)
- **CUT**: `verify-encryption-key.test.ts` — kill alongside cut #5.
- **CUT or MERGE**: `oauth-finalize-encrypted.test.ts` + `refresh-rotation-encrypted.test.ts` — if call sites just delegate to `provider.encrypt(...)`, integration testing this is testing the test double. One end-to-end "login → row in DB starts with `enc:`" smoke test covers both.
- **CUT**: `bun-encryption.test.ts` — see cut #7.

Net: 7 tests → 3 unit + 1 integration smoke = **4 tests**.

---

## What I'd actually ship

A single PR, ~150 LOC:
1. `src/security/idp-encryption.ts` — one class, `encrypt(string): string` + `decrypt(string): string` + static `loadKey()`, no interface, no context, no HMAC, no envelope, simple `enc:` prefix, AES-256-GCM with master key directly.
2. boot.ts — require the env var, fail loud if missing.
3. oauth-finalize.ts + refresh-rotation.ts — call `encrypt` / `decrypt` at 4 sites.
4. `migrate-idp-tokens` CLI — read-and-rewrite for plaintext rows.
5. 4 tests.

Defer everything else until a real second use case shows up.
