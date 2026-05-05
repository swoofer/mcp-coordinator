import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { ensureConfigDir, loadConfig, saveConfig } from "./config.js";

const CLAUDE_MD_TEMPLATE = `## Coordination via mcp-coordinator

You share a coordinator with other Claude Code sessions on this repo. Use the
\`coordinator\` MCP tools to announce work and resolve conflicts before writing
code.

### Before any source-file change

1. Call \`register_agent\` once per session, with your name and the modules you
   plan to touch.
2. Call \`announce_work\` with:
   - \`subject\`: short description of the change
   - \`target_files\`: files you will modify
   - \`depends_on_files\` (optional): files whose interface you depend on
   - \`target_modules\`: bounded contexts you'll touch
3. If the coordinator opens a thread (consultation triggered), wait for the
   resolution before writing code. Read the thread with \`get_thread\`, post
   context via \`post_to_thread\`, and either \`approve_resolution\` or
   \`contest_resolution\` once a proposal exists.
4. After completing a meaningful change, call \`log_action_summary\` to update
   the dashboard timeline.

### When another agent is already working on your file

Don't override silently. \`post_to_thread\` to ask, then wait for their reply
before proceeding. If the thread is in \`resolving\` state, vote on the
resolution rather than writing code.

### Tools you'll reach for most

- \`coordinator_status\` — full system snapshot (agents, threads, files, quota)
- \`announce_work\` / \`post_to_thread\` / \`approve_resolution\` /
  \`contest_resolution\` — consultation flow
- \`hot_files\` — files multiple agents are editing
- \`check_file_conflict\` — quick check before opening a file

The dashboard at the coordinator URL (default
\`http://localhost:3100/dashboard\`) shows everything live.
`;

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
      "Write the .mcp.json snippet into <path>/.mcp.json (merges if the file already exists). <path> must be an existing directory.",
    )
    .option(
      "--write-claude-md <path>",
      "Write a sample CLAUDE.md (system instructions for your coordinator-aware agent) into <path>/CLAUDE.md (merges with existing — appends a clearly-marked section). <path> must be an existing directory.",
    )
    .action((opts: { url?: string; writeMcpConfig?: string; writeClaudeMd?: string }) => {
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

      let exitCode = 0;

      if (opts.writeMcpConfig) {
        const dirAbs = validateDir(opts.writeMcpConfig, "--write-mcp-config");
        if (!dirAbs) {
          exitCode = 1;
        } else {
          const target = resolve(dirAbs, ".mcp.json");
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
        }
      }

      if (opts.writeClaudeMd) {
        const dirAbs = validateDir(opts.writeClaudeMd, "--write-claude-md");
        if (!dirAbs) {
          exitCode = 1;
        } else {
          const target = resolve(dirAbs, "CLAUDE.md");
          const SENTINEL = "<!-- mcp-coordinator:coordination-section -->";
          const sectionBody = SENTINEL + "\n" + CLAUDE_MD_TEMPLATE + SENTINEL + "\n";
          let final: string;
          if (existsSync(target)) {
            const existing = readFileSync(target, "utf-8");
            if (existing.includes(SENTINEL)) {
              const re = new RegExp(
                `${SENTINEL}[\\s\\S]*?${SENTINEL}\\n?`,
                "g",
              );
              final = existing.replace(re, sectionBody);
              console.log(`Updated CLAUDE.md (replaced existing coordinator section): ${target}`);
            } else {
              const sep = existing.endsWith("\n") ? "\n" : "\n\n";
              final = existing + sep + sectionBody;
              console.log(`Appended coordinator section to CLAUDE.md: ${target}`);
            }
          } else {
            final = "# CLAUDE.md\n\n" + sectionBody;
            console.log(`Wrote CLAUDE.md:         ${target}`);
          }
          writeFileSync(target, final);
        }
      }

      if (!opts.writeMcpConfig && !opts.writeClaudeMd) {
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
      console.log("  4. Health check:           mcp-coordinator doctor");

      if (exitCode !== 0) {
        process.exit(exitCode);
      }
    });
}
