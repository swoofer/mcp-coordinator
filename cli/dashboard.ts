import { Command } from "commander";
import { spawn } from "child_process";
import { getConfigDir, loadConfig } from "./config.js";

interface DashboardOpts {
  url?: string;
}

export function createDashboardCommand(): Command {
  return new Command("dashboard")
    .description("Open the real-time dashboard")
    .option("--url <url>", "Dashboard URL to open (overrides the configured port)")
    .action((opts: DashboardOpts) => {
      // issue #69: the URL was hardcoded to :3100, so anyone running on a
      // different port — which `server start --port` and config.server.port
      // both allow — got a dead tab. `server status` already resolves the port
      // from config; read it from the same place rather than adding a second
      // source of truth. --url stays as the escape hatch for a reverse proxy
      // or a remote coordinator, where no local config describes the address.
      const url =
        opts.url ?? `http://localhost:${loadConfig(getConfigDir()).server.port}/dashboard`;
      console.log(`Dashboard: ${url}`);
      // Use spawn with an argv array (no shell) so the URL is never
      // interpolated into a shell command — eliminates command-injection risk.
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer.exe"
            : "xdg-open";
      const child = spawn(opener, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    });
}
