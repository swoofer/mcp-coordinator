# IdP token column-level encryption (v0.10.5 design)

**Status**: V2 (post Round 1 review), 2026-05-17
**Target**: mcp-coordinator v0.10.5
**Author**: autonomous agent
**Supersedes**: V1 (also dated 2026-05-17)
**Round 1 reviews**: `docs/superpowers/working/v0.10.5-idp-encryption/round1/`
**Companion**: `docs/superpowers/specs/2026-05-11-encryption-at-rest-design.md` (whole-DB SQLCipher — deferred indefinitely; preserved for historical context)

## Revision history

- **V1** (2026-05-17): initial draft. Envelope encryption, env-only master key, lazy migration, `enc:v1:` prefix, `MasterKeyProvider` interface, `EncryptionContext` parameter, `hmac()` method on provider, `verify-encryption-key` CLI.
- **V2** (2026-05-17, this doc): incorporates 6-reviewer Round 1 findings — see `round1/00-SYNTHESIS.md` for full mapping. Key architectural changes:
  - Drop `MasterKeyProvider` interface (inline env read; re-add when 2nd impl exists).
  - Drop `hmac()` method from `EncryptionProvider` (unused; re-add with HKDF subkey when needed).
  - **Bind `EncryptionContext` (org_id‖column‖user_id) as GCM AAD** — closes cross-row/cross-column swap attack.
  - **Strict-mode boot guard**: if `enc:v1:` rows present and key missing or fingerprint mismatch → refuse boot.
  - **Key fingerprint** persisted at first encrypted write; checked at boot.
  - **Forward-compat**: `decrypt()` matches `enc:v\d+:`; unknown version → throws (not passthrough).
  - **Three-class typed errors**: `MalformedCiphertext`, `DEKUnwrapFailed`, `DataDecryptFailed`.
  - Sync `loadMasterKey()` — keeps `bootPhase2` sync.
  - `NULL`/`""` token handling via `encryptNullable` helper.
  - CLI namespaced under `encryption` subcommand (matches `server` pattern): `migrate`, `verify`, `fingerprint`, `migrate --decrypt`.
  - `cli/server/start.ts` daemon-spawn forwards the encryption key (critical fix — without it, `--daemon` silently runs plaintext).
  - Backup-restore guard: refuse boot if `enc:v1:` rows exist and key absent.
  - 3 prom metrics + 3 audit events.
  - DI wiring explicit: `AuthHandlerContext.encryptionProvider` added; `provisionUser()` signature changes; all 3 call sites enumerated.
  - Test fixtures stay plaintext (exercise lazy-migration path); `selectIdpToken` test helper for decryption-aware assertions.

## Summary

Encrypt `users.idp_access_token` and `users.idp_refresh_token` at-rest using **AES-256-GCM envelope encryption with AAD-bound context**. Master key from env var, sync read at boot. Per-row random DEK wrapped with master. Lazy migration of existing plaintext rows; CLI for one-shot full migration; CLI for verification and key fingerprint inspection. Strict-mode guards on boot prevent silent key-swap data loss and prevent restore-without-key from running. Closes the residual risk identified in `docs/security/threat-model.md` for IdP credentials in the DB while preserving Bun runtime support and backward compatibility with existing plaintext deployments.

Effort: ~1.5 weeks single release.

## Why column-level (not whole-DB SQLCipher)

1. **Bun support.** `better-sqlite3-multiple-ciphers` has no Bun binding. Bun stays first-class with `node:crypto`.
2. **No native toolchain dep.** Self-hosters don't need `python3 + make + g++` outside Docker.
3. **Compliance ROI.** The high-value residual risk is concentrated on the IdP tokens (cross-system impersonation). Other plaintext columns mitigated by OS-level encryption.

Whole-DB SQLCipher remains future-possible but is not roadmapped.

## Goals

1. `users.idp_access_token` and `users.idp_refresh_token` unreadable from `coordinator.db` without the master key.
2. Cross-row / cross-column ciphertext swap attacks fail (AAD bound to identity).
3. **Fail-closed against silent misconfiguration**: wrong key, missing key, swapped key all refuse boot when prior encryption is detected.
4. Zero-downtime enablement: lazy migration, backward-compatible fallback for fresh v0.10.4 → v0.10.5 upgrade with no env var.
5. Bun runtime preserved.
6. Reusable pattern: `EncryptionProvider` interface gets a real implementation that future columns can adopt.

## Non-goals

- Whole-DB encryption.
- Encryption of other plaintext columns (separate spec per column family).
- KMS / file key sources (env-only in v0.10.5; interface allows future expansion).
- **Online key rotation** (deferred; v0.10.5 ships "operator workflow" rotation = stop daemon + run `encryption migrate --decrypt` + redeploy with new key + run `encryption migrate`).
- HMAC / searchable encryption (no use case; `hmac()` removed from interface).
- Backup encryption (OS-level is correct layer).
- Process memory zeroization (documented risk; v0.10.6 follow-up).
- Multi-instance with shared DB (single-writer constraint already documented elsewhere).

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│ Boot (bootPhase2, src/boot.ts) — synchronous                           │
│                                                                        │
│  step 1: load master key                                               │
│    raw = process.env.COORDINATOR_ENCRYPTION_KEY                        │
│    if (raw) {                                                          │
│      masterKey = decodeMasterKey(raw)            // trim, alphabet,    │
│                                                  // length, entropy    │
│      keyFingerprint = sha256(masterKey).slice(0,8)                     │
│      encryptionProvider = new EnvelopeEncryption(masterKey)            │
│    } else {                                                            │
│      encryptionProvider = new PassthroughEncryption()                  │
│    }                                                                   │
│                                                                        │
│  step 2: strict-mode guards                                            │
│    hasEncryptedRows = SELECT 1 FROM users                              │
│      WHERE idp_access_token LIKE 'enc:v_:%' LIMIT 1                    │
│    storedFingerprint = SELECT value FROM system_config                 │
│      WHERE key = 'encryption.key_fingerprint'                          │
│                                                                        │
│    case (key absent, hasEncryptedRows=true):                           │
│      REFUSE boot. Override: COORDINATOR_ALLOW_TOKEN_LOSS=1             │
│      (NULLs all enc:v_: rows on next start; users re-auth)             │
│                                                                        │
│    case (key present, hasEncryptedRows=true,                           │
│          storedFingerprint != keyFingerprint):                         │
│      REFUSE boot. Override: COORDINATOR_ALLOW_KEY_ROTATION=1           │
│      (operator confirms rotation; new fingerprint stored on next       │
│       successful encrypt)                                              │
│                                                                        │
│    case (key present, hasEncryptedRows=false, storedFingerprint=null): │
│      OK — daemon will write fingerprint on first encrypted row         │
│                                                                        │
│    case (key absent, hasEncryptedRows=false):                          │
│      log at ERROR (prod) or WARN (dev); daemon runs plaintext          │
│                                                                        │
│  step 3: wire into AuthHandlerContext                                  │
│    ctx.encryptionProvider = encryptionProvider                         │
│    ctx.keyFingerprint = keyFingerprint                                 │
└────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────┐   writes via    ┌──────────────────────────┐
│ oauth-finalize.ts        │  encryptNullable│ users.idp_access_token   │
│   provisionUser(...,     │────────────────▶│ users.idp_refresh_token  │
│     encryption, ...)     │                 │ (TEXT, enc:v1:... blob)  │
└──────────────────────────┘                 └──────────────────────────┘
                                                       │
                                                       │ reads via
                                                       ▼
                                             ┌──────────────────────────┐
                                             │ refresh-rotation.ts      │
                                             │   ctx.encryptionProvider │
                                             │   .decrypt(...)          │
                                             └──────────────────────────┘
```

## Storage format

```
enc:v1:<base64url(wrappedDEK || nonceData || tagData || ciphertext)>

where:
  wrappedDEK = 12 bytes nonce || 16 bytes tag || 32 bytes ciphertext (encrypted DEK)
             = 60 bytes total
  nonceData  = 12 bytes (random per encryption)
  tagData    = 16 bytes (AES-GCM auth tag — covers ciphertext AND AAD)
  ciphertext = N bytes (same length as plaintext)

AAD bound on the DATA layer (cipherData.setAAD(aad)):
  aad = utf8(`v1|${org_id}|${column}|${user_id}`)

  This binds the ciphertext to (org, column, user) identity. An attacker
  with DB-write access cannot:
    - swap a victim user's encrypted token into the attacker's row
    - swap idp_access_token ciphertext into idp_refresh_token column
    - replay an older (revoked) ciphertext for the same user+column
      (replay still possible across timestamps — out of scope; replay
      defense is the IdP's refresh-token revocation, not ours)

AAD is NOT bound on the wrap layer — the master key wraps DEKs that are
opaque to context. Context binding lives where it has semantic meaning:
plaintext data.

Total overhead: ~110 bytes header + base64url expansion ≈ 145 bytes per row
Typical token ~200 bytes → encrypted row ~370 bytes
```

**Prefix `enc:v1:` rationale**:
- Plaintext detection at zero cost (`startsWith("enc:v1:")` is cheap).
- Self-documenting in DB dumps.
- Forward-compat: `decrypt()` matches the pattern `^enc:v(\d+):` — any future version is detected; unknown versions throw `UnknownCipherVersion` (NOT silent passthrough — this is the failure mode that would re-emit the blob as a bearer token if reverted to an older daemon). See §Forward-compat below.

**Why not NUL-prefix** (alternative considered): a control byte (`\x00mcc:v1:`) would prevent the theoretical collision with a token that legitimately begins with the literal string `enc:v1:` (Edge#5). Rejected because: SQLite TEXT does not strip NULs but operator tooling (sqlite3 CLI, GUI tools) often misrenders embedded NULs. Trade-off: rare false positive (collision) is handled by the AAD check (a plaintext starting with `enc:v1:` won't have valid base64url AAD-tagged bytes after the prefix and will throw `MalformedCiphertext`, distinct from `DEKUnwrapFailed`) and surfaced clearly in logs.

## Components

### A. Master key load (inline, sync)

In `src/boot.ts` directly, no separate provider class:

```typescript
function loadMasterKey(): Buffer | null {
  const raw = process.env.COORDINATOR_ENCRYPTION_KEY;
  if (!raw) return null;
  return decodeMasterKey(raw.trim());
}

function decodeMasterKey(trimmed: string): Buffer {
  // Auto-detect alphabet; refuse if ambiguous.
  const isHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
  const isB64 = /^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed);
  const isB64u = /^[A-Za-z0-9_-]{43}$/.test(trimmed);

  const matches = [isHex && "hex", isB64 && "base64", isB64u && "base64url"]
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new Error(
      "COORDINATOR_ENCRYPTION_KEY format unrecognized or ambiguous. " +
      "Use exactly one of: 64-char hex, 44-char base64, or 43-char base64url. " +
      "Generate with: openssl rand -base64 32"
    );
  }
  const encoding = matches[0] as "hex" | "base64" | "base64url";
  const key = Buffer.from(trimmed, encoding);
  if (key.length !== 32) {
    throw new Error(
      `COORDINATOR_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
      `Use: openssl rand -base64 32`
    );
  }

  // Soft entropy check: warn if key looks like a passphrase.
  const entropy = shannonEntropyBitsPerByte(key);
  if (entropy < 4.5) {
    auditLog.warn(
      { entropy_bits_per_byte: entropy.toFixed(2) },
      "COORDINATOR_ENCRYPTION_KEY has low entropy — this looks like a passphrase, " +
      "not a random key. AES-256 requires a uniformly-random 32-byte key. " +
      "Generate with: openssl rand -base64 32"
    );
  }
  return key;
}
```

Rationale for sync (not Promise): env reads are sync; `bootPhase2` is sync (`src/boot.ts:54`); making it async cascades through `serve-http.ts:400` and tests. When KMS support arrives (if ever), a separate `MasterKeyProvider` interface can be introduced then with both sync and async paths.

### B. `EnvelopeEncryption` (with AAD, three error classes)

`src/security/envelope-encryption.ts`:

```typescript
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { EncryptionProvider, EncryptionContext } from "./encryption.js";
import {
  DecryptionError,
  MalformedCiphertext,
  DEKUnwrapFailed,
  DataDecryptFailed,
  UnknownCipherVersion,
} from "./encryption.js";

const PREFIX_V1 = "enc:v1:";
const VERSION_RE = /^enc:v(\d+):/;
const ALG = "aes-256-gcm";

export class EnvelopeEncryption implements EncryptionProvider {
  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) {
      throw new Error(
        `EnvelopeEncryption requires a 32-byte master key for AES-256 (got ${masterKey.length}). ` +
        `Generate with: openssl rand -base64 32`
      );
    }
  }

  encrypt(plaintext: string, context: EncryptionContext): string {
    const dek = randomBytes(32);
    const nonceData = randomBytes(12);
    const cipherData = createCipheriv(ALG, dek, nonceData);
    cipherData.setAAD(this.aad(context));
    const ciphertext = Buffer.concat([
      cipherData.update(plaintext, "utf8"),
      cipherData.final(),
    ]);
    const tagData = cipherData.getAuthTag();

    const nonceDek = randomBytes(12);
    const cipherDek = createCipheriv(ALG, this.masterKey, nonceDek);
    const wrappedDek = Buffer.concat([
      cipherDek.update(dek),
      cipherDek.final(),
    ]);
    const tagDek = cipherDek.getAuthTag();
    const wrappedDekBlob = Buffer.concat([nonceDek, tagDek, wrappedDek]);

    dek.fill(0); // zero ephemeral DEK
    const blob = Buffer.concat([wrappedDekBlob, nonceData, tagData, ciphertext]);
    return PREFIX_V1 + blob.toString("base64url");
  }

  decrypt(ciphertext: string, context: EncryptionContext): string {
    const versionMatch = VERSION_RE.exec(ciphertext);
    if (!versionMatch) {
      // No version prefix: legacy plaintext. Return as-is (callers handle).
      return ciphertext;
    }
    const version = versionMatch[1];
    if (version !== "1") {
      throw new UnknownCipherVersion(
        `Cannot decrypt enc:v${version}: prefix. This daemon only understands enc:v1:. ` +
        `Upgrade or roll back the daemon to the version that wrote this row.`
      );
    }

    const blob = (() => {
      try {
        return Buffer.from(ciphertext.slice(PREFIX_V1.length), "base64url");
      } catch (cause) {
        throw new MalformedCiphertext("base64url decode failed", { cause });
      }
    })();
    if (blob.length < 88) {
      throw new MalformedCiphertext(
        `ciphertext too short (got ${blob.length} bytes, need ≥88)`
      );
    }

    const nonceDek = blob.subarray(0, 12);
    const tagDek = blob.subarray(12, 28);
    const wrappedDek = blob.subarray(28, 60);
    const nonceData = blob.subarray(60, 72);
    const tagData = blob.subarray(72, 88);
    const dataCt = blob.subarray(88);

    let dek: Buffer;
    try {
      const decipherDek = createDecipheriv(ALG, this.masterKey, nonceDek);
      decipherDek.setAuthTag(tagDek);
      dek = Buffer.concat([decipherDek.update(wrappedDek), decipherDek.final()]);
    } catch (cause) {
      throw new DEKUnwrapFailed(
        "wrapped DEK authentication failed — wrong master key or corrupted wrap header",
        { cause }
      );
    }

    try {
      const decipherData = createDecipheriv(ALG, dek, nonceData);
      decipherData.setAuthTag(tagData);
      decipherData.setAAD(this.aad(context));
      const pt = Buffer.concat([
        decipherData.update(dataCt),
        decipherData.final(),
      ]);
      return pt.toString("utf8");
    } catch (cause) {
      throw new DataDecryptFailed(
        "ciphertext authentication failed — data corruption or AAD mismatch (cross-row/column swap?)",
        { cause }
      );
    } finally {
      dek.fill(0);
    }
  }

  private aad(context: EncryptionContext): Buffer {
    // Note: includes user_id from context. EncryptionContext interface
    // updated to require user_id (see §EncryptionContext below).
    return Buffer.from(
      `v1|${context.org_id}|${context.column}|${context.user_id}`,
      "utf8"
    );
  }
}
```

Error classes in `src/security/encryption.ts`:

```typescript
export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecryptionError";
  }
}
export class MalformedCiphertext extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MalformedCiphertext";
  }
}
export class DEKUnwrapFailed extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DEKUnwrapFailed";
  }
}
export class DataDecryptFailed extends DecryptionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataDecryptFailed";
  }
}
export class UnknownCipherVersion extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownCipherVersion";
  }
}
```

Updated `EncryptionContext`:

```typescript
export interface EncryptionContext {
  org_id: string;
  column: "idp_access_token" | "idp_refresh_token";
  user_id: string;
}
```

`PassthroughEncryption` updated to keep new interface (HMAC removed):

```typescript
export class PassthroughEncryption implements EncryptionProvider {
  encrypt(p: string, _ctx: EncryptionContext): string { return p; }
  decrypt(c: string, _ctx: EncryptionContext): string { return c; }
}
```

`EncryptionProvider` interface (post-cut):

```typescript
export interface EncryptionProvider {
  encrypt(plaintext: string, context: EncryptionContext): string;
  decrypt(ciphertext: string, context: EncryptionContext): string;
}
```

### C. NULL/empty token helper

Per Edge#1 (CRITICAL) and Edge#2 (MAJOR): NULL and empty-string handling MUST be at the call site, not in the provider (the provider only sees strings).

```typescript
// src/security/encrypt-nullable.ts
export function encryptNullable(
  provider: EncryptionProvider,
  value: string | null | undefined,
  context: EncryptionContext,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return provider.encrypt(value, context);
}

export function decryptNullable(
  provider: EncryptionProvider,
  value: string | null,
  context: EncryptionContext,
): string | null {
  if (value === null) return null;
  return provider.decrypt(value, context);
}
```

All write call sites MUST use `encryptNullable`. Empty string is normalized to NULL at the boundary — never encrypted, never stored. Mirror at read sites with `decryptNullable`.

### D. Strict-mode boot guards

In `bootPhase2`, after loading the encryption provider:

```typescript
const hasEncryptedRows = !!(db
  .prepare("SELECT 1 FROM users WHERE idp_access_token LIKE 'enc:v_:%' OR idp_refresh_token LIKE 'enc:v_:%' LIMIT 1")
  .get());

const storedFingerprint = (db
  .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
  .get() as { value: string } | undefined)?.value ?? null;

// Guard 1: encrypted rows exist but no key
if (hasEncryptedRows && !encryptionKey) {
  if (process.env.COORDINATOR_ALLOW_TOKEN_LOSS !== "1") {
    throw new BootValidationError(
      "Database contains encrypted IdP token rows but COORDINATOR_ENCRYPTION_KEY is not set. " +
      "Either set the key, or set COORDINATOR_ALLOW_TOKEN_LOSS=1 to NULL all encrypted rows " +
      "(users will be forced to re-authenticate on next refresh). " +
      "If you restored from a backup, recover the original key first."
    );
  }
  // Override path: NULL out enc:v_: rows, log, audit.
  db.prepare("UPDATE users SET idp_access_token = NULL WHERE idp_access_token LIKE 'enc:v_:%'").run();
  db.prepare("UPDATE users SET idp_refresh_token = NULL WHERE idp_refresh_token LIKE 'enc:v_:%'").run();
  audit("encryption.token.invalidated", { reason: "key_absent_token_loss_allowed" });
}

// Guard 2: key present but fingerprint mismatch
if (hasEncryptedRows && encryptionKey && storedFingerprint && storedFingerprint !== keyFingerprint) {
  if (process.env.COORDINATOR_ALLOW_KEY_ROTATION !== "1") {
    throw new BootValidationError(
      `Database was encrypted with a different key (stored fingerprint=${storedFingerprint}, current key fingerprint=${keyFingerprint}). ` +
      "Either restore the correct key, or set COORDINATOR_ALLOW_KEY_ROTATION=1 to begin rotation. " +
      "Existing rows encrypted with the old key will become unreadable; users will be forced to re-authenticate."
    );
  }
  audit("encryption.key.rotation_begin", { old_fingerprint: storedFingerprint, new_fingerprint: keyFingerprint });
  // New fingerprint will be persisted on first successful encrypt with the new key.
  db.prepare("DELETE FROM system_config WHERE key = 'encryption.key_fingerprint'").run();
}

// Fresh key, no prior fingerprint: store on first encrypt (handled in EnvelopeEncryption call site).
// Either: key present, hasEncryptedRows=false, no stored fingerprint → OK, write fingerprint on first encrypt.
// Or: key present, hasEncryptedRows=true, storedFingerprint=null (pre-fingerprint era) → write current fingerprint now.
if (encryptionKey && hasEncryptedRows && !storedFingerprint) {
  db.prepare("INSERT INTO system_config (key, value) VALUES (?, ?)").run("encryption.key_fingerprint", keyFingerprint);
}
```

The `system_config` table is a generic key-value store. If it doesn't exist (verify against `src/database.ts` schema), add it via the existing idempotent `try { ALTER... } catch { /* already exists */ }` pattern.

### E. Logging when running plaintext

```typescript
if (!encryptionKey) {
  const level = process.env.NODE_ENV === "production" ? "error" : "warn";
  audit.log(level, "IdP tokens stored plaintext at rest. Set COORDINATOR_ENCRYPTION_KEY for at-rest encryption.");
  // Schedule periodic re-log (every 24h) so plaintext state remains visible.
  setInterval(() => {
    audit.log(level, "REMINDER: COORDINATOR_ENCRYPTION_KEY is not set. IdP tokens stored plaintext.");
  }, 86_400_000).unref();
}
```

Surface in `/health/ready` payload (non-blocking):

```json
{
  "ready": true,
  "checks": { ... },
  "encryption": {
    "enabled": true,
    "key_source": "env",
    "key_fingerprint": "abc12345",
    "decrypt_failures_5m": 0
  }
}
```

Operators wanting strict mode set `COORDINATOR_ENCRYPTION_REQUIRED=true` in a v0.10.6 follow-up (out of scope for v0.10.5).

## DI wiring

### `src/auth/context.ts`

Add field:

```typescript
export interface AuthHandlerContext {
  // ... existing fields ...
  encryptionProvider: EncryptionProvider;
  encryptionKeyFingerprint: string | null;  // null when running plaintext
}
```

### `src/boot.ts` (bootPhase2)

Inject the constructed provider into the context object built around line 235.

### `src/auth/oauth-finalize.ts` — `provisionUser` signature change

Current:
```typescript
provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, idpRefreshToken?)
```

New:
```typescript
provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, encryption, idpRefreshToken?)
```

Inside `provisionUser`:
- Compute `context = { org_id: allowlistOrg.org_id, column: "idp_access_token", user_id: <user_id> }` for each token write.
- For UPDATE (returning user, line ~88-90 bind): use `encryptNullable(encryption, accessToken, ctx_a)` and same for refresh token with `ctx_r`.
- For INSERT (new user, line ~107-119 bind): same.
- Note: `user_id` is generated for new users immediately before the INSERT, so context construction is straightforward. Spec mandates that `user_id` MUST be the final value bound to the row (no post-insert rekey).

### `src/auth/refresh-rotation.ts` — read + write sites

- Line ~548 SELECT: unchanged.
- Line ~557-558 destructuring: wrap with `decryptNullable(ctx.encryptionProvider, row.idp_access_token, ctx_a)` and same for refresh.
- Line ~606-613 UPDATE: wrap binds with `encryptNullable(ctx.encryptionProvider, newAccess, ctx_a)`.
- Decrypt errors: catch `DecryptionError` (any subclass), audit `encryption.decrypt.failed` with `error_class`, treat the user as if `IdPTokenRevoked` was thrown (same audit code, same `token_epoch` bump policy, same forced-reauth response).

### All call sites of `provisionUser` — ENUMERATED

1. `src/auth/oauth-finalize.ts:107` (within `provisionUser` itself)
2. `src/auth/oauth-callback.ts:366` (browser callback path)
3. `src/auth/oauth-token.ts:229` (CLI authorization_code grant)

All three must be updated to pass `ctx.encryptionProvider` (or equivalent).

### Test fixtures (existing tests)

Existing tests that INSERT `users.idp_access_token = 'plaintext...'` directly (e.g., `tests/unit/oauth-finalize.test.ts`, `refresh-rotation-happy.test.ts`, `refresh-rotation-reuse.test.ts`, `oauth-callback-provisioning.test.ts`, `tests/perf/bench-refresh-rotation.ts`, `tests/unit/device-approve.test.ts`, `tests/unit/logout.test.ts`, `tests/integration/d1-d10-matrix.test.ts`) **continue to work unchanged**. The read path tolerates plaintext, and the lazy-migration semantics are exercised exactly by these fixtures.

New tests that need to assert on stored values should use a helper:

```typescript
// tests/helpers/idp-token.ts
export function selectIdpToken(
  db: DatabaseAdapter,
  userId: string,
  column: "idp_access_token" | "idp_refresh_token",
  provider: EncryptionProvider,
  context: EncryptionContext,
): string | null {
  const row = db.prepare(`SELECT ${column} FROM users WHERE id = ?`).get(userId) as Row;
  if (!row || row[column] === null) return null;
  return decryptNullable(provider, row[column], context);
}
```

## Migration

### Lazy migration (steady-state)

Per spec §B `decrypt()`, rows without `enc:v_:` prefix are returned as-is. On the next write to that row (oauth refresh or login), `encryptNullable` re-stores ciphertext. Over time, all active users' tokens are encrypted.

Inactive users' rows may remain plaintext indefinitely. Acceptable: those tokens may have already expired at the IdP. Operators paranoid about this run the CLI.

### CLI `mcp-coordinator encryption migrate`

```bash
# Encrypt all plaintext rows in batches.
mcp-coordinator encryption migrate [--batch-size <n>] [--force]

# Decrypt all enc:v1: rows back to plaintext (rollback / pre-rotation).
mcp-coordinator encryption migrate --direction=decrypt [--batch-size <n>] [--force]
```

Implementation:
- Reads `COORDINATOR_ENCRYPTION_KEY` from env, builds `EnvelopeEncryption`.
- Refuses to start if `getRunningCoordinatorPid()` (see `cli/server/backup.ts`) returns a PID and `--force` not passed.
- Acquires a file lock (`{data_dir}/migration.lock`, fail-if-exists) to prevent parallel migrators.
- For encrypt direction:
  - `SELECT id, primary_org_id, idp_access_token, idp_refresh_token FROM users WHERE idp_access_token NOT LIKE 'enc:v_:%' OR idp_refresh_token NOT LIKE 'enc:v_:%' ORDER BY id LIMIT ?` (batch_size).
  - For each row, build `ctx_a`, `ctx_r` from `{org_id, column, user_id}`.
  - Encrypt non-null, non-empty plaintext values.
  - UPDATE with **compare-and-swap**: `UPDATE users SET idp_access_token = ? WHERE id = ? AND idp_access_token = ?` (bind exact prior plaintext). If 0 rows affected, skip + log (live daemon raced ahead).
  - Wrap each batch in transaction.
  - Zero plaintext buffers in finally.
- For decrypt direction: reverse — decrypt `enc:v_:` rows back to plaintext, CAS on the ciphertext value.
- Exit codes (aligned with `cli/doctor.ts`): 0 = ok, 1 = warnings (some rows skipped due to CAS), 2 = fatal (key invalid, DB inaccessible, lock held).
- Final summary: rows encrypted, rows skipped (CAS), rows already encrypted, rows null.

### Mandatory backup

The encrypt-direction CLI checks for a recent backup (`{data_dir}/backups/` mtime within last 7 days) and prints a warning if none. `--force` overrides.

### Crash recovery

Per-batch transactions mean a crash leaves the DB in a consistent half-migrated state. Re-running the CLI is idempotent (CAS skips already-encrypted rows). Lock file is removed on clean exit; stale lock requires manual `rm`.

## CLI commands (namespaced under `encryption`)

Match the existing `mcp-coordinator server <subcommand>` pattern (`cli/server/{start,stop,status,logs,backup,restore}.ts`):

```bash
mcp-coordinator encryption migrate [--direction=encrypt|decrypt] [--batch-size N] [--force]
mcp-coordinator encryption verify [--samples N]      # sample N (default 10) random rows
mcp-coordinator encryption fingerprint                # prints sha256(key).slice(0,16) hex from env
```

Files:
- `cli/encryption/index.ts` — subcommand group factory.
- `cli/encryption/migrate.ts`, `cli/encryption/verify.ts`, `cli/encryption/fingerprint.ts`.

Wiring: `cli/index.ts` adds `program.addCommand(createEncryptionCommand())`.

### `verify` semantics

- Loads key from env.
- Reads `system_config.encryption.key_fingerprint`. If absent and no enc:v1: rows: exit 0 with "no encrypted rows; verify will pass on first encrypt".
- Computes current key's fingerprint. If mismatch with stored: exit 2 with explicit "DB was encrypted with fingerprint X; current env key fingerprint Y. MISMATCH."
- Samples N random rows (`ORDER BY RANDOM() LIMIT N`) with `enc:v1:` prefix.
- Attempts to decrypt each. Reports counts: `{decryptable: N, undecryptable_dek: N, undecryptable_data: N, plaintext: N, null: N}`.
- Exit 0 if all sampled enc:v1: rows decrypt successfully. Exit 2 if any fail.

### `fingerprint` semantics

- Reads `COORDINATOR_ENCRYPTION_KEY` from env (does NOT need DB).
- Decodes + length-validates.
- Prints `sha256(key).slice(0,16).toString('hex')` to stdout.
- Operators use this to compare against `system_config.encryption.key_fingerprint` or against fingerprints emitted at boot.

## Operational config

| Variable | Default | Effect |
|---|---|---|
| `COORDINATOR_ENCRYPTION_KEY` | (unset) | 64 hex / 44 base64 / 43 base64url. When unset, runs plaintext + boot warning (ERROR in prod). |
| `COORDINATOR_ALLOW_TOKEN_LOSS` | `0` | When `1` AND key unset AND encrypted rows present: NULL them + audit, instead of refusing boot. For disaster-recovery restore without original key. |
| `COORDINATOR_ALLOW_KEY_ROTATION` | `0` | When `1` AND key fingerprint differs from stored: allow boot anyway. For deliberate key rotation. |

### Daemon-spawn forwarding (CRITICAL)

`cli/server/start.ts` builds `childEnv` explicitly to avoid leaking unrelated secrets. Add:

```typescript
fwd("COORDINATOR_ENCRYPTION_KEY", process.env.COORDINATOR_ENCRYPTION_KEY);
fwd("COORDINATOR_ALLOW_TOKEN_LOSS", process.env.COORDINATOR_ALLOW_TOKEN_LOSS);
fwd("COORDINATOR_ALLOW_KEY_ROTATION", process.env.COORDINATOR_ALLOW_KEY_ROTATION);
```

Without this, `mcp-coordinator server start --daemon` runs the child without the key → silent plaintext mode.

### Docker exposure

Setting `COORDINATOR_ENCRYPTION_KEY` via `env_file` in `docker-compose.yml` exposes the value to `docker inspect <container>` (`Config.Env`). Document this in `.env.example` and `docs/onboarding-self-host.md`.

For production: mount via Docker secret (`/run/secrets/encryption_key`) and add support for `COORDINATOR_ENCRYPTION_KEY_FILE=/path` reading. Deferred to v0.10.6 unless an operator pushes for it (~10 LOC addition).

### `.env.example` updates

Both `.env.example` (repo root) and `examples/docker-compose/.env.example` add:

```bash
# Encrypt OAuth IdP tokens at rest in coordinator.db.
# Generate: openssl rand -base64 32
# Security note: env vars are visible to docker inspect. For production
# Docker deploys, mount via secret; future versions will support
# COORDINATOR_ENCRYPTION_KEY_FILE.
# COORDINATOR_ENCRYPTION_KEY=<base64 32 random bytes>
```

## Migration & rollback runbook

### v0.10.4 → v0.10.5, encryption off

No-op. Daemon boots, logs the plaintext warning at ERROR (prod) / WARN (dev), continues. No rows touched. `system_config.encryption.key_fingerprint` not written.

### v0.10.4 → v0.10.5, encryption on (new operator, fresh setup)

1. Generate key: `openssl rand -base64 32`.
2. Set `COORDINATOR_ENCRYPTION_KEY=<key>` in env / docker secret.
3. Restart daemon. Boot passes (no encrypted rows yet, key present).
4. First login writes ciphertext. First write also stores `system_config.encryption.key_fingerprint`.
5. (Optional) `mcp-coordinator encryption migrate` to encrypt existing plaintext rows in one pass.
6. (Optional) `mcp-coordinator encryption verify` to validate.

### v0.10.4 → v0.10.5, encryption on (existing deployment, lazy)

Same as fresh — existing plaintext rows are encrypted as they're touched by oauth/refresh flows. Operators wanting "everything encrypted now" run `encryption migrate`.

### Key rotation (NOT online — requires daemon stop)

This is the closest thing v0.10.5 has to rotation. Online rotation deferred to v0.10.6+.

1. Take a backup.
2. Stop daemon.
3. `mcp-coordinator encryption migrate --direction=decrypt` (with current key). All rows revert to plaintext.
4. Replace `COORDINATOR_ENCRYPTION_KEY` with new key. Delete `system_config.encryption.key_fingerprint` row (via SQL or admin tool).
5. `mcp-coordinator encryption migrate` (with new key). All rows re-encrypted with new key. Fingerprint written.
6. Start daemon.
7. `mcp-coordinator encryption verify`.

Total downtime: seconds to minutes depending on user count.

### Rollback v0.10.5 → v0.10.4

1. Stop daemon.
2. `mcp-coordinator encryption migrate --direction=decrypt`.
3. Unset `COORDINATOR_ENCRYPTION_KEY`.
4. Downgrade.

v0.10.4 does not understand `enc:v1:` rows; the decrypt-direction migration is mandatory.

### Restore from backup

1. Operator restores `coordinator.db` to new host.
2. Set `COORDINATOR_ENCRYPTION_KEY` to the key that was active at backup time (operator's responsibility to track via fingerprint in their secret manager).
3. Start daemon. Boot guard 1 passes (key present). Boot guard 2 passes (fingerprints match).
4. If wrong key: boot guard 2 fails. Operator either fixes key or sets `COORDINATOR_ALLOW_KEY_ROTATION=1` (accepts data loss for current encrypted rows).
5. If no key available: boot guard 1 fails. Operator sets `COORDINATOR_ALLOW_TOKEN_LOSS=1` (NULLs all encrypted rows).

The fingerprint check is the operator's lifeline. Document storing the fingerprint alongside the backup metadata.

## Testing

### Coverage threshold note

`vitest.config.ts` enforces 100% coverage on `src/security/*`. Add per-file threshold entries for `src/security/envelope-encryption.ts`, `src/security/encrypt-nullable.ts`, and the new error classes. CI will hard-fail without this.

### Test files (matching existing conventions)

| File | Scope |
|---|---|
| `tests/unit/envelope-encryption.test.ts` | Round-trip (plain, empty-skip-via-helper, NUL bytes, multi-KB token); wrong-key throws `DEKUnwrapFailed`; wrong-AAD throws `DataDecryptFailed`; malformed base64 throws `MalformedCiphertext`; unknown version throws `UnknownCipherVersion`; deterministic decode of fixed test vectors |
| `tests/unit/decode-master-key.test.ts` | hex/base64/base64url accepted; ambiguous strings rejected (e.g. `0123456789abcdef...` is valid hex but no other alphabet); trailing whitespace trimmed; wrong length rejected; low entropy logs warning but accepts |
| `tests/unit/encrypt-nullable.test.ts` | NULL → null, empty → null, real value → enc:v1: |
| `tests/unit/cli-encryption-migrate.test.ts` | Idempotent (re-run = no-op); mixed plaintext/encrypted rows; batching; CAS skip when concurrent write detected; lock file held → exit 2; decrypt direction round-trips; `--force` bypasses daemon-running check |
| `tests/unit/cli-encryption-verify.test.ts` | Fresh DB exit 0 ("no rows yet"); valid sample exit 0 with counts; wrong key exit 2 with fingerprint message; mixed pass/fail counts |
| `tests/unit/cli-encryption-fingerprint.test.ts` | Prints SHA-256 prefix; no DB access; fails on missing key with clear message |
| `tests/unit/boot-encryption-guards.test.ts` | Guard 1 (key absent + encrypted rows) refuses; `ALLOW_TOKEN_LOSS=1` NULLs + audits; guard 2 (fingerprint mismatch) refuses; `ALLOW_KEY_ROTATION=1` proceeds; no guards when fresh |
| `tests/unit/envelope-bun.test.ts` | Buffer.from / toString round-trip under both runtimes; same encrypt→decrypt result Node↔Bun |
| `tests/integration/oauth-finalize-encrypted.test.ts` | Full login flow with encryption on; row contains `enc:v1:`; selectIdpToken helper retrieves plaintext |
| `tests/integration/refresh-rotation-encrypted.test.ts` | Full refresh flow round-trip; decrypt failure surfaces as `IdPTokenRevoked`-equivalent path |

Test fixtures using plaintext directly are explicitly kept (exercise lazy-path).

### Bun runtime

Spec requires Bun ≥1.0.20 (confirmed base64url Buffer support). CI must run the full test suite under both Node and Bun. The `envelope-bun.test.ts` provides an additional sanity check on the encoding boundary.

## Observability

### Prom metrics (`src/observability/metrics.ts` extension)

```
coordinator_idp_encryption_enabled              gauge (0|1)
coordinator_idp_decrypt_failures_total          counter (labels: error_class)
coordinator_idp_plaintext_rows                  gauge (updated by encryption verify or sweeper, not real-time)
```

### Audit events (`src/security/audit.ts`)

```
encryption.config.loaded                  (boot, metadata: key_fingerprint, key_source: "env")
encryption.decrypt.failed                 (user_id, column, error_class)
encryption.migration.completed            (direction: encrypt|decrypt, rows_changed, rows_skipped_cas, rows_already_done)
encryption.key.rotation_begin             (old_fingerprint, new_fingerprint)
encryption.token.invalidated              (reason: key_absent_token_loss_allowed | key_rotation_no_decrypt)
```

### `/health/ready` extension

See §E (logging). The `encryption` block in the readiness payload exposes status without affecting readiness boolean in v0.10.5 (backward-compat).

### Logger redaction

Add to `src/observability/logger.ts:REDACT_PATHS`:
- `*.idp_refresh_token` (currently missing; only `*.idp_access_token` is present)

## Threat model coverage

Update `docs/security/threat-model.md`. After v0.10.5:
- ✅ **Backup theft** of `coordinator.db` → IdP tokens unreadable without key.
- ✅ **Insider direct-read** of DB file → IdP tokens unreadable.
- ✅ **Cross-row / cross-column ciphertext swap** by attacker with DB-write → fails (AAD bound to identity).
- ✅ **Silent key swap** by operator typo → boot refuses (fingerprint check).
- ✅ **Silent restore without key** → boot refuses (encrypted-rows-but-no-key check).
- ✅ **Daemon-spawn silently runs plaintext** → fixed (env forwarding).
- ⚠️ **Other plaintext columns** (file paths, plan text, audit metadata) still readable. Mitigation = OS-level encryption (operator scope).
- ⚠️ **Decrypt failure forces re-auth** can be weaponized as targeted DoS by flipping bytes in a single user's row. Mitigation = rate-limit forced re-auth per user (deferred v0.10.6).
- ❌ **Process memory dump** → out of scope (plaintext in RAM during request handling; documented).
- ❌ **Compromised master key** → all encrypted rows readable. Mitigation = secure env handling, rotate on suspected compromise.
- ❌ **Replay across timestamps** (an old ciphertext for the same user+column re-injected) → IdP refresh-token revocation is the defense, not us.
- ❌ **Operator using a passphrase as key** → soft entropy warning at load, but accepted.

## Risks accepted

- **Master key loss** = only the 2 IdP token columns become unreadable. Daemon continues; users forced re-auth.
- **No HMAC indexing** = cannot query by token value (never needed).
- **Plaintext fallback by default** = misconfigured deploy silently runs without encryption (mitigated by boot ERROR log + readiness payload).
- **No key zeroization on shutdown** (documented; v0.10.6 follow-up).
- **Nonce safety bound**: at ~2^32 wraps the random nonce collision probability becomes non-trivial. Operators must rotate master key before this point. Documented; not enforced.
- **Multi-instance with shared DB** = unsupported (single-writer constraint). Fingerprint check prevents most disasters from typo'd second instance.
- **Operator using passphrase as key** = soft warning only.

## What was cut and why

| Cut | Reason |
|---|---|
| KMS / file key sources | No buyer demand. Interface ready for future. |
| Online key rotation | Daemon-restart rotation is fine for v0.10.5 cadence. |
| Per-org DEK | Single-tenant; multi-tenant comes with Postgres in v1.x. |
| Backup encryption layer | OS-level is correct layer. |
| HMAC search columns | Never queried; method removed from `EncryptionProvider`. |
| Encrypting other columns | Separate specs per column family. |
| `MasterKeyProvider` interface | YAGNI for env-only; re-add when 2nd impl exists. |
| `--rotate --new-key=<x>` argv flag | Footgun (shell history, /proc). Future rotation uses env or stdin. |
| Bun-dedicated integration suite | Covered by unit-level `envelope-bun.test.ts` + CI matrix run of full suite |

## References

- `src/security/encryption.ts` — existing `EncryptionProvider` interface (extended in V2)
- `src/database.ts:651-660` — `users.idp_*_token` column definitions
- `src/database.ts:300-313` — `audit_log` table
- `src/auth/oauth-finalize.ts:60-119` — `provisionUser` write site
- `src/auth/oauth-callback.ts:366` — provisionUser caller (browser)
- `src/auth/oauth-token.ts:229` — provisionUser caller (CLI grant)
- `src/auth/refresh-rotation.ts:547-613` — read + write sites
- `src/auth/context.ts` — `AuthHandlerContext` (extended in V2)
- `src/boot.ts:54` — `bootPhase2` (extended in V2)
- `src/boot.ts:235` — context composition
- `cli/server/start.ts:66-91` — daemon-spawn env forwarding (extended in V2)
- `cli/server/backup.ts:115-121` — `getRunningCoordinatorPid` pattern (reused)
- `cli/doctor.ts:877-880` — CLI exit-code conventions (followed)
- `cli/rotate-jwt-secret.ts` — similar one-shot operator CLI (style template)
- `src/observability/logger.ts:11-31` — REDACT_PATHS
- `src/observability/metrics.ts` — prom registry extension point
- `vitest.config.ts:15-56` — 100% coverage thresholds for `src/security/`
- `docs/security/threat-model.md` — residual risk on IdP credentials (V2 updates this)
- `docs/onboarding-self-host.md` — operator-facing setup doc (V2 updates this)
- `docs/superpowers/specs/2026-05-11-encryption-at-rest-design.md` — whole-DB SQLCipher (deferred indefinitely)
- `docs/superpowers/working/v0.10.5-idp-encryption/round1/` — 6-reviewer audit + synthesis
