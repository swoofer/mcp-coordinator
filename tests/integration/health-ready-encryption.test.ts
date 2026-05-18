import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import fs from "node:fs";
import { bootPhase2 } from "../../src/boot.js";
import { FakeClock } from "../helpers/clock.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { resetPhase2Auth } from "../../src/auth.js";
import {
  initDatabase as initGlobalDatabase,
  getDb as getGlobalDb,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import { handleHealthReady } from "../../src/http/health.js";
import {
  clearEncryptionStatus,
} from "../../src/observability/encryption-status.js";
import {
  decryptFailuresCounter,
  resetMetricsForTest,
} from "../../src/observability/metrics.js";
import { makeTestEncryption } from "../helpers/encryption.js";

/**
 * T12c integration — verifies /health/ready surfaces the boot-resolved
 * encryption block (enabled, key_source, key_fingerprint,
 * decrypt_failures_total) and OMITS the block entirely when boot has not
 * run.
 *
 * Drives the real `bootPhase2` so the wiring from
 * `buildWrappedProvider` -> `setEncryptionStatus` -> `getEncryptionStatus`
 * is exercised end-to-end.
 */

const DATA_DIR = "data-test-health-ready-encryption";
// High-entropy JWT secret required by readRequiredEnv + assertSecretEntropy.
const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";

const ENV_KEYS = [
  "COORDINATOR_OAUTH_ENABLED",
  "COORDINATOR_JWT_SECRET",
  "COORDINATOR_GITHUB_CLIENT_ID",
  "COORDINATOR_GITHUB_CLIENT_SECRET",
  "COORDINATOR_PUBLIC_URL",
  "COORDINATOR_GITHUB_ORG",
  "COORDINATOR_INSECURE_COOKIES",
  "COORDINATOR_ENCRYPTION_KEY",
];

function makeSynthEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_JWT_SECRET: STRONG_SECRET,
    COORDINATOR_GITHUB_CLIENT_ID: "test-client-id",
    COORDINATOR_GITHUB_CLIENT_SECRET: "test-client-secret",
    COORDINATOR_PUBLIC_URL: "http://localhost:3100",
    COORDINATOR_GITHUB_ORG: "acme-encryption-health",
    ...extra,
  } as NodeJS.ProcessEnv;
}

interface MockResponse {
  statusCode: number | null;
  body: unknown;
  writeHead(status: number, _headers?: Record<string, string>): MockResponse;
  end(payload?: string): void;
}

function mockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: null,
    body: undefined,
    writeHead(status: number) {
      this.statusCode = status;
      return this;
    },
    end(payload?: string) {
      this.body = payload ? JSON.parse(payload) : null;
    },
  };
  return res;
}

function mockReq(): IncomingMessage {
  return {} as IncomingMessage;
}

let db: Database.Database;
let clock: FakeClock;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];

  // Make sure each test starts with no leaked status from a prior run.
  clearEncryptionStatus();
  resetAuditQueue();
  resetPhase2Auth();
  resetMetricsForTest();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  initGlobalDatabase(DATA_DIR);
  db = getGlobalDb() as unknown as Database.Database;
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM orgs");
  db.exec("DELETE FROM system_config WHERE key = 'encryption.key_fingerprint'");

  clock = new FakeClock(1_700_000_000);
});

afterEach(() => {
  for (const [k, v] of Object.entries(envSnapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearEncryptionStatus();
  resetAuditQueue();
  resetPhase2Auth();
  resetMetricsForTest();
  try { closeGlobalDb(); } catch { /* idempotent */ }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
});

describe("/health/ready encryption block — boot with key", () => {
  it("returns status: ready with encryption block populated from the resolved key", async () => {
    const { key, fingerprint } = makeTestEncryption();
    const synthEnv = makeSynthEnv({
      COORDINATOR_ENCRYPTION_KEY: key.toString("base64"),
    });
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv });
    expect(result).not.toBeNull();

    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.encryption).toEqual({
      enabled: true,
      key_source: "env",
      key_fingerprint: fingerprint,
      decrypt_failures_total: 0,
    });
    // 16-hex fingerprint sanity (computeKeyFingerprint format).
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);

    await result!.shutdown();
  });
});

describe("/health/ready encryption block — boot without key", () => {
  it("returns encryption block with enabled: false, key_source: absent, fingerprint: null", async () => {
    // No COORDINATOR_ENCRYPTION_KEY → passthrough mode.
    const synthEnv = makeSynthEnv();
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv });
    expect(result).not.toBeNull();

    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.encryption).toEqual({
      enabled: false,
      key_source: "absent",
      key_fingerprint: null,
      decrypt_failures_total: 0,
    });

    await result!.shutdown();
  });
});

describe("/health/ready encryption block — boot not run", () => {
  it("OMITS the encryption field entirely when setEncryptionStatus was never called", async () => {
    // beforeEach already called clearEncryptionStatus(); no bootPhase2 run.
    const res = mockResponse();
    await handleHealthReady(mockReq(), res as unknown as ServerResponse);
    const body = res.body as Record<string, unknown>;
    // Field must not appear at all (not undefined, not null, not {}).
    expect(Object.prototype.hasOwnProperty.call(body, "encryption")).toBe(false);
  });
});

describe("/health/ready encryption block — decrypt failures surface in counter total", () => {
  it("reflects incremented decryptFailuresCounter on subsequent /health/ready call", async () => {
    const { key } = makeTestEncryption();
    const synthEnv = makeSynthEnv({
      COORDINATOR_ENCRYPTION_KEY: key.toString("base64"),
    });
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv });
    expect(result).not.toBeNull();

    // Baseline: 0 failures.
    {
      const res = mockResponse();
      await handleHealthReady(mockReq(), res as unknown as ServerResponse);
      const body = res.body as Record<string, unknown>;
      const enc = body.encryption as Record<string, unknown>;
      expect(enc.decrypt_failures_total).toBe(0);
    }

    // Induce a decrypt failure by incrementing the counter (mirrors the
    // production catch site in src/auth/refresh-rotation.ts where a wrong-
    // key decrypt triggers `decryptFailuresCounter.inc({ error_class })`).
    decryptFailuresCounter.inc({ error_class: "DEKUnwrapFailed" });

    // Next probe surfaces the increment.
    {
      const res = mockResponse();
      await handleHealthReady(mockReq(), res as unknown as ServerResponse);
      const body = res.body as Record<string, unknown>;
      const enc = body.encryption as Record<string, unknown>;
      expect(enc.decrypt_failures_total).toBe(1);
    }

    await result!.shutdown();
  });
});
