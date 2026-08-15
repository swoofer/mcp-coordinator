import { Command } from "commander";
import { existingPidFilePath } from "../pid-file.js";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir, loadConfig } from "../config.js";

/**
 * Injectable side effects for stopServer, so the signal/timing flow can be
 * unit-tested without touching real processes. The CLI wrapper supplies the
 * real fs + process.kill implementations.
 */
export interface StopDeps {
  /** Raw PID-file contents, or null when the file is absent. */
  readPidFile: () => string | null;
  /** True if the process is alive (process.kill(pid, 0) without throwing). */
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  removePidFile: () => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (msg: string) => void;
  logError: (msg: string) => void;
  exit: (code: number) => never;
}

export interface StopOptions {
  /** SIGTERM grace period in seconds before escalating to SIGKILL. Default 5. */
  timeoutSeconds?: number;
  /** Skip the graceful SIGTERM and SIGKILL immediately. */
  force?: boolean;
}

const DEFAULT_TIMEOUT_SECONDS = 5;
const POLL_INTERVAL_MS = 200;

/**
 * Stop the coordinator identified by the PID file. Graceful by default
 * (SIGTERM, wait up to timeoutSeconds, then SIGKILL); `force` goes straight
 * to SIGKILL. Exits 1 on a missing/invalid PID file.
 */
export async function stopServer(deps: StopDeps, opts: StopOptions = {}): Promise<void> {
  const raw = deps.readPidFile();
  if (raw === null) {
    deps.logError("No server PID file found. Is the server running?");
    deps.exit(1);
  }

  const pid = parseInt(raw.trim(), 10);
  if (isNaN(pid)) {
    deps.logError("Invalid PID file. Removing.");
    deps.removePidFile();
    deps.exit(1);
  }

  if (!deps.isAlive(pid)) {
    deps.log(`Server (PID ${pid}) is not running. Cleaning up PID file.`);
    deps.removePidFile();
    return;
  }

  if (opts.force) {
    deps.log(`Force-stopping coordinator (PID ${pid}) with SIGKILL...`);
    deps.kill(pid, "SIGKILL");
    deps.removePidFile();
    deps.log("Coordinator stopped.");
    return;
  }

  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  deps.log(`Stopping coordinator (PID ${pid})... (grace ${timeoutSeconds}s)`);
  deps.kill(pid, "SIGTERM");

  const deadline = deps.now() + timeoutSeconds * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS);
    if (!deps.isAlive(pid)) {
      deps.log("Coordinator stopped.");
      deps.removePidFile();
      return;
    }
  }

  deps.log("Server did not stop gracefully. Sending SIGKILL.");
  deps.kill(pid, "SIGKILL");
  deps.removePidFile();
}

/**
 * Parse a --timeout value (seconds). Rejects negative / non-numeric input.
 * Returns the number of seconds, or null when the input is invalid.
 */
export function parseTimeoutSeconds(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Build the real, process-backed StopDeps for a given PID-file path. */
export function makeDefaultStopDeps(pidPath: string): StopDeps {
  return {
    readPidFile: () => (existsSync(pidPath) ? readFileSync(pidPath, "utf-8") : null),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, signal) => process.kill(pid, signal),
    removePidFile: () => {
      try {
        unlinkSync(pidPath);
      } catch {
        /* already gone */
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (msg) => console.log(msg),
    logError: (msg) => console.error(msg),
    exit: (code) => process.exit(code),
  };
}

export function createServerStopCommand(): Command {
  return new Command("stop")
    .description("Stop the coordination server")
    .option(
      "--timeout <seconds>",
      `SIGTERM grace period before SIGKILL (default: ${DEFAULT_TIMEOUT_SECONDS})`,
    )
    .option("--force", "Skip graceful SIGTERM and SIGKILL immediately", false)
    .option("--port <port>", "HTTP port of the instance to address (default: from config)")
    .addHelpText(
      "after",
      "\nExamples:\n" +
        "  mcp-coordinator server stop                # graceful, 5s grace\n" +
        "  mcp-coordinator server stop --timeout 30   # allow a slow audit flush\n" +
        "  mcp-coordinator server stop --force        # SIGKILL now (no graceful shutdown)\n",
    )
    .action(async (opts: { timeout?: string; force?: boolean; port?: string }) => {
      const timeoutSeconds = parseTimeoutSeconds(opts.timeout);
      if (timeoutSeconds === null) {
        console.error(
          `Invalid --timeout: ${opts.timeout} (expected a non-negative number of seconds)`,
        );
        process.exit(1);
      }
      // issue #279: the PID file is named per instance, so the port picks which
      // daemon this command addresses. Default port keeps the historical name.
      const port = parseInt(opts.port ?? process.env.PORT ?? String(loadConfig().server.port), 10);
      const pidPath = existingPidFilePath(getConfigDir(), port);
      await stopServer(makeDefaultStopDeps(pidPath), {
        timeoutSeconds,
        force: opts.force ?? false,
      });
    });
}
