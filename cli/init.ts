import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { ensureConfigDir, loadConfig, saveConfig } from "./config.js";

export function createInitCommand(): Command {
  return new Command("init")
    .description(
      "First-time setup: create the config dir, write a default config.json, and print a .mcp.json snippet for your MCP client",
    )
    .option(
      "--url <url>",
      "Coordinator URL to use in the printed .mcp.json snippet (defaults to http://localhost:<port>/mcp)",
    )
    .option(
      "--write-mcp-config <path>",
      "Write the .mcp.json snippet into <path>/.mcp.json (merges if the file already exists)",
    )
    .action((opts: { url?: string; writeMcpConfig?: string }) => {
      const dir = ensureConfigDir();
      console.log(`Config directory: ${dir}`);

      const configPath = join(dir, "config.json");
      if (!existsSync(configPath)) {
        saveConfig(loadConfig());
        console.log(`Wrote default config:    ${configPath}`);
      } else {
        console.log(`Config already exists:   ${configPath} (untouched)`);
      }

      const config = loadConfig();
      const url = opts.url ?? `http://localhost:${config.server.port}/mcp`;

      const snippet = {
        mcpServers: {
          coordinator: {
            type: "http",
            url,
          },
        },
      };

      if (opts.writeMcpConfig) {
        const target = resolve(opts.writeMcpConfig, ".mcp.json");
        let merged: { mcpServers?: Record<string, unknown> } = snippet;
        if (existsSync(target)) {
          try {
            const existing = JSON.parse(readFileSync(target, "utf-8")) as {
              mcpServers?: Record<string, unknown>;
            };
            merged = {
              ...existing,
              mcpServers: {
                ...(existing.mcpServers ?? {}),
                coordinator: snippet.mcpServers.coordinator,
              },
            };
          } catch {
            console.warn(`Warning: ${target} is not valid JSON; overwriting`);
          }
        }
        writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
        console.log(`Wrote MCP config:        ${target}`);
      } else {
        console.log("");
        console.log("Add this to your MCP client (e.g., ~/.claude/.mcp.json):");
        console.log("");
        console.log(JSON.stringify(snippet, null, 2));
      }

      console.log("");
      console.log("Next steps:");
      console.log("  1. Start the coordinator:  mcp-coordinator server start --daemon");
      console.log("  2. Open the dashboard:     mcp-coordinator dashboard");
      console.log("  3. Connect any MCP client (Claude Code, Cursor, Cline, ...) using the snippet above");
    });
}
