/**
 * protocole-mcp-01 (R3 — real stdio entrypoint, end-to-end).
 *
 * The MCP stdio transport spec reserves stdout EXCLUSIVELY for JSON-RPC
 * protocol messages ("MUST NOT" write anything else to stdout). This test
 * spawns the actual `src/index.ts` entrypoint as a subprocess — the same
 * invocation `tests/helpers/mcp-client-harness.ts`'s `createStdioHarness`
 * uses, and what `pnpm dev:stdio` does at the CLI — and inspects the RAW
 * stdout/stderr bytes directly, bypassing the SDK's Client/Transport
 * parsing layer entirely. That matters: `StdioClientTransport` swallows a
 * stray non-JSON line into `onerror` rather than failing the handshake, so
 * a test built on top of the SDK Client (like mcp-stdio-smoke.test.ts)
 * would NOT have caught this bug. Reading the child's raw stdout does.
 *
 * We hand-roll the `initialize` JSON-RPC request instead of going through
 * `@modelcontextprotocol/sdk`'s Client, specifically so nothing sits
 * between the subprocess's stdout pipe and this test's assertions.
 */
import { TSX_NODE_ARGS } from "../helpers/tsx-node.js";
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

// The exact string src/index.ts used to log via log.info(...) right after
// connecting the stdio transport (previously routed to console.log = stdout).
const STARTUP_LOG_MSG = "mcp-coordinator running on stdio";

describe("MCP stdio entrypoint — stdout carries ONLY JSON-RPC (protocole-mcp-01)", () => {
  let child: ChildProcess | null = null;
  let dataDir = "";

  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed) {
      // Wait for the subprocess to actually exit (bounded) before touching
      // its dataDir — on Windows, deleting the sqlite file while the child
      // still holds a handle to it throws EBUSY.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        child!.once("exit", done);
        child!.kill("SIGTERM");
        setTimeout(() => {
          try {
            child!.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, 3000).unref();
      });
    }
    child = null;
    if (dataDir) {
      // Windows: the sqlite file handle can lag slightly behind process
      // exit; retry the cleanup instead of failing the test on a teardown
      // race unrelated to what this test verifies.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt === 4) throw err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  });

  it("every stdout line is valid JSON-RPC; the startup log line lands on stderr, never stdout", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "mcp-stdio-purity-"));
    const command = process.execPath;
    const args = [...TSX_NODE_ARGS, path.join(REPO_ROOT, "src", "index.ts")];

    child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        COORDINATOR_DATA_DIR: dataDir,
        COORDINATOR_AUTH_ENABLED: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child!.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
    child!.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

    // Real JSON-RPC `initialize` request, framed exactly like the SDK
    // does (newline-delimited JSON — see
    // @modelcontextprotocol/sdk/shared/stdio.js: serializeMessage).
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stdio-purity-test", version: "0.0.0-test" },
      },
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for initialize response on stdout")),
        25_000,
      );
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            clearTimeout(timeout);
            child!.stdout!.off("data", onData);
            resolve();
            return;
          }
        }
      };
      child!.stdout!.on("data", onData);
      child!.on("error", reject);
      child!.stdin!.write(JSON.stringify(initializeRequest) + "\n");
    });

    // The startup log (index.ts, right after `await server.connect(...)`)
    // is written via pino's fd-2 destination, which flushes async — give
    // it a moment before reading the accumulated buffers.
    await new Promise((r) => setTimeout(r, 500));

    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");

    // 1) NEGATIVE (the actual regression this task fixes): the startup
    //    log line must never reach stdout.
    expect(stdoutRaw).not.toContain(STARTUP_LOG_MSG);

    // 2) Sanity: assertion (1) isn't vacuous — the line WAS logged, just
    //    on stderr, where MCP stdio-mode logs belong.
    expect(stderrRaw).toContain(STARTUP_LOG_MSG);

    // 3) Every non-empty stdout line ever emitted parses as JSON-RPC —
    //    i.e. stdout is exclusively the protocol stream, never prose.
    const lines = stdoutRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line); // throws -> test fails if a line isn't JSON
      expect(parsed).toHaveProperty("jsonrpc", "2.0");
    }
  }, 30_000);
});
