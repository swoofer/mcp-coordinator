# Round 1 review — Codebase consistency

**Reviewer lens**: integration with existing patterns, file/line accuracy, framework conventions
**Spec under review**: docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md
**Overall verdict**: NEEDS-INTEGRATION-WORK

The cryptography, storage format, and overall enablement model are all coherent with the codebase's existing patterns (EncryptionProvider stub, PassthroughEncryption, idempotent ALTERs, EncryptionContext shape). However, the spec materially understates the integration surface in three places:

1. The boot file has no `logger` import — `logger.warn(...)` will not compile as written.
2. The boot file has no plumbing for an EncryptionProvider into `AuthHandlerContext` — the "Provider passed into authContext already built at boot" claim is false today.
3. `provisionUser` is called from THREE call sites (`oauth-callback.ts`, `oauth-token.ts`, plus its own file), not just oauth-finalize.ts. The spec's "Line 88/110 of oauth-finalize.ts" framing misses that the encryption wiring must be threaded through the `provisionUser` function signature itself.

These are fixable but the spec's "~1 week, single release" effort estimate assumes a smaller blast radius than the code actually has.

## Concerns

### 1. `logger` does not exist in `src/boot.ts` — CRITICAL
**Description**: The spec's §C "Boot wiring" snippet calls `logger.warn(...)` directly, and the architecture diagram shows `log.warn(...)`. But `src/boot.ts` (verified end-to-end) has **no logger import and no `logger` symbol in scope**. `grep -n "logger|log\.warn|log\.info" src/boot.ts` returns zero matches. The file uses `throw new BootValidationError(...)` for errors and emits structured `audit(...)` for observability — no pino logger calls at all.

`src/observability/logger.ts` exports `createLogger()` (pino-based), but the boot module currently never constructs or receives a logger instance.

**Recommendation**: Either (a) introduce a logger by adding `import { createLogger } from "./observability/logger.js"; const logger = createLogger({ level: process.env.COORDINATOR_LOG_LEVEL ?? "info" });` near the top of `bootPhase2`, OR (b) follow the established boot-warning idiom and emit an audit row instead: `audit("config.encryption_disabled", { tier: 1, metadata: { reason: "no_master_key" } })`. The audit-row approach matches existing patterns at boot.ts:251 (`audit("config.boot", ...)`) and bot.ts:263 (`audit("config.key_rotation", ...)`).

### 2. `EncryptionProvider` is not in `AuthHandlerContext` and is not threaded into `provisionUser` — CRITICAL
**Description**: The spec §C says "Provider passed into authContext already built at boot. Downstream consumers receive it via existing context object." This is false. `src/auth/context.ts` (the `AuthHandlerContext` interface) has **no `encryptionProvider` field** today (verified — fields are `db, clock, providers, rateLimiter, publicUrl, stateBindingKey, signingKeys, membershipCache`). `provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, idpRefreshToken?)` in `oauth-finalize.ts:61` takes no encryption parameter either.

**Recommendation**: Add `encryptionProvider: EncryptionProvider` to `AuthHandlerContext`, default it to `new PassthroughEncryption()` in tests, and either (a) add an 8th parameter to `provisionUser` or (b) pass the whole context. The spec should explicitly enumerate the signature changes — currently it reads as "no plumbing change," which understates the work.

### 3. Spec misses 2 of 3 `provisionUser` call sites — MAJOR
**Description**: Spec §D lists only `oauth-finalize.ts:88/110` for writes. But `provisionUser` is invoked from:
- `src/auth/oauth-callback.ts:366` (browser callback path)
- `src/auth/oauth-token.ts:229` (CLI authorization_code grant)
- the function's own definition in `oauth-finalize.ts:107` (the INSERT)

Additionally the `refresh-rotation.ts:607` UPDATE also writes both `idp_access_token` and `idp_refresh_token` after a refreshIdpToken exchange (the spec mentions this read site as 557-558 + 607 but treats it like a single combined site).

**Recommendation**: Reframe §D as "wherever `provisionUser` is called or `users.idp_*_token` is written/read" and enumerate: oauth-callback.ts:366, oauth-token.ts:229, oauth-finalize.ts:88+119 (in `provisionUser`), refresh-rotation.ts:548 (SELECT), refresh-rotation.ts:607 (UPDATE). If wiring goes through `provisionUser`'s signature (recommendation in #2), the callers don't need changes — but the spec should make that explicit.

### 4. Line numbers in spec §D are slightly off — MINOR
**Description**: Spec says "Line 88 (UPDATE): wrap both token values" and "Line 110 (INSERT): same." In `oauth-finalize.ts`:
- Line 88 is the SQL `SET idp_access_token = ?, idp_refresh_token = ?, last_login_at = ?` — the variable bind happens at line 90 `.run(accessToken, refreshTokenValue, ...)`.
- Line 110 is `idp_access_token, idp_refresh_token, role, last_login_at)` (column list) — the bind happens at line 119 `accessToken,` inside `.run()`.

For `refresh-rotation.ts`:
- Spec says "Line 557-558 (after SELECT)" — actually line 547-549 is the SELECT, the destructuring `idpAccessToken = userRow?.idp_access_token ?? null` is at line 557. Close enough.
- Spec says "Line 607 (UPDATE on refresh)" — verified, line 607 is `"UPDATE users SET idp_access_token = ?, idp_refresh_token = ? WHERE id = ?"`. Accurate.

**Recommendation**: Update spec to point at the actual `.run(...)` bind lines (90 and 119 in oauth-finalize.ts) and note that the wrap happens before the bind, not at the SQL string.

### 5. `require("node:crypto")` inside class body breaks ESM idiom — MINOR
**Description**: Spec §B's `EnvelopeEncryption.hmac()` method body uses `require("node:crypto").createHmac(...)` even though the file imports `randomBytes, createCipheriv, createDecipheriv` at the top via ESM. The codebase is fully ESM (`.js` extension on import paths in every src file). `require` inside a method is also untyped and triggers `@typescript-eslint/no-require-imports` in most configs.

**Recommendation**: Add `createHmac` to the top-level import: `import { randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto"`. Spec sample code should be ESM-clean since reviewers/implementers copy it verbatim.

### 6. CLI commands don't match existing scaffold convention — MAJOR
**Description**: Spec §E proposes top-level commands:
```
mcp-coordinator migrate-idp-tokens
mcp-coordinator verify-encryption-key
```

Existing CLI patterns (verified by reading `cli/index.ts`, `cli/server/index.ts`, `cli/server/backup.ts`, `cli/rotate-jwt-secret.ts`):
- Every command exports a `create<Name>Command(): Command` factory from its own file in `cli/`.
- Operational/destructive verbs use `commander`'s `Command` class with `.description()`, `.option()`, `.action(async (opts) => {...})`.
- Multi-step server lifecycle commands live under `cli/server/` (e.g., `cli/server/backup.ts`), single-purpose admin verbs live at top level (e.g., `cli/rotate-jwt-secret.ts`).
- Each new top-level command needs `program.addCommand(create<X>Command())` in `cli/index.ts:18-24`.

The spec doesn't mention any of this. It also doesn't say whether the migration command should refuse to run with the daemon up (the `backup` command does exactly that via `getRunningCoordinatorPid` — and a migration that writes `users` rows is even more dangerous to run live than a read-only backup, because it can race writes from the live oauth/refresh handlers).

**Recommendation**: Add to spec:
- File paths: `cli/migrate-idp-tokens.ts` + `cli/verify-encryption-key.ts` (top level, since they're operator one-shots like `rotate-jwt-secret`).
- Export factories `createMigrateIdpTokensCommand()` + `createVerifyEncryptionKeyCommand()` registered in `cli/index.ts`.
- Use `commander` `.option("--force", ...)` to skip the running-daemon check; default refuse if PID file present, mirroring `cli/server/backup.ts:115-121`.
- Reuse `getConfigDir() + loadConfig() + initDatabase()` from `cli/config.ts` and `src/database.ts` to open the DB.

### 7. Spec's CLI uses `migrate-idp-tokens` SQL, but lock semantics aren't addressed — MAJOR
**Description**: Spec §E says `migrate-idp-tokens` "Wrapped in a single transaction per batch. Resumable (idempotent)." But if the daemon is running, both the CLI process AND the daemon are opening the same `coordinator.db` with `journal_mode = WAL` (verified at `src/database.ts:323`). The CLI batched UPDATEs will succeed under WAL, but during the same window the daemon's oauth-finalize/refresh-rotation handlers might write plaintext to a row the CLI just encrypted (overwriting the ciphertext with plaintext). Since on read the prefix check (`startsWith("enc:v1:")`) correctly handles the mixed state, this isn't a correctness bug — but if the operator runs migrate then expects all rows to be encrypted, races against the live daemon will leave some plaintext behind.

**Recommendation**: Either (a) follow `cli/server/backup.ts`'s pattern: refuse with daemon up unless `--force`, OR (b) document explicitly in the spec that the CLI is safe to run live but isn't fully exhaustive — operators wanting a guaranteed-clean state must stop the daemon first.

### 8. Migration approach matches existing idempotent ALTER pattern — NIT (positive)
**Description**: Spec §Schema correctly says "No new tables, no ALTER. `idp_access_token` and `idp_refresh_token` are already `TEXT`." Verified at `src/database.ts:655` and `:660`. This is correct and matches the codebase's existing idempotent `try { db.exec("ALTER TABLE users ADD COLUMN ..."); } catch { /* already exists */ }` pattern. No new migration required.

**Recommendation**: None — this part of the spec is consistent.

### 9. `EncryptionContext` shape matches existing convention — NIT (positive)
**Description**: Verified — the existing `src/security/encryption.ts:1-4` interface is `{ org_id: string; column: string }`, exactly what the spec proposes to pass. The existing test `tests/unit/encryption-passthrough.test.ts:6` uses `{ org_id: "o1", column: "users.email" }`. Spec proposes `{ org_id: user.primary_org_id, column: "idp_access_token" | "idp_refresh_token" }`.

**Recommendation**: For consistency with the existing test fixture, prefer the dotted `"users.idp_access_token"` form over the unqualified column name. Cheap to do at the call site and future-proofs for the multi-table encryption story.

### 10. Test framework + path convention matches, but file naming is off — MINOR
**Description**: vitest is correct (verified at `vitest.config.ts`, includes `tests/**/*.test.ts`). The unit test directory uses `tests/unit/<feature>.test.ts`. Existing `tests/unit/encryption-passthrough.test.ts` is the right neighbor for the proposed `tests/unit/envelope-encryption.test.ts`.

Two issues with the spec's test list:
- `tests/integration/` only has 2 files today (`cross-tenant-isolation.test.ts`, `d1-d10-matrix.test.ts`). Spec proposes 3 new integration tests (`oauth-finalize-encrypted.test.ts`, `refresh-rotation-encrypted.test.ts`, `bun-encryption.test.ts`) — that's a 2.5x growth in a sparse directory. Fine, just worth flagging the convention is light.
- The proposed `tests/unit/migrate-idp-tokens.test.ts` and `tests/unit/verify-encryption-key.test.ts` should probably live under `tests/unit/cli-<...>.test.ts` to match `tests/unit/cli-config.test.ts` — the only existing CLI unit test.

**Recommendation**: Rename to `tests/unit/cli-migrate-idp-tokens.test.ts` and `tests/unit/cli-verify-encryption-key.test.ts` to match the established `cli-*` prefix.

### 11. Coverage threshold for security-critical files is 100% — spec doesn't mention — MINOR
**Description**: `vitest.config.ts:15-56` enforces 100% branch/line/statement/function coverage on every file under `src/auth/`, `src/security/`, `src/observability/logger.ts`, etc. The proposed `src/security/envelope-encryption.ts` and `src/security/master-key.ts` will fall under that threshold automatically (config uses path-prefix). The CI will hard-fail if any branch is uncovered, including the `decrypt` plaintext-passthrough branch and the error branches.

**Recommendation**: Add to spec §Testing a line: "All new files under `src/security/` are subject to the 100% coverage thresholds enforced in `vitest.config.ts`. Add per-file threshold entries for `src/security/envelope-encryption.ts` and `src/security/master-key.ts` to match the existing pattern." Otherwise PR will fail CI on first run.

### 12. Bun compat — `node:crypto` works but spec's `require()` doesn't — MINOR
**Description**: `src/db-adapter.ts` and `src/database.ts:329` confirm Bun is a supported runtime path. `node:crypto` APIs used in the spec (`randomBytes`, `createCipheriv`, `createDecipheriv`) are all supported in Bun's node-compat layer. `Buffer.from(...).toString("base64url")` is also Bun-supported (Node 16+ and current Bun both have it). **However**, the `require("node:crypto")` inside the `hmac` method (see Concern #5) will fail in Bun's ESM mode without an explicit `createRequire` shim — Bun doesn't auto-inject `require` into ESM modules.

**Recommendation**: Top-level ESM import (already in Concern #5) fixes this for Bun simultaneously.

### 13. Spec misses `tests/perf/bench-refresh-rotation.ts` seed paths — MINOR
**Description**: Performance benchmark `tests/perf/bench-refresh-rotation.ts:89` directly INSERTs into `users` with `idp_access_token=NULL`. Not a write of a real token (intentionally NULL to skip the IdP recheck branch), so encryption doesn't affect it — but spec should acknowledge: "Test fixtures and benchmarks that write `users.idp_access_token` directly (e.g., `tests/perf/bench-refresh-rotation.ts`, `tests/unit/device-approve.test.ts:166`, `tests/unit/logout.test.ts:173`, `tests/integration/d1-d10-matrix.test.ts:325`, `tests/unit/oauth-callback-provisioning.test.ts:487+558`) write plaintext directly and bypass `provisionUser`. They will continue to work because the read path's prefix check tolerates plaintext, but they should not be 'corrected' to write ciphertext — keeping them as plaintext exercises the lazy-migration backward-compat path."

**Recommendation**: Add a note to spec §Testing covering this.

### 14. Plaintext warning would benefit from existing redaction allowlist — NIT
**Description**: `src/observability/logger.ts:11-31` already redacts `*.idp_access_token`, `*.access_token`, `*.refresh_token`, `*.idp_refresh_token` (not currently in the list — but `*.idp_access_token` is at line 22). The redaction is structural — if encrypted-on-the-wire happens, the redaction is moot, but a defense-in-depth check is to add `*.idp_refresh_token` to the REDACT_PATHS list while we're touching this code.

**Recommendation**: As part of this spec, append `"*.idp_refresh_token"` to `REDACT_PATHS` in `src/observability/logger.ts`. One-line change, defense-in-depth, no scope creep.

### 15. db-adapter `Statement.get()` returns `unknown` — type-cast pattern needed for migration CLI — NIT
**Description**: `src/db-adapter.ts:19-23` types `get()` and `all()` as returning `unknown`/`unknown[]`. The spec's migration code reading rows in batches will need explicit casts (e.g., `as { id: string; idp_access_token: string | null; idp_refresh_token: string | null }[]`). Existing code does this consistently (e.g., `refresh-rotation.ts:469` casts as `RefreshRow | undefined`).

**Recommendation**: When fleshing out the migration code in implementation, define a local `interface UserTokenRow { id: string; idp_access_token: string | null; idp_refresh_token: string | null; }` and cast at the `.all()` boundary. Match the file-local-interface pattern used throughout `src/auth/`.
