# Round 1 review — TypeScript / API design

**Reviewer lens**: type correctness, API ergonomics, dependency injection, ESM/CJS hygiene
**Spec under review**: docs/superpowers/specs/2026-05-17-idp-token-encryption-design.md
**Overall verdict**: NEEDS-REWRITE

The spec's pseudo-code has several issues that would not compile under the project's strict TS / Node16 module config, and the DI story for getting the provider to call sites is missing. None of the issues are deep — all fixable in a half-day rewrite of the Components section — but they have to be fixed before implementation starts, because the spec's API surface flows downstream into 7+ call sites.

## Concerns

### 1. `bootPhase2` is currently sync but spec uses `await` inside it — CRITICAL

**Description.** `src/boot.ts:54` declares `export function bootPhase2(opts: Phase2BootOptions): Phase2Bootstrap | null` — synchronous. The spec §C "Boot wiring" uses `await new EnvVarMasterKeyProvider().load()` at the call site, which only compiles if `bootPhase2` becomes `async`. Making it `async` is a breaking change to the call sites in `src/serve-http.ts:400` (`bootPhase2({...})` is currently called non-awaited and assigned directly to a typed variable), to tests that call `bootPhase2(...)`, and to the `Phase2Bootstrap | null` return type contract.

**Recommendation.** Either (a) keep `bootPhase2` sync and make the provider expose a sync `loadSync()` method for env-var sources (env reads are sync anyway — `MasterKeyProvider.load(): Promise<Buffer>` is over-engineered for v0.10.5's env-only scope), or (b) explicitly call out the `bootPhase2` signature change in the spec and add it to the "Touched files" list. Option (a) is cleaner because the interface contract reflects what it actually does today:

```typescript
export interface MasterKeyProvider {
  /** Returns the 32-byte master key. Called once at boot. Sync because
   *  env-var sources are sync; future KMS-backed impls can add a
   *  separate async variant when actually needed. */
  load(): Buffer;
}
```

Async-readiness for future KMS is a YAGNI tax we don't need to pay in v0.10.5 — the spec explicitly defers KMS to "future expansion", and changing a sync-to-async interface later is a one-line edit when the second implementation actually exists.

### 2. `require("node:crypto")` inside ESM module — CRITICAL

**Description.** Spec §B line 176: `return require("node:crypto").createHmac("sha256", this.masterKey)...`. The file already does `import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto"` at the top. `package.json` declares `"type": "module"` and `tsconfig.json` sets `"module": "Node16"` — `require` is not defined in ESM. This will throw `ReferenceError: require is not defined` at runtime on Node, and is a TS compile error under strict mode unless `@types/node` shims `require` (it does, but the runtime crash still happens). The only `require()` calls left in `src/` are the two intentional ones in `database.ts` (Bun-runtime conditional) and `logger.ts` — and those are wrapped in eval-style runtime guards specifically because static `import` of the optional dep would fail.

**Recommendation.** Add `createHmac` to the top-level import:

```typescript
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
// ...
hmac(value: string, _context: EncryptionContext): string {
  return createHmac("sha256", this.masterKey).update(value).digest("hex");
}
```

This was almost certainly a copy-paste from a CJS example. Easy fix, but a smell — suggests the spec wasn't dry-run against tsc.

### 3. `EncryptionProvider` DI path is undefined — MAJOR

**Description.** Spec §C says "Provider passed into `authContext` already built at boot. Downstream consumers receive it via existing context object." But `src/auth/context.ts` (the `AuthHandlerContext` interface) has no `encryptionProvider` field, and the spec doesn't say to add one. `oauth-finalize.ts:provisionUser` (the write site) doesn't even take a `ctx` parameter — it takes `(db, clock, idpUser, accessToken, allowlistOrg, providerName, idpRefreshToken)`. `refresh-rotation.ts` uses `ctx.db` / `ctx.providers` / `ctx.membershipCache` (so it does take ctx, but ctx doesn't have the provider). Neither call site can reach the provider as the spec describes.

**Recommendation.** Be explicit:

1. Add `encryptionProvider: EncryptionProvider` to `AuthHandlerContext` in `src/auth/context.ts`.
2. Add it to the composition in `src/boot.ts:235` (the context-build block).
3. For `provisionUser`, change the signature to `provisionUser(db, clock, idpUser, accessToken, allowlistOrg, providerName, encryption: EncryptionProvider, idpRefreshToken?)`. List the call-site updates in the spec's "Touched files" section — `provisionUser` is called from `oauth-callback.ts` and the CLI grant path (T18), both of which need updating. Don't pretend the wiring is "already there."

### 4. No typed error class for decrypt failures — MAJOR

**Description.** Existing interface contract (`src/security/encryption.ts:9`) says "Throws on wrong key / corruption." Spec §D ("Decrypt error handling") says the call site logs at ERROR, returns null, and forces re-auth. But it specifies no error *type*. `node:crypto.createDecipheriv().final()` throws a generic `Error` with message `"Unsupported state or unable to authenticate data"`. Call sites in `refresh-rotation.ts` already have a working `IdPTokenRevoked` typed-error pattern (line 599) for selective `instanceof` catches. Without a typed error, the call site has to `catch (err)` broadly, which (a) swallows unrelated errors that happen to surface inside the try block, and (b) makes the audit reason metadata generic.

**Recommendation.** Define a typed error in `src/security/encryption.ts`:

```typescript
export class DecryptionError extends Error {
  readonly cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "DecryptionError";
    this.cause = options?.cause;
  }
}
```

Wrap in `EnvelopeEncryption.decrypt`:

```typescript
try {
  // ... existing decrypt logic ...
} catch (err) {
  throw new DecryptionError(
    "Failed to decrypt: wrong master key or ciphertext tampered",
    { cause: err },
  );
}
```

Call site can then `catch (err) { if (err instanceof DecryptionError) { ... } else { throw err; } }` — same pattern as `IdPTokenRevoked`. Add `DecryptionError` to the public re-export from `src/security/encryption.ts`.

### 5. `EncryptionContext` is required but ignored — MAJOR (API ergonomics)

**Description.** Current interface forces every call site to construct `{ org_id, column }` even though v0.10.5 ignores both fields. The spec acknowledges this ("kept in the interface for future per-org/per-column key derivation"). This means:
- Every call site has to thread `org_id` through code paths that don't otherwise need it (luckily `oauth-finalize` has `allowlistOrg.org_id` and `refresh-rotation` has `row.org_id`, but `provisionUser` would need its signature changed).
- Tests have to construct dummy contexts forever.
- If a v1.x future spec changes the field set, every call site has to be touched a second time.

The "always pass `{ org_id, column }`" mandate buys exactly zero forward-compatibility because the field set itself is what would change in a future per-org-DEK design (you'd want a derived-key index, not raw org_id).

**Recommendation.** Make context optional, and let providers that need it (future) require it via their own constructor or a separate interface extension:

```typescript
export interface EncryptionProvider {
  encrypt(plaintext: string, context?: EncryptionContext): string;
  decrypt(ciphertext: string, context?: EncryptionContext): string;
  hmac(value: string, context?: EncryptionContext): string;
}
```

Call sites become `encryption.encrypt(token)` — clean. When a future per-org variant arrives, introduce `PerOrgEncryptionProvider extends EncryptionProvider` with a required-context narrower type, and the boot wiring picks the right impl. This is a smaller change today, not a bigger one tomorrow.

### 6. `master-key.ts` references undefined `decodeKey` helper — MINOR

**Description.** Spec §A line 109: `const key = decodeKey(raw);` — `decodeKey` is mentioned but never defined in the spec. It needs to: detect 64-hex vs base64 vs base64url, return a 32-byte Buffer, and reject ambiguous inputs (a 32-byte base64 string is also 44 chars including padding — can collide with 44 hex chars... actually no, hex is 0-9a-f only, base64 includes /+=, so disambiguation is by alphabet). The spec also lists "openssl rand -base64 32" as the documented format but doesn't say what happens on `openssl rand -hex 32` (64 chars) or `openssl rand -base64 32` with newline trailing. Trailing newlines from `echo $KEY` are a common operator footgun.

**Recommendation.** Define `decodeKey` in the spec:

```typescript
function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();
  // 64-char hex (case-insensitive)
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  // 32-byte base64 or base64url
  if (/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64");
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    return Buffer.from(trimmed, "base64url");
  }
  throw new Error("Master key format unrecognized (expected 64 hex chars, 44-char base64, or 43-char base64url)");
}
```

And explicitly trim. Test coverage for "trailing whitespace tolerated" should be added to §Testing.

### 7. CLI exit codes inconsistent with project conventions — MINOR

**Description.** Spec §E says `verify-encryption-key` uses 0=ok, 1=fail, 2=no encrypted rows. Project precedent in `cli/doctor.ts:877-880` uses 0=ok, 1=warnings, 2=fail. `cli/rotate-jwt-secret.ts:133-149` uses 2 for input validation errors. Spec's "2 = no rows yet (informational)" inverts the severity convention — operators monitoring exit codes in CI/cron will read `exit 2` as "fatal" and page somebody.

**Recommendation.** Realign: 0 = ok (decrypt succeeded), 1 = informational (no encrypted rows present yet — operator should run `migrate-idp-tokens` first), 2 = fatal (master key cannot decrypt existing rows — wrong key, deployment broken). This matches doctor.ts semantics where `2` = "fix this now".

### 8. Hard-coded batch size 100 — MINOR

**Description.** Spec §E `migrate-idp-tokens` says "in batches of 100" with no rationale and no override. For a deployment with 100k users (we have plausible scale claims in threat model), that's 1000 batches × ~50µs encrypt each = ~50ms work, but the SQL round-trips dominate. Operators with larger DBs may want bigger batches; CI smoke-tests on a 5-row fixture may want batch=1 to test the loop boundary.

**Recommendation.** Top-of-file `const`:

```typescript
const DEFAULT_BATCH_SIZE = 100;
// ...
.option("--batch-size <n>", "Rows per transaction (default 100)", DEFAULT_BATCH_SIZE.toString())
```

And note the default in the spec's CLI section.

### 9. `MasterKeyProvider.load()` returns raw Buffer — no zeroization story — MINOR

**Description.** The spec says "Master key in process memory" and the threat model section explicitly accepts "Process memory dump → out of scope". Fine. But returning a raw `Buffer` from `load()` means the key is in the V8 heap, garbage-collected when references drop, and *never* explicitly zeroed. Even a half-step toward defense in depth (zero on shutdown, or wrap in a `SecretKey` class with a `dispose()`) would let a future audit say "we tried." Not blocking for v0.10.5 but worth a follow-up TODO comment if not implementing now.

**Recommendation.** Either accept and add a code comment `// Master key Buffer is intentionally not zeroed; threat model §X accepts process-memory exposure`, OR introduce a thin wrapper:

```typescript
export class MasterKey {
  constructor(private buf: Buffer) {}
  unwrap(): Buffer { return this.buf; }
  dispose(): void { this.buf.fill(0); }
}
```

and have `load(): Promise<MasterKey>`. Latter is more work; former is fine for v0.10.5 — just be explicit.

### 10. Bun's Buffer base64url support — verify, don't assume — MINOR

**Description.** Project supports both Node and Bun (see `src/database.ts:320-331` Bun branch, `tests/integration/bun-encryption.test.ts` in spec §Testing). `Buffer.toString("base64url")` is Node-native since 16.x. Bun implements `Buffer` for compat but historically lagged on edge cases. The codebase already uses `"base64url"` (`src/auth/pkce.ts:7,17`), so this is *probably* fine, but the spec's Bun integration test should explicitly exercise the encode/decode round-trip — not just "did it boot."

**Recommendation.** Add to `tests/integration/bun-encryption.test.ts` (already in spec):
- assert `Buffer.from("abc", "base64url").toString("base64url") === "abc"` round-trip
- assert encrypt → string contains only `[A-Za-z0-9_-]` after `enc:v1:` prefix

If Bun's base64url is broken on the deployed version, the test catches it before users do.

### 11. `_context` underscore prefix — convention check passes — NIT

**Description.** `tsconfig.json` does NOT enable `noUnusedParameters` (strict mode does not imply it). Existing `PassthroughEncryption` already uses `_context: EncryptionContext` (`src/security/encryption.ts:16-18`). So the convention is established and the spec's pseudo-code is consistent. No change needed — flagging only to confirm.

### 12. `column` field on EncryptionContext is `string`, not literal union — NIT

**Description.** `src/security/encryption.ts:3` declares `column: string`. The two valid values today are `"idp_access_token"` and `"idp_refresh_token"`. A typed literal union would catch typos at compile time (`column: "idp_acces_token"` is a common fat-finger).

**Recommendation.** Either tighten to a union if you keep `EncryptionContext` (`column: "idp_access_token" | "idp_refresh_token"` — extend as more columns adopt the pattern), or drop the field entirely per concern #5. Don't ship `string` — it's the worst of both worlds.

### 13. `EnvelopeEncryption` constructor validation — NIT

**Description.** Spec §B line 132: `if (masterKey.length !== 32) throw new Error("master key must be 32 bytes");`. Already validated in `EnvVarMasterKeyProvider.load()` (line 110-115). Double validation isn't wrong, but the constructor's error message is less actionable than the provider's ("Use: openssl rand -base64 32"). If a third caller constructs `EnvelopeEncryption(someBuffer)` directly (a test, perhaps), the bare error message gives no hint.

**Recommendation.** Mirror the actionable message: `throw new Error("master key must be exactly 32 bytes for AES-256; got ${masterKey.length}");`. Tiny detail, free win.

### 14. Boot fallback uses comma operator in ternary — MINOR style

**Description.** Spec §C:

```typescript
const encryptionProvider: EncryptionProvider = process.env.COORDINATOR_ENCRYPTION_KEY
  ? new EnvelopeEncryption(await new EnvVarMasterKeyProvider().load())
  : (logger.warn("..."), new PassthroughEncryption());
```

The `(logger.warn(...), new PassthroughEncryption())` comma-operator trick works but is unusual in this codebase — `boot.ts` consistently uses if/else statements with explicit early returns / throws. Strict mode + `noImplicitAny` is fine with this, but it's hostile to readers and to grep.

**Recommendation.**

```typescript
let encryptionProvider: EncryptionProvider;
if (process.env.COORDINATOR_ENCRYPTION_KEY) {
  const masterKey = new EnvVarMasterKeyProvider().load();  // sync per concern #1
  encryptionProvider = new EnvelopeEncryption(masterKey);
} else {
  logger.warn(
    "IdP tokens stored plaintext. Set COORDINATOR_ENCRYPTION_KEY for at-rest encryption.",
  );
  encryptionProvider = new PassthroughEncryption();
}
```

Matches the surrounding style in `boot.ts` (e.g. the Google/OIDC provider opt-in blocks at lines 130-227).

### 15. `decipher.update(...)` typing without input encoding — NIT

**Description.** Spec §B line 167: `Buffer.concat([decipherDek.update(wrappedDek), decipherDek.final()])`. When `decipher.update()` is called with a `Buffer` (no encoding arg), it returns `Buffer`. When called with a `string` (no encoding), TS infers `string`. Mixing in the same expression can confuse strict-mode type narrowing on `Buffer.concat`. The spec's code happens to be correct (all inputs are Buffers), but the variance is fragile. Future maintainer "helpfully" passes a string-encoded ciphertext and the types still compile but `Buffer.concat([string, Buffer])` throws at runtime.

**Recommendation.** Either explicit casts `Buffer.concat([decipherDek.update(wrappedDek) as Buffer, decipherDek.final()])`, or — better — add a unit test that round-trips a binary value containing 0x00 bytes mid-string to prove the encoding path is correct end-to-end. The latter has more value.
