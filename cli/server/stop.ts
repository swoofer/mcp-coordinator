import { Command } from "commander";
import { readFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config.js";

export function createServerStopCommand(): Command {
  return new Command("stop").description("Stop the coordination server").action(() => {
    const pidPath = join(getConfigDir(), "server.pid");

    if (!existsSync(pidPath)) {
      console.error("No server PID file found. Is the server running?");
      process.exit(1);
    }

    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (isNaN(pid)) {
      console.error("Invalid PID file. Removing.");
      unlinkSync(pidPath);
      process.exit(1);
    }

    // Check if process is alive
    try {
      process.kill(pid, 0);
    } catch {
      console.log(`Server (PID ${pid}) is not running. Cleaning up PID file.`);
      unlinkSync(pidPath);
      return;
    }

    // Send SIGTERM
    console.log(`Stopping coordinator (PID ${pid})...`);
    process.kill(pid, "SIGTERM");

    // Wait up to 5 seconds
    const deadline = Date.now() + 5000;
    const check = () => {
      try {
        process.kill(pid, 0);
        if (Date.now() < deadline) {
          setTimeout(check, 200);
        } else {
          console.log("Server did not stop gracefully. Sending SIGKILL.");
          process.kill(pid, "SIGKILL");
          try {
            unlinkSync(pidPath);
          } catch {}
        }
      } catch {
        console.log("Coordinator stopped.");
        try {
          unlinkSync(pidPath);
        } catch {}
      }
    };
    check();
  });
}
