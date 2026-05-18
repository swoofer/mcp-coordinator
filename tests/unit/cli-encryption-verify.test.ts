import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  createVerifyCommand,
  formatVerifyResult,
  runVerify,
  type VerifyResult,
} from "../../cli/encryption/verify.js";
import { createEncryptionCommand } from "../../cli/encryption/index.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import {
  decodeMasterKey,
  computeKeyFingerprint,
} from "../../src/security/master-key.js";

const KEY_A_HEX = randomBytes(32).toString("hex");
const KEY_B_HEX = randomBytes(32).toString("hex");

interface SeedRow {
  id: string;
  primary_org_id: string;
  idp_access_token: string | null;
  idp_refresh_token: string | null;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enc-verify-test-"));
}

function newDbAt(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, "coordinator.db"));
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_org_id TEXT NOT NULL,
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

function seedUsers(db: Database.Database, rows: SeedRow[]): void {
  const stmt = db.prepare(
    "INSERT INTO users (id, primary_org_id, idp_access_token, idp_refresh_token) VALUES (?,?,?,?)",
  );
  for (const r of rows) {
    stmt.run(r.id, r.primary_org_id, r.idp_access_token, r.idp_refresh_token);
  }
}

function setStoredFingerprint(db: Database.Database, fp: string): void {
  db.prepare(
    "INSERT INTO system_config (key, value) VALUES ('encryption.key_fingerprint', ?)",
  ).run(fp);
}

describe("cli encryption verify — happy paths", () => {
  let dataDir: string;
  let configDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
    configDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("fresh DB + key set with no encrypted rows -> exit 0 (NOT 2)", () => {
    const db = newDbAt(dataDir);
    db.close();
    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.message).toMatch(/No encrypted rows present yet/);
    expect(result.storedFingerprint).toBeNull();
    expect(result.currentFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("encrypted DB + correct key -> exit 0 and decryptable count matches", () => {
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const provider = new EnvelopeEncryption(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    const ct1 = provider.encrypt("tokA", {
      org_id: "org-1",
      column: "idp_access_token",
      user_id: "u-1",
    });
    const ct2 = provider.encrypt("tokR", {
      org_id: "org-1",
      column: "idp_refresh_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: ct1, idp_refresh_token: ct2 },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.decryptable).toBe(2);
    expect(result.undecryptable_dek).toBe(0);
    expect(result.undecryptable_data).toBe(0);
    expect(result.storedFingerprint).toBe(fp);
    expect(result.currentFingerprint).toBe(fp);
    expect(result.message).toMatch(/Verification OK/);
  });

  it("stored fingerprint mismatch -> exit 2 fast-fail BEFORE sampling", () => {
    const keyA = decodeMasterKey(KEY_A_HEX);
    const providerA = new EnvelopeEncryption(keyA);
    const db = newDbAt(dataDir);
    // Store key B's fingerprint, then encrypt with key A — but verify will
    // fast-fail on fingerprint mismatch before it ever samples.
    const fpB = computeKeyFingerprint(decodeMasterKey(KEY_B_HEX));
    setStoredFingerprint(db, fpB);
    const ct = providerA.encrypt("v", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: ct, idp_refresh_token: null },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Fingerprint mismatch/);
    // No sampling occurred — counts are all zero.
    expect(result.decryptable).toBe(0);
    expect(result.undecryptable_dek).toBe(0);
  });

  it("stored fingerprint matches current but rows encrypted under another key -> dek_fail > 0, exit 2", () => {
    // Force the pathological scenario: system_config row claims our key, but
    // the actual ciphertexts were written by a different key.
    const keyA = decodeMasterKey(KEY_A_HEX);
    const fpA = computeKeyFingerprint(keyA);
    const providerB = new EnvelopeEncryption(decodeMasterKey(KEY_B_HEX));
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fpA); // lie: claim key A wrote these rows
    const ct = providerB.encrypt("tok", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: ct, idp_refresh_token: null },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.undecryptable_dek).toBeGreaterThan(0);
    expect(result.decryptable).toBe(0);
    expect(result.message).toMatch(/Verification FAILED/);
  });

  it("mixed pass/fail: corrupting the ciphertext body produces a data_fail (AAD-like mismatch)", () => {
    // The simplest way to deterministically produce a categorized failure
    // alongside a passing row is to break the AAD context (swap user_id at
    // decrypt time). But verify uses the row's actual id as user_id, so we
    // instead seed a row whose stored ciphertext was originally encrypted
    // under a DIFFERENT user_id. The wrapped-DEK unwrap will succeed (same
    // master key + nonce/tag/wrap), then the inner AES-GCM verification will
    // fail because the AAD mismatches → DataDecryptFailed.
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const provider = new EnvelopeEncryption(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    // Good row: encrypted with user_id="u-good", stored as u-good.
    const ctGood = provider.encrypt("good", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-good",
    });
    // Bad row: encrypted with user_id="u-other", but stored under id="u-bad"
    // so the AAD at decrypt time mismatches.
    const ctBad = provider.encrypt("bad", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-other",
    });
    seedUsers(db, [
      { id: "u-good", primary_org_id: "o", idp_access_token: ctGood, idp_refresh_token: null },
      { id: "u-bad", primary_org_id: "o", idp_access_token: ctBad, idp_refresh_token: null },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.undecryptable_data).toBeGreaterThanOrEqual(1);
    expect(result.decryptable).toBeGreaterThanOrEqual(1);
  });

  it("malformed enc:v ciphertext is counted as malformed", () => {
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    // enc:v0: is rejected by VERSION_RE -> MalformedCiphertext branch.
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: "enc:v0:zzz", idp_refresh_token: null },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.malformed).toBeGreaterThanOrEqual(1);
  });

  it("unknown cipher version (enc:v2:) is counted as unknown_version", () => {
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: "enc:v2:abc", idp_refresh_token: null },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(2);
    expect(result.unknown_version).toBeGreaterThanOrEqual(1);
  });

  it("custom --samples count is respected", () => {
    const key = decodeMasterKey(KEY_A_HEX);
    const provider = new EnvelopeEncryption(key);
    const db = newDbAt(dataDir);
    const rows: SeedRow[] = [];
    for (let i = 0; i < 5; i++) {
      const ct = provider.encrypt(`tok-${i}`, {
        org_id: "o",
        column: "idp_access_token",
        user_id: `u-${i}`,
      });
      rows.push({
        id: `u-${i}`,
        primary_org_id: "o",
        idp_access_token: ct,
        idp_refresh_token: null,
      });
    }
    seedUsers(db, rows);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
      samples: 2,
    });
    expect(result.exitCode).toBe(0);
    // Exactly 2 rows sampled, 1 access column each = 2 decryptable.
    expect(result.decryptable).toBe(2);
  });

  it("counts plaintext columns and nulls on a sampled row (encrypted other column)", () => {
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const provider = new EnvelopeEncryption(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    // u-1: access encrypted, refresh plaintext -> 1 decryptable + 1 plaintext.
    const ct = provider.encrypt("v", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: ct, idp_refresh_token: "still-plain" },
      // u-2: access encrypted, refresh null -> 1 decryptable + 1 null.
      {
        id: "u-2",
        primary_org_id: "o",
        idp_access_token: provider.encrypt("w", {
          org_id: "o",
          column: "idp_access_token",
          user_id: "u-2",
        }),
        idp_refresh_token: null,
      },
    ]);
    db.close();

    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.decryptable).toBe(2);
    expect(result.plaintext).toBe(1);
    expect(result.nullCount).toBe(1);
  });

  it("samples clamps to >= 1 when given 0", () => {
    const db = newDbAt(dataDir);
    db.close();
    const result = runVerify({
      encryptionKey: KEY_A_HEX,
      configDir,
      dataDir,
      samples: 0,
    });
    expect(result.exitCode).toBe(0); // empty DB
  });
});

describe("cli encryption verify — guards", () => {
  let dataDir: string;
  let configDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
    configDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("missing COORDINATOR_ENCRYPTION_KEY -> exit 2", () => {
    const prev = process.env.COORDINATOR_ENCRYPTION_KEY;
    delete process.env.COORDINATOR_ENCRYPTION_KEY;
    try {
      const result = runVerify({ configDir, dataDir });
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe("COORDINATOR_ENCRYPTION_KEY not set");
    } finally {
      if (prev !== undefined) process.env.COORDINATOR_ENCRYPTION_KEY = prev;
    }
  });

  it("malformed master key throws (decodeMasterKey)", () => {
    expect(() =>
      runVerify({ encryptionKey: "not-a-real-key", configDir, dataDir }),
    ).toThrow();
  });

  it("unrecognized decrypt errors are re-thrown (catch-all else branch)", () => {
    // Stub EnvelopeEncryption.decrypt to throw an unrelated Error so we hit
    // the `else throw err` arm of the per-column catch chain in runVerify.
    const key = decodeMasterKey(KEY_A_HEX);
    const fp = computeKeyFingerprint(key);
    const provider = new EnvelopeEncryption(key);
    const db = newDbAt(dataDir);
    setStoredFingerprint(db, fp);
    const ct = provider.encrypt("x", {
      org_id: "o",
      column: "idp_access_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      { id: "u-1", primary_org_id: "o", idp_access_token: ct, idp_refresh_token: null },
    ]);
    db.close();

    const spy = vi
      .spyOn(EnvelopeEncryption.prototype, "decrypt")
      .mockImplementation(() => {
        throw new Error("unexpected non-decryption error");
      });
    try {
      expect(() =>
        runVerify({ encryptionKey: KEY_A_HEX, configDir, dataDir }),
      ).toThrow(/unexpected non-decryption error/);
    } finally {
      spy.mockRestore();
    }
  });

  it("nonexistent dataDir surfaces a DB-open error", () => {
    const nonexistent = path.join(dataDir, "missing-subdir");
    expect(() =>
      runVerify({
        encryptionKey: KEY_A_HEX,
        configDir,
        dataDir: nonexistent,
      }),
    ).toThrow();
  });
});

describe("cli encryption verify — formatVerifyResult", () => {
  it("includes current + stored fingerprint and counts when populated", () => {
    const r: VerifyResult = {
      exitCode: 0,
      storedFingerprint: "0123456789abcdef",
      currentFingerprint: "0123456789abcdef",
      decryptable: 3,
      undecryptable_dek: 0,
      undecryptable_data: 0,
      malformed: 0,
      unknown_version: 0,
      plaintext: 1,
      nullCount: 2,
      message: "Verification OK: 3 rows decrypted, 1 plaintext, 2 null",
    };
    const out = formatVerifyResult(r);
    expect(out).toMatch(/Verification OK/);
    expect(out).toMatch(/current fingerprint:\s+0123456789abcdef/);
    expect(out).toMatch(/stored fingerprint:\s+0123456789abcdef/);
    expect(out).toMatch(/decryptable=3/);
    expect(out).toMatch(/plaintext=1/);
    expect(out).toMatch(/null=2/);
  });

  it("omits the counts line when all counts are zero (and omits stored fp when null)", () => {
    const r: VerifyResult = {
      exitCode: 2,
      storedFingerprint: null,
      currentFingerprint: "",
      decryptable: 0,
      undecryptable_dek: 0,
      undecryptable_data: 0,
      malformed: 0,
      unknown_version: 0,
      plaintext: 0,
      nullCount: 0,
      message: "COORDINATOR_ENCRYPTION_KEY not set",
    };
    const out = formatVerifyResult(r);
    expect(out).toBe("COORDINATOR_ENCRYPTION_KEY not set");
  });
});

describe("cli encryption verify — command + wiring", () => {
  let dataDir: string;
  let configDir: string;

  beforeEach(() => {
    dataDir = makeTempDir();
    configDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("createVerifyCommand exposes the expected commander definition", () => {
    const cmd = createVerifyCommand();
    expect(cmd.name()).toBe("verify");
    expect(cmd.options.map((o) => o.long)).toContain("--samples");
  });

  it("createEncryptionCommand registers the verify subcommand", () => {
    const cmd = createEncryptionCommand();
    const sub = cmd.commands.find((c) => c.name() === "verify");
    expect(sub).toBeDefined();
  });

  it("action wrapper drives the success path via parse() (writes to stdout, exit 0)", () => {
    // Seed a fresh DB so verify reports "no encrypted rows" (exit 0).
    const db = newDbAt(dataDir);
    db.close();

    const fakeHome = makeTempDir();
    const fakeMccDir = path.join(fakeHome, ".mcp-coordinator");
    fs.mkdirSync(fakeMccDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeMccDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: dataDir } }),
    );

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.COORDINATOR_ENCRYPTION_KEY = KEY_A_HEX;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);
    try {
      const cmd = createVerifyCommand();
      expect(() => cmd.parse([], { from: "user" })).toThrow(/__exit:0/);
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevKey === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
      else process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("action wrapper writes to stderr and exits 2 on a non-zero VerifyResult", () => {
    // Fresh DB but no key set -> runVerify returns exit 2 with the "not set"
    // message. This exercises the stderr branch of the action wrapper without
    // touching the DB at all (the early return precedes DB open).
    const fakeHome = makeTempDir();
    const fakeMccDir = path.join(fakeHome, ".mcp-coordinator");
    fs.mkdirSync(fakeMccDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeMccDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: dataDir } }),
    );

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    delete process.env.COORDINATOR_ENCRYPTION_KEY;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);
    try {
      const cmd = createVerifyCommand();
      expect(() => cmd.parse([], { from: "user" })).toThrow(/__exit:2/);
      const written = String(stderrSpy.mock.calls[0][0]);
      expect(written).toMatch(/COORDINATOR_ENCRYPTION_KEY not set/);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevKey !== undefined) process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("action wrapper catches thrown errors and exits 2 with 'verify error:' prefix", () => {
    // Force runVerify to throw by pointing config at a bad data dir.
    const fakeHome = makeTempDir();
    const fakeMccDir = path.join(fakeHome, ".mcp-coordinator");
    fs.mkdirSync(fakeMccDir, { recursive: true });
    const bogusDataDir = path.join(fakeHome, "no-such-dir");
    fs.writeFileSync(
      path.join(fakeMccDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: bogusDataDir } }),
    );

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.COORDINATOR_ENCRYPTION_KEY = KEY_A_HEX;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);
    try {
      const cmd = createVerifyCommand();
      expect(() => cmd.parse([], { from: "user" })).toThrow(/__exit:2/);
      const written = String(stderrSpy.mock.calls[0][0]);
      expect(written).toMatch(/^verify error:/);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevKey === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
      else process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("action wrapper clamps --samples to >= 1 (rejects 0 / negative)", () => {
    const db = newDbAt(dataDir);
    db.close();
    const fakeHome = makeTempDir();
    const fakeMccDir = path.join(fakeHome, ".mcp-coordinator");
    fs.mkdirSync(fakeMccDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeMccDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: dataDir } }),
    );

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.COORDINATOR_ENCRYPTION_KEY = KEY_A_HEX;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockReturnValue(true);
    try {
      const cmd = createVerifyCommand();
      expect(() =>
        cmd.parse(["--samples", "0"], { from: "user" }),
      ).toThrow(/__exit:0/);
      expect(stdoutSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      if (prevKey === undefined) delete process.env.COORDINATOR_ENCRYPTION_KEY;
      else process.env.COORDINATOR_ENCRYPTION_KEY = prevKey;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
