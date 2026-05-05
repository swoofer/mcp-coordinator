import { Command } from "commander";
import { existsSync, statSync, openSync, readSync, closeSync, watchFile, unwatchFile } from "fs";
import { join } from "path";
import { getConfigDir } from "../config.js";

export function createServerLogsCommand(): Command {
  return new Command("logs")
    .description("Tail the daemon server log at ~/.mcp-coordinator/logs/server.log")
    .option("-n, --lines <n>", "Print the last N lines and exit (default: 50)", "50")
    .option("-f, --follow", "After printing the tail, follow the file for new lines")
    .action((opts: { lines: string; follow?: boolean }) => {
      const logPath = join(getConfigDir(), "logs", "server.log");
      if (!existsSync(logPath)) {
        console.error(`No log file at ${logPath}.`);
        console.error("The server has never been started in daemon mode (foreground runs print to stdout).");
        console.error("Start a daemon: mcp-coordinator server start --daemon");
        process.exit(1);
      }

      const n = Math.max(1, parseInt(opts.lines, 10) || 50);

      // Print the last N lines by reading from the end of the file in chunks.
      const fd = openSync(logPath, "r");
      try {
        const size = statSync(logPath).size;
        const chunkSize = 65536;
        let pos = size;
        let collected = "";
        let newlines = 0;
        while (pos > 0 && newlines <= n) {
          const readLen = Math.min(chunkSize, pos);
          pos -= readLen;
          const buf = Buffer.alloc(readLen);
          readSync(fd, buf, 0, readLen, pos);
          const piece = buf.toString("utf-8");
          collected = piece + collected;
          newlines = (collected.match(/\n/g) ?? []).length;
        }
        const lines = collected.split("\n");
        const tail = lines.slice(Math.max(0, lines.length - n - 1));
        process.stdout.write(tail.join("\n"));
        if (!collected.endsWith("\n")) process.stdout.write("\n");
      } finally {
        closeSync(fd);
      }

      if (!opts.follow) return;

      // Follow mode: poll the file for size changes and print appended bytes.
      let lastSize = statSync(logPath).size;
      const onChange = () => {
        try {
          const cur = statSync(logPath).size;
          if (cur < lastSize) {
            // file truncated/rotated — reset
            lastSize = 0;
          }
          if (cur > lastSize) {
            const fd2 = openSync(logPath, "r");
            try {
              const buf = Buffer.alloc(cur - lastSize);
              readSync(fd2, buf, 0, buf.length, lastSize);
              process.stdout.write(buf.toString("utf-8"));
              lastSize = cur;
            } finally {
              closeSync(fd2);
            }
          }
        } catch {
          // ignore transient errors during rotation
        }
      };

      console.log("");
      console.log("[following — Ctrl+C to stop]");

      watchFile(logPath, { interval: 500 }, onChange);

      const cleanup = () => {
        unwatchFile(logPath, onChange);
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    });
}
