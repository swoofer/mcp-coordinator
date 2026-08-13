/**
 * MCP integration test harness — exercises the same `mcp-coordinator`
 * server you ship from the consumer side, using the official MCP SDK
 * client. Two transports are supported:
 *
 *   - stdio: spawns `src/index.ts` as a subprocess and talks to it over
 *     stdin/stdout. This is what `pnpm dev:stdio` does at the CLI, and
 *     what `mcp-coordinator channel` (#130) will do once the Channels
 *     integration lands.
 *   - http:  starts an in-process HTTP server via `startServer(...)` from
 *     `src/serve-http.ts` and connects with the streamable-HTTP client.
 *     This is the production transport for `pnpm dev` / the daemon flow.
 *
 * The harness returns a typed `Client` from `@modelcontextprotocol/sdk`
 * so tests can call `client.listTools()`, `client.callTool({...})`,
 * `client.setNotificationHandler(...)` exactly like a real consumer.
 *
 * The cleanup function MUST run in afterAll (or the test's finally block);
 * otherwise subprocesses and HTTP listeners leak across the suite.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, type ServerHandle } from "../../src/serve-http.js";

/** Common shape of every harness — call `cleanup()` in afterAll. */
export interface McpHarness {
  client: Client;
  cleanup: () => Promise<void>;
  /** Disposable scratch directory the server wrote into. Tests usually don't care. */
  dataDir: string;
}

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

/**
 * Spawn `src/index.ts` over stdio and connect a client to it.
 *
 * Auth is intentionally off (the stdio mode in src/index.ts does not gate
 * tool calls — it trusts the spawning process). MQTT broker is NOT started
 * by stdio mode, so any test that expects MQTT push events should use the
 * HTTP harness instead.
 */
export async function createStdioHarness(opts?: {
  dataDir?: string;
  env?: Record<string, string>;
}): Promise<McpHarness> {
  const dataDir = opts?.dataDir ?? mkdtempSync(path.join(tmpdir(), "mcp-stdio-harness-"));

  // tsx is on the dev PATH; lets us run src/index.ts directly without a
  // pre-built dist/. Falls back to npx-style invocation if tsx isn't on PATH.
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["tsx", path.join(REPO_ROOT, "src", "index.ts")];

  const transport = new StdioClientTransport({
    command,
    args,
    env: {
      ...(process.env as Record<string, string>),
      COORDINATOR_DATA_DIR: dataDir,
      // Defensive: never let the spawned process try to enable auth.
      COORDINATOR_AUTH_ENABLED: "false",
      ...(opts?.env ?? {}),
    },
    // Pipe stderr through so test output surfaces server logs on failure.
    stderr: "pipe",
  });

  const client = new Client(
    { name: "mcp-coordinator-harness-stdio", version: "0.0.0-test" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    client,
    dataDir,
    cleanup: async () => {
      try {
        await client.close();
      } catch {
        // Subprocess may already be gone; swallow.
      }
      if (!opts?.dataDir) {
        // We created the tmp dir, so we clean it.
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Start the in-process HTTP server via `startServer({...})` and connect a
 * streamable-HTTP client to its /mcp endpoint.
 *
 * Auth defaults to off (env `COORDINATOR_AUTH_ENABLED` unset). Both the
 * HTTP MCP endpoint and the embedded MQTT broker run for the duration of
 * the test — handy for any future test that wants to verify the daemon's
 * MQTT events alongside the MCP HTTP surface.
 */
export async function createHttpHarness(opts?: {
  dataDir?: string;
  port?: number;
  mqttTcpPort?: number;
}): Promise<McpHarness & { server: ServerHandle; httpPort: number }> {
  const dataDir = opts?.dataDir ?? mkdtempSync(path.join(tmpdir(), "mcp-http-harness-"));

  // Port 0 = "OS, pick a free port as you bind it". We used to probe for a
  // free port by binding :0, closing, and handing the number to startServer —
  // which left a window where a parallel vitest worker doing the same dance
  // could be handed the same port and win the re-bind, so one of us died with
  // EADDRINUSE. Binding once removes the window entirely.
  const server = await startServer({
    port: opts?.port ?? 0,
    dataDir,
    mqttTcpPort: opts?.mqttTcpPort ?? 0,
  });
  const port = server.port;

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client(
    { name: "mcp-coordinator-harness-http", version: "0.0.0-test" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    client,
    server,
    httpPort: port,
    dataDir,
    cleanup: async () => {
      try {
        await client.close();
      } catch {}
      try {
        await server.stop();
      } catch {}
      if (!opts?.dataDir) {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}
