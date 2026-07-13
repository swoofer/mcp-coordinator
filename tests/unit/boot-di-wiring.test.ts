import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { bootPhase2, type BootPhase2Deps } from "../../src/boot.js";
import { FakeClock } from "../helpers/clock.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { resetPhase2Auth } from "../../src/auth.js";
import {
  initDatabase as initGlobalDatabase,
  getDb as getGlobalDb,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import { computeKeyFingerprint } from "../../src/security/master-key.js";
import type { EncryptionContext } from "../../src/security/encryption.js";
import fs from "node:fs";

/**
 * T06b: end-to-end DI wiring — verifies bootPhase2 surfaces the
 * wrapped encryption provider + key fingerprint on the
 * AuthHandlerContext, with proper behavior in both key-present and
 * key-absent (passthrough) modes.
 */

const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_INSECURE_COOKIES",
  "COORDINATOR_ALLOW_RESTORE",
  "COORDINATOR_ENCRYPTION_KEY",
];

const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";
const DATA_DIR = "data-test-boot-di-wiring";

let envSnapshot: Record<string, string | undefined>;
let db: Database.Database;
let clock: FakeClock;

function makeSynthEnv(): NodeJS.ProcessEnv {
  return {
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_JWT_SECRET: STRONG_SECRET,
    COORDINATOR_GITHUB_CLIENT_ID: "test-client-id",
    COORDINATOR_GITHUB_CLIENT_SECRET: "test-client-secret",
    COORDINATOR_PUBLIC_URL: "http://localhost:3100",
    COORDINATOR_GITHUB_ORG: "acme-di-wiring",
  } as NodeJS.ProcessEnv;
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  resetAuditQueue();
  resetPhase2Auth();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  initGlobalDatabase(DATA_DIR);
  db = getGlobalDb() as unknown as Database.Database;
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM orgs");
  db.exec("DELETE FROM system_config");

  clock = new FakeClock(1_700_000_000);
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAuditQueue();
  resetPhase2Auth();
  try {
    closeGlobalDb();
  } catch {
    /* idempotent */
  }
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {
    /* Windows EBUSY */
  }
});

const CTX: EncryptionContext = {
  org_id: "org-test",
  column: "idp_access_token",
  user_id: "user-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

describe("bootPhase2 — encryptionProvider DI wiring", () => {
  it("with COORDINATOR_ENCRYPTION_KEY set → ctx.encryptionProvider behaves as a real encryption provider (encrypt returns enc:v1:…)", () => {
    const key = randomBytes(32);
    const env = makeSynthEnv();
    env.COORDINATOR_ENCRYPTION_KEY = key.toString("base64");
    const deps: BootPhase2Deps = { env };

    const result = bootPhase2({ enabled: true, db, clock }, deps);
    expect(result).not.toBeNull();
    const ctx = result!.context;
    expect(ctx.encryptionProvider).toBeDefined();

    const ct = ctx.encryptionProvider!.encrypt("secret-plaintext", CTX);
    expect(ct.startsWith("enc:v1:")).toBe(true);

    // Round-trip via the same wrapped provider.
    const pt = ctx.encryptionProvider!.decrypt(ct, CTX);
    expect(pt).toBe("secret-plaintext");

    void result!.shutdown();
  });

  it("without COORDINATOR_ENCRYPTION_KEY → ctx.encryptionProvider behaves as passthrough (encrypt returns plaintext unchanged)", () => {
    const env = makeSynthEnv();
    // No COORDINATOR_ENCRYPTION_KEY.
    const result = bootPhase2({ enabled: true, db, clock }, { env });
    expect(result).not.toBeNull();
    const ctx = result!.context;
    expect(ctx.encryptionProvider).toBeDefined();

    const ct = ctx.encryptionProvider!.encrypt("plain-text", CTX);
    expect(ct).toBe("plain-text"); // passthrough

    void result!.shutdown();
  });

  it("ctx.encryptionKeyFingerprint matches computed fingerprint when key set; null when absent", () => {
    // With key
    const key = randomBytes(32);
    const expectedFp = computeKeyFingerprint(key);
    const envWithKey = makeSynthEnv();
    envWithKey.COORDINATOR_ENCRYPTION_KEY = key.toString("base64");

    const r1 = bootPhase2({ enabled: true, db, clock }, { env: envWithKey });
    expect(r1).not.toBeNull();
    expect(r1!.context.encryptionKeyFingerprint).toBe(expectedFp);
    void r1!.shutdown();

    // Tear down + reset between boots so the second boot starts clean.
    resetAuditQueue();
    resetPhase2Auth();
    db.exec("DELETE FROM audit_log");
    db.exec("DELETE FROM users");
    db.exec("DELETE FROM orgs");
    db.exec("DELETE FROM system_config");

    // Without key
    const envNoKey = makeSynthEnv();
    const r2 = bootPhase2({ enabled: true, db, clock }, { env: envNoKey });
    expect(r2).not.toBeNull();
    expect(r2!.context.encryptionKeyFingerprint).toBeNull();
    void r2!.shutdown();
  });
});
