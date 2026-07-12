import { decodeMasterKey, computeKeyFingerprint } from "./security/master-key.js";
import {
  PassthroughEncryption,
  type EncryptionProvider,
  type EncryptionContext,
} from "./security/encryption.js";
import { EnvelopeEncryption } from "./security/envelope-encryption.js";
import { pseudonym } from "./security/audit-pseudonym.js";
import { encryptionEnabledGauge } from "./observability/metrics.js";
import { setEncryptionStatus } from "./observability/encryption-status.js";
import type Database from "better-sqlite3";
import type { Logger } from "pino";

/**
 * Boot-time validation failure. Re-uses the canonical class identity exported
 * from `boot.ts` so `instanceof BootValidationError` works whether the check
 * imports from this module or from `boot.ts`. Defined here (and re-exported
 * from `boot.ts`) to avoid a circular import; `boot.ts` is the historic
 * source so we keep its public name stable.
 */
export class BootValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootValidationError";
  }
}

export interface InitEncryptionResult {
  /** EnvelopeEncryption when a key is present, PassthroughEncryption otherwise. */
  rawProvider: EncryptionProvider;
  /** 16-hex fingerprint of the master key, or null when no key. */
  keyFingerprint: string | null;
  /** True iff system_config already had a matching fingerprint row at entry. */
  fingerprintAlreadyPersisted: boolean;
}

export interface InitEncryptionDeps {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Optional audit hook — caller (boot.ts) wires the real `audit()` here. */
  audit?: (action: string, options: { tier?: 1 | 2; metadata?: Record<string, unknown> }) => void;
}

/**
 * Phase 1 — load + validate the master key from env. No DB I/O.
 *
 * Returns null when COORDINATOR_ENCRYPTION_KEY is unset/empty. Throws (via
 * decodeMasterKey) on malformed or catastrophically low-entropy keys. Low-but-
 * not-catastrophic entropy emits a warn log and returns the key anyway.
 */
export function loadEncryptionKey(env: NodeJS.ProcessEnv, logger: Logger): Buffer | null {
  const raw = env.COORDINATOR_ENCRYPTION_KEY;
  if (!raw) return null;
  return decodeMasterKey(raw, logger);
}

/**
 * Phase 2 — strict-mode guards. May throw BootValidationError; may NULL out
 * encrypted rows under COORDINATOR_ALLOW_TOKEN_LOSS=1 + confirmation token.
 *
 * Branch matrix (V2 PATCH 4):
 *   1. !enc, !key                                     → OK, Passthrough
 *   2. !enc,  key                                     → OK, Envelope
 *   3.  enc,  key, storedFP=match                     → OK, Envelope
 *   4.  enc,  key, storedFP=null                      → OK + backfill FP
 *   5.  enc, !key                                     → throw (no override)
 *   6.  enc, !key, ALLOW_TL=1, CONFIRM=wrong          → throw (mismatch)
 *   7.  enc, !key, ALLOW_TL=1, CONFIRM=correct        → NULL rows + audit
 *   8.  enc,  key, storedFP=mismatch                  → throw (no override)
 *   9.  enc,  key, storedFP=mismatch, ALLOW_KR=1      → rotation_begin audit
 */
export function runEncryptionGuards(
  deps: InitEncryptionDeps,
  key: Buffer | null,
): InitEncryptionResult {
  const { db, env, logger, audit } = deps;
  const fingerprint = key ? computeKeyFingerprint(key) : null;

  // GLOB matches enc:v[1-9]\d{0,2}:* — note SQLite GLOB uses [0-9] character
  // class (NOT POSIX [:digit:]). We intentionally accept the broader v[0-9]*
  // pattern here for detection; strict version-validity lives in
  // EnvelopeEncryption.decrypt (which is what actually has to make sense of
  // each row). Detection just needs to err on the side of "yes, encrypted".
  const hasEncryptedRows = !!db
    .prepare(
      "SELECT 1 FROM users WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*' LIMIT 1",
    )
    .get();

  const storedFingerprintRow = db
    .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
    .get() as { value: string } | undefined;
  const storedFingerprint = storedFingerprintRow?.value ?? null;

  // ── Guard 1: encrypted rows present but no key supplied. ────────────────
  if (hasEncryptedRows && !key) {
    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*'",
        )
        .get() as { n: number }
    ).n;
    const expectedConfirm = `I_UNDERSTAND_THIS_NULLS_${count}_ROWS`;
    if (env.COORDINATOR_ALLOW_TOKEN_LOSS !== "1") {
      throw new BootValidationError(
        "Database contains encrypted IdP token rows but COORDINATOR_ENCRYPTION_KEY is not set. " +
          "Either set the key, or set COORDINATOR_ALLOW_TOKEN_LOSS=1 + COORDINATOR_TOKEN_LOSS_CONFIRM=" +
          expectedConfirm +
          " to NULL the encrypted rows (users will be forced to re-authenticate). " +
          "If you restored from a backup, recover the original key first.",
      );
    }
    if (env.COORDINATOR_TOKEN_LOSS_CONFIRM !== expectedConfirm) {
      throw new BootValidationError(
        "COORDINATOR_ALLOW_TOKEN_LOSS=1 is set but COORDINATOR_TOKEN_LOSS_CONFIRM does not match the required value. " +
          `To proceed (DESTRUCTIVE), set: COORDINATOR_TOKEN_LOSS_CONFIRM=${expectedConfirm}`,
      );
    }
    // Stash-and-NULL. The encryption_invalidated_tokens table is created
    // lazily so re-runs after a previous loss event don't crash.
    db.exec(`
      CREATE TABLE IF NOT EXISTS encryption_invalidated_tokens (
        user_id TEXT NOT NULL,
        column_name TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        invalidated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reason TEXT NOT NULL,
        PRIMARY KEY (user_id, column_name, invalidated_at)
      )
    `);
    const invalidatedRows = db
      .prepare(
        "SELECT id, idp_access_token, idp_refresh_token FROM users " +
          "WHERE idp_access_token GLOB 'enc:v[0-9]*:*' OR idp_refresh_token GLOB 'enc:v[0-9]*:*'",
      )
      .all() as Array<{
      id: string;
      idp_access_token: string | null;
      idp_refresh_token: string | null;
    }>;
    const stash = db.prepare(
      "INSERT INTO encryption_invalidated_tokens (user_id, column_name, ciphertext, reason) VALUES (?, ?, ?, ?)",
    );
    const nullify = db.prepare(
      "UPDATE users SET idp_access_token = NULL, idp_refresh_token = NULL WHERE id = ?",
    );
    for (const r of invalidatedRows) {
      if (r.idp_access_token && r.idp_access_token.startsWith("enc:v")) {
        stash.run(r.id, "idp_access_token", r.idp_access_token, "key_absent_token_loss_allowed");
      }
      if (r.idp_refresh_token && r.idp_refresh_token.startsWith("enc:v")) {
        stash.run(r.id, "idp_refresh_token", r.idp_refresh_token, "key_absent_token_loss_allowed");
      }
      nullify.run(r.id);
      if (audit) {
        audit("encryption.token.invalidated", {
          tier: 1,
          metadata: {
            user_id_hash: pseudonym(r.id),
            reason: "key_absent_token_loss_allowed",
          },
        });
      }
    }
    logger.warn(
      { rows_invalidated: invalidatedRows.length },
      "COORDINATOR_ALLOW_TOKEN_LOSS=1 + confirmation matched: NULL'd encrypted IdP token rows; ciphertexts stashed in encryption_invalidated_tokens for forensic recovery.",
    );
    return {
      rawProvider: new PassthroughEncryption(),
      keyFingerprint: null,
      fingerprintAlreadyPersisted: false,
    };
  }

  // ── Guard 2: key present, encrypted rows present, fingerprint mismatch. ─
  if (hasEncryptedRows && key && storedFingerprint && storedFingerprint !== fingerprint) {
    if (env.COORDINATOR_ALLOW_KEY_ROTATION !== "1") {
      throw new BootValidationError(
        `Database was encrypted with a different key (stored fingerprint=${storedFingerprint}, current key fingerprint=${fingerprint}). ` +
          "Either restore the correct key, or set COORDINATOR_ALLOW_KEY_ROTATION=1 to begin rotation. " +
          "Existing rows encrypted with the old key will become unreadable; affected users will be forced to re-authenticate.",
      );
    }
    if (audit) {
      audit("encryption.key.rotation_begin", {
        tier: 1,
        metadata: {
          old_fingerprint: storedFingerprint,
          new_fingerprint: fingerprint,
        },
      });
    }
    db.prepare("DELETE FROM system_config WHERE key = 'encryption.key_fingerprint'").run();
    return {
      rawProvider: new EnvelopeEncryption(key),
      keyFingerprint: fingerprint,
      fingerprintAlreadyPersisted: false,
    };
  }

  // ── Guard 3: encrypted rows + key + no stored fingerprint → backfill. ───
  if (hasEncryptedRows && key && !storedFingerprint) {
    db.prepare("INSERT INTO system_config (key, value) VALUES (?, ?)").run(
      "encryption.key_fingerprint",
      fingerprint,
    );
    return {
      rawProvider: new EnvelopeEncryption(key),
      keyFingerprint: fingerprint,
      fingerprintAlreadyPersisted: true,
    };
  }

  // ── OK paths. ───────────────────────────────────────────────────────────
  if (key) {
    return {
      rawProvider: new EnvelopeEncryption(key),
      keyFingerprint: fingerprint,
      fingerprintAlreadyPersisted: !!storedFingerprint,
    };
  }
  return {
    rawProvider: new PassthroughEncryption(),
    keyFingerprint: null,
    fingerprintAlreadyPersisted: false,
  };
}

export interface BuildWrappedProviderArgs {
  rawProvider: EncryptionProvider;
  keyFingerprint: string | null;
  fingerprintAlreadyPersisted: boolean;
  db: Database.Database;
  audit?: (action: string, options: { tier?: 1 | 2; metadata?: Record<string, unknown> }) => void;
}

/**
 * T06b: Wraps a raw EncryptionProvider so the first successful encrypt() call
 * persists the key fingerprint to system_config (idempotent via INSERT OR
 * IGNORE) and emits an `encryption.config.loaded` audit (once per process).
 *
 * Behavior matrix:
 *  - keyFingerprint=null (passthrough mode) → returns rawProvider unchanged
 *    (reference equality preserved; nothing to persist).
 *  - fingerprintAlreadyPersisted=true → first encrypt() does NOT INSERT and
 *    does NOT emit audit (already done in a prior boot).
 *  - fingerprintAlreadyPersisted=false → first encrypt() INSERTs the
 *    fingerprint into system_config (INSERT OR IGNORE makes concurrent
 *    racers safe) and emits exactly one `encryption.config.loaded` audit.
 *
 * The wrapper preserves closure state for the lifetime of the process so
 * subsequent encrypt() calls never re-persist or re-audit. decrypt() is a
 * pure pass-through to the underlying provider (no persistence side-effect).
 */
export function buildWrappedProvider(args: BuildWrappedProviderArgs): EncryptionProvider {
  const { rawProvider, keyFingerprint, fingerprintAlreadyPersisted, db, audit } = args;
  // T12b: surface encryption mode as a Prometheus gauge. Set once, here,
  // because buildWrappedProvider is the single funnel both code paths go
  // through after runEncryptionGuards. 1 = EnvelopeEncryption active,
  // 0 = Passthrough (no master key).
  encryptionEnabledGauge.set(keyFingerprint ? 1 : 0);
  // T12c: publish boot-resolved encryption status to the module-level
  // accessor so /health/ready can surface it without coupling to boot.
  setEncryptionStatus({
    enabled: !!keyFingerprint,
    key_source: keyFingerprint ? "env" : "absent",
    key_fingerprint: keyFingerprint,
  });
  // Passthrough mode (no key) — no fingerprint to persist; return raw provider
  // unchanged so reference equality holds (tests rely on this).
  if (!keyFingerprint) return rawProvider;

  let persisted = fingerprintAlreadyPersisted;
  return {
    encrypt(plaintext: string, ctx: EncryptionContext): string {
      const ct = rawProvider.encrypt(plaintext, ctx);
      if (!persisted) {
        db.prepare("INSERT OR IGNORE INTO system_config (key, value) VALUES (?, ?)").run(
          "encryption.key_fingerprint",
          keyFingerprint,
        );
        persisted = true;
        if (audit) {
          audit("encryption.config.loaded", {
            tier: 1,
            metadata: { key_fingerprint: keyFingerprint, key_source: "env" },
          });
        }
      }
      return ct;
    },
    decrypt(ciphertext: string, ctx: EncryptionContext): string {
      return rawProvider.decrypt(ciphertext, ctx);
    },
  };
}

const REMINDER_INTERVAL_MS = 86_400_000; // 24h
const PLAINTEXT_MESSAGE =
  "IdP tokens stored plaintext at rest. " +
  "Set COORDINATOR_ENCRYPTION_KEY for at-rest encryption.";
const REMINDER_PREFIX =
  "REMINDER: COORDINATOR_ENCRYPTION_KEY is not set. IdP tokens stored plaintext.";

export interface PlaintextReminderArgs {
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

/**
 * T06c: If encryption is disabled (no key), log a startup warning at the
 * appropriate level (error in production, warn otherwise) and register a
 * 24h recurring reminder. Returns a teardown function that clears the
 * interval (idempotent — safe to call multiple times).
 *
 * If encryption is enabled (key present), no-op; returns a no-op teardown.
 *
 * The interval handle is `.unref()`'d so it does not keep the event loop
 * alive — tests that don't tear down explicitly won't hang.
 */
export function registerPlaintextReminder(
  args: PlaintextReminderArgs,
  key: Buffer | null,
): () => void {
  if (key) return () => {}; // encryption active; nothing to remind

  const level = args.env.NODE_ENV === "production" ? "error" : "warn";
  args.logger[level](PLAINTEXT_MESSAGE);

  const handle = setInterval(() => {
    args.logger[level](REMINDER_PREFIX);
  }, REMINDER_INTERVAL_MS);
  handle.unref();

  let cleared = false;
  return () => {
    if (cleared) return;
    clearInterval(handle);
    cleared = true;
  };
}
