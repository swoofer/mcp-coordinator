import type Database from "better-sqlite3";
import { assertSecretEntropy } from "./auth/entropy.js";
import { deriveStateBindingKey } from "./auth/crypto-keys.js";
import { buildJwtKeyRegistry } from "./auth/jwt-keys.js";
import { GitHubProvider } from "./auth/providers/github.js";
import { MembershipCache } from "./auth/membership-cache.js";
import { RateLimiter } from "./auth/rate-limit.js";
import { initAuditQueue, getAuditQueue, audit } from "./security/audit.js";
import { initPhase2Auth } from "./auth.js";
import { bumpTokenEpochAllUsers } from "./auth/token-epoch.js";
import { realClock, type Clock } from "./auth/clock.js";
import { Sweeper } from "./sweeper/index.js";
import type { AuthHandlerContext } from "./auth/context.js";

// T29: Phase 2 boot. This module is the integration glue that activates
// Phase 2 features on the live HTTP server. It is the ONLY module (besides
// org-settings.ts shim and cookies.ts pre-shim escape hatch) allowed to read
// process.env.COORDINATOR_* directly — that's its job, and the lint allowlist
// reflects that (see scripts/lint-no-direct-env-in-auth.sh).
//
// Refs: V3 §4 env list, V4 §16.3 (NR12 restore detection), V3 §B-NEW-4
// (bootstrap org row).

export interface Phase2BootOptions {
  /** When false (default), Phase 2 is not initialized; bootPhase2 returns null. */
  enabled: boolean;
  db: Database.Database;
  clock?: Clock;
}

export interface Phase2Bootstrap {
  context: AuthHandlerContext;
  sweeper: Sweeper;
  shutdown: () => Promise<void>;
}

const MIN_JWT_SECRET_BITS = 128;
const RESTORE_DETECTION_STALE_THRESHOLD_S = 300; // 5 minutes
const DRAIN_TIMEOUT_MS = 5000;

/**
 * Phase 2 boot. Returns null if COORDINATOR_OAUTH_ENABLED != "true" (Phase 1
 * compatibility). On enabled-true, validates env, composes ServerContext,
 * runs NR12 restore detection, starts sweeper, wires audit queue +
 * authenticateRequest cookie path.
 *
 * Throws on validation failure — boot must NOT silently activate with
 * weak/missing secrets.
 */
export function bootPhase2(opts: Phase2BootOptions): Phase2Bootstrap | null {
  if (!opts.enabled) return null;

  const clock = opts.clock ?? realClock;
  const db = opts.db;

  // 1. Required env vars (V3 §4).
  const jwtSecret = readRequiredEnv("COORDINATOR_JWT_SECRET");
  const githubClientId = readRequiredEnv("COORDINATOR_GITHUB_CLIENT_ID");
  const githubClientSecret = readRequiredEnv("COORDINATOR_GITHUB_CLIENT_SECRET");
  const publicUrl = readRequiredEnv("COORDINATOR_PUBLIC_URL");
  const githubOrg = readRequiredEnv("COORDINATOR_GITHUB_ORG");

  // 2. Validate PUBLIC_URL format. http:// non-localhost requires an explicit
  //    COORDINATOR_INSECURE_COOKIES=true override since the Secure flag is
  //    dropped — see V3 §4.2 and src/auth/cookies.ts.
  validatePublicUrl(publicUrl);

  // 3. Validate JWT secret entropy (T08b assertSecretEntropy).
  const secretBuf = Buffer.from(jwtSecret, "utf8");
  assertSecretEntropy(secretBuf, MIN_JWT_SECRET_BITS);

  // 4. Bootstrap orgs row if needed (V3 §B-NEW-4 — Phase 5 readiness).
  ensureBootstrapOrg(db, githubOrg);

  // 5. NR12 restore detection — refuse boot if audit_log is more than
  //    5 minutes stale relative to wall clock, unless explicitly overridden.
  performRestoreCheck(db, clock);

  // 6. Compose Phase 2 components.
  const stateBindingKey = deriveStateBindingKey(secretBuf);
  const signingKeys = buildJwtKeyRegistry(secretBuf);
  const rateLimiter = new RateLimiter(clock);
  const membershipCache = new MembershipCache(clock);
  const githubProvider = new GitHubProvider({
    clientId: githubClientId,
    clientSecret: githubClientSecret,
  });

  // 7. Initialize audit queue (Tier 2 buffered writes; T11b).
  initAuditQueue(db);

  // 8. Wire authenticateRequest cookie path (Scenario 5, spec §9.5).
  initPhase2Auth({ db, signingKeys, publicUrl });

  // 9. Compose AuthHandlerContext for dispatchAuthRoutes.
  const context: AuthHandlerContext = {
    db,
    clock,
    githubProvider,
    rateLimiter,
    publicUrl,
    stateBindingKey,
    signingKeys,
    membershipCache,
  };

  // 10. Start sweeper (60s cadence; T28).
  const sweeper = new Sweeper(db, clock);
  sweeper.start();

  // 11. Emit config.boot audit (Tier 1, never drop).
  audit("config.boot", {
    tier: 1,
    metadata: { public_url: publicUrl, github_org: githubOrg },
  });

  return {
    context,
    sweeper,
    shutdown: async () => {
      sweeper.stop();
      await sweeper.drain(DRAIN_TIMEOUT_MS);
      const queue = getAuditQueue();
      if (queue) {
        queue.drain(DRAIN_TIMEOUT_MS);
      }
    },
  };
}

function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new BootValidationError(
      `${key} is required when COORDINATOR_OAUTH_ENABLED=true`,
    );
  }
  return value;
}

function validatePublicUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BootValidationError(
      `COORDINATOR_PUBLIC_URL is not a valid URL: ${url}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BootValidationError(
      `COORDINATOR_PUBLIC_URL must be http:// or https://, got ${parsed.protocol}`,
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalhost(parsed.hostname) &&
    process.env.COORDINATOR_INSECURE_COOKIES !== "true"
  ) {
    throw new BootValidationError(
      `COORDINATOR_PUBLIC_URL=${url} uses http:// for non-localhost; ` +
        `set COORDINATOR_INSECURE_COOKIES=true to override (NOT recommended for production)`,
    );
  }
}

function isLocalhost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function ensureBootstrapOrg(db: Database.Database, githubOrg: string): void {
  // Per V3 §B-NEW-4: if no orgs row has allowlist_github_org=githubOrg
  // (case-insensitive), insert one. Idempotent — re-running boot with the
  // same env is a no-op.
  const existing = db
    .prepare("SELECT id FROM orgs WHERE LOWER(allowlist_github_org) = LOWER(?)")
    .get(githubOrg);
  if (!existing) {
    const suffix = Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO orgs (id, name, allowlist_github_org) VALUES (?, ?, ?)`,
    ).run(`org-${githubOrg}-${suffix}`, githubOrg, githubOrg);
  }
}

interface MaxEpochRow {
  max_epoch: string | null;
}

function performRestoreCheck(db: Database.Database, clock: Clock): void {
  // NR12: compare max audit_log.created_at (ISO string) to wall clock.
  // If > 5 min stale → refuse boot UNLESS COORDINATOR_ALLOW_RESTORE=true.
  const row = db
    .prepare("SELECT MAX(strftime('%s', created_at)) AS max_epoch FROM audit_log")
    .get() as MaxEpochRow | undefined;

  const maxEpoch = row?.max_epoch ? Number(row.max_epoch) : null;
  if (maxEpoch === null) return; // empty audit log = fresh deployment

  const now = clock.now();
  const staleSeconds = now - maxEpoch;
  if (staleSeconds <= RESTORE_DETECTION_STALE_THRESHOLD_S) return; // healthy

  if (process.env.COORDINATOR_ALLOW_RESTORE !== "true") {
    throw new BootValidationError(
      `Restore suspected: audit_log timestamps lag wall-clock by ${staleSeconds}s ` +
        `(threshold: ${RESTORE_DETECTION_STALE_THRESHOLD_S}s). ` +
        `Set COORDINATOR_ALLOW_RESTORE=true after verifying this is a deliberate ` +
        `restore, then unset after boot.`,
    );
  }

  // ALLOW_RESTORE=true: bump every user's token_epoch + emit recovery audits.
  // This invalidates ALL existing sessions across the restored corpus.
  bumpTokenEpochAllUsers(db);
  audit("recovery.token_epoch_global_bump", {
    tier: 1,
    metadata: { stale_seconds: staleSeconds },
  });
  audit("recovery.completed", {
    tier: 1,
    metadata: {
      stale_seconds: staleSeconds,
      threshold_seconds: RESTORE_DETECTION_STALE_THRESHOLD_S,
    },
  });
}

export class BootValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootValidationError";
  }
}
