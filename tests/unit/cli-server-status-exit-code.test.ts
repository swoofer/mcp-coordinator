import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for https://github.com/swoofer/mcp-coordinator/issues/78
 *
 * Bug: `mcp-coordinator server status` always returns exit code 0, even when
 * the daemon is stopped or unhealthy. That defeats the canonical shell idiom
 *
 *     if ! mcp-coordinator server status; then start_server; fi
 *
 * because the conditional never fires.
 *
 * Contract under test:
 *   - stopped (no PID file)      -> non-zero exit code
 *   - stopped (stale PID file)   -> non-zero exit code
 *   - running but health failure -> non-zero exit code
 *   - running AND healthy        -> exit code 0 (or unset)
 */
describe("cli/server status — exit code reflects daemon health (issue #78)", () => {
  let tmpConfigDir: string;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "mcp-coord-status-test-"));
    // Snapshot and reset process.exitCode so each test starts clean.
    originalExitCode = process.exitCode;
    process.exitCode = 0;

    // Redirect getConfigDir() so the action looks at our empty temp dir
    // instead of the real ~/.mcp-coordinator.
    vi.doMock("../../cli/config.js", async () => {
      const real = await vi.importActual<typeof import("../../cli/config.js")>(
        "../../cli/config.js",
      );
      return {
        ...real,
        getConfigDir: () => tmpConfigDir,
        loadConfig: () => ({
          server: { port: 3199, data_dir: tmpConfigDir },
          defaults: { coordinator_url: "http://localhost:3199" },
        }),
      };
    });
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.doUnmock("../../cli/config.js");
    vi.resetModules();
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  async function runStatus(): Promise<void> {
    const mod = await import("../../cli/server/status.js");
    const cmd = mod.createServerStatusCommand();
    // Silence console.log so test output stays clean.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await cmd.parseAsync(["node", "status"]);
    } finally {
      logSpy.mockRestore();
    }
  }

  it("exits non-zero when no PID file exists (daemon stopped)", async () => {
    // Sanity: PID file does not exist in the fresh tmp dir.
    expect(existsSync(join(tmpConfigDir, "server.pid"))).toBe(false);

    await runStatus();

    expect(process.exitCode).not.toBe(0);
  });

  it("exits non-zero when PID file is stale (process not alive)", async () => {
    // PID 1 is init on Linux/Mac (always alive) — pick an impossibly-large
    // PID that should never refer to a live process.
    const stalePid = 2 ** 31 - 1; // INT32_MAX
    if (!existsSync(tmpConfigDir)) mkdirSync(tmpConfigDir, { recursive: true });
    writeFileSync(join(tmpConfigDir, "server.pid"), String(stalePid));

    await runStatus();

    expect(process.exitCode).not.toBe(0);
  });
});
