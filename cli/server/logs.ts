import { Command } from "commander";
import { existsSync, statSync, openSync, readSync, closeSync, watchFile, unwatchFile } from "fs";
import { join } from "path";
import { getConfigDir } from "../config.js";

const LEVEL_NUM: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

export interface LogFilters {
  /** Epoch-ms lower bound; lines older than this are dropped. */
  sinceMs?: number;
  /** Regex the raw line must match. */
  grep?: RegExp;
  /** Minimum numeric pino level (lines below it are dropped). */
  minLevel?: number;
}

/**
 * Parse a duration like "30s", "15m", "1h", "2d" into milliseconds.
 * Returns null on invalid input.
 */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * unit[m[2]];
}

/** Map a --level name to its numeric pino level, or null if unknown. */
export function levelToNum(level: string): number | null {
  return LEVEL_NUM[level.toLowerCase()] ?? null;
}

/**
 * True if an NDJSON log line passes all active filters. `--grep` matches the
 * raw line; `--since` / `--level` require parsing the JSON — a non-JSON line
 * cannot satisfy a structured filter and is dropped when one is active. Empty
 * lines are always dropped.
 */
export function matchesLogLine(line: string, f: LogFilters): boolean {
  if (line.trim() === "") return false;
  if (f.grep && !f.grep.test(line)) return false;

  if (f.sinceMs !== undefined || f.minLevel !== undefined) {
    let obj: { level?: unknown; time?: unknown };
    try {
      obj = JSON.parse(line);
    } catch {
      return false; // can't evaluate a structured filter against a non-JSON line
    }
    if (f.minLevel !== undefined) {
      if (typeof obj.level !== "number" || obj.level < f.minLevel) return false;
    }
    if (f.sinceMs !== undefined) {
      const t = typeof obj.time === "number" ? obj.time : Date.parse(String(obj.time));
      if (!Number.isFinite(t) || t < f.sinceMs) return false;
    }
  }
  return true;
}

/** Build a RegExp from --grep input; falls back to a literal match on invalid regex. */
function buildGrep(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

/** Emit only the lines from `text` that pass the filters (preserving order). */
function writeFiltered(text: string, filters: LogFilters): void {
  const hasFilter =
    filters.sinceMs !== undefined || filters.grep !== undefined || filters.minLevel !== undefined;
  if (!hasFilter) {
    process.stdout.write(text);
    return;
  }
  for (const line of text.split("\n")) {
    if (matchesLogLine(line, filters)) process.stdout.write(line + "\n");
  }
}

export function createServerLogsCommand(): Command {
  return new Command("logs")
    .description("Tail the daemon server log at ~/.mcp-coordinator/logs/server.log")
    .option("-n, --lines <n>", "Print the last N lines and exit (default: 50)", "50")
    .option("-f, --follow", "After printing the tail, follow the file for new lines")
    .option("--since <duration>", "Only show entries within a window, e.g. 30m, 1h, 2d")
    .option("--grep <pattern>", "Only show lines matching this regex (or literal substring)")
    .option("--level <level>", "Only show entries at this level or higher (debug|info|warn|error)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  mcp-coordinator server logs --since 1h --level warn\n" +
        "  mcp-coordinator server logs -f --grep consultation\n",
    )
    .action(
      (opts: {
        lines: string;
        follow?: boolean;
        since?: string;
        grep?: string;
        level?: string;
      }) => {
        // Resolve filters up front so bad flags fail before touching the file.
        const filters: LogFilters = {};
        if (opts.since !== undefined) {
          const ms = parseDuration(opts.since);
          if (ms === null) {
            console.error(`Invalid --since: ${opts.since} (expected e.g. 30m, 1h, 2d)`);
            process.exit(1);
          }
          filters.sinceMs = Date.now() - ms;
        }
        if (opts.level !== undefined) {
          const num = levelToNum(opts.level);
          if (num === null) {
            console.error(`Invalid --level: ${opts.level} (expected debug|info|warn|error|fatal)`);
            process.exit(1);
          }
          filters.minLevel = num;
        }
        if (opts.grep !== undefined) filters.grep = buildGrep(opts.grep);

        const logPath = join(getConfigDir(), "logs", "server.log");
        if (!existsSync(logPath)) {
          console.error(`No log file at ${logPath}.`);
          console.error(
            "The server has never been started in daemon mode (foreground runs print to stdout).",
          );
          console.error("Start a daemon: mcp-coordinator server start --daemon");
          process.exit(1);
        }

        const n = Math.max(1, parseInt(opts.lines, 10) || 50);

        // Print the last N lines by reading from the end of the file in chunks.
        const fd = openSync(logPath, "r");
        try {
          const size = statSync(logPath).size;
          const chunkSize = 65536;
          let pos = size;
          let collected = "";
          let newlines = 0;
          while (pos > 0 && newlines <= n) {
            const readLen = Math.min(chunkSize, pos);
            pos -= readLen;
            const buf = Buffer.alloc(readLen);
            readSync(fd, buf, 0, readLen, pos);
            const piece = buf.toString("utf-8");
            collected = piece + collected;
            newlines = (collected.match(/\n/g) ?? []).length;
          }
          const lines = collected.split("\n");
          const tail = lines.slice(Math.max(0, lines.length - n - 1));
          let tailText = tail.join("\n");
          if (!collected.endsWith("\n")) tailText += "\n";
          writeFiltered(tailText, filters);
        } finally {
          closeSync(fd);
        }

        if (!opts.follow) return;

        // Follow mode: poll the file for size changes and print appended bytes.
        let lastSize = statSync(logPath).size;
        const onChange = () => {
          try {
            const cur = statSync(logPath).size;
            if (cur < lastSize) {
              // file truncated/rotated — reset
              lastSize = 0;
            }
            if (cur > lastSize) {
              const fd2 = openSync(logPath, "r");
              try {
                const buf = Buffer.alloc(cur - lastSize);
                readSync(fd2, buf, 0, buf.length, lastSize);
                writeFiltered(buf.toString("utf-8"), filters);
                lastSize = cur;
              } finally {
                closeSync(fd2);
              }
            }
          } catch {
            // ignore transient errors during rotation
          }
        };

        console.log("");
        console.log("[following — Ctrl+C to stop]");

        watchFile(logPath, { interval: 500 }, onChange);

        const cleanup = () => {
          unwatchFile(logPath, onChange);
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      },
    );
}
