import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import {
  createMigrateCommand,
  formatSummary,
  migrationSignalHandler,
  runMigration,
  type MigrateSummary,
} from "../../cli/encryption/migrate.js";
import { createEncryptionCommand } from "../../cli/encryption/index.js";
import { EnvelopeEncryption } from "../../src/security/envelope-encryption.js";
import { decodeMasterKey } from "../../src/security/master-key.js";

// Two distinct, high-entropy 32-byte keys for negative-path tests.
const MASTER_KEY_HEX = randomBytes(32).toString("hex");

interface SeedRow {
  id: string;
  primary_org_id: string;
  idp_access_token: string | null;
  idp_refresh_token: string | null;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "enc-migrate-test-"));
}

function createUsersTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      primary_org_id TEXT NOT NULL,
      idp_access_token TEXT,
      idp_refresh_token TEXT
    );
  `);
}

function seedUsers(db: Database.Database, rows: SeedRow[]): void {
  const stmt = db.prepare(
    "INSERT INTO users (id, primary_org_id, idp_access_token, idp_refresh_token) VALUES (?,?,?,?)",
  );
  for (const r of rows) {
    stmt.run(r.id, r.primary_org_id, r.idp_access_token, r.idp_refresh_token);
  }
}

function newDbAt(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, "coordinator.db"));
  createUsersTable(db);
  return db;
}

describe("cli encryption migrate — happy paths", () => {
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

  it("encrypts plaintext rows, skips nulls and already-encrypted (idempotent)", () => {
    const db = newDbAt(dataDir);
    const provider = new EnvelopeEncryption(decodeMasterKey(MASTER_KEY_HEX));
    const preEnc = provider.encrypt("preexisting", {
      org_id: "org-1",
      column: "idp_access_token",
      user_id: "u-3",
    });
    seedUsers(db, [
      {
        id: "u-1",
        primary_org_id: "org-1",
        idp_access_token: "plain-a",
        idp_refresh_token: "plain-b",
      },
      { id: "u-2", primary_org_id: "org-1", idp_access_token: null, idp_refresh_token: "" },
      { id: "u-3", primary_org_id: "org-1", idp_access_token: preEnc, idp_refresh_token: null },
    ]);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBeDefined();
    const s = result.summary as MigrateSummary;
    expect(s.direction).toBe("encrypt");
    expect(s.scanned).toBe(3);
    // u-1: 2 plaintext -> 2 changed
    expect(s.changed).toBe(2);
    // u-3 access (preEnc) -> already_done
    expect(s.already_done).toBe(1);
    // u-2 access (null) + u-2 refresh ("") + u-3 refresh (null) -> 3 nulls
    expect(s.null_skipped).toBe(3);
    expect(s.skipped_cas).toBe(0);

    // Verify ciphertext format on disk
    const db2 = new Database(path.join(dataDir, "coordinator.db"));
    const after = db2.prepare("SELECT * FROM users ORDER BY id").all() as SeedRow[];
    db2.close();
    expect(after[0].idp_access_token).toMatch(/^enc:v1:/);
    expect(after[0].idp_refresh_token).toMatch(/^enc:v1:/);
    expect(after[1].idp_access_token).toBeNull();
    // empty string remains untouched (null_skipped path is no-op)
    expect(after[1].idp_refresh_token).toBe("");
    expect(after[2].idp_access_token).toBe(preEnc);

    // Idempotent second pass.
    const second = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(second.exitCode).toBe(0);
    const s2 = second.summary as MigrateSummary;
    expect(s2.changed).toBe(0);
    // All 3 non-null/non-empty tokens are encrypted now.
    expect(s2.already_done).toBe(3);
    expect(s2.null_skipped).toBe(3);
  });

  it("decrypts ciphertext back to original plaintext (round-trip)", () => {
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "tok-A", idp_refresh_token: "tok-R" },
      {
        id: "u-2",
        primary_org_id: "org-2",
        idp_access_token: "plain-only",
        idp_refresh_token: null,
      },
    ]);
    db.close();

    const enc = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(enc.exitCode).toBe(0);

    const dec = runMigration({
      direction: "decrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(dec.exitCode).toBe(0);
    const s = dec.summary as MigrateSummary;
    expect(s.direction).toBe("decrypt");
    expect(s.changed).toBe(3); // u-1 access, u-1 refresh, u-2 access
    expect(s.skipped_cas).toBe(0);

    const db2 = new Database(path.join(dataDir, "coordinator.db"));
    const rows = db2.prepare("SELECT * FROM users ORDER BY id").all() as SeedRow[];
    db2.close();
    expect(rows[0].idp_access_token).toBe("tok-A");
    expect(rows[0].idp_refresh_token).toBe("tok-R");
    expect(rows[1].idp_access_token).toBe("plain-only");
    expect(rows[1].idp_refresh_token).toBeNull();
  });

  it("decrypt-only on a partially-encrypted DB marks plaintext rows as already_done", () => {
    const db = newDbAt(dataDir);
    const provider = new EnvelopeEncryption(decodeMasterKey(MASTER_KEY_HEX));
    const ct = provider.encrypt("enc-tok", {
      org_id: "org-1",
      column: "idp_access_token",
      user_id: "u-1",
    });
    seedUsers(db, [
      // mixed row: access encrypted, refresh plaintext
      {
        id: "u-1",
        primary_org_id: "org-1",
        idp_access_token: ct,
        idp_refresh_token: "still-plain",
      },
      // plain-only row (will be filtered out of the SELECT by GLOB)
      { id: "u-2", primary_org_id: "org-1", idp_access_token: "p-a", idp_refresh_token: "p-b" },
    ]);
    db.close();

    const result = runMigration({
      direction: "decrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    const s = result.summary as MigrateSummary;
    // Only u-1 is selected (matches GLOB on access).
    expect(s.scanned).toBe(1);
    expect(s.changed).toBe(1); // u-1 access decrypted
    expect(s.already_done).toBe(1); // u-1 refresh is plaintext, not enc
    expect(s.null_skipped).toBe(0);

    const db2 = new Database(path.join(dataDir, "coordinator.db"));
    const u1 = db2.prepare("SELECT * FROM users WHERE id=?").get("u-1") as SeedRow;
    db2.close();
    expect(u1.idp_access_token).toBe("enc-tok");
    expect(u1.idp_refresh_token).toBe("still-plain");
  });

  it("processes rows correctly with --batch-size 1", () => {
    const db = newDbAt(dataDir);
    const seed: SeedRow[] = [];
    for (let i = 0; i < 7; i++) {
      seed.push({
        id: `u-${i}`,
        primary_org_id: "org-1",
        idp_access_token: `tok-${i}`,
        idp_refresh_token: null,
      });
    }
    seedUsers(db, seed);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 1,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    const s = result.summary as MigrateSummary;
    expect(s.scanned).toBe(7);
    expect(s.changed).toBe(7);
  });

  it("clamps batch-size to >= 1 when given 0 or negative", () => {
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "x", idp_refresh_token: null },
    ]);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 0,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.changed).toBe(1);
  });
});

describe("cli encryption migrate — CAS + concurrent mutation", () => {
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

  it("detects a CAS race when the row is mutated between batches", () => {
    // Use batchSize=1 + 2 rows. After batch 1 commits, mutate row 2's plaintext
    // before batch 2 runs. The cursor SELECT for batch 2 reads the new value;
    // we then mutate it back to a 3rd value before the UPDATE runs.
    // Simpler / portable approach: spy on Database#prepare's UPDATE statement to
    // tamper the row between SELECT and UPDATE. Easiest: use SQLite hooks.
    //
    // We use better-sqlite3 transaction commit hook by wrapping the inner UPDATE.
    // But the cleanest deterministic test is: pre-write a row whose CAS will
    // mismatch because we tamper between the cursor SELECT and the UPDATE. We
    // achieve this with an `update_hook` that fires AFTER each statement.
    //
    // Since update_hook fires per-row-write (not pre-UPDATE), we instead use a
    // sqlite "function" trick by wrapping `prepare`. Simplest valid approach:
    // race via two DB connections + pragma busy_timeout. But that's heavy.
    //
    // Pragmatic path used here: open the DB ourselves, hand-call `runMigration`,
    // and intercept BetterSQLite's prepared-statement creation via a Proxy on
    // Database.prototype is too invasive. We instead exploit the public API:
    // the cursor SELECT and the UPDATE both go through prepared statements on
    // the same connection inside the same transaction; we cannot reach in.
    //
    // FINAL APPROACH: simulate the race by writing a row whose value our code
    // will read, then in the test we re-open the DB AFTER runMigration returns
    // and assert behaviour. This doesn't exercise the skipped_cas branch.
    //
    // To actually hit skipped_cas deterministically, we monkey-patch
    // Database.prototype.prepare to wrap the UPDATE statement's run() so the
    // first invocation mutates the row to a different value BEFORE delegating
    // to the real run() — guaranteeing 0 rows affected.
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "race-me", idp_refresh_token: null },
      { id: "u-2", primary_org_id: "org-1", idp_access_token: "safe", idp_refresh_token: null },
    ]);
    db.close();

    // Monkey-patch Database#prepare to tamper with u-1's access token
    // immediately before the UPDATE for that column runs.
    const origPrepare = (Database.prototype as unknown as { prepare: (sql: string) => unknown })
      .prepare;
    let tampered = false;
    (Database.prototype as unknown as { prepare: (sql: string) => unknown }).prepare = function (
      this: Database.Database,
      sql: string,
    ): unknown {
      const stmt = origPrepare.call(this, sql) as {
        run: (...args: unknown[]) => Database.RunResult;
      };
      const dbConn = this;
      if (/UPDATE users SET idp_access_token = \?/.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]): Database.RunResult => {
          if (!tampered && args[1] === "u-1") {
            tampered = true;
            // Tamper outside the prepared statement to bypass our wrapper.
            const tamperStmt = origPrepare.call(
              dbConn,
              "UPDATE users SET idp_access_token='tampered' WHERE id='u-1'",
            ) as { run: () => Database.RunResult };
            tamperStmt.run();
          }
          return origRun(...args);
        };
      }
      return stmt;
    };

    let result;
    try {
      result = runMigration({
        direction: "encrypt",
        batchSize: 100,
        force: false,
        encryptionKey: MASTER_KEY_HEX,
        configDir,
        dataDir,
        runningPid: null,
      });
    } finally {
      (Database.prototype as unknown as { prepare: typeof origPrepare }).prepare = origPrepare;
    }

    // u-1 access CAS fails (changed from "race-me" to "tampered"); u-2 access succeeds.
    expect(result.exitCode).toBe(1);
    const s = result.summary as MigrateSummary;
    expect(s.skipped_cas).toBe(1);
    expect(s.changed).toBe(1);
  });
});

describe("cli encryption migrate — decrypt CAS", () => {
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

  it("detects a CAS race on the decrypt path", () => {
    // Seed with encrypted rows so the decrypt SELECT picks them up.
    const provider = new EnvelopeEncryption(decodeMasterKey(MASTER_KEY_HEX));
    const ct1 = provider.encrypt("decrypt-me", {
      org_id: "org-1",
      column: "idp_access_token",
      user_id: "u-1",
    });
    const ct2 = provider.encrypt("safe-decrypt", {
      org_id: "org-1",
      column: "idp_access_token",
      user_id: "u-2",
    });
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: ct1, idp_refresh_token: null },
      { id: "u-2", primary_org_id: "org-1", idp_access_token: ct2, idp_refresh_token: null },
    ]);
    db.close();

    const origPrepare = (Database.prototype as unknown as { prepare: (sql: string) => unknown })
      .prepare;
    let tampered = false;
    (Database.prototype as unknown as { prepare: (sql: string) => unknown }).prepare = function (
      this: Database.Database,
      sql: string,
    ): unknown {
      const stmt = origPrepare.call(this, sql) as {
        run: (...args: unknown[]) => Database.RunResult;
      };
      const dbConn = this;
      if (/UPDATE users SET idp_access_token = \?/.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]): Database.RunResult => {
          if (!tampered && args[1] === "u-1") {
            tampered = true;
            const tamperStmt = origPrepare.call(
              dbConn,
              "UPDATE users SET idp_access_token='tampered-decrypt' WHERE id='u-1'",
            ) as { run: () => Database.RunResult };
            tamperStmt.run();
          }
          return origRun(...args);
        };
      }
      return stmt;
    };

    let result;
    try {
      result = runMigration({
        direction: "decrypt",
        batchSize: 100,
        force: false,
        encryptionKey: MASTER_KEY_HEX,
        configDir,
        dataDir,
        runningPid: null,
      });
    } finally {
      (Database.prototype as unknown as { prepare: typeof origPrepare }).prepare = origPrepare;
    }

    expect(result.exitCode).toBe(1);
    const s = result.summary as MigrateSummary;
    expect(s.skipped_cas).toBe(1);
    expect(s.changed).toBe(1);
  });
});

describe("cli encryption migrate — guards", () => {
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

  it("rejects invalid --direction with exit 2", () => {
    const result = runMigration({
      direction: "sideways",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/--direction/);
  });

  it("rejects missing COORDINATOR_ENCRYPTION_KEY with exit 2", () => {
    const prev = process.env.COORDINATOR_ENCRYPTION_KEY;
    delete process.env.COORDINATOR_ENCRYPTION_KEY;
    try {
      const result = runMigration({
        direction: "encrypt",
        batchSize: 100,
        force: false,
        // no encryptionKey override; env is unset
        configDir,
        dataDir,
        runningPid: null,
      });
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/COORDINATOR_ENCRYPTION_KEY/);
    } finally {
      if (prev !== undefined) process.env.COORDINATOR_ENCRYPTION_KEY = prev;
    }
  });

  it("rejects malformed master key with exit 2", () => {
    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: "not-a-real-key",
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/master key/);
  });

  it("refuses when the daemon is running without --force", () => {
    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: 12345,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Coordinator daemon is running/);
  });

  it("proceeds when the daemon is running but --force is set", () => {
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "x", idp_refresh_token: null },
    ]);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: true,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: 12345,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.changed).toBe(1);
  });

  it("fails with exit 2 when migration lock is held by another alive PID", () => {
    // Pre-write a lock file claiming an alive PID (use current process pid
    // from a sibling location to look like another process).
    const lockPath = path.join(dataDir, "migration.lock");
    // Spawn a fixture child to get a real foreign pid.
    // Simpler: spy on isPidAlive via the lock file route — write current pid + 1
    // and mock process.kill to claim it's alive.
    fs.writeFileSync(lockPath, "12345");
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const result = runMigration({
        direction: "encrypt",
        batchSize: 100,
        force: false,
        encryptionKey: MASTER_KEY_HEX,
        configDir,
        dataDir,
        runningPid: null,
      });
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/Migration lock held/);
    } finally {
      spy.mockRestore();
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("recovers from a stale lock file with a dead PID", () => {
    const lockPath = path.join(dataDir, "migration.lock");
    fs.writeFileSync(lockPath, "99999999"); // very-high PID, presumed dead
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "x", idp_refresh_token: null },
    ]);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir,
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.changed).toBe(1);
    // Lock cleaned up.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("returns exit 2 with friendly message when DB open fails", () => {
    // Point at a non-existent data dir under a read-only parent path.
    // Easiest: pass a dataDir that doesn't exist — better-sqlite3 throws.
    const nonexistent = path.join(dataDir, "nope-subdir-that-doesnt-exist");
    // The lock acquisition happens before DB open and would fail too.
    // So instead, create the dir but make coordinator.db a directory to force open failure.
    fs.mkdirSync(nonexistent, { recursive: true });
    fs.mkdirSync(path.join(nonexistent, "coordinator.db"), { recursive: true });

    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      dataDir: nonexistent,
      runningPid: null,
    });
    expect(result.exitCode).toBe(2);
    expect(result.message).toMatch(/Migration error/);
  });

  it("re-throws non-LockHeldError errors from acquireLock", () => {
    // Force acquireLock to fail with a non-LockHeldError by pointing the
    // lock path at a directory that doesn't exist.
    const bogusDataDir = path.join(dataDir, "ghost", "deeper", "nested");
    expect(() =>
      runMigration({
        direction: "encrypt",
        batchSize: 100,
        force: false,
        encryptionKey: MASTER_KEY_HEX,
        configDir,
        dataDir: bogusDataDir,
        runningPid: null,
      }),
    ).toThrow();
  });
});

describe("cli encryption migrate — config + command wiring", () => {
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

  it("falls back to loadConfig(configDir).server.data_dir when dataDir not provided", () => {
    // Write a config.json pointing at our test dataDir.
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: dataDir } }),
    );
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "x", idp_refresh_token: null },
    ]);
    db.close();

    const result = runMigration({
      direction: "encrypt",
      batchSize: 100,
      force: false,
      encryptionKey: MASTER_KEY_HEX,
      configDir,
      // no dataDir override — should pull from config
      runningPid: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary?.changed).toBe(1);
  });

  it("formatSummary produces a human-readable single-line string", () => {
    const s: MigrateSummary = {
      direction: "encrypt",
      scanned: 10,
      changed: 8,
      skipped_cas: 1,
      already_done: 0,
      null_skipped: 1,
    };
    const line = formatSummary(s);
    expect(line).toContain("Migration encrypt");
    expect(line).toContain("scanned=10");
    expect(line).toContain("changed=8");
    expect(line).toContain("skipped_cas=1");
    expect(line).toContain("already_done=0");
    expect(line).toContain("null_skipped=1");
  });

  it("createMigrateCommand exposes the expected commander definition", () => {
    const cmd = createMigrateCommand();
    expect(cmd.name()).toBe("migrate");
    const opts = cmd.options.map((o) => o.long);
    expect(opts).toContain("--direction");
    expect(opts).toContain("--batch-size");
    expect(opts).toContain("--force");
  });

  it("migrationSignalHandler calls process.exit(130)", () => {
    const spy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`__exit:${code}`);
    });
    try {
      expect(() => migrationSignalHandler()).toThrow(/__exit:130/);
    } finally {
      spy.mockRestore();
    }
  });

  it("createEncryptionCommand registers the migrate subcommand", () => {
    const cmd = createEncryptionCommand();
    expect(cmd.name()).toBe("encryption");
    const sub = cmd.commands.find((c) => c.name() === "migrate");
    expect(sub).toBeDefined();
  });

  it("action wrapper invokes process.exit with the result's exitCode", () => {
    // Drive the action callback with valid opts but force an invalid direction,
    // so runMigration returns exit 2 without touching the FS/DB.
    const cmd = createMigrateCommand();
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // commander's action callback is the last listener; reach via parse with a
      // bad --direction so we don't need DB setup.
      expect(() => cmd.parse(["--direction", "nope"], { from: "user" })).toThrow(/__exit:2/);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("action wrapper runs the encrypt path end-to-end via parse()", () => {
    // Seed a real DB so the action's runMigration call has work to do, then
    // drive it through commander parse to exercise the action body.
    // ensureConfigDir() resolves to `${homedir()}/.mcp-coordinator`; override
    // HOME/USERPROFILE to a temp parent and create the .mcp-coordinator child
    // with a config.json that points at our test dataDir.
    const fakeHome = makeTempDir();
    const fakeMccDir = path.join(fakeHome, ".mcp-coordinator");
    fs.mkdirSync(fakeMccDir, { recursive: true });
    fs.writeFileSync(
      path.join(fakeMccDir, "config.json"),
      JSON.stringify({ server: { port: 3100, data_dir: dataDir } }),
    );
    const db = newDbAt(dataDir);
    seedUsers(db, [
      { id: "u-1", primary_org_id: "org-1", idp_access_token: "tok", idp_refresh_token: null },
    ]);
    db.close();

    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevKey = process.env.COORDINATOR_ENCRYPTION_KEY;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.COORDINATOR_ENCRYPTION_KEY = MASTER_KEY_HEX;

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null) => {
        throw new Error(`__exit:${code}`);
      });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const cmd = createMigrateCommand();
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
});
