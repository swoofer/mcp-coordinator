import { REDACT_PATHS } from "./observability/redact-paths.js";

export interface Logger {
  level: string;
  info(obj: unknown, msg?: string): void;
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  warn(msg: string): void;
  error(obj: unknown, msg?: string): void;
  error(msg: string): void;
  fatal(obj: unknown, msg?: string): void;
  fatal(msg: string): void;
  debug(obj: unknown, msg?: string): void;
  debug(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Pure helper: returns a copy of `input` with the value at every dotted
 * `paths` entry replaced by `"[REDACTED]"`. Supports a `"*"` wildcard
 * segment (matches any key at that level — same semantics as pino/
 * fast-redact's `*.field` paths), so it stays behavior-parity with the
 * `redact` option passed to pino in `createPinoLogger` / Phase 2's logger.
 *
 * Only the branches actually touched by a path are cloned; everything
 * else keeps its original reference. The caller's object is never
 * mutated.
 */
export function redactPaths<T>(input: T, paths: readonly string[]): T {
  if (input === null || typeof input !== "object") return input;
  const result: Record<string, unknown> = Array.isArray(input)
    ? ([...(input as unknown as unknown[])] as unknown as Record<string, unknown>)
    : { ...(input as Record<string, unknown>) };
  for (const path of paths) {
    applyRedact(result, path.split("."));
  }
  return result as unknown as T;
}

function applyRedact(obj: Record<string, unknown>, segments: string[]): void {
  if (obj === null || typeof obj !== "object") return;
  const [head, ...rest] = segments;
  const keys = head === "*" ? Object.keys(obj) : [head];
  for (const key of keys) {
    if (!(key in obj)) continue;
    if (rest.length === 0) {
      obj[key] = "[REDACTED]";
      continue;
    }
    const child = obj[key];
    if (child !== null && typeof child === "object") {
      const clonedChild: Record<string, unknown> = Array.isArray(child)
        ? ([...(child as unknown[])] as unknown as Record<string, unknown>)
        : { ...(child as Record<string, unknown>) };
      obj[key] = clonedChild;
      applyRedact(clonedChild, rest);
    }
  }
}

// Simple console-based logger (works everywhere, no native deps)
//
// `stdio`: when true, EVERY level (including info/warn/debug) is written via
// console.error (stderr), never console.log (stdout). This is required by
// the MCP stdio transport, which reserves stdout exclusively for JSON-RPC
// protocol messages — the spec's "MUST NOT write anything else to stdout".
// See createLogger()'s `stdio` option and src/index.ts, the stdio entrypoint.
export function createConsoleLogger(
  level: string,
  bindings: Record<string, unknown> = {},
  stdio = false,
): Logger {
  const levels: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: 100 };
  const threshold = levels[level] ?? 20;

  function log(lvl: string, num: number, args: unknown[]): void {
    if (num < threshold) return;
    const ts = new Date().toISOString();
    const prefix = Object.keys(bindings).length > 0
      ? `[${Object.values(bindings).join(":")}]`
      : "";
    const obj = typeof args[0] === "object" && args[0] !== null ? args[0] : {};
    const msg = typeof args[0] === "string" ? args[0] : (args[1] as string) ?? "";
    const rawData = typeof args[0] === "object" ? { ...bindings, ...(obj as Record<string, unknown>) } : bindings;
    const data = redactPaths(rawData, REDACT_PATHS);
    if (stdio || lvl === "error" || lvl === "fatal") {
      console.error(JSON.stringify({ level: num, time: ts, ...data, msg }));
    } else {
      console.log(JSON.stringify({ level: num, time: ts, ...data, msg }));
    }
  }

  return {
    level,
    info: (...args: unknown[]) => log("info", 20, args),
    warn: (...args: unknown[]) => log("warn", 30, args),
    error: (...args: unknown[]) => log("error", 40, args),
    fatal: (...args: unknown[]) => log("fatal", 50, args),
    debug: (...args: unknown[]) => log("debug", 10, args),
    child: (b: Record<string, unknown>) => createConsoleLogger(level, { ...bindings, ...b }, stdio),
  };
}

// Pino-based logger (dev mode, richer output)
//
// `stdio`: when true and no explicit `destination` is supplied, logs are
// written to fd 2 (stderr) via `pino.destination(2)` instead of pino's
// default fd 1 (stdout), and the pino-pretty transport (which always
// targets stdout, regardless of the `destination` passed to `pino()`) is
// disabled. An explicit `destination` (used by tests to capture output)
// always wins over the stdio default.
export function createPinoLogger(
  level: string,
  destination?: NodeJS.WritableStream,
  stdio = false,
): Logger {
  const pino = require("pino");
  const isDev = process.env.NODE_ENV === "development";
  const transport = isDev && !stdio
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:mm:ss" } }
    : undefined;
  const pinoOpts = {
    level,
    transport,
    redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
  };
  const dest = destination ?? (stdio ? pino.destination(2) : undefined);
  return dest ? pino(pinoOpts, dest) : pino(pinoOpts);
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /**
   * MCP stdio transport mode: stdout is reserved for JSON-RPC protocol
   * messages, so ALL log levels must go to stderr instead. See
   * createConsoleLogger / createPinoLogger for the per-backend mechanism.
   */
  stdio?: boolean;
  /** Test-only: override the pino destination stream to capture output. */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level || process.env.LOG_LEVEL || "info";
  const stdio = options?.stdio ?? false;

  // Use console logger in Bun compiled binary (pino uses thread-stream which breaks)
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    return createConsoleLogger(level, {}, stdio);
  }

  // Use pino in Node.js (dev/test)
  try {
    return createPinoLogger(level, options?.destination, stdio);
  } catch {
    return createConsoleLogger(level, {}, stdio);
  }
}

export const silentLogger: Logger = createConsoleLogger("silent");
