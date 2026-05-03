import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServices, createMcpServer } from "./server-setup.js";
import { createLogger } from "./logger.js";

const DATA_DIR = process.env.COORDINATOR_DATA_DIR || "./data";

async function main(): Promise<void> {
  const services = createServices({ dataDir: DATA_DIR });
  const log = services.logger;

  const server = createMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Coordinator v3 running on stdio (no MQTT broker in stdio mode)");
}

main().catch((err) => {
  const log = createLogger();
  log.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
