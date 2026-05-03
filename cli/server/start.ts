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
        const child = spawn(cmd, args, {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...process.env, PORT: String(port), COORDINATOR_DATA_DIR: dataDir },
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

