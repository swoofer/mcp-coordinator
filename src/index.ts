import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "url";
import { createServices, createMcpServer } from "./server-setup.js";

// Re-export the public package surface for npm consumers
export { startServer, type ServerOptions } from "./serve-http.js";
export { createServices, createMcpServer } from "./server-setup.js";

// STDIO entry: only run when invoked directly (not when imported).
// Uses pathToFileURL for cross-platform correctness (handles Windows drive letters
// + the file:///C:/... vs file://C:/... slash-count mismatch). Guards against
// process.argv[1] being undefined (REPL, some bundlers).
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const DATA_DIR = process.env.COORDINATOR_DATA_DIR || "./data";

  async function main(): Promise<void> {
    const services = createServices({ dataDir: DATA_DIR });
    const log = services.logger;

    const server = createMcpServer(services);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("mcp-coordinator running on stdio (no MQTT broker in stdio mode)");
  }

  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
