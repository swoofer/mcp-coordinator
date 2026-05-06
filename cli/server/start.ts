import { Command } from "commander";
import { writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, ensureConfigDir } from "../config.js";

export function createServerStartCommand(): Command {
  return new Command("start")
    .description("Start the coordination server")
    .option("--port <port>", "Server port")
    .option("--data-dir <path>", "Data directory")
    .option("--daemon", "Run as background daemon")
    .action(async (opts: { port?: string; dataDir?: string; daemon?: boolean }) => {
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
        // Only forward the env vars the daemon actually needs.
        // Each var is read explicitly (no Object.keys / dynamic indexing into
        // process.env) so the daemon can't inherit unrelated parent-process
        // secrets such as AWS_*, GITHUB_TOKEN, OPENAI_API_KEY, etc.
        const childEnv: Record<string, string> = {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? process.env.USERPROFILE ?? "",
          PORT: String(port),
          COORDINATOR_DATA_DIR: dataDir,
        };
        const fwd = (key: string, value: string | undefined): void => {
          if (value !== undefined) childEnv[key] = value;
        };
        fwd("NODE_ENV", process.env.NODE_ENV);
        fwd("LOG_LEVEL", process.env.LOG_LEVEL);
        fwd("COORDINATOR_AUTH_ENABLED", process.env.COORDINATOR_AUTH_ENABLED);
        fwd("COORDINATOR_JWT_SECRET", process.env.COORDINATOR_JWT_SECRET);
        fwd("COORDINATOR_JWT_EXPIRY", process.env.COORDINATOR_JWT_EXPIRY);
        fwd("COORDINATOR_REGISTRATION_SECRET", process.env.COORDINATOR_REGISTRATION_SECRET);
        fwd("COORDINATOR_ADMIN_SECRET", process.env.COORDINATOR_ADMIN_SECRET);
        fwd("COORDINATOR_MQTT_TCP_PORT", process.env.COORDINATOR_MQTT_TCP_PORT);
        fwd("COORDINATOR_MQTT_WS_PATH", process.env.COORDINATOR_MQTT_WS_PATH);
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

