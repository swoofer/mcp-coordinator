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
export function createConsoleLogger(level: string, bindings: Record<string, unknown> = {}): Logger {
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
    if (lvl === "error" || lvl === "fatal") {
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
    child: (b: Record<string, unknown>) => createConsoleLogger(level, { ...bindings, ...b }),
  };
}

// Pino-based logger (dev mode, richer output)
export function createPinoLogger(level: string, destination?: NodeJS.WritableStream): Logger {
  const pino = require("pino");
  const isDev = process.env.NODE_ENV === "development";
  const transport = isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:mm:ss" } }
    : undefined;
  const pinoOpts = {
    level,
    transport,
    redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" },
  };
  return destination ? pino(pinoOpts, destination) : pino(pinoOpts);
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
  /** Test-only: override the pino destination stream to capture output. */
  destination?: NodeJS.WritableStream;
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level || process.env.LOG_LEVEL || "info";

  // Use console logger in Bun compiled binary (pino uses thread-stream which breaks)
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    return createConsoleLogger(level);
  }

  // Use pino in Node.js (dev/test)
  try {
    return createPinoLogger(level, options?.destination);
  } catch {
    return createConsoleLogger(level);
  }
}

export const silentLogger: Logger = createConsoleLogger("silent");
