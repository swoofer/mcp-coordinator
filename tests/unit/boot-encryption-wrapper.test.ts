import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { buildWrappedProvider } from "../../src/boot-encryption.js";
import {
  PassthroughEncryption,
  type EncryptionContext,
  type EncryptionProvider,
} from "../../src/security/encryption.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { computeKeyFingerprint } from "../../src/security/master-key.js";

/**
 * T06b: tests for buildWrappedProvider — verifies first-encrypt
 * fingerprint persistence + idempotency + audit emission semantics.
 */

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

const CTX: EncryptionContext = {
  org_id: "org-test",
  column: "idp_access_token",
  user_id: "user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

let db: Database.Database;
type AuditFn = (
  action: string,
  options: { tier?: 1 | 2; metadata?: Record<string, unknown> },
) => void;
let audit: AuditFn & ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = makeDb();
  audit = vi.fn() as unknown as AuditFn & ReturnType<typeof vi.fn>;
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* idempotent */
  }
});

function fingerprintRows(): Array<{ value: string }> {
  return db
    .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
    .all() as Array<{ value: string }>;
}

describe("buildWrappedProvider — first encrypt persists fingerprint", () => {
  it("first encrypt() INSERTs the fingerprint row and emits encryption.config.loaded audit exactly once", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });

    const ct = wrapped.encrypt("hello", CTX);
    expect(ct.startsWith("enc:v1:")).toBe(true);

    const rows = fingerprintRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(fp);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith("encryption.config.loaded", {
      tier: 1,
      metadata: { key_fingerprint: fp, key_source: "env" },
    });
  });

  it("subsequent encrypt() calls do NOT INSERT or audit again (idempotent)", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });

    wrapped.encrypt("one", CTX);
    wrapped.encrypt("two", CTX);
    wrapped.encrypt("three", CTX);

    const rows = fingerprintRows();
    expect(rows).toHaveLength(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("INSERT OR IGNORE: two sequential encrypts on a fresh wrapper produce exactly 1 row even if a row appears mid-flight", () => {
    // Simulate a racer that inserts the fingerprint AFTER the wrapper was
    // constructed but BEFORE the wrapper's first encrypt fires. INSERT OR
    // IGNORE must turn the wrapper's INSERT into a no-op (row count stays 1).
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });

    // Racer wins the INSERT.
    db.prepare(
      "INSERT INTO system_config (key, value) VALUES ('encryption.key_fingerprint', ?)",
    ).run(fp);

    // Wrapper's first encrypt: INSERT OR IGNORE → no new row.
    wrapped.encrypt("payload", CTX);
    wrapped.encrypt("payload2", CTX);

    const rows = fingerprintRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(fp);
    // Audit still fires once (we have no way to know we lost the race; the
    // important invariant is no DUPLICATE row, which INSERT OR IGNORE
    // guarantees).
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("decrypt() does NOT trigger fingerprint persistence (only encrypt does)", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });

    // Encrypt with the raw (un-wrapped) provider so the wrapper never sees
    // an encrypt call. Then decrypt through the wrapper.
    const ct = raw.encrypt("payload", CTX);
    const pt = wrapped.decrypt(ct, CTX);
    expect(pt).toBe("payload");

    // Wrapper.decrypt must NOT INSERT or audit.
    expect(fingerprintRows()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("keyFingerprint=null → returns rawProvider unchanged (reference equality)", () => {
    const raw: EncryptionProvider = new PassthroughEncryption();
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: null,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });
    expect(wrapped).toBe(raw);

    // Sanity: passthrough still works + nothing was persisted/audited.
    expect(wrapped.encrypt("x", CTX)).toBe("x");
    expect(fingerprintRows()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("fingerprintAlreadyPersisted=true → first encrypt does NOT INSERT (no audit either)", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    // Seed the row that's already there from a prior boot's backfill.
    db.prepare(
      "INSERT INTO system_config (key, value) VALUES ('encryption.key_fingerprint', ?)",
    ).run(fp);

    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: true,
      db,
      audit,
    });

    const ct = wrapped.encrypt("payload", CTX);
    expect(ct.startsWith("enc:v1:")).toBe(true);

    // Still exactly 1 row (the seeded one) — wrapper performed no INSERT.
    const rows = fingerprintRows();
    expect(rows).toHaveLength(1);
    // No audit fired because we already persisted in a prior boot.
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("buildWrappedProvider — wrapper is a NEW object delegating to rawProvider", () => {
  it("wrapped provider with a key is NOT reference-equal to raw provider", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });
    expect(wrapped).not.toBe(raw);
  });

  it("wrapped decrypt delegates and produces the original plaintext", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      audit,
    });
    const ct = wrapped.encrypt("round-trip-me", CTX);
    expect(wrapped.decrypt(ct, CTX)).toBe("round-trip-me");
  });

  it("audit hook is optional — wrapper works when omitted", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    const raw = new EnvelopeEncryption(key);
    const wrapped = buildWrappedProvider({
      rawProvider: raw,
      keyFingerprint: fp,
      fingerprintAlreadyPersisted: false,
      db,
      // no audit
    });
    const ct = wrapped.encrypt("ok", CTX);
    expect(ct.startsWith("enc:v1:")).toBe(true);
    expect(fingerprintRows()).toHaveLength(1);
  });
});
