# IdP token encryption — V3 patches

**Date**: 2026-05-17
**Status**: V3 patches — supersedes specific sections of V2
**Supersedes**: `2026-05-17-idp-token-encryption-design.md` V2, specific sections enumerated below
**Round 2 reviews**: `docs/superpowers/working/v0.10.5-idp-encryption/round2/`
**Synthesis**: `docs/superpowers/working/v0.10.5-idp-encryption/round2/00-SYNTHESIS-R2.md`
**Read order**: V2 spec first (architecture + rationale), then this patches doc (mechanical fixes).

## Purpose

Round 2 (3 reviewers) found 36 issues against V2. The architecture is sound; V3 closes mechanical bugs and signature traps that would produce wrong-but-plausible implementations. No new architectural decisions — just precision on what V2 left ambiguous.

V3 is patches-doc style (not full rewrite) because:
- V2's architecture survives unchanged.
- Patches are localized — easier to audit.
- Matches `2026-05-13-auth-phase2-oauth-device-design-V4-patches.md` convention.

---

## PATCH 1 — Storage format: length-prefixed binary AAD

**Supersedes**: V2 §Storage format (the AAD subsection) and §B `EnvelopeEncryption.aad()` method.

**Reason**: V2's `aad = utf8("v1|${org_id}|${column}|${user_id}")` uses `|` as delimiter with no escape. `org_id`/`column`/`user_id` are server-controlled today (UUIDs and a literal-union string), but the spec does not enforce a no-`|` invariant. A future column-encryption family that introduces a user-controlled context field (slug, tenant, team-name) would create a parser ambiguity that allows cross-row attacks under controllable conditions. Fix it now.

**New AAD encoding**:

```
aad = u8(version) || u16be(len_org) || org_id_utf8
            || u16be(len_col) || column_utf8
            || u16be(len_user) || user_id_utf8

where:
  version    = 0x01 (single byte)
  u16be(len) = big-endian unsigned 16-bit length (max 65535 bytes per field)
  *_utf8     = UTF-8 bytes of the string
```

Parser-proof: length-prefixed framing cannot be confused regardless of field content. Compact (4-byte overhead per field + 1 version byte = max ~13 bytes total for our triple).

**New `aad()` implementation**:

```typescript
private aad(context: EncryptionContext): Buffer {
  const org = Buffer.from(context.org_id, "utf8");
  const col = Buffer.from(context.column, "utf8");
  const usr = Buffer.from(context.user_id, "utf8");
  if (org.length > 65535 || col.length > 65535 || usr.length > 65535) {
    throw new Error("EncryptionContext field too long for AAD (>65535 bytes)");
  }
  const buf = Buffer.alloc(1 + 2 + org.length + 2 + col.length + 2 + usr.length);
  let o = 0;
  buf.writeUInt8(0x01, o); o += 1;
  buf.writeUInt16BE(org.length, o); o += 2; org.copy(buf, o); o += org.length;
  buf.writeUInt16BE(col.length, o); o += 2; col.copy(buf, o); o += col.length;
  buf.writeUInt16BE(usr.length, o); o += 2; usr.copy(buf, o); o += usr.length;
  return buf;
}
```

**Test addition** (replaces V2 "wrong-AAD throws DataDecryptFailed" with a more explicit matrix):

In `tests/unit/envelope-encryption.test.ts`:
- Encrypt with `{org: "a", col: "idp_access_token", user: "u1"}`.
- Decrypt with three swapped contexts: `{org: "b", ...}`, `{org: "a", col: "idp_refresh_token", ...}`, `{org: "a", col: "idp_access_token", user: "u2"}`. All three MUST throw `DataDecryptFailed`.
- **Format-injection test** (forcing function): encrypt with `{org: "evil_org", col: "idp_access_token", user: "u1"}` and verify decryption FAILS when context is `{org: "evil", col: "_org_idp_access_token_u1", user: ""}` — proves length-prefixed encoding does not collide.

---

## PATCH 2 — `decodeMasterKey`: refuse low-entropy keys

**Supersedes**: V2 §A `decodeMasterKey` function body + entropy comment.

**Reason**: V2 says "soft entropy check: warn if < 4.5 bits/byte" but accepts. A 32-byte key of `0xaa…aa` (Shannon entropy = 0) currently boots successfully. That is a known-plaintext catastrophe against AES — the key is trivially guessable.

**New behavior**:
- Refuse with throw if entropy `< 3.0` bits/byte (catastrophic).
- Warn but accept if entropy `3.0 – 4.5` bits/byte (suspicious — possibly a passphrase).
- Silent if `≥ 4.5` bits/byte.

**New code** (replaces the entropy section of V2's `decodeMasterKey`):

```typescript
const entropy = shannonEntropyBitsPerByte(key);
if (entropy < 3.0) {
  throw new Error(
    `COORDINATOR_ENCRYPTION_KEY has catastrophically low entropy (${entropy.toFixed(2)} bits/byte). ` +
    `This is not a random key — looks like a constant, passphrase, or test fixture. ` +
    `AES-256 requires a uniformly-random 32-byte key. Generate with: openssl rand -base64 32`
  );
}
if (entropy < 4.5) {
  // soft warning at boot
  bootLogger.warn(
    { entropy_bits_per_byte: entropy.toFixed(2) },
    "COORDINATOR_ENCRYPTION_KEY has low entropy — looks like a passphrase. " +
    "AES-256 requires a uniformly-random 32-byte key. Generate with: openssl rand -base64 32"
  );
}
```

Also: V2 said "auto-detect alphabet; refuse if ambiguous" — that claim was dead code (length disambiguates, not alphabet, by construction). Drop the claim from comments. Replacement comment:

```typescript
// Disambiguation by length + alphabet:
//   hex      = 64 chars [0-9a-fA-F]
//   base64   = 42-44 chars [A-Za-z0-9+/=]
//   base64url= 43 chars   [A-Za-z0-9_-]
// These cannot collide pairwise. Refuse if input matches none.
```

**Test additions**:
- `tests/unit/decode-master-key.test.ts`: `Buffer.alloc(32, 0xaa)` encoded as base64 → MUST throw `catastrophically low entropy`.
- `Buffer.from("passwordpasswordpasswordpassword").toString("base64")` → MUST log warning but boot succeed (entropy 3.0-4.5 range, depending on content).

---

## PATCH 3 — SQL prefix match: GLOB pattern (4 sites)

**Supersedes**: V2 every occurrence of `LIKE 'enc:v_:%'`. There are 4:
1. V2 §D Guard 1 SELECT (boot check for encrypted rows + no key)
2. V2 §D Guard 2 SELECT (same shape)
3. V2 §D `ALLOW_TOKEN_LOSS=1` override UPDATE (2 statements — access + refresh)
4. V2 §Migration CLI `WHERE idp_access_token NOT LIKE 'enc:v_:%'`

**Reason**: SQLite `LIKE` underscore `_` matches a single character. `'enc:v_:%'` matches `enc:v0:`..`enc:v9:` but NOT `enc:v10:`+. When a future spec writes `enc:v2:` or `enc:v10:`, these statements silently mis-classify those rows as plaintext. Boot guards stop firing on the exact downgrade scenario they were added to prevent (Round 1 C2/C8). Migrate CLI would re-encrypt already-`enc:v10:` rows, double-wrapping and corrupting.

**New pattern**: SQLite `GLOB` is case-sensitive and supports POSIX-like character classes:

```sql
-- Boot guard 1:
SELECT 1 FROM users
WHERE idp_access_token GLOB 'enc:v[0-9]*:*'
   OR idp_refresh_token GLOB 'enc:v[0-9]*:*'
LIMIT 1

-- Migrate CLI (encrypt direction):
SELECT id, primary_org_id, idp_access_token, idp_refresh_token
FROM users
WHERE (idp_access_token IS NOT NULL AND idp_access_token NOT GLOB 'enc:v[0-9]*:*')
   OR (idp_refresh_token IS NOT NULL AND idp_refresh_token NOT GLOB 'enc:v[0-9]*:*')
ORDER BY id LIMIT ?
```

`GLOB 'enc:v[0-9]*:*'` matches `enc:v` + one-or-more digits + `:` + any tail. Correctly catches v1, v10, v999, etc.

**Audit step**: implementer MUST grep the codebase for any other `enc:v_:` or `enc:v1:` string-prefix usage and convert.

---

## PATCH 4 — `provisionUser`: options-object signature

**Supersedes**: V2 §"DI wiring → `src/auth/oauth-finalize.ts` — `provisionUser` signature change".

**Reason**: V2 proposed adding `encryption` as 7th param, ahead of `idpRefreshToken?` (currently 7th). Existing call sites (oauth-callback.ts:366, oauth-token.ts:229) pass refresh token positionally as 7th. Inserting `encryption` 7th means refresh slides to 8th — every caller must be updated in the same commit (the TS compiler will fail loudly, but the spec was silent on this). Worse, this preserves the existing positional fragility.

**New signature** — options-object pattern, self-documenting:

```typescript
export interface ProvisionUserArgs {
  db: DatabaseAdapter;
  clock: Clock;
  idpUser: IdpUserInfo;
  accessToken: string;
  allowlistOrg: { org_id: string; allowlist_github_org?: string | null; allowlist_idp_org_id?: string | null };
  providerName: string;
  encryption: EncryptionProvider;
  idpRefreshToken?: string | null;
}

export async function provisionUser(args: ProvisionUserArgs): Promise<ProvisionedUser> {
  const { db, clock, idpUser, accessToken, allowlistOrg, providerName, encryption, idpRefreshToken } = args;
  // ...
}
```

**Call site updates** — explicit, all 3:

```typescript
// src/auth/oauth-callback.ts:366
const provisioned = await provisionUser({
  db, clock,
  idpUser: exchange.idpUser,
  accessToken: exchange.accessToken,
  allowlistOrg: allowlistOrg,
  providerName: providerKey,
  encryption: ctx.encryptionProvider,
  idpRefreshToken: exchange.refreshToken,
});

// src/auth/oauth-token.ts:229
const provisioned = await provisionUser({
  db, clock,
  idpUser: exchange.idpUser,
  accessToken: exchange.accessToken,
  allowlistOrg: allowlistOrg,
  providerName: providerKey,
  encryption: ctx.encryptionProvider,
  idpRefreshToken: exchange.refreshToken,
});

// src/auth/oauth-finalize.ts internal callers (if any): same pattern.
```

Bonus: this also fixes the long-standing complaint that `provisionUser`'s 7-positional-args signature is hard to read.

---

## PATCH 5 — `system_config` table: CREATE TABLE, not ALTER

**Supersedes**: V2 §D parenthetical "If it doesn't exist (verify against `src/database.ts` schema), add it via the existing idempotent `try { ALTER... } catch { /* already exists */ }` pattern."

**Reason**: `system_config` does NOT exist in `src/database.ts`. V2's wording was wrong on two counts: (a) the table is missing, not just a missing column; (b) `ALTER TABLE` cannot create a table.

**New behavior** — add to `src/database.ts` SCHEMA block (alongside other CREATE TABLE statements):

```sql
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Place it before the v0.8/v0.10 migration block so it exists by the time any boot logic queries it. Tracked key for v0.10.5: `encryption.key_fingerprint`. The table is generic — future code can add `encryption.min_version`, `feature.x.enabled`, etc.

---

## PATCH 6 — Boot guard placement: after step 8 of `bootPhase2`

**Supersedes**: V2 §Architecture diagram steps 1-3 ordering.

**Reason**: V2 implies encryption load + guards run early in boot. But:
- `audit()` calls in the guard's override path require `initAuditQueue(db)` (current step 7 in `bootPhase2`).
- DB SELECTs in guards require `initDatabase()` to have run (which is BEFORE bootPhase2 — fine).
- `performRestoreCheck` (step 5) must run before guards so a restore is detected first (otherwise an `ALLOW_TOKEN_LOSS=1` boot would NULL rows on a DB the restore-check then rejects).

**New placement**:

```
bootPhase2 step ordering (V3):
  1. Existing: opts.enabled check
  2-7. Existing: DB init, JWT keys, providers, restore-check, audit queue init, sweeper
  8. Existing: initPhase2Auth
  9. NEW: encryption key load (decode env, validate, compute fingerprint)
  10. NEW: encryption boot guards (SELECTs, optional UPDATEs, audit emissions)
  11. NEW: build wrapped encryption provider (first-encrypt fingerprint persistence)
  12. Existing (was 9): compose AuthHandlerContext with encryptionProvider + keyFingerprint
  13. Existing: return Phase2Bootstrap (now includes shutdown of reminder interval if registered)
```

V3 mandates step numbering in the spec's Architecture diagram. The implementation plan task that touches `bootPhase2` must add these steps in this order.

---

## PATCH 7 — Fingerprint persistence: wrapped-provider pattern

**Supersedes**: V2 §D ambiguous "Fresh key, no prior fingerprint: store on first encrypt (handled in EnvelopeEncryption call site)."

**Reason**: V2 leaves placement to implementer; produces 3 different plausible implementations. R2-Boot#8 recommends a wrapped provider — keeps `EnvelopeEncryption` pure crypto, centralizes the side-effect.

**New pattern** (in `bootPhase2` step 11):

```typescript
let fingerprintPersisted = !!storedFingerprint;
const rawProvider: EncryptionProvider = encryptionKey
  ? new EnvelopeEncryption(encryptionKey)
  : new PassthroughEncryption();

const wrappedProvider: EncryptionProvider = encryptionKey
  ? {
      encrypt(pt, ctx) {
        const ct = rawProvider.encrypt(pt, ctx);
        if (!fingerprintPersisted) {
          db.prepare(
            "INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)"
          ).run("encryption.key_fingerprint", keyFingerprint);
          fingerprintPersisted = true;
          audit("encryption.config.loaded", {
            tier: 1,
            metadata: { key_fingerprint: keyFingerprint, key_source: "env" },
          });
        }
        return ct;
      },
      decrypt: rawProvider.decrypt.bind(rawProvider),
    }
  : rawProvider;  // passthrough does not persist a fingerprint

ctx.encryptionProvider = wrappedProvider;
```

Notes:
- `INSERT OR IGNORE` handles the race between first concurrent requests.
- Boot guards already write the fingerprint if encrypted rows pre-exist (V2 §D end). So `fingerprintPersisted` correctly reflects boot-time state.
- `EnvelopeEncryption` itself stays pure — no DB handle, no side effects. Testable in isolation.

---

## PATCH 8 — Read SELECT extension + sync decrypt error mapping

**Supersedes**: V2 §"DI wiring → `src/auth/refresh-rotation.ts` — read + write sites".

**Reason**: V2 calls for `decryptNullable(provider, value, context)` where context REQUIRES `org_id` for AAD. But `refresh-rotation.ts:547-549` SELECTs only `idp_access_token, idp_refresh_token, idp_provider` — `primary_org_id` not fetched. Without it, AAD reconstruction fails and every decrypt throws `DataDecryptFailed`. Also: V2 says "treat decrypt errors as IdPTokenRevoked-equivalent" but the existing try/catch shape at lines 582-635 wraps only the async IdP-call branch — a sync throw from `decryptNullable` at line 557 propagates as an unhandled exception, crashing the request.

**New SELECT**:

```sql
SELECT idp_access_token, idp_refresh_token, idp_provider, primary_org_id
FROM users WHERE id = ?
```

**New error mapping** (replaces V2's vague "treat as IdPTokenRevoked"):

```typescript
import {
  DecryptionError,
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "../security/encryption.js";

const userRow = ... // SELECT result, including primary_org_id

let idpAccessToken: string | null = null;
let idpRefreshToken: string | null = null;
const idpProviderName: string | null = userRow?.idp_provider ?? null;
const orgId = userRow?.primary_org_id;

if (userRow && orgId) {
  try {
    idpAccessToken = decryptNullable(
      ctx.encryptionProvider,
      userRow.idp_access_token,
      { org_id: orgId, column: "idp_access_token", user_id: row.user_id },
    );
    idpRefreshToken = decryptNullable(
      ctx.encryptionProvider,
      userRow.idp_refresh_token,
      { org_id: orgId, column: "idp_refresh_token", user_id: row.user_id },
    );
  } catch (err) {
    if (err instanceof DecryptionError || err instanceof UnknownCipherVersion) {
      audit("encryption.decrypt.failed", {
        tier: 1,
        metadata: {
          user_id_hash: sha256(row.user_id).slice(0, 16),
          column: err instanceof Error ? err.message : "unknown",
          error_class: err.name,
        },
      });
      // Map to IdPTokenRevoked-equivalent: same audit + same 401 path
      audit("auth.idp.token_revoked", {
        tier: 1,
        metadata: {
          user_id_hash: sha256(row.user_id).slice(0, 16),
          phase: "refresh_decrypt_failed",
        },
      });
      // Bump token_epoch (forces all sessions for this user to re-auth)
      bumpTokenEpoch(db, row.user_id);
      // Respond identically to the existing IdPTokenRevoked path
      res.writeHead(401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "session expired" }));
      return;
    }
    throw err;
  }
}
```

Note: `bumpTokenEpoch` is the existing helper at `src/auth/token-epoch.ts` (or wherever the existing IdPTokenRevoked path calls it). V3 implementation plan must verify and reuse.

---

## PATCH 9 — Fingerprint format: HMAC, 16 hex chars everywhere

**Supersedes**: V2 §Boot architecture diagram (`sha256(masterKey).slice(0,8)`) and V2 §CLI fingerprint section (`slice(0,16)`).

**Reason**: V2 was inconsistent (8 hex at boot, 16 hex in CLI). Compare-by-string fails. Also: SHA-256 of the master key is fine, but HMAC with a labeled context provides key separation and future-proofs derivation changes.

**New fingerprint**:

```typescript
import { createHmac } from "node:crypto";

function computeKeyFingerprint(masterKey: Buffer): string {
  return createHmac("sha256", "mcc-fingerprint-v1")
    .update(masterKey)
    .digest("hex")
    .slice(0, 16);  // 64 bits, collision-resistant for practical operator scale
}
```

Use everywhere: boot diagram, system_config storage, CLI fingerprint command, audit metadata, boot mismatch error message. **16 hex chars across the board.**

---

## PATCH 10 — `ALLOW_TOKEN_LOSS` requires confirmation + per-user audit

**Supersedes**: V2 §D Guard 1 override.

**Reason**: V2's `COORDINATOR_ALLOW_TOKEN_LOSS=1` is irreversible (NULLs all encrypted rows) and one env var typo away from disaster. No backup of the to-be-nulled ciphertext is taken; no per-user audit.

**New behavior**:

```typescript
// Guard 1 override block (V3):
if (hasEncryptedRows && !encryptionKey) {
  const expectedConfirm = `I_UNDERSTAND_THIS_NULLS_${countEncryptedRows(db)}_ROWS`;
  if (process.env.COORDINATOR_ALLOW_TOKEN_LOSS !== "1") {
    throw new BootValidationError(
      "Database contains encrypted IdP token rows but COORDINATOR_ENCRYPTION_KEY is not set. " +
      "Either set the key, or set COORDINATOR_ALLOW_TOKEN_LOSS=1 to NULL all encrypted rows. " +
      "If you restored from a backup, recover the original key first."
    );
  }
  if (process.env.COORDINATOR_TOKEN_LOSS_CONFIRM !== expectedConfirm) {
    throw new BootValidationError(
      `COORDINATOR_ALLOW_TOKEN_LOSS=1 is set but COORDINATOR_TOKEN_LOSS_CONFIRM does not match. ` +
      `To proceed (THIS IS DESTRUCTIVE), set: COORDINATOR_TOKEN_LOSS_CONFIRM=${expectedConfirm}`
    );
  }

  // Stash ciphertexts to encryption_invalidated_tokens for forensic recovery.
  db.exec(`
    CREATE TABLE IF NOT EXISTS encryption_invalidated_tokens (
      user_id        TEXT NOT NULL,
      column_name    TEXT NOT NULL,
      ciphertext     TEXT NOT NULL,
      invalidated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason         TEXT NOT NULL,
      PRIMARY KEY (user_id, column_name, invalidated_at)
    )
  `);

  const invalidatedRows = db.prepare(
    "SELECT id, idp_access_token, idp_refresh_token FROM users " +
    "WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*'"
  ).all() as Array<{ id: string; idp_access_token: string | null; idp_refresh_token: string | null }>;

  const stash = db.prepare(
    "INSERT INTO encryption_invalidated_tokens (user_id, column_name, ciphertext, reason) VALUES (?, ?, ?, ?)"
  );
  const nullify = db.prepare("UPDATE users SET idp_access_token = NULL, idp_refresh_token = NULL WHERE id = ?");

  for (const r of invalidatedRows) {
    if (r.idp_access_token?.startsWith("enc:v")) stash.run(r.id, "idp_access_token", r.idp_access_token, "key_absent_token_loss_allowed");
    if (r.idp_refresh_token?.startsWith("enc:v")) stash.run(r.id, "idp_refresh_token", r.idp_refresh_token, "key_absent_token_loss_allowed");
    nullify.run(r.id);
    audit("encryption.token.invalidated", {
      tier: 1,
      metadata: { user_id_hash: sha256(r.id).slice(0, 16), reason: "key_absent_token_loss_allowed" },
    });
  }
}

function countEncryptedRows(db: DatabaseAdapter): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*'"
  ).get() as { n: number };
  return row.n;
}
```

Recovery path: if the operator later finds the original key, they can SELECT from `encryption_invalidated_tokens`, decrypt the stashed ciphertexts, and re-populate. Manual procedure; document in onboarding.

---

## PATCH 11 — Periodic plaintext reminder: pino logger + teardown

**Supersedes**: V2 §E `setInterval(...).unref()` block.

**Reason**: V2 used `audit.log(level, msg)` which is not an API on `src/security/audit.ts`. Also no teardown hook → tests that boot+shutdown repeatedly leak intervals.

**New behavior**:

```typescript
// In bootPhase2, after Guard checks. Returned in Phase2Bootstrap.
let reminderInterval: NodeJS.Timeout | null = null;

if (!encryptionKey) {
  const level = process.env.NODE_ENV === "production" ? "error" : "warn";
  bootLogger[level](
    "IdP tokens stored plaintext at rest. " +
    "Set COORDINATOR_ENCRYPTION_KEY for at-rest encryption."
  );
  audit("encryption.config.loaded", {
    tier: 1,
    metadata: { key_source: "absent" },
  });

  reminderInterval = setInterval(() => {
    bootLogger[level](
      "REMINDER: COORDINATOR_ENCRYPTION_KEY is not set. IdP tokens stored plaintext."
    );
  }, 86_400_000);
  reminderInterval.unref();
}

// In the shutdown function returned by bootPhase2:
function shutdown() {
  // ... existing shutdown ...
  if (reminderInterval) clearInterval(reminderInterval);
}
```

`bootLogger` is a pino instance created near the top of `bootPhase2` (or passed in via `(deps: { logger })` per PATCH 14).

---

## PATCH 12 — `/health/ready` JSON shape

**Supersedes**: V2 §E sample payload using `"ready": true`.

**Reason**: actual readiness payload (`src/http/health.ts:85-90`) uses `"status": "ready"|"not_ready"`. V2's example would confuse operators.

**New shape**:

```json
{
  "status": "ready",
  "checks": { ... existing ... },
  "encryption": {
    "enabled": true,
    "key_source": "env",
    "key_fingerprint": "abc12345def67890",
    "decrypt_failures_5m": 0
  }
}
```

Implementation: `handleHealthReady` needs access to encryption status. Add `getEncryptionStatus()` accessor (module-level getter set at boot, similar to `getAuditQueue()`) that returns `{ enabled, key_source, key_fingerprint, decrypt_failures_5m }`. The `decrypt_failures_5m` value is read from the prom counter (sliding 5-min window via prom-client's built-in rate or a separate ring buffer).

---

## PATCH 13 — Version regex bounds

**Supersedes**: V2 §B `VERSION_RE = /^enc:v(\d+):/`.

**Reason**: `\d+` accepts pathological values like `enc:v00000000001:` or `enc:v999999999999999:`. Tighten.

**New regex**:

```typescript
const VERSION_RE = /^enc:v([1-9]\d{0,2}):/;
// Matches: enc:v1: through enc:v999:. Rejects leading zeros, version 0, and anything longer than 3 digits.
```

If a string starts with `enc:v` but the version pattern doesn't match, throw `MalformedCiphertext`, not `UnknownCipherVersion`. Distinguishes "we don't speak this version" from "this is garbage".

---

## PATCH 14 — `bootPhase2` injectable dependencies (testability)

**Supersedes**: nothing in V2 — additive.

**Reason**: R2-test#16 — V2 has no story for testing fail-loud boot guards. The current `bootPhase2(opts)` reads global `process.env`, opens its own DB, instantiates its own logger. Cannot exercise guard branches in-process without spawning child processes.

**New signature** (backward-compatible default values):

```typescript
export interface BootPhase2Deps {
  db?: DatabaseAdapter;
  env?: NodeJS.ProcessEnv;
  logger?: pino.Logger;
  // Test-only injection points; production callers pass nothing.
}

export function bootPhase2(opts: Phase2BootOptions, deps?: BootPhase2Deps): Phase2Bootstrap | null {
  const db = deps?.db ?? openProductionDb(opts);
  const env = deps?.env ?? process.env;
  const logger = deps?.logger ?? createLogger({ level: env.COORDINATOR_LOG_LEVEL ?? "info" });
  // ... rest of bootPhase2 uses these locals instead of globals ...
}
```

Production call sites (`src/serve-http.ts:400`, etc.) pass no `deps`. Tests inject synthetic env + in-memory DB to exercise guard combinations without child processes.

**Test pattern** (replaces V2 implicit boot-test approach):

```typescript
// tests/unit/boot-encryption-guards.test.ts
const synthDb = openInMemoryDb();
seedEncryptedRows(synthDb, 5);
expect(() => bootPhase2(opts, { env: { /* no key */ }, db: synthDb, logger })).toThrow(/COORDINATOR_ENCRYPTION_KEY is not set/);
```

---

## PATCH 15 — Lock file: PID-in-content for auto-recovery

**Supersedes**: V2 §Migration CLI "Lock file is removed on clean exit; stale lock requires manual `rm`."

**Reason**: Windows / POSIX semantics differ; stale-lock-after-crash is a footgun.

**New behavior**:

```typescript
const lockPath = path.join(dataDir, "migration.lock");
let lockFd: number;
try {
  lockFd = fs.openSync(lockPath, "wx");  // fail if exists
  fs.writeSync(lockFd, String(process.pid));
  fs.closeSync(lockFd);
} catch (err: any) {
  if (err.code === "EEXIST") {
    // Lock exists. Check if PID alive.
    const oldPid = parseInt(fs.readFileSync(lockPath, "utf8"), 10);
    if (isPidAlive(oldPid)) {
      throw new Error(`Migration already running as PID ${oldPid}. Wait for completion or kill the process.`);
    }
    // Stale lock — take over.
    fs.unlinkSync(lockPath);
    lockFd = fs.openSync(lockPath, "wx");
    fs.writeSync(lockFd, String(process.pid));
    fs.closeSync(lockFd);
  } else {
    throw err;
  }
}
// On clean exit: fs.unlinkSync(lockPath)
// On SIGINT/SIGTERM: cleanup handler removes lock
```

`isPidAlive`: cross-platform via `try { process.kill(pid, 0); return true; } catch { return false; }`. Works on Windows and POSIX.

`--force` flag bypasses the daemon-PID check but NOT the file lock (documented in CLI help).

---

## PATCH 16 — CLI fingerprint length consistency

**Supersedes**: V2 §"fingerprint semantics" `slice(0,16)`.

**Reason**: PATCH 9 standardizes on 16 hex chars (HMAC-derived). The CLI must emit the same length, so operators comparing strings get exact match.

**New CLI output**:

```bash
$ mcp-coordinator encryption fingerprint
abc12345def67890
```

16 hex chars, no prefix, no trailing newline beyond stdout's. Operators can `diff` against `sqlite3 coordinator.db "SELECT value FROM system_config WHERE key='encryption.key_fingerprint'"`.

---

## PATCH 17 — Audit event tier pinning + user_id_hash

**Supersedes**: V2 §Observability audit events table (no `tier` column).

**Reason**: R2-Boot#14. `audit()` API takes `tier`; spec must commit.

**New audit table**:

| Event | Tier | Metadata fields |
|---|---|---|
| `encryption.config.loaded` | 1 | `key_fingerprint`, `key_source` ∈ `{"env", "absent"}` |
| `encryption.decrypt.failed` | 2 | `user_id_hash` (sha256(user_id).slice(0,16)), `column`, `error_class` |
| `encryption.migration.completed` | 2 | `direction`, `rows_changed`, `rows_skipped_cas`, `rows_already_done` |
| `encryption.key.rotation_begin` | 1 | `old_fingerprint`, `new_fingerprint` |
| `encryption.token.invalidated` | 1 | `user_id_hash`, `reason` |

`user_id_hash = createHmac("sha256", "mcc-audit-pseudonym-v1").update(user_id).digest("hex").slice(0,16)`. Same HMAC key separation pattern as fingerprint. Operator can still correlate failures across audit entries (same user_id → same hash) without exposing raw user_id.

---

## PATCH 18 — Risks accepted (additions)

Add to V2 §Risks accepted:

- **Rotation procedure transits plaintext on disk.** During `encryption migrate --direction=decrypt`, IdP tokens are written back to plaintext. Operator MUST ensure host filesystem is not externally accessible during this window (no backup snapshots taken, no network share mounted, no untrusted users on the host). Mitigation = operator runs rotation in a maintenance window.
- **DEK zeroized; plaintext not.** `EnvelopeEncryption.decrypt()` zeroes the DEK in a `finally` block. The plaintext IdP token is a JavaScript string — immutable, lives in V8 heap until GC. Process-memory dump exposes it. Out of scope per Round 1 S4.
- **Error-class observable to operators.** `coordinator_idp_decrypt_failures_total{error_class="…"}` and `encryption.decrypt.failed` audit metadata expose whether a failure was structural (Malformed/DEKUnwrap) vs tampering (DataDecrypt). Acceptable — operators need this for debugging. NOT exposed via HTTP responses.

---

## PATCH 19 — Test plan additions (from R2 test-coverage review)

Append to V2 §Testing the following test files / scenarios:

| File | Coverage added |
|---|---|
| `tests/helpers/encryption.ts` | `makeTestEncryption()` factory + `withEncryptionEnv(fn)` wrapper. **Required infrastructure** for all encryption-aware tests. |
| `tests/unit/cli-server-start-env-forwarding.test.ts` | Asserts `cli/server/start.ts` `childEnv` includes the 3 encryption env vars (C9 gap) |
| `tests/unit/boot-di-wiring.test.ts` | Asserts `ctx.encryptionProvider instanceof EnvelopeEncryption` with key, `PassthroughEncryption` without (C5 gap) |
| `tests/integration/oauth-callback-encrypted.test.ts` | Encrypted flow through the browser-callback provisionUser site (C6 gap) |
| `tests/integration/oauth-token-encrypted.test.ts` | Encrypted flow through the CLI authorization_code site (C6 gap) |
| `tests/integration/lazy-migration-tolerance.test.ts` | Boot daemon with key set, seed user with plaintext, refresh succeeds + row becomes `enc:v1:` (C14 gap) |
| `tests/integration/health-ready-encryption.test.ts` | GET /health/ready asserts encryption block shape (V2 addition gap) |
| `tests/unit/encryption-observability.test.ts` | Asserts metric increments + audit events emit on each lifecycle event (C15 gap) |

Extend existing files:
- `tests/unit/envelope-encryption.test.ts`: AAD swap matrix (cross-row, cross-column, cross-user) + length-prefixed format injection forcing-function test (PATCH 1)
- `tests/unit/boot-encryption-guards.test.ts`: enumerate the 12 branch cases (`{hasEncryptedRows × {true,false}} × {key present × {true,false}} × {fingerprint match × {match,mismatch,null}} × {override flag × {set,unset}}`). NODE_ENV=production ERROR-level vs WARN. setInterval `vi.useFakeTimers()` reminder.
- `tests/unit/cli-encryption-migrate.test.ts`: real concurrent-write CAS race (C18 improvement); 2 concurrent processes lock contention (C19 improvement); decrypt-direction round-trip symmetry.
- `tests/integration/refresh-rotation-encrypted.test.ts`: 3 explicit assertions for decrypt-failure → IdPTokenRevoked equivalence (audit code match, response byte-match, token_epoch +1).

Cuts (R2 test-coverage redundancies):
- `tests/integration/bun-encryption.test.ts` reduced to 1 focused Buffer base64url round-trip test (CI matrix run covers the rest).
- `cli-encryption-fingerprint.test.ts` "no DB access" → "runs without coordinator.db present".

---

## Summary of changes from V2

| Area | V2 | V3 |
|---|---|---|
| AAD encoding | pipe-delimited string | length-prefixed binary |
| Master key entropy | warn-only | refuse < 3.0, warn 3.0-4.5 |
| SQL prefix match | `LIKE 'enc:v_:%'` | `GLOB 'enc:v[0-9]*:*'` (4 sites) |
| `provisionUser` signature | positional 7th param | options-object |
| `system_config` table | assumed-existing ALTER | explicit CREATE TABLE in `database.ts` |
| Boot guard placement | top of `bootPhase2` | after step 8 (initPhase2Auth) |
| Fingerprint persistence | "first encrypt call site" | wrapped provider in `bootPhase2` |
| SELECT for read sites | unchanged | extends to include `primary_org_id` |
| Decrypt error mapping | "treat as IdPTokenRevoked" | explicit sync try/catch with code shape |
| Fingerprint format | mixed 8/16 hex SHA | 16 hex HMAC-SHA256 labeled |
| TOKEN_LOSS override | single env var | 2 env vars + per-user audit + stash table |
| Periodic reminder | `audit.log()` (non-existent) | pino `bootLogger[level]()` + teardown |
| `/health/ready` shape | `ready` field | `status` field (matches actual) |
| Version regex | `\d+` unbounded | `[1-9]\d{0,2}` (1-999) |
| `bootPhase2` testability | global env/db/logger | optional `deps` injection |
| Lock file | manual rm on stale | PID-in-content auto-recovery |
| Audit event tiers | not specified | tier per event + HMAC user_id_hash |

## Implementation order impact

V3 patches make several touched files larger and several signatures load-bearing. Implementation plan must:
1. Add `system_config` CREATE TABLE first (database.ts) — blocking dependency.
2. Refactor `provisionUser` to options-object signature in a dedicated PR before encryption code (so it's a clean refactor, not muddled with crypto).
3. Add `bootPhase2(opts, deps?)` injection signature in a dedicated PR (small, mechanical, enables testability for next PRs).
4. Then encryption proper: encryption.ts error classes → envelope-encryption.ts → encrypt-nullable.ts → boot guards → wrapped provider → CLI commands → daemon-spawn forwarding → docs.

Plan task count: ~12-15 atomic tasks across 3-4 PRs. Detailed plan to follow.
