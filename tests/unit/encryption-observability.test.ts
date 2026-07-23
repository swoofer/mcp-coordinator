import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  buildWrappedProvider,
  runEncryptionGuards,
  type InitEncryptionDeps,
} from "../../src/boot-encryption.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { DecryptionError, type EncryptionContext } from "../../src/security/encryption.js";
import {
  encryptionEnabledGauge,
  decryptFailuresCounter,
  plaintextRowsGauge,
  registry,
  resetMetricsForTest,
} from "../../src/observability/metrics.js";
import { pseudonym } from "../../src/security/audit-pseudonym.js";
import type { Logger } from "pino";

/**
 * T12b: observability surface for IdP token encryption.
 *
 * Three concerns:
 *  1. The three new prom-client metrics exist on the registry with the
 *     declared label sets + help text.
 *  2. decryptFailuresCounter increments on a real decrypt failure
 *     (wrong-key EnvelopeEncryption.decrypt of a real ciphertext).
 *  3. encryptionEnabledGauge flips between 0 (passthrough) and 1
 *     (envelope) based on whether boot wired a master key.
 *  4. Audit emissions from boot-encryption + the migration of the
 *     inline HMAC to pseudonym() carry the correct tier + metadata
 *     shape.
 */

// ── shared fixtures ─────────────────────────────────────────────────────

const CTX: EncryptionContext = {
  org_id: "org-test",
  column: "idp_access_token",
  user_id: "user-aaaaaaaa",
};

function makeLogger(): Logger {
  const noop = (..._a: unknown[]) => {};
  const fake = {
    warn: noop,
    debug: noop,
    info: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    child: () => fake,
    level: "debug",
  };
  return fake as unknown as Logger;
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_org_id TEXT NOT NULL DEFAULT 'org-test',
      idp_access_token TEXT,
      idp_refresh_token TEXT
    );
    CREATE TABLE system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

let db: Database.Database;
let audit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetMetricsForTest();
  db = makeDb();
  audit = vi.fn();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* idempotent */
  }
});

function depsFor(env: Record<string, string | undefined>): InitEncryptionDeps {
  return {
    db,
    env: env as NodeJS.ProcessEnv,
    logger: makeLogger(),
    audit: audit as unknown as InitEncryptionDeps["audit"],
  };
}

// ── 1. Metric shape ─────────────────────────────────────────────────────

describe("observability/metrics: encryption metrics shape", () => {
  it("encryptionEnabledGauge is a Gauge with no labels", () => {
    const m = encryptionEnabledGauge as unknown as { type: string; labelNames: string[] };
    expect(m.type).toBe("gauge");
    expect(m.labelNames).toEqual([]);
  });

  it("decryptFailuresCounter is a Counter with [error_class]", () => {
    const m = decryptFailuresCounter as unknown as { type: string; labelNames: string[] };
    expect(m.type).toBe("counter");
    expect(m.labelNames).toEqual(["error_class"]);
  });

  it("plaintextRowsGauge is a Gauge with no labels", () => {
    const m = plaintextRowsGauge as unknown as { type: string; labelNames: string[] };
    expect(m.type).toBe("gauge");
    expect(m.labelNames).toEqual([]);
  });

  it("HELP + TYPE lines render in the scrape output", async () => {
    const out = await registry.metrics();
    expect(out).toContain("# HELP coordinator_idp_encryption_enabled");
    expect(out).toContain("# TYPE coordinator_idp_encryption_enabled gauge");
    expect(out).toContain("# HELP coordinator_idp_decrypt_failures_total");
    expect(out).toContain("# TYPE coordinator_idp_decrypt_failures_total counter");
    expect(out).toContain("# HELP coordinator_idp_plaintext_rows");
    expect(out).toContain("# TYPE coordinator_idp_plaintext_rows gauge");
  });
});

// ── 2. decryptFailuresCounter on real decrypt failure ───────────────────

describe("decryptFailuresCounter: real decrypt failure increments with error_class label", () => {
  it("wrong-key decrypt of a real ciphertext throws DecryptionError; counter records the error class", async () => {
    // Encrypt with one key; attempt decrypt with a different key. The DEK
    // unwrap step fails first — this exercises the real failure path.
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const encA = new EnvelopeEncryption(keyA);
    const encB = new EnvelopeEncryption(keyB);
    const ct = encA.encrypt("hello", CTX);

    let caught: unknown = null;
    try {
      encB.decrypt(ct, CTX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecryptionError);
    const errName = (caught as Error).name;

    decryptFailuresCounter.inc({ error_class: errName });

    const out = await registry.metrics();
    expect(out).toContain(`coordinator_idp_decrypt_failures_total{error_class="${errName}"} 1`);
  });

  it("counter accumulates across distinct error_class labels", async () => {
    decryptFailuresCounter.inc({ error_class: "DEKUnwrapFailed" });
    decryptFailuresCounter.inc({ error_class: "DEKUnwrapFailed" });
    decryptFailuresCounter.inc({ error_class: "UnknownCipherVersion" });

    const out = await registry.metrics();
    expect(out).toContain(
      'coordinator_idp_decrypt_failures_total{error_class="DEKUnwrapFailed"} 2',
    );
    expect(out).toContain(
      'coordinator_idp_decrypt_failures_total{error_class="UnknownCipherVersion"} 1',
    );
  });
});

// ── 3. encryptionEnabledGauge tracks boot mode ──────────────────────────

describe("encryptionEnabledGauge: reflects boot-time encryption mode", () => {
  it("envelope mode (key set) → gauge=1 after buildWrappedProvider", async () => {
    const key = randomBytes(32);
    const encInit = runEncryptionGuards(depsFor({}), key);
    buildWrappedProvider({
      rawProvider: encInit.rawProvider,
      keyFingerprint: encInit.keyFingerprint,
      fingerprintAlreadyPersisted: encInit.fingerprintAlreadyPersisted,
      db,
      audit: audit as unknown as InitEncryptionDeps["audit"],
    });

    const out = await registry.metrics();
    expect(out).toMatch(/^coordinator_idp_encryption_enabled\s+1$/m);
  });

  it("passthrough mode (no key) → gauge=0 after buildWrappedProvider", async () => {
    const encInit = runEncryptionGuards(depsFor({}), null);
    buildWrappedProvider({
      rawProvider: encInit.rawProvider,
      keyFingerprint: encInit.keyFingerprint,
      fingerprintAlreadyPersisted: encInit.fingerprintAlreadyPersisted,
      db,
      audit: audit as unknown as InitEncryptionDeps["audit"],
    });

    const out = await registry.metrics();
    expect(out).toMatch(/^coordinator_idp_encryption_enabled\s+0$/m);
  });
});

// ── 4. Audit emissions: tier + metadata shape ───────────────────────────

describe("boot-encryption audit emissions: tier + metadata shape", () => {
  it("encryption.token.invalidated carries Tier 1 + user_id_hash via pseudonym(), not user_id_prefix", () => {
    // Seed 1 encrypted row, then run guard 1 (no key + ALLOW_TOKEN_LOSS=1
    // + matching confirm) so per-user invalidated audit fires.
    db.prepare("INSERT INTO users (id, idp_access_token, idp_refresh_token) VALUES (?, ?, ?)").run(
      "user-pseudonymized",
      "enc:v1:fakeAccess",
      "enc:v1:fakeRefresh",
    );

    runEncryptionGuards(
      depsFor({
        COORDINATOR_ALLOW_TOKEN_LOSS: "1",
        COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_1_ROWS",
      }),
      null,
    );

    expect(audit).toHaveBeenCalledWith(
      "encryption.token.invalidated",
      expect.objectContaining({
        tier: 1,
        metadata: expect.objectContaining({
          user_id_hash: pseudonym("user-pseudonymized"),
          reason: "key_absent_token_loss_allowed",
        }),
      }),
    );
    // Guard against regression: the old key MUST NOT appear in metadata.
    const call = audit.mock.calls.find((c) => c[0] === "encryption.token.invalidated");
    expect(call).toBeDefined();
    const meta = (call![1] as { metadata: Record<string, unknown> }).metadata;
    expect(meta).not.toHaveProperty("user_id_prefix");
  });

  it("encryption.config.loaded fires Tier 1 with key_fingerprint + key_source='env' on first encrypt", () => {
    const key = randomBytes(32);
    const encInit = runEncryptionGuards(depsFor({}), key);
    const wrapped = buildWrappedProvider({
      rawProvider: encInit.rawProvider,
      keyFingerprint: encInit.keyFingerprint,
      fingerprintAlreadyPersisted: false,
      db,
      audit: audit as unknown as InitEncryptionDeps["audit"],
    });

    wrapped.encrypt("hello", CTX);

    expect(audit).toHaveBeenCalledWith(
      "encryption.config.loaded",
      expect.objectContaining({
        tier: 1,
        metadata: expect.objectContaining({
          key_fingerprint: encInit.keyFingerprint,
          key_source: "env",
        }),
      }),
    );
  });
});
