import { Command } from "commander";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { loadConfig, ensureConfigDir } from "../config.js";
import { tcpReachable } from "../tcp-probe.js";

/**
 * architecture-04: builds the foreground SIGINT/SIGTERM handler.
 *
 * Previously the CLI registered its own `process.on("SIGINT"/"SIGTERM", ...)`
 * handlers that only removed the PID file and called `process.exit(0)`
 * immediately — bypassing `ServerHandle.stop()`'s ordered teardown (Phase 2
 * shutdown / audit drain → HTTP server → MQTT bridge → broker → timers →
 * DB). Since `process.exit()` inside a synchronous listener terminates the
 * process before any other registered listener for the same signal runs,
 * this raced against (and usually won over) `startServer`'s own graceful
 * shutdown handler, risking in-flight audit/quota data loss.
 *
 * Fix: the CLI now owns signal handling exclusively — it starts the server
 * with `registerSignalHandlers: false` so `startServer` does NOT install its
 * own listeners (no double-handler race), and this single handler awaits
 * `handle.stop()` (the real graceful teardown) before cleaning up the PID
 * file and exiting. Idempotent via the `shuttingDown` flag so a second
 * signal during shutdown is a no-op instead of double-running teardown.
 *
 * Mirrors serve-http.ts's own `onSignal`: a `stop()` error is reported and
 * exits with code 1 (instead of rejecting/throwing, which would otherwise
 * surface as an unhandled promise rejection since callers fire this via
 * `void shutdown(signal)` from a process signal listener) — but PID cleanup
 * still always runs.
 */
export function createForegroundShutdownHandler(
  handle: { stop: () => Promise<void> },
  pidFile: string,
  deps: {
    unlinkSync: (path: string) => void;
    exit: (code?: number) => void;
    onError?: (err: unknown) => void;
  } = {
    unlinkSync,
    exit: (code?: number) => process.exit(code),
    onError: (err) => console.error("Graceful shutdown error:", err),
  },
): (signal: NodeJS.Signals) => Promise<void> {
  let shuttingDown = false;
  return async (_signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    let exitCode = 0;
    try {
      await handle.stop();
    } catch (err) {
      exitCode = 1;
      deps.onError?.(err);
    } finally {
      try {
        deps.unlinkSync(pidFile);
      } catch {
        /* best-effort cleanup */
      }
      deps.exit(exitCode);
    }
  };
}

/**
 * How long `server start --daemon` waits for the child to accept a connection
 * before giving up on confirming it (issue #273). Generous rather than snappy:
 * first boot on an existing database runs the schema migrations, and reporting
 * a healthy daemon as failed is its own kind of lie.
 */
export const DEFAULT_DAEMON_BIND_TIMEOUT_MS = 15000;

/**
 * Overridable because 15s is a guess about someone else's machine: a first
 * boot that migrates a large database can legitimately outrun it, and a test
 * that mocks `spawn` should not sit through it.
 */
export function daemonBindTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.COORDINATOR_DAEMON_BIND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAEMON_BIND_TIMEOUT_MS;
}

/** Outcome of the wait: the child bound, died, or neither within the window. */
export type DaemonBindOutcome = "listening" | "exited" | "timeout";

/**
 * Wait until the spawned daemon is actually accepting connections.
 *
 * Resolves as soon as one of three things is true, whichever comes first: the
 * port answers, the child exits, or the window closes. The child-exit race is
 * the important one — a daemon that dies on EADDRINUSE does so in a few
 * milliseconds, long before any port ever answers, and that is exactly the
 * case that used to be reported as success.
 */
export async function waitForDaemonBind(
  child: {
    once?: (ev: string, cb: (...a: unknown[]) => void) => unknown;
    /** Set by Node once the child is gone; read so a death that happened
     *  before we attached a listener is not missed. */
    exitCode?: number | null;
    signalCode?: string | null;
  },
  port: number,
  timeoutMs: number = daemonBindTimeoutMs(),
  probe: (host: string, port: number, t?: number) => Promise<boolean> = tcpReachable,
  pollMs = 150,
): Promise<DaemonBindOutcome> {
  // Both the event AND the state: `once("exit")` only fires for a death that
  // happens after this call, and `spawn` is followed by this immediately, so
  // in production the event is enough. Reading exitCode too makes the
  // function answer correctly whenever it is called.
  let exited = child.exitCode != null || child.signalCode != null;
  // A mocked spawn may hand back a bare object; treat a child with no event
  // API as one that simply never reports, and let the probe/timeout decide.
  const on = typeof child.once === "function" ? child.once.bind(child) : () => undefined;
  on("exit", () => {
    exited = true;
  });
  // A spawn that fails outright (ENOENT on the command) emits `error`, never
  // `exit`. Same conclusion for the caller.
  on("error", () => {
    exited = true;
  });

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) return "exited";
    if (await probe("127.0.0.1", port, 500)) return "listening";
    if (exited) return "exited";
    if (Date.now() >= deadline) return "timeout";
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Last `lines` lines of a file, or "" when it cannot be read. Used to put the
 * daemon's own error in front of the operator instead of a path to go read.
 */
export function tailFile(path: string, lines: number): string {
  try {
    const text = readFileSync(path, "utf-8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Builds the env object passed to the detached daemon child process.
 *
 * PURE function (no process.env reads/writes of its own) so the allowlist
 * can be unit-tested directly instead of only via a mocked spawn(). Only
 * the env vars explicitly `fwd()`-ed below reach the daemon — this is an
 * intentional allowlist, NOT a blanket forward of the parent environment,
 * so the daemon can never inherit unrelated parent-process secrets such as
 * AWS_*, GITHUB_TOKEN, OPENAI_API_KEY, etc. When the server gains a new
 * `process.env.COORDINATOR_*` read, add a matching `fwd()` line here.
 */
export function buildDaemonEnv(
  parentEnv: NodeJS.ProcessEnv,
  opts: { port: number; dataDir: string },
): Record<string, string> {
  const childEnv: Record<string, string> = {
    PATH: parentEnv.PATH ?? "",
    HOME: parentEnv.HOME ?? parentEnv.USERPROFILE ?? "",
    PORT: String(opts.port),
    COORDINATOR_DATA_DIR: opts.dataDir,
  };
  const fwd = (key: string, value: string | undefined): void => {
    if (value !== undefined) childEnv[key] = value;
  };
  fwd("NODE_ENV", parentEnv.NODE_ENV);
  fwd("LOG_LEVEL", parentEnv.LOG_LEVEL);
  fwd("COORDINATOR_AUTH_ENABLED", parentEnv.COORDINATOR_AUTH_ENABLED);
  fwd("COORDINATOR_JWT_SECRET", parentEnv.COORDINATOR_JWT_SECRET);
  fwd("COORDINATOR_JWT_EXPIRY", parentEnv.COORDINATOR_JWT_EXPIRY);
  fwd("COORDINATOR_REGISTRATION_SECRET", parentEnv.COORDINATOR_REGISTRATION_SECRET);
  fwd("COORDINATOR_ADMIN_SECRET", parentEnv.COORDINATOR_ADMIN_SECRET);
  fwd("COORDINATOR_MQTT_TCP_PORT", parentEnv.COORDINATOR_MQTT_TCP_PORT);
  fwd("COORDINATOR_MQTT_WS_PATH", parentEnv.COORDINATOR_MQTT_WS_PATH);
  fwd("COORDINATOR_REPO_ROOT", parentEnv.COORDINATOR_REPO_ROOT);
  fwd("COORDINATOR_MAX_BODY_BYTES", parentEnv.COORDINATOR_MAX_BODY_BYTES);
  fwd("COORDINATOR_WORKING_FILES_TTL_MIN", parentEnv.COORDINATOR_WORKING_FILES_TTL_MIN);
  fwd(
    "COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS",
    parentEnv.COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS,
  );
  fwd("COORDINATOR_LAYER4_SINCE_DAYS", parentEnv.COORDINATOR_LAYER4_SINCE_DAYS);
  fwd("COORDINATOR_LAYER4_MAX_COMMITS", parentEnv.COORDINATOR_LAYER4_MAX_COMMITS);
  fwd("COORDINATOR_LAYER4_REFRESH_INTERVAL_MS", parentEnv.COORDINATOR_LAYER4_REFRESH_INTERVAL_MS);
  fwd("COORDINATOR_LAYER4_RETRY_MS", parentEnv.COORDINATOR_LAYER4_RETRY_MS);
  fwd("COORDINATOR_LOG_JSON", parentEnv.COORDINATOR_LOG_JSON);
  // T06a: Phase 3 encryption envs. Forward only when set in parent.
  fwd("COORDINATOR_ENCRYPTION_KEY", parentEnv.COORDINATOR_ENCRYPTION_KEY);
  fwd("COORDINATOR_ALLOW_TOKEN_LOSS", parentEnv.COORDINATOR_ALLOW_TOKEN_LOSS);
  fwd("COORDINATOR_TOKEN_LOSS_CONFIRM", parentEnv.COORDINATOR_TOKEN_LOSS_CONFIRM);
  fwd("COORDINATOR_ALLOW_KEY_ROTATION", parentEnv.COORDINATOR_ALLOW_KEY_ROTATION);

  // architecture-05: Phase 2 / OAuth / bind / SSE-tuning envs. Identified via
  // authoritative grep of `process.env.COORDINATOR_*` (and `env.COORDINATOR_*`
  // for boot.ts's injectable-env pattern) across src/. Without these, enabling
  // OAuth or setting a bind address only "works" in foreground mode — the
  // daemon silently boots Phase 1-only (COORDINATOR_OAUTH_ENABLED unset).
  fwd("COORDINATOR_OAUTH_ENABLED", parentEnv.COORDINATOR_OAUTH_ENABLED);
  fwd("COORDINATOR_PUBLIC_URL", parentEnv.COORDINATOR_PUBLIC_URL);
  fwd("COORDINATOR_BIND", parentEnv.COORDINATOR_BIND);
  fwd("COORDINATOR_INSECURE_COOKIES", parentEnv.COORDINATOR_INSECURE_COOKIES);
  // GitHub OAuth provider (required for Phase 2) + GHES base URL overrides.
  fwd("COORDINATOR_GITHUB_CLIENT_ID", parentEnv.COORDINATOR_GITHUB_CLIENT_ID);
  fwd("COORDINATOR_GITHUB_CLIENT_SECRET", parentEnv.COORDINATOR_GITHUB_CLIENT_SECRET);
  fwd("COORDINATOR_GITHUB_ORG", parentEnv.COORDINATOR_GITHUB_ORG);
  fwd("COORDINATOR_GITHUB_AUTH_BASE_URL", parentEnv.COORDINATOR_GITHUB_AUTH_BASE_URL);
  fwd("COORDINATOR_GITHUB_API_BASE_URL", parentEnv.COORDINATOR_GITHUB_API_BASE_URL);
  // Google OAuth provider (opt-in).
  fwd("COORDINATOR_GOOGLE_CLIENT_ID", parentEnv.COORDINATOR_GOOGLE_CLIENT_ID);
  fwd("COORDINATOR_GOOGLE_CLIENT_SECRET", parentEnv.COORDINATOR_GOOGLE_CLIENT_SECRET);
  // GitHub App provider (opt-in).
  fwd("COORDINATOR_GITHUB_APP_CLIENT_ID", parentEnv.COORDINATOR_GITHUB_APP_CLIENT_ID);
  fwd("COORDINATOR_GITHUB_APP_CLIENT_SECRET", parentEnv.COORDINATOR_GITHUB_APP_CLIENT_SECRET);
  fwd("COORDINATOR_GITHUB_APP_NAME", parentEnv.COORDINATOR_GITHUB_APP_NAME);
  fwd("COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE", parentEnv.COORDINATOR_GITHUB_APP_ALLOWLIST_SOURCE);
  // Generic OIDC provider (opt-in).
  fwd("COORDINATOR_OIDC_ISSUER_URL", parentEnv.COORDINATOR_OIDC_ISSUER_URL);
  fwd("COORDINATOR_OIDC_CLIENT_ID", parentEnv.COORDINATOR_OIDC_CLIENT_ID);
  fwd("COORDINATOR_OIDC_CLIENT_SECRET", parentEnv.COORDINATOR_OIDC_CLIENT_SECRET);
  fwd("COORDINATOR_OIDC_GROUPS_CLAIM", parentEnv.COORDINATOR_OIDC_GROUPS_CLAIM);
  // JWT rotation-overlap secrets (Phase 1 legacy name + Phase 2 name; see
  // docs/ops/key-rotation.md).
  fwd("COORDINATOR_JWT_PREV_SECRET", parentEnv.COORDINATOR_JWT_PREV_SECRET);
  fwd("COORDINATOR_JWT_SECRET_PREV", parentEnv.COORDINATOR_JWT_SECRET_PREV);
  fwd("COORDINATOR_JWT_SECRET_PREV_ROTATED_AT", parentEnv.COORDINATOR_JWT_SECRET_PREV_ROTATED_AT);
  // Boot-time fail-closed guard overrides (explicit operator opt-in).
  fwd("COORDINATOR_ALLOW_RESTORE", parentEnv.COORDINATOR_ALLOW_RESTORE);
  fwd("COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES", parentEnv.COORDINATOR_ALLOW_DUPLICATE_ORG_NAMES);
  fwd("COORDINATOR_ALLOW_RESET", parentEnv.COORDINATOR_ALLOW_RESET);
  // SSE tuning.
  fwd("COORDINATOR_MAX_SSE_CLIENTS", parentEnv.COORDINATOR_MAX_SSE_CLIENTS);
  fwd("COORDINATOR_SSE_HEARTBEAT_MS", parentEnv.COORDINATOR_SSE_HEARTBEAT_MS);
  fwd("COORDINATOR_METRICS_BEARER", parentEnv.COORDINATOR_METRICS_BEARER);

  return childEnv;
}

export function createServerStartCommand(): Command {
  return new Command("start")
    .description("Start the coordination server")
    .option("--port <port>", "Server port")
    .option("--data-dir <path>", "Data directory")
    .option("--daemon", "Run as background daemon")
    .option(
      "--repo-root <path>",
      "Project repo root (enables Layer 4 + FS fallback). Default env COORDINATOR_REPO_ROOT.",
    )
    .option("--max-body-bytes <bytes>", "Max HTTP request body in bytes. Default 1048576.")
    .option("--working-files-ttl-min <minutes>", "TTL for working_files claims. Default 30.")
    .option("--working-files-sweep-ms <ms>", "TTL sweeper tick interval. Default 60000.")
    .option("--layer4-since-days <days>", "git log --since window. Default 7.")
    .option("--layer4-max-commits <count>", "git log --max-count. Default 2000.")
    .option(
      "--layer4-refresh-ms <ms>",
      "Layer 4 successful-build refresh interval. Default 1800000.",
    )
    .option("--layer4-retry-ms <ms>", "Layer 4 retry interval on timeout. Default 300000.")
    .option(
      "--log-json",
      "Emit NDJSON logs (disable pino-pretty). For Docker/systemd/Loki/Datadog/CloudWatch. Default env COORDINATOR_LOG_JSON.",
    )
    .action(
      async (opts: {
        port?: string;
        dataDir?: string;
        daemon?: boolean;
        repoRoot?: string;
        maxBodyBytes?: string;
        workingFilesTtlMin?: string;
        workingFilesSweepMs?: string;
        layer4SinceDays?: string;
        layer4MaxCommits?: string;
        layer4RefreshMs?: string;
        layer4RetryMs?: string;
        logJson?: boolean;
      }) => {
        // Wire CLI flags to env vars (CLI takes precedence; rest of codebase reads from env)
        if (opts.repoRoot) process.env.COORDINATOR_REPO_ROOT = opts.repoRoot;
        if (opts.maxBodyBytes) process.env.COORDINATOR_MAX_BODY_BYTES = opts.maxBodyBytes;
        if (opts.workingFilesTtlMin)
          process.env.COORDINATOR_WORKING_FILES_TTL_MIN = opts.workingFilesTtlMin;
        if (opts.workingFilesSweepMs)
          process.env.COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS = opts.workingFilesSweepMs;
        if (opts.layer4SinceDays) process.env.COORDINATOR_LAYER4_SINCE_DAYS = opts.layer4SinceDays;
        if (opts.layer4MaxCommits)
          process.env.COORDINATOR_LAYER4_MAX_COMMITS = opts.layer4MaxCommits;
        if (opts.layer4RefreshMs)
          process.env.COORDINATOR_LAYER4_REFRESH_INTERVAL_MS = opts.layer4RefreshMs;
        if (opts.layer4RetryMs) process.env.COORDINATOR_LAYER4_RETRY_MS = opts.layer4RetryMs;
        if (opts.logJson) process.env.COORDINATOR_LOG_JSON = "true";

        const config = loadConfig();
        const port = parseInt(opts.port ?? process.env.PORT ?? String(config.server.port), 10);
        const dataDir = opts.dataDir ?? process.env.COORDINATOR_DATA_DIR ?? config.server.data_dir;

        const configDir = ensureConfigDir();

        if (opts.daemon) {
          // Daemon mode: spawn self, redirect logs via shell
          const { spawn } = await import("child_process");
          const { openSync } = await import("fs");

          const logPath = join(configDir, "logs", "server.log");
          const logFd = openSync(logPath, "a");

          // In compiled binary: process.execPath IS the binary, no argv[1] needed
          // In dev (tsx): process.execPath is node, argv[1] is the script
          const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
          const cmd = isBun ? process.execPath : process.execPath;
          const args = isBun ? ["server", "start"] : [process.argv[1], "server", "start"];
          // Only forward the env vars the daemon actually needs (see
          // buildDaemonEnv's explicit allowlist above) — the daemon can't
          // inherit unrelated parent-process secrets such as AWS_*,
          // GITHUB_TOKEN, OPENAI_API_KEY, etc.
          const childEnv = buildDaemonEnv(process.env, { port, dataDir });
          const child = spawn(cmd, args, {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: childEnv,
          });

          // issue #273: do NOT announce success on the strength of a successful
          // spawn. `spawn` returning a pid means a process was created, not that
          // it bound the port — and the bind fails closed downstream
          // (serve-http rejects on the listen `error` event) for EADDRINUSE, a
          // sandbox-refused bind, or any crash during boot. Writing the PID and
          // printing "Coordinator started in background" before knowing left a
          // green message, a PID file pointing at a corpse, and exit 0 for any
          // `&&` chain or wrapper script downstream.
          const outcome = await waitForDaemonBind(child, port, daemonBindTimeoutMs());
          child.unref();

          if (outcome === "exited") {
            console.error(`Coordinator failed to start — the process exited during boot.`);
            console.error(`  Logs: ${logPath}`);
            const tail = tailFile(logPath, 12);
            if (tail)
              console.error(`
${tail}`);
            process.exit(1);
          }

          // Still running: record the PID either way, so `server stop` can reach
          // it even when the bind never confirmed.
          writeFileSync(join(configDir, "server.pid"), String(child.pid));

          if (outcome === "timeout") {
            console.error(
              `Coordinator did not accept connections on port ${port} within ${daemonBindTimeoutMs() / 1000}s.`,
            );
            console.error(
              `  PID ${child.pid} is still running — it may be slow to boot, or stuck.`,
            );
            console.error(`  Logs: ${logPath}`);
            console.error(`  Stop: mcp-coordinator server stop`);
            process.exit(1);
          }

          console.log(`Coordinator started in background (PID ${child.pid}, port ${port})`);
          console.log(`  Logs: ${logPath}`);
          console.log(`  Stop: mcp-coordinator server stop`);
          process.exit(0);
        }

        // Foreground mode: start server in-process
        // Write PID file for server stop support
        const pidFile = join(configDir, "server.pid");
        writeFileSync(pidFile, String(process.pid));

        // Import and start server in-process. registerSignalHandlers: false
        // means startServer does NOT install its own SIGINT/SIGTERM listeners
        // — this CLI owns signal handling exclusively (see
        // createForegroundShutdownHandler) so the graceful teardown
        // (handle.stop()) always runs, without a double-handler race.
        const { startServer } = await import("../../src/serve-http.js");
        const handle = await startServer({ port, dataDir, registerSignalHandlers: false });

        const shutdown = createForegroundShutdownHandler(handle, pidFile);
        process.once("SIGINT", () => {
          void shutdown("SIGINT");
        });
        process.once("SIGTERM", () => {
          void shutdown("SIGTERM");
        });
      },
    );
}
