import { pathToFileURL } from "url";
import { runStdioServer } from "./stdio-server.js";

// Re-export the public package surface for npm consumers
export { startServer, type ServerOptions } from "./serve-http.js";
export { createServices, createMcpServer } from "./server-setup.js";
export { runStdioServer, type StdioServerOptions } from "./stdio-server.js";

// STDIO entry: only run when invoked directly (not when imported).
// Uses pathToFileURL for cross-platform correctness (handles Windows drive letters
// + the file:///C:/... vs file://C:/... slash-count mismatch). Guards against
// process.argv[1] being undefined (REPL, some bundlers).
//
// #277 moved the body to src/stdio-server.ts so `mcp-coordinator stdio` can
// start the same server. This entry point stays: docs/clients.md documents
// `node dist/src/index.js`, and existing .mcp.json files point at it.
const isMainModule =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  runStdioServer().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
