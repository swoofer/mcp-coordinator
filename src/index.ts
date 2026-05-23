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

    // STDIO mode is unauthenticated by contract — the trust boundary is "the
    // user spawned this binary", same as any local stdio MCP server. We pass
    // a getSessionClaims that returns synthetic legacy claims for every call
    // (the empty-string sessionId is the stdio sentinel; see fix #133).
    // Mirrors the AUTH_ENABLED=false synthetic-claims path in
    // src/serve-http.ts:315-317.
    const server = createMcpServer(services, () => ({
      sub: "stdio-local",
      user_id: "stdio-local",
      org: "default",
      role: "admin",
      jti: "stdio-local",
    }));
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("mcp-coordinator running on stdio (no MQTT broker in stdio mode)");
  }

  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
