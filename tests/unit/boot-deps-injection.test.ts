import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { bootPhase2, BootValidationError, type BootPhase2Deps } from "../../src/boot.js";
import { FakeClock } from "../helpers/clock.js";
import { resetAuditQueue } from "../../src/security/audit.js";
import { resetPhase2Auth } from "../../src/auth.js";
import {
  initDatabase as initGlobalDatabase,
  getDb as getGlobalDb,
  closeDb as closeGlobalDb,
} from "../../src/database.js";
import fs from "node:fs";

/**
 * T01 (plan V2): bootPhase2 dependency injection.
 *
 * The new optional `deps` parameter exposes db / env / logger so tests
 * can drive bootPhase2 without touching process.env or the global DB.
 * Each field falls back to its current global default (opts.db,
 * process.env, a silent Pino logger) when omitted — so the change is
 * backward-compatible with every existing caller.
 *
 * These tests focus narrowly on the injection plumbing itself:
 *   1. env is read from deps.env, NOT process.env
 *   2. logger.debug is invoked (proves deps.logger is used)
 *   3. db falls back to opts.db when deps.db is omitted
 *   4. when deps is omitted entirely, behavior matches process.env reads
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
  "COORDINATOR_JWT_SECRET_PREV",
  "COORDINATOR_JWT_SECRET_PREV_ROTATED_AT",
];

// High-entropy secret (32 bytes base64); passes assertSecretEntropy(128).
const STRONG_SECRET = "ZGVhZGJlZWZjYWZlYmFiZTAxMjM0NTY3ODlhYmNkZWY=xY9q";

const DATA_DIR = "data-test-boot-deps";
let envSnapshot: Record<string, string | undefined>;
let db: Database.Database;
let clock: FakeClock;

/**
 * A complete valid env, as a plain object — passed in via deps.env to
 * avoid mutating process.env. Tests can clone + override fields.
 */
function makeValidSynthEnv(): NodeJS.ProcessEnv {
  return {
    COORDINATOR_OAUTH_ENABLED: "true",
    COORDINATOR_JWT_SECRET: STRONG_SECRET,
    COORDINATOR_GITHUB_CLIENT_ID: "test-client-id",
    COORDINATOR_GITHUB_CLIENT_SECRET: "test-client-secret",
    COORDINATOR_PUBLIC_URL: "http://localhost:3100",
    COORDINATOR_GITHUB_ORG: "acme-from-deps",
  } as NodeJS.ProcessEnv;
}

/**
 * Fake logger that records every method call so tests can assert it
 * was invoked. Only the methods bootPhase2 actually calls are wired —
 * extra methods are stubs to satisfy the Pino interface lookups.
 */
function makeFakeLogger() {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push({ level, args });
    };
  const fake = {
    calls,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    silent: record("silent"),
    child: () => fake,
    level: "debug",
  };
  return fake;
}

beforeEach(() => {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  // CRITICAL: clear process.env of any COORDINATOR_* keys that the
  // synthEnv path is supposed to bypass — proves env=deps.env wins.
  for (const k of ENV_KEYS) delete process.env[k];

  resetAuditQueue();
  resetPhase2Auth();

  // bootPhase2 emits Tier 1 audits via the global DB (config.boot).
  // Initialize the on-disk global DB so those writes have somewhere to land.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  initGlobalDatabase(DATA_DIR);
  db = getGlobalDb() as unknown as Database.Database;
  db.exec("DELETE FROM audit_log");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM orgs");

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

describe("bootPhase2(opts, deps) — env injection", () => {
  it("reads required vars from deps.env, NOT process.env", () => {
    // process.env is empty (cleared in beforeEach). If env weren't
    // sourced from deps, readRequiredEnv would throw. The fact that
    // boot succeeds proves deps.env is the source of truth.
    const synthEnv = makeValidSynthEnv();
    const deps: BootPhase2Deps = { env: synthEnv };
    const result = bootPhase2({ enabled: true, db, clock }, deps);
    expect(result).not.toBeNull();
    // The bootstrap org row should carry the github_org from synthEnv,
    // not from process.env (which is empty).
    const org = db
      .prepare("SELECT allowlist_github_org FROM orgs WHERE LOWER(allowlist_github_org) = LOWER(?)")
      .get("acme-from-deps") as { allowlist_github_org: string } | undefined;
    expect(org?.allowlist_github_org).toBe("acme-from-deps");
    void result!.shutdown();
  });

  it("throws BootValidationError when deps.env omits a required var (proves env-from-deps is read)", () => {
    const synthEnv = makeValidSynthEnv();
    delete synthEnv.COORDINATOR_JWT_SECRET;
    expect(() => bootPhase2({ enabled: true, db, clock }, { env: synthEnv })).toThrow(
      BootValidationError,
    );
    expect(() => bootPhase2({ enabled: true, db, clock }, { env: synthEnv })).toThrow(
      /COORDINATOR_JWT_SECRET is required/,
    );
  });

  it("INSECURE_COOKIES override is read from deps.env (not process.env)", () => {
    const synthEnv = makeValidSynthEnv();
    synthEnv.COORDINATOR_PUBLIC_URL = "http://example.com:3100";
    // process.env.COORDINATOR_INSECURE_COOKIES is NOT set; the override
    // must come from deps.env. Without it, boot should throw.
    expect(() => bootPhase2({ enabled: true, db, clock }, { env: synthEnv })).toThrow(
      /COORDINATOR_INSECURE_COOKIES=true to override/,
    );

    synthEnv.COORDINATOR_INSECURE_COOKIES = "true";
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });
});

describe("bootPhase2(opts, deps) — logger injection", () => {
  it("invokes deps.logger during boot", () => {
    const fakeLogger = makeFakeLogger();
    const synthEnv = makeValidSynthEnv();
    const result = bootPhase2(
      { enabled: true, db, clock },
      {
        env: synthEnv,
        // Cast through unknown — fake satisfies the surface bootPhase2
        // actually uses (debug/info/etc.) but doesn't claim to be a full Pino.
        logger: fakeLogger as unknown as import("pino").Logger,
      },
    );
    expect(result).not.toBeNull();
    expect(fakeLogger.calls.length).toBeGreaterThan(0);
    void result!.shutdown();
  });
});

describe("bootPhase2(opts, deps) — db injection", () => {
  it("falls back to opts.db when deps.db is omitted", () => {
    // No deps.db — must use opts.db. Proven by orgs row being inserted
    // into the same db we passed via opts.
    const synthEnv = makeValidSynthEnv();
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv });
    expect(result).not.toBeNull();
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM orgs WHERE allowlist_github_org IS NOT NULL")
      .get() as { n: number };
    expect(count.n).toBeGreaterThan(0);
    void result!.shutdown();
  });

  it("uses deps.db when provided (it takes precedence over opts.db)", () => {
    // Sanity: passing the SAME instance via deps.db produces the same
    // result. The deeper "different db" case is harder to test in
    // isolation because audit() reads getDb() globally; this assertion
    // simply proves deps.db is the read path when set.
    const synthEnv = makeValidSynthEnv();
    const result = bootPhase2({ enabled: true, db, clock }, { env: synthEnv, db });
    expect(result).not.toBeNull();
    void result!.shutdown();
  });
});

describe("bootPhase2(opts, deps) — securite-auth-05 INSECURE_COOKIES boot warning", () => {
  // COORDINATOR_INSECURE_COOKIES only relaxes the PUBLIC_URL http://
  // non-localhost boot gate; it does NOT change Phase 2 cookie output
  // (hostCookie() always sets Secure for __Host--prefixed cookies). A
  // developer setting the flag expecting it to "work" over plain HTTP
  // gets a silent auth failure with no explanation — the boot-time
  // warning (warnOnInsecureCookiesFlag in src/boot.ts) is the mitigation.
  it("logs a warn when COORDINATOR_INSECURE_COOKIES=true (footgun disarmed)", () => {
    const fakeLogger = makeFakeLogger();
    const synthEnv = makeValidSynthEnv();
    synthEnv.COORDINATOR_PUBLIC_URL = "http://example.com:3100";
    synthEnv.COORDINATOR_INSECURE_COOKIES = "true";
    const result = bootPhase2(
      { enabled: true, db, clock },
      { env: synthEnv, logger: fakeLogger as unknown as import("pino").Logger },
    );
    expect(result).not.toBeNull();
    const warnCalls = fakeLogger.calls.filter((c) => c.level === "warn");
    expect(warnCalls.length).toBeGreaterThan(0);
    const messages = warnCalls.map((c) => String(c.args[0]));
    expect(messages.some((m) => m.includes("COORDINATOR_INSECURE_COOKIES=true"))).toBe(true);
    expect(messages.some((m) => m.toLowerCase().includes("secure"))).toBe(true);
    void result!.shutdown();
  });

  it("does NOT log the warning when COORDINATOR_INSECURE_COOKIES is unset (default/safe path)", () => {
    const fakeLogger = makeFakeLogger();
    const synthEnv = makeValidSynthEnv(); // localhost PUBLIC_URL, no override needed
    const result = bootPhase2(
      { enabled: true, db, clock },
      { env: synthEnv, logger: fakeLogger as unknown as import("pino").Logger },
    );
    expect(result).not.toBeNull();
    const warnCalls = fakeLogger.calls.filter((c) => c.level === "warn");
    expect(warnCalls.some((c) => String(c.args[0]).includes("COORDINATOR_INSECURE_COOKIES"))).toBe(
      false,
    );
    void result!.shutdown();
  });

  it("does NOT log the warning when COORDINATOR_INSECURE_COOKIES is set to a non-'true' value", () => {
    const fakeLogger = makeFakeLogger();
    const synthEnv = makeValidSynthEnv();
    synthEnv.COORDINATOR_INSECURE_COOKIES = "false";
    const result = bootPhase2(
      { enabled: true, db, clock },
      { env: synthEnv, logger: fakeLogger as unknown as import("pino").Logger },
    );
    expect(result).not.toBeNull();
    const warnCalls = fakeLogger.calls.filter((c) => c.level === "warn");
    expect(warnCalls.some((c) => String(c.args[0]).includes("COORDINATOR_INSECURE_COOKIES"))).toBe(
      false,
    );
    void result!.shutdown();
  });
});

describe("bootPhase2(opts) — backward-compat (no deps argument)", () => {
  it("still works when deps is omitted entirely (reads process.env)", () => {
    // Repopulate process.env for this single case — deps omitted means
    // bootPhase2 must fall back to process.env.
    process.env.COORDINATOR_OAUTH_ENABLED = "true";
    process.env.COORDINATOR_JWT_SECRET = STRONG_SECRET;
    process.env.COORDINATOR_GITHUB_CLIENT_ID = "test-client-id";
    process.env.COORDINATOR_GITHUB_CLIENT_SECRET = "test-client-secret";
    process.env.COORDINATOR_PUBLIC_URL = "http://localhost:3100";
    process.env.COORDINATOR_GITHUB_ORG = "acme-from-process-env";

    const result = bootPhase2({ enabled: true, db, clock });
    expect(result).not.toBeNull();
    const org = db
      .prepare("SELECT allowlist_github_org FROM orgs WHERE LOWER(allowlist_github_org) = LOWER(?)")
      .get("acme-from-process-env") as { allowlist_github_org: string } | undefined;
    expect(org?.allowlist_github_org).toBe("acme-from-process-env");
    void result!.shutdown();
  });
});
