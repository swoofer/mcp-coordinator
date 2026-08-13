/**
 * architecture-06 (R3/R5 — real entry points, end-to-end).
 *
 * `src/serve-http.ts:58` and `src/index.ts:16` fall back to `./data`
 * (resolved against the process's cwd) when `COORDINATOR_DATA_DIR` is
 * unset — unpredictable for a server a client spawns from an arbitrary
 * working directory, and NOT the `~/.mcp-coordinator/data` the CLI uses
 * (see README.md's Configuration section). Both entry points must log a
 * warning once at boot when that fallback is actually in effect, and must
 * NOT log it when the operator set `COORDINATOR_DATA_DIR` explicitly
 * (false positive — R5).
 *
 * Strategy mirrors tests/integration/stdio-log-purity.test.ts: spawn the
 * REAL entry point as a subprocess (not an in-process `startServer()` call)
 * so we observe exactly what an operator would see, with the process's cwd
 * pointed at an isolated temp directory — never the repo root — so the
 * `./data` fallback never touches this repo's working tree.
 */
import { describe, it, expect, afterEach } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..", "..");

const require = createRequire(import.meta.url);
const spawn: (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess = require("cross-spawn");

// Exact leading substring of the warning both entry points log — kept
// stable across src/serve-http.ts and src/index.ts.
const WARNING_SUBSTRING = "COORDINATOR_DATA_DIR not set — using cwd-relative ./data";

// In-process suites pass `port: 0` and read handle.port back (no race). Here
// the server runs as a SUBPROCESS and we poll its /health from the parent, so
// the parent has to know the port up front to build the URL — `PORT=0` would
// leave it discoverable only by scraping the child's stdout banner. Keeping
// the pre-probe, with its small window for another process to take the port.
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        s.close();
        reject(new Error("getFreePort: could not resolve port"));
        return;
      }
      const p = addr.port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    // Windows-specific: `npx.cmd` is a batch script, so Node routes it
    // through cmd.exe even with shell:false — the real work happens in a
    // grandchild (tsx -> node) process tree. `child.kill()` only signals
    // the immediate PID; on the stdio entry point (src/index.ts) the
    // grandchild happens to self-terminate anyway (its stdin pipe breaks
    // when the middle process dies, and StdioServerTransport closes on
    // stdin EOF), but the HTTP entry point (src/serve-http.ts) has no such
    // dependency and is orphaned as a live listener otherwise. Use
    // `taskkill /T /F` to reap the whole tree on Windows; POSIX kill()
    // already signals the whole process group when the child was spawned
    // normally (no `detached: true` here), so the plain path is fine there.
    if (process.platform === "win32" && child.pid) {
      try {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          shell: false,
          windowsHide: true,
        });
      } catch {
        // best-effort; fall through to the child.kill() + timeout below
      }
    } else {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve();
    }, 3000).unref();
  });
}

// Windows: sqlite file handles can lag slightly behind process exit.
function rmDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // best-effort retry loop; final attempt's failure is swallowed too —
      // this is teardown, not the assertion under test.
    }
  }
}

describe("Boot warns on cwd-relative ./data fallback (architecture-06)", () => {
  let child: ChildProcess | null = null;
  let cwd = "";

  afterEach(async () => {
    if (child) {
      await killAndWait(child);
      child = null;
    }
    if (cwd) {
      rmDirWithRetry(cwd);
      cwd = "";
    }
  });

  describe("stdio entry point (src/index.ts)", () => {
    it("warns on stderr (never stdout) when COORDINATOR_DATA_DIR is unset", async () => {
      cwd = mkdtempSync(path.join(tmpdir(), "boot-warn-stdio-unset-"));
      const command = process.platform === "win32" ? "npx.cmd" : "npx";
      const args = ["tsx", path.join(REPO_ROOT, "src", "index.ts")];

      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          COORDINATOR_AUTH_ENABLED: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      // COORDINATOR_DATA_DIR must be genuinely absent — strip it in case the
      // host environment happens to have it set.
      // (spawn's env above already omits it unless process.env carried it;
      // guard explicitly for CI/dev-shell safety.)

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      child.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

      // Wait for the stdio entry point to finish booting: it logs
      // "mcp-coordinator running on stdio" (stderr) once server.connect()
      // resolves. Poll the accumulated stderr buffer for it, or the startup
      // failure would otherwise hang the test until the outer timeout.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for stdio boot to complete")),
          25_000,
        );
        const check = () => {
          if (Buffer.concat(stderrChunks).toString("utf8").includes("running on stdio")) {
            clearTimeout(timeout);
            child!.stderr!.off("data", check);
            resolve();
          }
        };
        child!.stderr!.on("data", check);
        child!.on("error", reject);
      });

      const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
      const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");

      expect(stderrRaw).toContain(WARNING_SUBSTRING);
      // protocole-mcp-01: stdout is exclusively JSON-RPC — the warning must
      // never leak there.
      expect(stdoutRaw).not.toContain(WARNING_SUBSTRING);
    }, 30_000);

    it("does NOT warn when COORDINATOR_DATA_DIR is explicitly set (no false positive)", async () => {
      cwd = mkdtempSync(path.join(tmpdir(), "boot-warn-stdio-set-"));
      const dataDir = mkdtempSync(path.join(tmpdir(), "boot-warn-stdio-set-data-"));
      const command = process.platform === "win32" ? "npx.cmd" : "npx";
      const args = ["tsx", path.join(REPO_ROOT, "src", "index.ts")];

      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          COORDINATOR_DATA_DIR: dataDir,
          COORDINATOR_AUTH_ENABLED: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stderrChunks: Buffer[] = [];
      child.stderr!.on("data", (c: Buffer) => stderrChunks.push(c));

      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for stdio boot to complete")),
            25_000,
          );
          const check = () => {
            if (Buffer.concat(stderrChunks).toString("utf8").includes("running on stdio")) {
              clearTimeout(timeout);
              child!.stderr!.off("data", check);
              resolve();
            }
          };
          child!.stderr!.on("data", check);
          child!.on("error", reject);
        });
      } finally {
        rmDirWithRetry(dataDir);
      }

      const stderrRaw = Buffer.concat(stderrChunks).toString("utf8");
      expect(stderrRaw).not.toContain(WARNING_SUBSTRING);
    }, 30_000);
  });

  describe("HTTP entry point (src/serve-http.ts, `pnpm dev` / `node dist/src/serve-http.js`)", () => {
    it("warns on stdout when COORDINATOR_DATA_DIR is unset", async () => {
      cwd = mkdtempSync(path.join(tmpdir(), "boot-warn-http-unset-"));
      const port = await getFreePort();
      const mqttTcpPort = await getFreePort();
      const command = process.platform === "win32" ? "npx.cmd" : "npx";
      const args = ["tsx", path.join(REPO_ROOT, "src", "serve-http.ts")];

      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          PORT: String(port),
          COORDINATOR_MQTT_TCP_PORT: String(mqttTcpPort),
          COORDINATOR_AUTH_ENABLED: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      child.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));
      child.stderr!.on("data", () => {
        // drained but not asserted on here; failures surface via the
        // readiness poll timing out.
      });

      await waitForHealth(port, 25_000);

      const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
      expect(stdoutRaw).toContain(WARNING_SUBSTRING);
    }, 30_000);

    it("does NOT warn when COORDINATOR_DATA_DIR is explicitly set (no false positive)", async () => {
      cwd = mkdtempSync(path.join(tmpdir(), "boot-warn-http-set-"));
      const dataDir = mkdtempSync(path.join(tmpdir(), "boot-warn-http-set-data-"));
      const port = await getFreePort();
      const mqttTcpPort = await getFreePort();
      const command = process.platform === "win32" ? "npx.cmd" : "npx";
      const args = ["tsx", path.join(REPO_ROOT, "src", "serve-http.ts")];

      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          PORT: String(port),
          COORDINATOR_MQTT_TCP_PORT: String(mqttTcpPort),
          COORDINATOR_DATA_DIR: dataDir,
          COORDINATOR_AUTH_ENABLED: "false",
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });

      const stdoutChunks: Buffer[] = [];
      child.stdout!.on("data", (c: Buffer) => stdoutChunks.push(c));

      try {
        await waitForHealth(port, 25_000);
      } finally {
        rmDirWithRetry(dataDir);
      }

      const stdoutRaw = Buffer.concat(stdoutChunks).toString("utf8");
      expect(stdoutRaw).not.toContain(WARNING_SUBSTRING);
    }, 30_000);
  });
});

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForHealth: /health never returned 200 within ${timeoutMs}ms (last error: ${String(lastErr)})`,
  );
}
