import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServices, createMcpServer } from "./server-setup.js";

// Re-export the public package surface for npm consumers
export { startServer, type ServerOptions } from "./serve-http.js";
export { createServices, createMcpServer } from "./server-setup.js";

// STDIO entry: only run when invoked directly (not when imported)
const isMainModule = import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));

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
