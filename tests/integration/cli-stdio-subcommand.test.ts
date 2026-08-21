/**
 * issue #277 — the README told readers a client could connect over stdio, and
 * the stdio server did ship, but there was no way to launch it by name. A
 * stdio-only client had to be pointed at a raw path
 * (`<npm root -g>/mcp-coordinator/dist/src/index.js`), which breaks on
 * reinstall to a different prefix and differs between global, local and npx
 * installs.
 *
 * `mcp-coordinator stdio` now starts the same server. The risk that introduces
 * is specific: the CLI layer sits in front of the transport, and the MCP stdio
 * spec reserves stdout EXCLUSIVELY for JSON-RPC. A single Commander line on
 * stdout would corrupt the stream — and it would not fail loudly, because
 * StdioClientTransport routes an unparseable line to onerror rather than
 * failing the handshake. So this reads the child's raw stdout, exactly as
 * stdio-log-purity.test.ts does for the direct entry point.
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

const STARTUP_LOG_MSG = "mcp-coordinator running on stdio";

describe("mcp-coordinator stdio (#277)", () => {
  let child: ChildProcess | null = null;
  let dataDir = "";

  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        child!.kill("SIGTERM");
        setTimeout(() => {
          try {
            child!.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          resolve();
        }, 3000).unref();
      });
    }
    child = null;
    if (dataDir) {
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

  it("serves MCP over stdio, and the CLI layer writes nothing to stdout", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "cli-stdio-"));
    // node + the tsx loader (tests/helpers/tsx-node.ts) rather than a .cmd
    // shim -- see that file for why.
    //
    // Through the CLI entry point, not src/index.ts — that the subcommand path
    // is equivalent is the whole claim.
    const args = [
      ...TSX_NODE_ARGS,
      path.join(REPO_ROOT, "cli", "index.ts"),
      "stdio",
      "--data-dir",
      dataDir,
    ];

    child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, COORDINATOR_AUTH_ENABLED: "false" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child!.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
    child!.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "cli-stdio-test", version: "0.0.0-test" },
      },
    };

    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              `timed out waiting for initialize response on stdout. stderr so far:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
            ),
          ),
        30_000,
      );
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === 1) {
            clearTimeout(timeout);
            child!.stdout!.off("data", onData);
            resolve(msg);
            return;
          }
        }
      };
      child!.stdout!.on("data", onData);
      child!.on("error", reject);
      child!.stdin!.write(JSON.stringify(initializeRequest) + "\n");
    });

    // It is a real MCP server, not just a process that echoed something.
    expect(response).toHaveProperty("jsonrpc", "2.0");
    expect(response.result).toHaveProperty("serverInfo");

    await new Promise((r) => setTimeout(r, 500));
    const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
    const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");

    // Every stdout line is protocol, never prose — the risk the CLI adds.
    const lines = stdoutRaw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line)).toHaveProperty("jsonrpc", "2.0");
    }

    // And the assertion above is not vacuous: the startup line was logged, on
    // stderr, where stdio-mode logs belong.
    expect(stdoutRaw).not.toContain(STARTUP_LOG_MSG);
    expect(stderrRaw).toContain(STARTUP_LOG_MSG);

    // --data-dir was honoured: passing it explicitly suppresses the
    // cwd-relative-./data warning the direct entry point emits.
    expect(stderrRaw).not.toContain("COORDINATOR_DATA_DIR not set");
  }, 60_000);
});
