import { Command } from "commander";
import { existingPidFilePath } from "../pid-file.js";
import { join } from "path";
import { getConfigDir, loadConfig } from "../config.js";
import { stopServer, makeDefaultStopDeps } from "./stop.js";

/** Signals a tolerated stop-abort (no/invalid PID) so restart can proceed to start. */
class StopAborted extends Error {
  constructor(public code: number) {
    super(`stop aborted (${code})`);
  }
}

export interface StartArgvParts {
  execPath: string;
  /** argv[1] (the CLI script) — omitted for a Bun-compiled binary. */
  scriptPath?: string;
  isBun: boolean;
}

/**
 * The port `start` will bind, read from the args restart passes through.
 * Accepts `--port 3200` and `--port=3200`; null when absent or unparseable so
 * the caller falls back to the configured port.
 */
export function portFromArgs(args: readonly string[]): number | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      return Number.isFinite(n) ? n : null;
    }
    if (a.startsWith("--port=")) {
      const n = parseInt(a.slice("--port=".length), 10);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/**
 * Build the argv for re-invoking `server start` with the forwarded flags.
 * In a Bun-compiled binary, execPath IS the CLI so no script path is needed;
 * under Node/tsx, argv[1] (the script) must be re-passed. Pure + testable.
 */
export function buildStartArgv(startArgs: string[], parts: StartArgvParts): string[] {
  const base = parts.isBun ? [] : parts.scriptPath !== undefined ? [parts.scriptPath] : [];
  return [...base, "server", "start", ...startArgs];
}

export function createServerRestartCommand(): Command {
  return new Command("restart")
    .description("Stop the running server (graceful), then start it again with the given flags")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument(
      "[startArgs...]",
      "Flags forwarded verbatim to `server start` (e.g. --daemon --port 3100)",
    )
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  mcp-coordinator server restart --daemon              # reload a background server\n" +
        "  mcp-coordinator server restart --daemon --port 3200  # ...with new flags\n",
    )
    .action(async (startArgs: string[]) => {
      // issue #279: the PID file is named per instance. restart forwards its
      // passthrough args to `start`, so the port it will START on is the port
      // whose daemon it must STOP — read it from the same argv rather than from
      // config, or `restart --port 3200` would stop the default instance and
      // then start a second one alongside it.
      const port = portFromArgs(startArgs) ?? loadConfig().server.port;
      const pidPath = existingPidFilePath(getConfigDir(), port);

      // 1. Graceful stop. A missing/invalid PID file is not fatal for restart —
      //    it just means there's nothing to stop, so proceed to start.
      const stopDeps = {
        ...makeDefaultStopDeps(pidPath),
        exit: ((code: number) => {
          throw new StopAborted(code);
        }) as (code: number) => never,
      };
      try {
        await stopServer(stopDeps, {});
      } catch (e) {
        if (!(e instanceof StopAborted)) throw e;
        console.log("(no running server to stop — starting fresh)");
      }

      // 2. Re-invoke `server start` with the forwarded flags. stopServer only
      //    returns once the old process is dead, so the port is free.
      const { spawn } = await import("child_process");
      const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
      const args = buildStartArgv(startArgs, {
        execPath: process.execPath,
        scriptPath: process.argv[1],
        isBun,
      });
      const child = spawn(process.execPath, args, { stdio: "inherit" });
      child.on("exit", (code) => process.exit(code ?? 0));
      child.on("error", (err) => {
        console.error(`Failed to start server: ${err.message}`);
        process.exit(1);
      });
    });
}
