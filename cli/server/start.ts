import { Command } from "commander";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, ensureConfigDir } from "../config.js";

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
  fwd("COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS", parentEnv.COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS);
  fwd("COORDINATOR_LAYER4_SINCE_DAYS", parentEnv.COORDINATOR_LAYER4_SINCE_DAYS);
  fwd("COORDINATOR_LAYER4_MAX_COMMITS", parentEnv.COORDINATOR_LAYER4_MAX_COMMITS);
  fwd("COORDINATOR_LAYER4_REFRESH_INTERVAL_MS", parentEnv.COORDINATOR_LAYER4_REFRESH_INTERVAL_MS);
  fwd("COORDINATOR_LAYER4_RETRY_MS", parentEnv.COORDINATOR_LAYER4_RETRY_MS);
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

  return childEnv;
}

export function createServerStartCommand(): Command {
  return new Command("start")
    .description("Start the coordination server")
    .option("--port <port>", "Server port")
    .option("--data-dir <path>", "Data directory")
    .option("--daemon", "Run as background daemon")
    .option("--repo-root <path>", "Project repo root (enables Layer 4 + FS fallback). Default env COORDINATOR_REPO_ROOT.")
    .option("--max-body-bytes <bytes>", "Max HTTP request body in bytes. Default 1048576.")
    .option("--working-files-ttl-min <minutes>", "TTL for working_files claims. Default 30.")
    .option("--working-files-sweep-ms <ms>", "TTL sweeper tick interval. Default 60000.")
    .option("--layer4-since-days <days>", "git log --since window. Default 7.")
    .option("--layer4-max-commits <count>", "git log --max-count. Default 2000.")
    .option("--layer4-refresh-ms <ms>", "Layer 4 successful-build refresh interval. Default 1800000.")
    .option("--layer4-retry-ms <ms>", "Layer 4 retry interval on timeout. Default 300000.")
    .action(async (opts: {
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
    }) => {
      // Wire CLI flags to env vars (CLI takes precedence; rest of codebase reads from env)
      if (opts.repoRoot) process.env.COORDINATOR_REPO_ROOT = opts.repoRoot;
      if (opts.maxBodyBytes) process.env.COORDINATOR_MAX_BODY_BYTES = opts.maxBodyBytes;
      if (opts.workingFilesTtlMin) process.env.COORDINATOR_WORKING_FILES_TTL_MIN = opts.workingFilesTtlMin;
      if (opts.workingFilesSweepMs) process.env.COORDINATOR_WORKING_FILES_SWEEP_INTERVAL_MS = opts.workingFilesSweepMs;
      if (opts.layer4SinceDays) process.env.COORDINATOR_LAYER4_SINCE_DAYS = opts.layer4SinceDays;
      if (opts.layer4MaxCommits) process.env.COORDINATOR_LAYER4_MAX_COMMITS = opts.layer4MaxCommits;
      if (opts.layer4RefreshMs) process.env.COORDINATOR_LAYER4_REFRESH_INTERVAL_MS = opts.layer4RefreshMs;
      if (opts.layer4RetryMs) process.env.COORDINATOR_LAYER4_RETRY_MS = opts.layer4RetryMs;

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

        // Write PID file
        writeFileSync(join(configDir, "server.pid"), String(child.pid));

        child.unref();
        console.log(`Coordinator started in background (PID ${child.pid}, port ${port})`);
        console.log(`  Logs: ${logPath}`);
        console.log(`  Stop: mcp-coordinator server stop`);
        process.exit(0);
      }

      // Foreground mode: start server in-process
      // Write PID file for server stop support
      writeFileSync(join(configDir, "server.pid"), String(process.pid));

      // Graceful shutdown
      const { unlinkSync } = await import("fs");
      const cleanup = () => {
        try { unlinkSync(join(configDir, "server.pid")); } catch {}
      };
      process.on("SIGINT", () => { cleanup(); process.exit(0); });
      process.on("SIGTERM", () => { cleanup(); process.exit(0); });

      // Import and start server in-process
      const { startServer } = await import("../../src/serve-http.js");
      await startServer({ port, dataDir });
    });
}

