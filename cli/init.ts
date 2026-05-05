import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { ensureConfigDir, loadConfig, saveConfig } from "./config.js";

const CLAUDE_MD_TEMPLATE = `## Coordination via mcp-coordinator

You share a coordinator with other Claude Code sessions on this repo. Use the
\`coordinator\` MCP tools to announce work and resolve conflicts before writing
code.

### How coordination flows (important — read first)

You communicate with the coordinator over MCP (request/response). You do NOT
receive automatic push notifications. To stay aware of what other agents are
doing, you must **poll** at the right moments:

- **Session start** — call \`register_agent\` once.
- **Before any source-file change** — call \`announce_work\`. The response tells
  you immediately if a thread was opened (conflict detected). If yes, react.
- **Before resuming work after a non-trivial pause** (e.g., before a new
  feature, between phases, after returning from a sub-task) — call
  \`coordinator_status\` to see if anyone has posted to threads you're a
  participant in. New posts may need your reply or vote.
- **Anytime you suspect activity** — call \`list_threads\` or
  \`coordinator_status\` to scan for open threads.

If you skip the polling step, you can still write code, but you may miss a
question another agent posted on a thread you opened. The dashboard
(\`http://localhost:3100/dashboard\`) is the human's view of all activity if
you want a quick visual.

### Before any source-file change

1. (Once per session) Call \`register_agent\` with your name and the modules
   you plan to touch.
2. Call \`announce_work\` with:
   - \`subject\`: short description of the change
   - \`target_files\`: files you will modify
   - \`depends_on_files\` (optional): files whose interface you depend on
   - \`target_modules\`: bounded contexts you'll touch
3. **Read the response carefully**. If \`thread_id\` is present, a conflict
   was detected — DO NOT proceed to code. Instead:
   - Call \`get_thread(thread_id)\` to see what other agents have said.
   - Call \`post_to_thread\` with \`type: "context"\` to share your plan and
     constraints.
   - Wait for the other agent to acknowledge. Poll \`get_thread_updates\` or
     \`coordinator_status\` until the thread reaches \`resolving\`.
   - When a resolution is proposed, call \`approve_resolution\` or
     \`contest_resolution\` (with reason).
   - Only proceed to code once the thread is \`resolved\`.
4. After completing a meaningful change, call \`log_action_summary\` to update
   the dashboard timeline.

### Polling for thread updates (the most-missed step)

Whenever you've opened a thread or are a participant in one, the other agents
may post new context. They cannot push to you — you must check. A reasonable
cadence:

- **Whenever you call any other coordinator tool** (announce_work,
  log_action_summary, etc.), spend one extra call on
  \`coordinator_status\` and scan for open threads where the latest message is
  from someone else.
- **Before each major task transition** (finishing one feature, starting the
  next), call \`list_threads\` or \`coordinator_status\` once.

A useful pattern: after every 3-5 file edits, run
\`coordinator_status\` once to confirm no thread you opened is still waiting on
your input.

### Tools you'll reach for most

- \`coordinator_status\` — full system snapshot (agents, threads, files, quota)
- \`announce_work\` / \`post_to_thread\` / \`approve_resolution\` /
  \`contest_resolution\` — consultation flow
- \`get_thread_updates\` — fetch only new posts since a timestamp
- \`hot_files\` — files multiple agents are editing
- \`check_file_conflict\` — quick check before opening a file

If you want push-based coordination (real-time interrupts between agent
turns instead of polling), see [essaim](https://github.com/swoofer/essaim) —
it ships an agent-loop wrapper that subscribes to the coordinator's MQTT
broker and injects events into your turn flow automatically.
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
