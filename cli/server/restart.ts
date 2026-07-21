import { Command } from "commander";
import { join } from "path";
import { getConfigDir } from "../config.js";
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
      const pidPath = join(getConfigDir(), "server.pid");

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
