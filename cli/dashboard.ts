import { Command } from "commander";
import { spawn } from "child_process";

export function createDashboardCommand(): Command {
  return new Command("dashboard")
    .description("Open the real-time dashboard")
    .action(() => {
      const url = "http://localhost:3100/dashboard";
      console.log(`Dashboard: ${url}`);
      // Use spawn with an argv array (no shell) so the URL is never
      // interpolated into a shell command — eliminates command-injection risk.
      const opener =
        process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer.exe"
        : "xdg-open";
      const child = spawn(opener, [url], { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    });
}
