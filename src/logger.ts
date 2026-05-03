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

// Simple console-based logger (works everywhere, no native deps)
function createConsoleLogger(level: string, bindings: Record<string, unknown> = {}): Logger {
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
    const data = typeof args[0] === "object" ? { ...bindings, ...(obj as Record<string, unknown>) } : bindings;
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
function createPinoLogger(level: string): Logger {
  const pino = require("pino");
  const isDev = process.env.NODE_ENV === "development";
  const transport = isDev
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:mm:ss" } }
    : undefined;
  return pino({ level, transport });
}

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(options?: LoggerOptions): Logger {
  const level = options?.level || process.env.LOG_LEVEL || "info";

  // Use console logger in Bun compiled binary (pino uses thread-stream which breaks)
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    return createConsoleLogger(level);
  }

  // Use pino in Node.js (dev/test)
  try {
    return createPinoLogger(level);
  } catch {
    return createConsoleLogger(level);
  }
}

export const silentLogger: Logger = createConsoleLogger("silent");
