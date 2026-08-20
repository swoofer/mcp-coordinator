import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import path from "path";
import { createServices, createMcpServer } from "./server-setup.js";

export interface StdioServerOptions {
  /** Where the SQLite database lives. Defaults to COORDINATOR_DATA_DIR, then ./data. */
  dataDir?: string;
}

/**
 * Run the coordinator as a stdio MCP server until the transport closes.
 *
 * Extracted from src/index.ts's main-module guard so the CLI can start the
 * same server (#277). src/index.ts still works as a direct entry point —
 * `node dist/src/index.js` is what docs/clients.md documents and what existing
 * .mcp.json files point at — it just calls this now instead of inlining it.
 *
 * Nothing here may write to stdout: that stream carries JSON-RPC frames and
 * the MCP stdio transport spec says MUST NOT. createServices({stdio: true})
 * routes every log level to stderr, which is why the logger below is safe.
 */
export async function runStdioServer(opts: StdioServerOptions = {}): Promise<void> {
  const dataDir = opts.dataDir || process.env.COORDINATOR_DATA_DIR || "./data";
  const services = createServices({ dataDir, stdio: true });
  const log = services.logger;

  // architecture-06: same cwd-relative-./data fallback warning as
  // src/serve-http.ts. Only when nothing was chosen — an explicit --data-dir
  // is a choice, and warning about it would be noise.
  if (!opts.dataDir && !process.env.COORDINATOR_DATA_DIR) {
    log.warn(
      { resolvedDataDir: path.resolve(dataDir) },
      `COORDINATOR_DATA_DIR not set — using cwd-relative ./data (${path.resolve(dataDir)}); set COORDINATOR_DATA_DIR or pass --data-dir for a stable location.`,
    );
  }

  // STDIO mode is unauthenticated by contract — the trust boundary is "the
  // user spawned this binary", same as any local stdio MCP server. We pass a
  // getSessionClaims that returns synthetic legacy claims for every call (the
  // empty-string sessionId is the stdio sentinel; see fix #133). Mirrors the
  // AUTH_ENABLED=false synthetic-claims path in src/serve-http.ts.
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
