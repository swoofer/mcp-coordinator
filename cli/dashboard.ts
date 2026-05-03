import { Command } from "commander";
import { exec } from "child_process";

export function createDashboardCommand(): Command {
  return new Command("dashboard")
    .description("Open the real-time dashboard")
    .action(() => {
      const url = "http://localhost:3100/dashboard";
      console.log(`Dashboard: ${url}`);
      const cmd =
        process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}" 2>/dev/null`;
      exec(cmd, () => {});
    });
}
