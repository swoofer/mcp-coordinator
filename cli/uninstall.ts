import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, rmSync, statSync } from "fs";
import { resolve } from "path";
import { getConfigDir } from "./config.js";

const SENTINEL = "<!-- mcp-coordinator:coordination-section -->";

export function createUninstallCommand(): Command {
  return new Command("uninstall")
    .description(
      "Remove mcp-coordinator integrations: the 'coordinator' MCP server entry from a .mcp.json, the coordination section from a CLAUDE.md, and (with --purge) the ~/.mcp-coordinator/ directory.",
    )
    .option(
      "--mcp-config <path>",
      "Remove the 'coordinator' entry from <path>/.mcp.json (leaves other servers untouched). Removes the file if it ends up empty.",
    )
    .option(
      "--claude-md <path>",
      "Remove the mcp-coordinator coordination section from <path>/CLAUDE.md (between the sentinel comments). Leaves other content untouched.",
    )
    .option(
      "--purge",
      "Delete the ~/.mcp-coordinator/ directory entirely (config + data + logs + pid file). Asks for confirmation unless --force is set.",
    )
    .option("--force", "Skip the confirmation prompt for --purge. Useful in scripts.")
    .action(
      async (opts: { mcpConfig?: string; claudeMd?: string; purge?: boolean; force?: boolean }) => {
        let didSomething = false;
        let exitCode = 0;

        const validateDir = (p: string, label: string): string | null => {
          const abs = resolve(p);
          if (!existsSync(abs)) {
            console.error(`Error: ${label} path ${abs} does not exist.`);
            return null;
          }
          const st = statSync(abs);
          if (!st.isDirectory()) {
            console.error(`Error: ${label} path ${abs} is not a directory.`);
            return null;
          }
          return abs;
        };

        // 1. Remove coordinator from .mcp.json
        if (opts.mcpConfig) {
          const dirAbs = validateDir(opts.mcpConfig, "--mcp-config");
          if (!dirAbs) {
            exitCode = 1;
          } else {
            const target = resolve(dirAbs, ".mcp.json");
            if (!existsSync(target)) {
              console.log(`No .mcp.json at ${target} — nothing to remove.`);
            } else {
              try {
                const json = JSON.parse(readFileSync(target, "utf-8")) as {
                  mcpServers?: Record<string, unknown>;
                };
                if (json.mcpServers && "coordinator" in json.mcpServers) {
                  delete json.mcpServers.coordinator;
                  if (Object.keys(json.mcpServers).length === 0) {
                    delete json.mcpServers;
                  }
                  if (Object.keys(json).length === 0) {
                    rmSync(target);
                    console.log(`Removed empty .mcp.json:  ${target}`);
                  } else {
                    writeFileSync(target, JSON.stringify(json, null, 2) + "\n");
                    console.log(`Removed coordinator entry from ${target}`);
                  }
                  didSomething = true;
                } else {
                  console.log(`No coordinator entry in ${target} — nothing to remove.`);
                }
              } catch (e) {
                // issue #273: this catch spans the read, the rewrite
                // (writeFileSync) and the delete (rmSync), so "Error reading"
                // was wrong for two of the three — and misleading in exactly
                // the case that matters, a permission-denied write.
                console.error(`Error updating ${target}: ${(e as Error).message}`);
                exitCode = 1;
              }
            }
          }
        }

        // 2. Remove coordination section from CLAUDE.md
        if (opts.claudeMd) {
          const dirAbs = validateDir(opts.claudeMd, "--claude-md");
          if (!dirAbs) {
            exitCode = 1;
          } else {
            const target = resolve(dirAbs, "CLAUDE.md");
            if (!existsSync(target)) {
              console.log(`No CLAUDE.md at ${target} — nothing to remove.`);
            } else {
              const content = readFileSync(target, "utf-8");
              if (!content.includes(SENTINEL)) {
                console.log(`No mcp-coordinator section in ${target} — nothing to remove.`);
              } else {
                const re = new RegExp(`${SENTINEL}[\\s\\S]*?${SENTINEL}\\n?`, "g");
                const cleaned = content.replace(re, "");
                const tidied = cleaned
                  .replace(/\n{3,}/g, "\n\n")
                  .replace(/^\n+/, "")
                  .replace(/\n+$/, "\n");
                if (tidied.trim() === "" || tidied.trim() === "# CLAUDE.md") {
                  rmSync(target);
                  console.log(`Removed empty CLAUDE.md:  ${target}`);
                } else {
                  writeFileSync(target, tidied);
                  console.log(`Removed coordination section from ${target}`);
                }
                didSomething = true;
              }
            }
          }
        }

        // 3. Purge ~/.mcp-coordinator/
        if (opts.purge) {
          const dir = getConfigDir();
          if (!existsSync(dir)) {
            console.log(`No config dir at ${dir} — nothing to purge.`);
          } else {
            if (!opts.force) {
              // Read a single line from stdin
              const ask = await new Promise<string>((resolveP) => {
                process.stdout.write(`Delete ${dir} (config, data, logs, pid)? [y/N] `);
                process.stdin.once("data", (b) => resolveP(b.toString().trim()));
              });
              if (ask.toLowerCase() !== "y" && ask.toLowerCase() !== "yes") {
                console.log("Aborted.");
                if (exitCode !== 0) process.exit(exitCode);
                return;
              }
            }
            rmSync(dir, { recursive: true, force: true });
            console.log(`Purged config dir:        ${dir}`);
            didSomething = true;
          }
        }

        if (!opts.mcpConfig && !opts.claudeMd && !opts.purge) {
          console.log(
            "Nothing to do. Pass --mcp-config <path>, --claude-md <path>, --purge, or any combination.",
          );
          console.log("");
          console.log("Examples:");
          console.log("  mcp-coordinator uninstall --mcp-config ~/my-repo");
          console.log("  mcp-coordinator uninstall --claude-md ~/my-repo");
          console.log("  mcp-coordinator uninstall --mcp-config ~/my-repo --claude-md ~/my-repo");
          console.log("  mcp-coordinator uninstall --purge --force");
          console.log("");
          console.log("To remove the npm package itself: npm uninstall -g mcp-coordinator");
          process.exit(0);
        }

        if (!didSomething) {
          console.log("");
          console.log("No changes made.");
        }

        if (exitCode !== 0) process.exit(exitCode);
      },
    );
}
