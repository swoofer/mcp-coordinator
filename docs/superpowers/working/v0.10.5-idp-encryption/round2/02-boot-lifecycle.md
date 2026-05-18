# Round 2 review — Boot / Lifecycle / Integration (V2 spec)

**Reviewer scope**: boot ordering, DI threading, daemon-spawn forwarding, lifecycle hooks, schema dependencies, CLI helpers, error-mapping integration. Crypto correctness reviewed elsewhere.

**Overall verdict**: NEEDS-WORK

V2 closes most of the architectural gaps Round 1 found, but several integration mechanics are under-specified or inconsistent with what the actual files do. Two are CRITICAL (signature collision in `provisionUser`; `system_config` doesn't exist and spec only hand-waves "add via idempotent ALTER" — but it would need CREATE TABLE, not ALTER). The rest are MAJOR/MINOR placement, ordering, and lifecycle nits. No new attack surface introduced.

## Findings

### 1. `system_config` table does not exist — spec needs CREATE, not ALTER — MAJOR
**Where**: V2 spec §D ("If it doesn't exist (verify against `src/database.ts` schema), add it via the existing idempotent `try { ALTER... } catch { /* already exists */ }` pattern.")
Actual code: `src/database.ts` — `system_config` is absent from the inline SCHEMA string (`src/database.ts:280-316`) and from the entire migration block I scanned. `grep system_config` returns zero matches in `src/`.

**Issue**: The spec calls `SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'` at boot before any DDL. With no table, the SELECT throws `SqliteError: no such table: system_config`, which means **every fresh-DB boot of v0.10.5 crashes** unless this is set up first. Also, "idempotent ALTER" is the wrong pattern — you cannot `ALTER TABLE x ADD COLUMN ...` on a non-existent table. You need `CREATE TABLE IF NOT EXISTS system_config (...)`.

**Recommendation**: V2 §D must specify exactly:
```sql
CREATE TABLE IF NOT EXISTS system_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```
…and place it in `src/database.ts`'s migration block (after the v0.10.x ALTERs, before `system_config` is read). The boot guard SELECTs run AFTER `initDatabase()` which means the table will be present. Spec must also call this DDL placement out explicitly — say "extend `src/database.ts` SCHEMA + migrations" — because spec §D currently lives only inside the bootPhase2 change description.

---

### 2. `provisionUser` signature change collides with existing optional 7th param — CRITICAL
**Where**: V2 §"DI wiring → `src/auth/oauth-finalize.ts` — `provisionUser` signature change".
Current signature (`src/auth/oauth-finalize.ts:61-72`):
```typescript
provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, idpRefreshToken?: string | null)
```
Spec proposes:
```typescript
provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, encryption, idpRefreshToken?)
```
Existing call sites (`oauth-callback.ts:366-377` and `oauth-token.ts:229-240`) **already pass `exchange.refreshToken` positionally as the 7th argument**.

**Issue**: If the spec is implemented as written, both existing call sites will silently pass an `EncryptionProvider` where `idpRefreshToken: string | null` is expected. TypeScript will flag this (different types) — so it will at least fail compile, not silently corrupt — but the spec is wrong about what "the proposed signature works" means: every call site MUST be updated in the same commit, and the spec must state this as load-bearing.

**Recommendation**: Pick ONE of:
- (a) Append `encryption` as the 8th parameter (after `idpRefreshToken`), making the signature `(...providerName, idpRefreshToken?, encryption)` — but `encryption` being non-optional after an optional parameter is a TS error. So this requires making `idpRefreshToken` non-optional (with explicit `null` at every call site).
- (b) **Recommended**: Bundle args into an options object — `provisionUser(db, clock, { idpUser, accessToken, allowlistOrg, providerName, encryption, idpRefreshToken })`. Self-documenting, future-proof, fixes the positional fragility V1 already had with `idpRefreshToken`.
- (c) Spec's current ordering (`encryption` as 7th, refresh as 8th) — acceptable if and only if the spec explicitly enumerates "update all 3 call sites in the SAME commit" and notes the TS compile error as the safety net. Currently it says "all three must be updated to pass `ctx.encryptionProvider`" but does NOT say "and reorder the refresh-token argument." That ambiguity will bite a Claude doing the implementation.

---

### 3. Boot guard placement vs. `initAuditQueue()` ordering — MAJOR
**Where**: V2 §"Architecture" diagram shows "step 2: strict-mode guards" calling `audit(...)`. `bootPhase2` (`src/boot.ts:54-285`) currently calls `initAuditQueue(db)` at line 229 — **step 7 of 11**. The encryption load + guards are spec'd as steps 1-3, which are BEFORE `initAuditQueue`.

**Issue**: Spec §D guard 1 (the override path) emits `audit("encryption.token.invalidated", ...)`. `audit()` (`src/security/audit.ts:91`) defaults to tier 2, which writes via `_auditQueue`. If the queue is null at that point, the call falls through to whatever the audit module does without a queue (per spec comment line 84-85: "until then, callers writing Tier 2 events get correctness (no drops) at the cost of latency on hot paths" — but the queue must exist). Looking at `audit.ts`, the path with `_auditQueue` null is the queue-less Tier 1 fallback to direct INSERT in audit-queue.ts; for Tier 2 with no queue, behavior is currently untested at boot time.

Also: the boot guard's UPDATE on `users` for the `ALLOW_TOKEN_LOSS=1` path runs BEFORE `performRestoreCheck` (current step 5), which means a restored DB with `ALLOW_TOKEN_LOSS=1` would NULL encrypted rows BEFORE the restore detection runs — confusing audit ordering, and the NULL'd rows are then in a DB that's about to throw a restore-detection error.

**Recommendation**: Spec must specify exact placement:
- Encryption KEY LOAD (no DB I/O): place at step 1 (top of `bootPhase2`, after `opts.enabled` check).
- Encryption BOOT GUARDS (DB SELECT + UPDATE + audit): place AFTER `initAuditQueue(db)` (current step 7) and AFTER `performRestoreCheck` (step 5). Suggested new placement: between step 8 (`initPhase2Auth`) and step 9 (compose `context`).
- Wire into `AuthHandlerContext`: at step 9 (line 235), as spec already says.

Document the ordering constraint explicitly in the spec's Architecture diagram.

---

### 4. Strict-mode guard SELECT runs on every boot, no index — MINOR
**Where**: V2 §D SELECT `SELECT 1 FROM users WHERE idp_access_token LIKE 'enc:v_:%' OR idp_refresh_token LIKE 'enc:v_:%' LIMIT 1`.
`src/database.ts:651-660` defines `users.idp_access_token` and `idp_refresh_token` as plain TEXT columns; **no index on either**. Existing indexes on users are `idx_users_org` (on primary_org_id) only.

**Issue**: With `LIMIT 1`, the query is fine on small DBs (full scan, stops at first match). On a deployment with 100k+ users, this is a one-time full-table scan per boot — measurable but not catastrophic (~tens of ms on SQLite WAL). Not worth indexing (`LIKE 'enc:v_:%'` would need an expression index, and `users` writes are not hot enough to justify maintenance).

**Recommendation**: Spec should add one sentence: "Full-table scan acceptable; `LIMIT 1` short-circuits. No index added — IdP token columns are not hot read paths, and the boot scan happens once per process start." Also: combine into a single SELECT (spec already does — good) rather than two.

---

### 5. `cli/server/start.ts` `fwd()` lines syntactically correct — but missing `COORDINATOR_NODE_ENV` propagation insight — NIT
**Where**: V2 §"Daemon-spawn forwarding". Proposed:
```typescript
fwd("COORDINATOR_ENCRYPTION_KEY", process.env.COORDINATOR_ENCRYPTION_KEY);
fwd("COORDINATOR_ALLOW_TOKEN_LOSS", process.env.COORDINATOR_ALLOW_TOKEN_LOSS);
fwd("COORDINATOR_ALLOW_KEY_ROTATION", process.env.COORDINATOR_ALLOW_KEY_ROTATION);
```
Confirmed: `fwd()` defined at `cli/server/start.ts:72-74` matches exactly: `(key: string, value: string | undefined) => void` skipping `undefined`. Syntax is correct.

**Issue**: None for syntax. Minor: spec says "without this, `--daemon` silently runs plaintext" — partly true. With the V2 boot guards (§D), if the DB already has `enc:v1:` rows, the daemonized child will REFUSE boot (good), so the failure is loud, not silent. The "silent plaintext" only happens on a fresh DB whose first daemonized run has no key forwarded. Update the spec language to acknowledge the guard mitigates this on existing-encrypted deployments.

**Recommendation**: Accept the proposed lines verbatim. Tweak spec phrasing: "without this, `--daemon` runs plaintext until the first encrypted-row guard triggers on subsequent boots."

---

### 6. `setInterval(...).unref()` for plaintext reminder — lifecycle teardown missing — MAJOR
**Where**: V2 §E: `setInterval(() => { audit.log(...) }, 86_400_000).unref();`.
Lifecycle: `cli/server/start.ts:117-118` SIGINT/SIGTERM handlers do `cleanup(); process.exit(0)` — no graceful drain. `bootPhase2` returns a `shutdown` function (`src/boot.ts:276-284`) that drains the sweeper + audit queue, but `start.ts` doesn't call it. The spec's `setInterval` has no teardown.

**Issue**:
(a) `.unref()` is correct for not blocking shutdown — fine.
(b) BUT in long-lived tests (vitest with `fileParallelism: false`), if a test boots Phase 2 and the daemon never exits, the interval handle leaks. Tests that boot+shutdown repeatedly will accumulate intervals. The spec needs to attach the interval handle to the `Phase2Bootstrap.shutdown` function and `clearInterval()` it there.
(c) `audit.log(level, msg)` is NOT a method on the current audit module. `src/security/audit.ts` exports `audit(action, options)` and `auditLog(ev)`. There is no `audit.log("warn", "string")` API. The spec is invoking a Pino-style logger API on the audit emitter — wrong module.

**Recommendation**:
- Use the structured logger (`src/observability/logger.ts:createLogger`) for the periodic reminder, NOT `audit()` (which is event-stream, not message-stream).
- Store the interval handle: `const reminderInterval = setInterval(...).unref();` and add `clearInterval(reminderInterval)` to the returned `shutdown` function.
- Separately, audit ONCE at boot via `audit("encryption.config.loaded", { tier: 1, metadata: { key_source: "absent", ... } })` so operators get a durable record.

---

### 7. `/health/ready` payload extension — JSON shape doesn't match current — MINOR
**Where**: V2 §E shows:
```json
{ "ready": true, "checks": {...}, "encryption": {...} }
```
Actual (`src/http/health.ts:85-90`): `{ "status": "ready"|"not_ready", "checks": {...} }` — uses `status`, NOT `ready`.

**Issue**: Spec's JSON example uses `"ready": true`. Existing payload uses `"status": "ready"`. Operators with monitoring scripts parse the current key.

**Recommendation**: Spec should show:
```json
{
  "status": "ready",
  "checks": { ... },
  "encryption": {
    "enabled": true,
    "key_source": "env",
    "key_fingerprint": "abc12345",
    "decrypt_failures_5m": 0
  }
}
```
Implementation note: `handleHealthReady` takes `ReadinessOptions` — extend it to accept the encryption status (or read it from a singleton built at boot). The function currently does NOT have access to the encryption provider; needs threading or a module-level getter. Spec doesn't address how this flows. Add a `getEncryptionStatus()` accessor next to `getAuditQueue()`.

---

### 8. Fingerprint persistence on first encrypt — placement ambiguous — MAJOR
**Where**: V2 §D end: "Fresh key, no prior fingerprint: store on first encrypt (handled in EnvelopeEncryption call site)." V2 §"Architecture" diagram says: "OK — daemon will write fingerprint on first encrypted row."

**Issue**: Spec is genuinely ambiguous. Three possible places:
- (A) Inside `EnvelopeEncryption.encrypt()` — but the provider has no DB handle and shouldn't (separation of concerns; provider is pure crypto).
- (B) Inside `encryptNullable()` helper — same problem.
- (C) At each write call site (`provisionUser`, `refresh-rotation.ts` line 606) — requires every caller to know the rule, easy to miss.
- (D) At the read side of `encryptNullable` results in `provisionUser` — wrong layer.

The cleanest fit is a small "persist fingerprint" helper called once per process from the FIRST successful encrypt. That requires a process-singleton flag (`fingerprintWritten = false`) checked + set inside `encryptNullable` (or a wrapper around the provider in boot.ts). Either way, the spec must define this — leaving it to implementation will produce 3 different attempts.

**Recommendation**: Spec must add a §F "Fingerprint persistence":
```typescript
// in boot.ts, build a wrapped provider:
let fingerprintPersisted = !!storedFingerprint; // already there
const wrappedProvider: EncryptionProvider = {
  encrypt(pt, ctx) {
    const ct = encryptionProvider.encrypt(pt, ctx);
    if (!fingerprintPersisted) {
      db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)")
        .run("encryption.key_fingerprint", keyFingerprint);
      fingerprintPersisted = true;
      audit("encryption.config.loaded", { tier: 1, metadata: { key_fingerprint: keyFingerprint, key_source: "env" } });
    }
    return ct;
  },
  decrypt: encryptionProvider.decrypt.bind(encryptionProvider),
};
ctx.encryptionProvider = wrappedProvider;
```
This keeps `EnvelopeEncryption` pure and centralizes the side-effect.

---

### 9. `getRunningCoordinatorPid` accessibility from `cli/encryption/migrate.ts` — MINOR
**Where**: V2 §"CLI" says "Refuses to start if `getRunningCoordinatorPid()` (see `cli/server/backup.ts`) returns a PID and `--force` not passed."
Confirmed: `cli/server/backup.ts:44` exports `getRunningCoordinatorPid`. `cli/server/restore.ts:6` already imports it as `import { getRunningCoordinatorPid } from "./backup.js";`. From `cli/encryption/migrate.ts`, the import would be `import { getRunningCoordinatorPid } from "../server/backup.js";` — works.

**Issue**: Helper is accessible. However: the helper requires `configDir`, not data_dir. Spec doesn't specify which dir the encryption CLI uses. Existing CLIs use `ensureConfigDir()` (from `cli/config.ts`). Spec should reference this.

**Recommendation**: One-line addition: "encryption CLI uses `ensureConfigDir()` to locate `server.pid` (same as `backup`/`restore`)."

---

### 10. `encryption fingerprint` CLI — add `--compare` option — NIT
**Where**: V2 §"fingerprint semantics": "Reads `COORDINATOR_ENCRYPTION_KEY` from env (does NOT need DB). Prints `sha256(key).slice(0,16).toString('hex')` to stdout."

**Issue**: Operator workflow is "did I set the right key?" The only way to answer is run `encryption fingerprint`, then separately read `system_config.encryption.key_fingerprint` from the DB. Two steps, error-prone. `encryption verify` already does the comparison (per spec verify semantics) — so this overlap is acceptable as-is. But a simple `--compare` flag that opens the DB and reports MATCH/MISMATCH is a 5-line addition with high operator value.

**Recommendation**: Add to spec: "`encryption fingerprint [--compare]` — when `--compare` is set, also reads `system_config.encryption.key_fingerprint` and reports `MATCH` or `MISMATCH` (exit 0 / 2)." Defer if scope is tight — `encryption verify` covers it.

---

### 11. Decrypt failure → `IdPTokenRevoked` mapping — placement clarification needed — MAJOR
**Where**: V2 §"DI wiring → `src/auth/refresh-rotation.ts`": "Decrypt errors: catch `DecryptionError` (any subclass), audit `encryption.decrypt.failed`, treat the user as if `IdPTokenRevoked` was thrown."
Actual handling (`src/auth/refresh-rotation.ts:639-660`): there is a single `if (firstErr instanceof IdPTokenRevoked)` branch in the `memberships === null` path. The token is fetched via `decryptNullable(...)` at line ~557 — BEFORE this branch.

**Issue**: A decrypt failure at line 557 throws SYNC in the destructuring path, not as `firstErr` from an async listMemberships call. The current `try/catch` structure (lines 582-590, 603-635) wraps only the async IdP calls. A sync throw from `decryptNullable` bypasses the entire mapping path — and propagates as an unhandled exception, crashing the request.

The spec needs to be explicit about wrapping: either wrap the decrypt itself in try/catch and map to `IdPTokenRevoked`, OR (cleaner) extend the existing destructuring to be a function that returns `{ token, error }` and feed the error into the existing flow.

**Recommendation**: Spec should add:
```typescript
// in refresh-rotation.ts, replace the SELECT + destructure with:
let idpAccessToken: string | null = null;
let idpRefreshToken: string | null = null;
const idpProviderName: string | null = userRow?.idp_provider ?? null;
try {
  idpAccessToken = decryptNullable(ctx.encryptionProvider, userRow?.idp_access_token ?? null, { org_id: ..., column: "idp_access_token", user_id: row.user_id });
  idpRefreshToken = decryptNullable(ctx.encryptionProvider, userRow?.idp_refresh_token ?? null, { org_id: ..., column: "idp_refresh_token", user_id: row.user_id });
} catch (err) {
  if (err instanceof DecryptionError) {
    audit("encryption.decrypt.failed", { tier: 1, metadata: { user_id_hash: hashPrefix(row.user_id), error_class: err.name } });
    // Same as IdPTokenRevoked path:
    audit("auth.idp.token_revoked", { tier: 1, metadata: { user_id: row.user_id, phase: "refresh_decrypt_failed" } });
    res.writeHead(401, { ... }); res.end(...); return;
  }
  throw err;
}
```
Also: the spec needs to mention that the `org_id` for context is `row.user_id`'s primary_org_id — which requires SELECTing that column too (currently the SELECT at line 547 only fetches token columns + provider).

---

### 12. Logger redact addition — pattern syntax confirmed — NIT
**Where**: V2 §"Logger redaction" adds `*.idp_refresh_token` to `REDACT_PATHS`.
Confirmed: `src/observability/logger.ts:22` has `"*.idp_access_token"`; the proposed line follows the exact same wildcard pattern.

**Issue**: None. Drop in next to line 22.

**Recommendation**: Accept as-is.

---

### 13. Coverage threshold update — syntax confirmed, but `boot.ts` already at 100% — MINOR
**Where**: `vitest.config.ts:55` already has `"src/boot.ts": { branches: 100, ... }`. Spec proposes adding entries for `src/security/envelope-encryption.ts`, `src/security/encrypt-nullable.ts`, error classes.

**Issue**: Adding new entries: trivial, same nested object syntax (lines 16-55). No issue.

But: `src/boot.ts` is at 100% TODAY. The V2 spec adds ~80 LOC to it (key load, decode helper, 4 guard branches, fingerprint persistence wrapper). Hitting 100% branch coverage on guard combinations (4 cases × override flag × env flag) requires ~12 new tests in `boot-encryption-guards.test.ts`. Spec lists this file but doesn't enumerate the case matrix. Without it, CI will fail.

**Recommendation**: Spec's test plan §`boot-encryption-guards.test.ts` should enumerate the 12+ branch cases (each combination of `{hasEncryptedRows, key present, fingerprint match/mismatch, override flag set/unset}`). Otherwise the implementer will iterate against CI for hours.

---

### 14. Audit event signatures align with `audit()` API — but spec uses ad-hoc shapes — NIT
**Where**: V2 §"Audit events" lists:
```
encryption.config.loaded         (boot, metadata: key_fingerprint, key_source: "env")
encryption.decrypt.failed        (user_id, column, error_class)
encryption.migration.completed   (direction, rows_changed, ...)
encryption.key.rotation_begin    (old_fingerprint, new_fingerprint)
encryption.token.invalidated     (reason)
```
Confirmed: `audit(action, { tier, metadata, target, outcome })` in `src/security/audit.ts:91`. The proposed metadata shapes fit `Record<string, unknown>` — fine.

**Issue**: Two of the proposed events emit `user_id` as a metadata field, but `audit()` automatically captures `actor_user_id` from `getCurrentActor()`. The spec should clarify: `encryption.decrypt.failed` happens INSIDE a request, so `getCurrentActor()` will return the requesting user — but the "user whose token failed to decrypt" may not be the same as the requesting actor (e.g., admin endpoints). Per spec §S6, hash-prefix the user id, not raw.

Also: spec doesn't say which tier each event is. `tier: 1` for boot config + key rotation begin + token invalidated; `tier: 2` for decrypt failures + migration completed seems right. Spec should pin these.

**Recommendation**: Add `tier:` to each event in the spec's audit table. Use `user_id_hash` (sha256 prefix) in metadata per S6, distinct from `actor_user_id` (which audit captures automatically).

---

### 15. `decryptNullable` requires `EncryptionContext` — but read path lacks `org_id` in SELECT — MAJOR
**Where**: V2 §C `decryptNullable(provider, value, context)` where `context.org_id` is required (AAD binding from §B).
`refresh-rotation.ts:547-549`:
```sql
SELECT idp_access_token, idp_refresh_token, idp_provider FROM users WHERE id = ?
```
Does NOT select `primary_org_id`. The decrypt context needs `org_id` — without it, the AAD won't match what was bound at encrypt time, and decryption will always throw `DataDecryptFailed`.

**Issue**: Spec doesn't enumerate the SELECT change. Implementer will copy the existing SELECT and silently decrypt with `org_id: undefined` (or fall back to some sentinel), causing universal decrypt failures the moment AAD-bound encryption is enabled.

**Recommendation**: Spec must explicitly extend the SELECT in refresh-rotation.ts:547 to include `primary_org_id`. Same audit at the other read site (if any). Add to spec: "SELECT statements at read sites MUST include `primary_org_id` for AAD reconstruction."

---

## Summary by severity

- CRITICAL (1): #2 `provisionUser` signature collision.
- MAJOR (6): #1 missing `system_config` DDL; #3 boot guard ordering; #6 setInterval teardown + wrong audit API; #8 fingerprint persistence ambiguity; #11 decrypt-failure mapping placement; #15 SELECT missing primary_org_id.
- MINOR (4): #4 boot scan perf note; #7 `/health/ready` JSON shape; #9 `getRunningCoordinatorPid` accessibility; #13 boot.ts coverage cases.
- NIT (4): #5 fwd lines OK; #10 `--compare` flag; #12 logger redact; #14 audit tiers.

The V2 spec's high-level integration story is sound and Round 1's convergent issues are addressed. The remaining gaps are mechanical specificity — the implementer needs the spec to be wrong-proof, and V2 leaves enough wiggle room in §D/§F/§refresh-rotation wiring that a wrong-but-plausible implementation will ship. Recommend a V3 pass focused on §D (boot ordering + DDL), §F (new section: fingerprint persistence wrapper), and §refresh-rotation (SELECT + try/catch shape).
