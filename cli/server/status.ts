import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { getConfigDir, loadConfig } from "../config.js";

export function createServerStatusCommand(): Command {
  return new Command("status")
    .description("Show coordinator status")
    .action(() => {
      const configDir = getConfigDir();
      const pidPath = join(configDir, "server.pid");
      const config = loadConfig();
      const port = config.server.port;

      if (!existsSync(pidPath)) {
        console.log("Coordinator: stopped");
        return;
      }

      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      let processAlive = false;
      try {
        process.kill(pid, 0);
        processAlive = true;
      } catch {}

      if (!processAlive) {
        console.log("Coordinator: stopped (stale PID file)");
        return;
      }

      // Health check
      let health: { status?: string } = {};
      try {
        const raw = execSync(`curl -s --max-time 3 http://localhost:${port}/health`, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        health = JSON.parse(raw);
      } catch {}

      if (health.status === "ok") {
        let status: { online?: number; open_threads?: number; hot_files?: number } = {};
        try {
          const raw = execSync(`curl -s --max-time 3 -X POST http://localhost:${port}/api/status`, {
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          status = JSON.parse(raw);
        } catch {}

        console.log(`Coordinator: running (PID ${pid}, port ${port})`);
        if (status.online !== undefined) {
          console.log(`Agents:      ${status.online} online`);
          console.log(`Threads:     ${status.open_threads} open`);
        }
        console.log(`Dashboard:   http://localhost:${port}/dashboard`);
      } else {
        console.log(`Coordinator: running (PID ${pid}) but health check failed`);
      }
    });
}

