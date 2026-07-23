import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import {
  loadEncryptionKey,
  runEncryptionGuards,
  BootValidationError,
  type InitEncryptionDeps,
} from "../../src/boot-encryption.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { PassthroughEncryption } from "../../src/security/encryption.js";
import { computeKeyFingerprint } from "../../src/security/master-key.js";

/**
 * T06a: 13-row branch matrix for runEncryptionGuards + loadEncryptionKey.
 * Each scenario seeds an in-memory better-sqlite3 with a minimal users +
 * system_config schema, then exercises a single branch in isolation.
 */

type FakeLogger = Logger & {
  warnCalls: Array<{ obj?: unknown; msg?: unknown }>;
  debugCalls: Array<{ obj?: unknown; msg?: unknown }>;
  infoCalls: Array<{ obj?: unknown; msg?: unknown }>;
};

function makeLogger(): FakeLogger {
  const warnCalls: Array<{ obj?: unknown; msg?: unknown }> = [];
  const debugCalls: Array<{ obj?: unknown; msg?: unknown }> = [];
  const infoCalls: Array<{ obj?: unknown; msg?: unknown }> = [];
  const noop = (..._a: unknown[]) => {};
  const fake = {
    warn: (obj?: unknown, msg?: unknown) => {
      warnCalls.push({ obj, msg });
    },
    debug: (obj?: unknown, msg?: unknown) => {
      debugCalls.push({ obj, msg });
    },
    info: (obj?: unknown, msg?: unknown) => {
      infoCalls.push({ obj, msg });
    },
    error: noop,
    fatal: noop,
    trace: noop,
    silent: noop,
    child: () => fake,
    level: "debug",
    warnCalls,
    debugCalls,
    infoCalls,
  };
  return fake as unknown as FakeLogger;
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

function seedEncryptedUsers(db: Database.Database, n = 2): void {
  // Fake ciphertext blobs — guards detect by GLOB pattern, not real crypto.
  const ins = db.prepare(
    "INSERT INTO users (id, idp_access_token, idp_refresh_token) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < n; i++) {
    ins.run(
      `user-${i.toString().padStart(8, "0")}-aaaa`,
      `enc:v1:fakeAccess${i}`,
      `enc:v1:fakeRefresh${i}`,
    );
  }
}

function seedPlaintextUser(
  db: Database.Database,
  id: string,
  orgId: string,
  accessToken: string | null,
  refreshToken: string | null,
): void {
  db.prepare(
    "INSERT INTO users (id, primary_org_id, idp_access_token, idp_refresh_token) VALUES (?, ?, ?, ?)",
  ).run(id, orgId, accessToken, refreshToken);
}

function seedFingerprint(db: Database.Database, fp: string): void {
  db.prepare("INSERT INTO system_config (key, value) VALUES ('encryption.key_fingerprint', ?)").run(
    fp,
  );
}

let db: Database.Database;
let logger: FakeLogger;
let audit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = makeDb();
  logger = makeLogger();
  audit = vi.fn();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* idempotent */
  }
});

function depsFor(env: NodeJS.ProcessEnv = {}): InitEncryptionDeps {
  return { db, env, logger, audit: audit as unknown as InitEncryptionDeps["audit"] };
}

describe("runEncryptionGuards — branch matrix", () => {
  // Row 1
  it("hasEnc=false, key=absent → OK + PassthroughEncryption", () => {
    const r = runEncryptionGuards(depsFor({}), null);
    expect(r.rawProvider).toBeInstanceOf(PassthroughEncryption);
    expect(r.keyFingerprint).toBeNull();
    expect(r.fingerprintAlreadyPersisted).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  // Row 2
  it("hasEnc=false, key=present, storedFP=null → OK + EnvelopeEncryption + fingerprint", () => {
    const key = randomBytes(32);
    const r = runEncryptionGuards(depsFor({}), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(computeKeyFingerprint(key));
    expect(r.fingerprintAlreadyPersisted).toBe(false);
  });

  // Row 3
  it("hasEnc=true, key=present, storedFP=match → OK + EnvelopeEncryption", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    seedEncryptedUsers(db);
    seedFingerprint(db, fp);
    const r = runEncryptionGuards(depsFor({}), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(fp);
    expect(r.fingerprintAlreadyPersisted).toBe(true);
    expect(audit).not.toHaveBeenCalled();
  });

  // Row 4
  it("hasEnc=true, key=present, storedFP=null → OK + backfills fingerprint", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    seedEncryptedUsers(db);
    const r = runEncryptionGuards(depsFor({}), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(fp);
    expect(r.fingerprintAlreadyPersisted).toBe(true);
    const persisted = db
      .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
      .get() as { value: string } | undefined;
    expect(persisted?.value).toBe(fp);
  });

  // Row 5
  it("hasEnc=true, key=absent, ALLOW_TL=unset → throws BootValidationError mentioning env var", () => {
    seedEncryptedUsers(db, 3);
    expect(() => runEncryptionGuards(depsFor({}), null)).toThrow(BootValidationError);
    try {
      runEncryptionGuards(depsFor({}), null);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("COORDINATOR_ENCRYPTION_KEY");
      expect(msg).toContain("COORDINATOR_ALLOW_TOKEN_LOSS=1");
      expect(msg).toContain("I_UNDERSTAND_THIS_NULLS_3_ROWS");
    }
  });

  // Row 6
  it("hasEnc=true, key=absent, ALLOW_TL=1, TL_CONFIRM=wrong → throws mentioning required confirm", () => {
    seedEncryptedUsers(db, 2);
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "WRONG_TOKEN",
    };
    expect(() => runEncryptionGuards(depsFor(env), null)).toThrow(BootValidationError);
    try {
      runEncryptionGuards(depsFor(env), null);
    } catch (e) {
      expect((e as Error).message).toContain("I_UNDERSTAND_THIS_NULLS_2_ROWS");
    }
  });

  // Row 7
  it("hasEnc=true, key=absent, ALLOW_TL=1, TL_CONFIRM=correct → NULLs rows + stashes + audits + warn log", () => {
    seedEncryptedUsers(db, 2);
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_2_ROWS",
    };
    const r = runEncryptionGuards(depsFor(env), null);
    expect(r.rawProvider).toBeInstanceOf(PassthroughEncryption);
    expect(r.keyFingerprint).toBeNull();

    // Verify NULL
    const remaining = db
      .prepare(
        "SELECT COUNT(*) AS n FROM users WHERE idp_access_token IS NOT NULL OR idp_refresh_token IS NOT NULL",
      )
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    // Verify stash table contents (2 users × 2 cols = 4 stashed rows).
    const stashCount = db
      .prepare("SELECT COUNT(*) AS n FROM encryption_invalidated_tokens")
      .get() as { n: number };
    expect(stashCount.n).toBe(4);

    // Per-user audit (one call per user).
    expect(audit).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      "encryption.token.invalidated",
      expect.objectContaining({
        tier: 1,
        metadata: expect.objectContaining({
          reason: "key_absent_token_loss_allowed",
        }),
      }),
    );

    // Warn log fired.
    expect(logger.warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(logger.warnCalls[0]?.obj).toEqual({ rows_invalidated: 2 });
  });

  // Row 8
  it("hasEnc=true, key=present, storedFP=mismatch, ALLOW_KR=unset → throws mentioning both fingerprints", () => {
    const key = randomBytes(32);
    const newFp = computeKeyFingerprint(key);
    const oldFp = "deadbeefdeadbeef";
    seedEncryptedUsers(db);
    seedFingerprint(db, oldFp);
    expect(() => runEncryptionGuards(depsFor({}), key)).toThrow(BootValidationError);
    try {
      runEncryptionGuards(depsFor({}), key);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(oldFp);
      expect(msg).toContain(newFp);
      expect(msg).toContain("COORDINATOR_ALLOW_KEY_ROTATION=1");
    }
  });

  // Row 9
  it("hasEnc=true, key=present, storedFP=mismatch, ALLOW_KR=1 → OK + rotation_begin audit + clears storedFingerprint", () => {
    const key = randomBytes(32);
    const newFp = computeKeyFingerprint(key);
    const oldFp = "deadbeefdeadbeef";
    seedEncryptedUsers(db);
    seedFingerprint(db, oldFp);
    const r = runEncryptionGuards(depsFor({ COORDINATOR_ALLOW_KEY_ROTATION: "1" }), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(newFp);
    expect(r.fingerprintAlreadyPersisted).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      "encryption.key.rotation_begin",
      expect.objectContaining({
        tier: 1,
        metadata: { old_fingerprint: oldFp, new_fingerprint: newFp },
      }),
    );

    const cleared = db
      .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
      .get();
    expect(cleared).toBeUndefined();
  });

  // ── Finding: fingerprint-mismatch detection must fire even when only
  //    plaintext rows exist (hasEncryptedRows=false). Previously the guard
  //    was gated on hasEncryptedRows, so a rotated key with no `enc:v` rows
  //    left in the table silently passed through the OK path below. ────────
  it("hasEnc=false, key=present, storedFP=mismatch, ALLOW_KR=unset → throws (plaintext-only rows)", () => {
    const key = randomBytes(32);
    const newFp = computeKeyFingerprint(key);
    const oldFp = "deadbeefdeadbeef";
    seedPlaintextUser(db, "user-plain-1", "org-a", "plain-access-token", "plain-refresh-token");
    seedFingerprint(db, oldFp);
    expect(() => runEncryptionGuards(depsFor({}), key)).toThrow(BootValidationError);
    try {
      runEncryptionGuards(depsFor({}), key);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(oldFp);
      expect(msg).toContain(newFp);
      expect(msg).toContain("COORDINATOR_ALLOW_KEY_ROTATION=1");
    }
    // No side effects from the throwing path — plaintext left untouched.
    const row = db
      .prepare("SELECT idp_access_token FROM users WHERE id = 'user-plain-1'")
      .get() as { idp_access_token: string };
    expect(row.idp_access_token).toBe("plain-access-token");
  });

  it("hasEnc=false, key=present, storedFP=mismatch, ALLOW_KR=1 → OK + rotation_begin audit + clears storedFingerprint (plaintext-only rows)", () => {
    const key = randomBytes(32);
    const newFp = computeKeyFingerprint(key);
    const oldFp = "deadbeefdeadbeef";
    seedPlaintextUser(db, "user-plain-1", "org-a", "plain-access-token", null);
    seedFingerprint(db, oldFp);
    const r = runEncryptionGuards(depsFor({ COORDINATOR_ALLOW_KEY_ROTATION: "1" }), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(newFp);
    expect(r.fingerprintAlreadyPersisted).toBe(false);

    expect(audit).toHaveBeenCalledWith(
      "encryption.key.rotation_begin",
      expect.objectContaining({
        tier: 1,
        metadata: { old_fingerprint: oldFp, new_fingerprint: newFp },
      }),
    );

    const cleared = db
      .prepare("SELECT value FROM system_config WHERE key = 'encryption.key_fingerprint'")
      .get();
    expect(cleared).toBeUndefined();
  });

  it("hasEnc=false, key=present, storedFP=match (no mismatch) → OK, no throw (regression guard)", () => {
    const key = randomBytes(32);
    const fp = computeKeyFingerprint(key);
    seedPlaintextUser(db, "user-plain-1", "org-a", null, null);
    seedFingerprint(db, fp);
    const r = runEncryptionGuards(depsFor({}), key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
    expect(r.keyFingerprint).toBe(fp);
    expect(audit).not.toHaveBeenCalled();
  });

  // ── Finding: boot does not bulk-re-encrypt pre-existing PLAINTEXT
  //    idp_*_token rows when an encryption key is set. Added a one-time,
  //    transactional, idempotent migration that runs on every successful
  //    key-present resolution. ─────────────────────────────────────────────
  describe("plaintext IdP token migration", () => {
    it("hasEnc=false, key=present (fresh key, fallthrough OK path) → plaintext rows become enc:v... and decrypt correctly", () => {
      const key = randomBytes(32);
      seedPlaintextUser(db, "user-1", "org-a", "plain-access", "plain-refresh");

      const r = runEncryptionGuards(depsFor({}), key);
      expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);

      const row = db
        .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = 'user-1'")
        .get() as { idp_access_token: string; idp_refresh_token: string };
      expect(row.idp_access_token).toMatch(/^enc:v1:/);
      expect(row.idp_refresh_token).toMatch(/^enc:v1:/);

      const provider = new EnvelopeEncryption(key);
      expect(
        provider.decrypt(row.idp_access_token, {
          org_id: "org-a",
          column: "idp_access_token",
          user_id: "user-1",
        }),
      ).toBe("plain-access");
      expect(
        provider.decrypt(row.idp_refresh_token, {
          org_id: "org-a",
          column: "idp_refresh_token",
          user_id: "user-1",
        }),
      ).toBe("plain-refresh");
    });

    it("hasEnc=true, key=present, storedFP=match (steady-state boot) → any lingering plaintext row is still migrated", () => {
      const key = randomBytes(32);
      const fp = computeKeyFingerprint(key);
      seedEncryptedUsers(db, 1); // establishes hasEncryptedRows=true
      seedFingerprint(db, fp);
      seedPlaintextUser(db, "user-straggler", "org-b", "straggler-access", null);

      runEncryptionGuards(depsFor({}), key);

      const row = db
        .prepare("SELECT idp_access_token FROM users WHERE id = 'user-straggler'")
        .get() as { idp_access_token: string };
      expect(row.idp_access_token).toMatch(/^enc:v1:/);
      const provider = new EnvelopeEncryption(key);
      expect(
        provider.decrypt(row.idp_access_token, {
          org_id: "org-b",
          column: "idp_access_token",
          user_id: "user-straggler",
        }),
      ).toBe("straggler-access");
    });

    it("hasEnc=true, key=present, storedFP=null (backfill path) → backfills fingerprint AND migrates plaintext rows", () => {
      const key = randomBytes(32);
      seedEncryptedUsers(db, 1);
      seedPlaintextUser(db, "user-mixed", "org-c", "mixed-access", "mixed-refresh");

      const r = runEncryptionGuards(depsFor({}), key);
      expect(r.fingerprintAlreadyPersisted).toBe(true);

      const row = db
        .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = 'user-mixed'")
        .get() as { idp_access_token: string; idp_refresh_token: string };
      expect(row.idp_access_token).toMatch(/^enc:v1:/);
      expect(row.idp_refresh_token).toMatch(/^enc:v1:/);
    });

    it("hasEnc=true, key=present, storedFP=mismatch, ALLOW_KR=1 (rotation) → plaintext rows migrated with the NEW key", () => {
      const key = randomBytes(32);
      seedEncryptedUsers(db, 1);
      seedFingerprint(db, "deadbeefdeadbeef");
      seedPlaintextUser(db, "user-rotated", "org-d", "rotated-access", null);

      runEncryptionGuards(depsFor({ COORDINATOR_ALLOW_KEY_ROTATION: "1" }), key);

      const row = db
        .prepare("SELECT idp_access_token FROM users WHERE id = 'user-rotated'")
        .get() as { idp_access_token: string };
      expect(row.idp_access_token).toMatch(/^enc:v1:/);
      const provider = new EnvelopeEncryption(key);
      expect(
        provider.decrypt(row.idp_access_token, {
          org_id: "org-d",
          column: "idp_access_token",
          user_id: "user-rotated",
        }),
      ).toBe("rotated-access");
    });

    it("is idempotent: a second boot with the same key does not re-touch already-migrated rows", () => {
      const key = randomBytes(32);
      seedPlaintextUser(db, "user-1", "org-a", "plain-access", null);

      runEncryptionGuards(depsFor({}), key);
      const afterFirst = db
        .prepare("SELECT idp_access_token FROM users WHERE id = 'user-1'")
        .get() as { idp_access_token: string };

      runEncryptionGuards(depsFor({}), key);
      const afterSecond = db
        .prepare("SELECT idp_access_token FROM users WHERE id = 'user-1'")
        .get() as { idp_access_token: string };

      // Ciphertext is unchanged byte-for-byte — the second run's SELECT
      // matched zero rows (already `enc:v1:`), so no re-encryption/rewrite
      // occurred (a fresh encrypt() would produce a different blob, since
      // nonces are random per call).
      expect(afterSecond.idp_access_token).toBe(afterFirst.idp_access_token);
    });

    it("leaves NULL and already-encrypted columns untouched; only migrates the plaintext column on a mixed row", () => {
      const key = randomBytes(32);
      const provider = new EnvelopeEncryption(key);
      const alreadyEnc = provider.encrypt("already-there", {
        org_id: "org-e",
        column: "idp_refresh_token",
        user_id: "user-mixed-col",
      });
      seedPlaintextUser(db, "user-mixed-col", "org-e", "needs-migration", alreadyEnc);
      seedPlaintextUser(db, "user-all-null", "org-e", null, null);

      runEncryptionGuards(depsFor({}), key);

      const mixed = db
        .prepare(
          "SELECT idp_access_token, idp_refresh_token FROM users WHERE id = 'user-mixed-col'",
        )
        .get() as { idp_access_token: string; idp_refresh_token: string };
      expect(mixed.idp_access_token).toMatch(/^enc:v1:/);
      // Refresh token untouched — same ciphertext bytes as originally encrypted.
      expect(mixed.idp_refresh_token).toBe(alreadyEnc);

      const allNull = db
        .prepare("SELECT idp_access_token, idp_refresh_token FROM users WHERE id = 'user-all-null'")
        .get() as { idp_access_token: string | null; idp_refresh_token: string | null };
      expect(allNull.idp_access_token).toBeNull();
      expect(allNull.idp_refresh_token).toBeNull();
    });

    it("migrates a refresh-only plaintext row (access_token NULL)", () => {
      const key = randomBytes(32);
      seedPlaintextUser(db, "user-refresh-only", "org-f", null, "refresh-only-plain");

      runEncryptionGuards(depsFor({}), key);

      const row = db
        .prepare(
          "SELECT idp_access_token, idp_refresh_token FROM users WHERE id = 'user-refresh-only'",
        )
        .get() as { idp_access_token: string | null; idp_refresh_token: string };
      expect(row.idp_access_token).toBeNull();
      expect(row.idp_refresh_token).toMatch(/^enc:v1:/);
      const provider = new EnvelopeEncryption(key);
      expect(
        provider.decrypt(row.idp_refresh_token, {
          org_id: "org-f",
          column: "idp_refresh_token",
          user_id: "user-refresh-only",
        }),
      ).toBe("refresh-only-plain");
    });

    it("runs inside a single transaction (all-or-nothing per boot)", () => {
      const key = randomBytes(32);
      seedPlaintextUser(db, "user-1", "org-a", "plain-1", null);
      seedPlaintextUser(db, "user-2", "org-a", "plain-2", null);

      runEncryptionGuards(depsFor({}), key);

      const rows = db.prepare("SELECT id, idp_access_token FROM users ORDER BY id").all() as Array<{
        id: string;
        idp_access_token: string;
      }>;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.idp_access_token).toMatch(/^enc:v1:/);
      }
    });
  });

  // Row 10 — low-entropy key (all 0xaa bytes → entropy = 0)
  it("low-entropy key → throws via decodeMasterKey entropy check", () => {
    const lowEntropyB64 = Buffer.alloc(32, 0xaa).toString("base64");
    expect(() => loadEncryptionKey({ COORDINATOR_ENCRYPTION_KEY: lowEntropyB64 }, logger)).toThrow(
      /catastrophically low entropy/,
    );
  });

  // Row 11 — medium-entropy key (passphrase-ish) → OK + warn
  it("medium-entropy key → loads + emits warn log", () => {
    // Engineer a 32-byte buffer with entropy in (3.0, 4.5). A repeating
    // 8-symbol alphabet across 32 bytes yields exactly 3.0 bits/byte (rejected),
    // so use ~16 distinct symbols → 4.0 bits/byte.
    const buf = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) buf[i] = i % 16;
    const b64 = buf.toString("base64");
    const k = loadEncryptionKey({ COORDINATOR_ENCRYPTION_KEY: b64 }, logger);
    expect(k).not.toBeNull();
    expect(k!.length).toBe(32);
    expect(logger.warnCalls.length).toBeGreaterThanOrEqual(1);
    const warnMsg = String(logger.warnCalls[0]?.msg ?? "");
    expect(warnMsg).toMatch(/low entropy/i);
  });

  // Row 12 — malformed key (wrong length / wrong alphabet)
  it("malformed key → throws decode error", () => {
    expect(() =>
      loadEncryptionKey({ COORDINATOR_ENCRYPTION_KEY: "not-a-real-key" }, logger),
    ).toThrow(/format unrecognized/);
  });

  // Row 13 — idempotent re-run after a previous ALLOW_TOKEN_LOSS pass
  it("ALLOW_TOKEN_LOSS run twice → second run is idempotent (no NULLs to do, no crash)", () => {
    seedEncryptedUsers(db, 1);
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_1_ROWS",
    };
    const r1 = runEncryptionGuards(depsFor(env), null);
    expect(r1.rawProvider).toBeInstanceOf(PassthroughEncryption);

    // Second run: no encrypted rows left → guard 1 should not fire; OK path.
    const r2 = runEncryptionGuards(depsFor(env), null);
    expect(r2.rawProvider).toBeInstanceOf(PassthroughEncryption);
    expect(r2.keyFingerprint).toBeNull();

    // encryption_invalidated_tokens still exists (no crash). Same row count
    // (no new rows added on the second pass).
    const stashCount = db
      .prepare("SELECT COUNT(*) AS n FROM encryption_invalidated_tokens")
      .get() as { n: number };
    expect(stashCount.n).toBe(2); // 1 user × 2 columns from the first run
  });
});

describe("loadEncryptionKey — env handling", () => {
  it("returns null when COORDINATOR_ENCRYPTION_KEY is unset", () => {
    expect(loadEncryptionKey({}, logger)).toBeNull();
  });

  it("returns null when COORDINATOR_ENCRYPTION_KEY is empty string", () => {
    expect(loadEncryptionKey({ COORDINATOR_ENCRYPTION_KEY: "" }, logger)).toBeNull();
  });

  it("returns 32-byte buffer for a valid base64 key", () => {
    const key = randomBytes(32);
    const k = loadEncryptionKey({ COORDINATOR_ENCRYPTION_KEY: key.toString("base64") }, logger);
    expect(k).not.toBeNull();
    expect(k!.length).toBe(32);
    expect(k!.equals(key)).toBe(true);
  });
});

describe("runEncryptionGuards — audit hook is optional", () => {
  it("works when audit is omitted (Guard 1 stash path)", () => {
    seedEncryptedUsers(db, 1);
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_1_ROWS",
    };
    // No audit field at all.
    const deps: InitEncryptionDeps = { db, env, logger };
    const r = runEncryptionGuards(deps, null);
    expect(r.rawProvider).toBeInstanceOf(PassthroughEncryption);
  });

  it("works when audit is omitted (Guard 2 rotation path)", () => {
    const key = randomBytes(32);
    seedEncryptedUsers(db);
    seedFingerprint(db, "deadbeefdeadbeef");
    const deps: InitEncryptionDeps = {
      db,
      env: { COORDINATOR_ALLOW_KEY_ROTATION: "1" },
      logger,
    };
    const r = runEncryptionGuards(deps, key);
    expect(r.rawProvider).toBeInstanceOf(EnvelopeEncryption);
  });
});

describe("runEncryptionGuards — Guard 1 NULL skips already-null columns", () => {
  it("only stashes columns that actually had ciphertext", () => {
    // One user with only access_token encrypted, refresh_token NULL.
    db.prepare(
      "INSERT INTO users (id, idp_access_token, idp_refresh_token) VALUES (?, ?, NULL)",
    ).run("user-only-access", "enc:v1:abc");
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_1_ROWS",
    };
    runEncryptionGuards(depsFor(env), null);
    const rows = db
      .prepare("SELECT column_name FROM encryption_invalidated_tokens")
      .all() as Array<{ column_name: string }>;
    expect(rows.map((r) => r.column_name).sort()).toEqual(["idp_access_token"]);
  });

  it("only stashes refresh_token when access_token is NULL", () => {
    db.prepare(
      "INSERT INTO users (id, idp_access_token, idp_refresh_token) VALUES (?, NULL, ?)",
    ).run("user-only-refresh", "enc:v1:xyz");
    const env = {
      COORDINATOR_ALLOW_TOKEN_LOSS: "1",
      COORDINATOR_TOKEN_LOSS_CONFIRM: "I_UNDERSTAND_THIS_NULLS_1_ROWS",
    };
    runEncryptionGuards(depsFor(env), null);
    const rows = db
      .prepare("SELECT column_name FROM encryption_invalidated_tokens")
      .all() as Array<{ column_name: string }>;
    expect(rows.map((r) => r.column_name).sort()).toEqual(["idp_refresh_token"]);
  });
});
