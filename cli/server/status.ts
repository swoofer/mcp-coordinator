import { Command } from "commander";
import { existingPidFilePath } from "../pid-file.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir, loadConfig } from "../config.js";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function createServerStatusCommand(): Command {
  return new Command("status").description("Show coordinator status").action(async () => {
    const configDir = getConfigDir();
    const config = loadConfig();
    const port = config.server.port;
    // issue #279: the PID file is named per instance; the configured port
    // selects which daemon this reports on.
    const pidPath = existingPidFilePath(configDir, port);

    if (!existsSync(pidPath)) {
      console.log("Coordinator: stopped");
      process.exitCode = 1;
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
      process.exitCode = 1;
      return;
    }

    const health = await fetchJson<{ status?: string }>(`http://localhost:${port}/health`);

    // /health returns {"status":"alive",...} since the health endpoint rewrite;
    // accept "ok" too for backwards-compat with any older daemon still running.
    if (health?.status === "alive" || health?.status === "ok") {
      const status = await fetchJson<{
        online?: number;
        open_threads?: number;
        hot_files?: number;
      }>(`http://localhost:${port}/api/status`, { method: "POST" });

      console.log(`Coordinator: running (PID ${pid}, port ${port})`);
      if (status?.online !== undefined) {
        console.log(`Agents:      ${status.online} online`);
        console.log(`Threads:     ${status.open_threads} open`);
      }
      console.log(`Dashboard:   http://localhost:${port}/dashboard`);
    } else {
      console.log(`Coordinator: running (PID ${pid}) but health check failed`);
      process.exitCode = 1;
    }
  });
}
