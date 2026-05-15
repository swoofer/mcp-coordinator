import type { Writable } from "node:stream";
import pino, { type Logger as PinoLogger } from "pino";

/**
 * Phase 2 structured logger. Sensitive paths are redacted at the Pino
 * level — they will never appear in log output regardless of what
 * handler code logs.
 *
 * NR4 / V4 §11.3 redaction allowlist (16 paths):
 */
const REDACT_PATHS: readonly string[] = [
  // JWT + session secrets
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.access_token",
  "*.refresh_token",
  "*.id_token",
  "*.code_verifier",
  "*.client_secret",
  "*.idp_access_token",
  // Form bodies
  "body.code",
  "body.code_verifier",
  "body.client_secret",
  "body.refresh_token",
  // Internal request scope
  "req.idpAccessToken",
  "req.session",
];

export type Logger = PinoLogger;

export interface CreateLoggerOptions {
  /** Pino log level. Defaults to "info". Tests pass "silent". */
  level?: string;
  /** Optional destination writable stream — used by tests to capture output. */
  destination?: Writable;
}

/**
 * Create the Phase 2 logger. Level defaults to "info"; override via
 * the `level` option (T29 boot reads COORDINATOR_LOG_LEVEL — no env
 * read in this module per T44 discipline).
 *
 * Tests pass `level: "silent"` to keep the test output clean, or pass
 * a `destination` Writable to capture and assert on log output.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const pinoOpts = {
    level: opts.level ?? "info",
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
  };
  if (opts.destination) {
    return pino(pinoOpts, opts.destination);
  }
  return pino(pinoOpts);
}

/** Return the redaction path list (for tests). */
export function getRedactPaths(): readonly string[] {
  return REDACT_PATHS;
}
