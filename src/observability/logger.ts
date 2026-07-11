import type { Writable } from "node:stream";
import pino, { type Logger as PinoLogger } from "pino";
import { REDACT_PATHS } from "./redact-paths.js";

/**
 * Phase 2 structured logger. Sensitive paths are redacted at the Pino
 * level — they will never appear in log output regardless of what
 * handler code logs.
 *
 * The allowlist itself lives in `./redact-paths.js` so it can be shared
 * with the Phase 1 logger (`src/logger.ts`) without that module having to
 * statically import this one (see the comment in `redact-paths.ts` for why).
 */

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
