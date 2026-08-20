import { Command } from "commander";

/**
 * `mcp-coordinator stdio` — run the coordinator as a stdio MCP server (#277).
 *
 * The stdio server has always shipped (src/index.ts, in the npm `files` list),
 * but there was no way to launch it by name, so a stdio-only client had to be
 * pointed at a raw path:
 *
 *   { "command": "node", "args": ["<npm root -g>/mcp-coordinator/dist/src/index.js"] }
 *
 * which breaks on reinstall to a different prefix, differs between global,
 * local and npx installs, and requires knowing `npm root -g`. The README
 * already told readers a client could connect over stdio.
 *
 * The import of the server graph is inside the action on purpose: registering
 * this command must not pull it in for every other invocation (#278).
 */
export function createStdioCommand(): Command {
  return new Command("stdio")
    .description("Run as a stdio MCP server (single client, no MQTT broker — see --help)")
    .addHelpText(
      "after",
      [
        "",
        "stdio is a different topology, not just a different transport:",
        "",
        "  - No MQTT broker. wait_for_message, get_queued_messages and",
        "    mqtt_publish are unavailable.",
        "  - One process and one SQLite handle per client, instead of one shared",
        "    daemon. Two stdio clients do not see each other.",
        "  - Unauthenticated by contract: the trust boundary is that you spawned",
        "    the process.",
        "  - No retention sweeper runs, so nothing is ever purged.",
        "",
        "For coordination BETWEEN agents — what this tool is for — run the daemon",
        "instead: `mcp-coordinator server start --daemon`, then point clients at",
        "its HTTP endpoint. Use stdio for a single-agent setup or for development.",
      ].join("\n"),
    )
    .option("--data-dir <path>", "Directory for the SQLite database")
    .action(async (opts: { dataDir?: string }) => {
      const { runStdioServer } = await import("../src/stdio-server.js");
      await runStdioServer({ dataDir: opts.dataDir });
    });
}
