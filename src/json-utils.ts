import type { Logger } from "./logger.js";

/**
 * qualite-code-07: safe JSON parsing for values that came from a SQLite
 * column (or any other read path we don't fully control) rather than
 * from an input we already validated ourselves.
 *
 * A corrupted/partially-written column, a stale schema, or a hand-edited
 * DB file must never crash a read path. `safeJsonParse` never throws:
 * on any failure it logs a warning and returns `fallback` instead.
 *
 * `raw` being `null`/`undefined` is treated as "column not set" — a
 * normal, expected state (e.g. a nullable `TEXT` column that was never
 * written) — and returns `fallback` silently, no warning logged.
 */
export function safeJsonParse<T>(
  raw: unknown,
  fallback: T,
  logger?: Pick<Logger, "warn">,
  context?: string,
): T {
  if (raw === null || raw === undefined) return fallback;

  if (typeof raw !== "string") {
    warn(logger, context, `expected a JSON string, got ${typeof raw}`);
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    warn(logger, context, err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

function warn(logger: Pick<Logger, "warn"> | undefined, context: string | undefined, reason: string): void {
  const payload = {
    context: context ?? "safeJsonParse",
    reason,
  };
  const msg = "safeJsonParse: malformed JSON on read path, using fallback";
  if (logger) {
    logger.warn(payload, msg);
  } else {
    // No structured logger wired at this call site — still surface the
    // corruption instead of parsing silently into the wrong shape.
    console.warn(`[${payload.context}] ${msg}: ${reason}`);
  }
}
