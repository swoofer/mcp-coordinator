import { describe, it, expect, vi } from "vitest";
import { createForegroundShutdownHandler } from "../../cli/server/start.js";

/**
 * architecture-04: foreground `mcp-coordinator server start` (no --daemon)
 * previously registered its own SIGINT/SIGTERM handlers that only removed
 * the PID file and called `process.exit(0)` immediately — bypassing
 * `ServerHandle.stop()`'s ordered teardown (Phase 2 shutdown / audit drain
 * → HTTP server → MQTT bridge → broker → timers → DB). Because
 * `process.exit()` inside a synchronous listener kills the process before
 * any other listener for the same signal gets to run, this raced against
 * (and could win over) the server's own graceful shutdown handler — risking
 * in-flight audit/quota data loss.
 *
 * `createForegroundShutdownHandler` is the fix, extracted so it can be
 * exercised without real OS signals (flaky/inconsistent on Windows) or a
 * real HTTP/MQTT stack: it must (1) await the real `handle.stop()` graceful
 * teardown BEFORE exiting, (2) still clean up the PID file even if stop()
 * throws, and (3) be idempotent so a second signal during shutdown doesn't
 * re-run teardown or double-exit.
 */
describe("cli/server/start.ts — createForegroundShutdownHandler (architecture-04)", () => {
  it("awaits handle.stop() (graceful teardown) before cleaning up the PID file and exiting", async () => {
    const callOrder: string[] = [];
    const handle = {
      stop: vi.fn(async () => {
        callOrder.push("stop");
      }),
    };
    const unlinkSync = vi.fn(() => {
      callOrder.push("unlink");
    });
    const exit = vi.fn(() => {
      callOrder.push("exit");
    });

    const shutdown = createForegroundShutdownHandler(handle, "/fake/server.pid", {
      unlinkSync,
      exit,
    });
    await shutdown("SIGTERM");

    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(unlinkSync).toHaveBeenCalledWith("/fake/server.pid");
    expect(exit).toHaveBeenCalledWith(0);
    // Ordered teardown: stop() (drains audit/quota etc.) must complete before
    // the PID file is removed and the process exits.
    expect(callOrder).toEqual(["stop", "unlink", "exit"]);
  });

  it("still cleans up the PID file and exits (code 1) — without throwing — if handle.stop() rejects", async () => {
    const handle = {
      stop: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const unlinkSync = vi.fn();
    const exit = vi.fn();
    const onError = vi.fn();

    const shutdown = createForegroundShutdownHandler(handle, "/fake/server.pid", {
      unlinkSync,
      exit,
      onError,
    });

    // Must resolve, not reject: callers invoke this as `void shutdown(signal)`
    // from a process signal listener, so a rejection would be an unhandled
    // promise rejection.
    await expect(shutdown("SIGINT")).resolves.toBeUndefined();

    expect(unlinkSync).toHaveBeenCalledWith("/fake/server.pid");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not throw if unlinkSync fails (best-effort PID cleanup)", async () => {
    const handle = { stop: vi.fn(async () => {}) };
    const unlinkSync = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const exit = vi.fn();

    const shutdown = createForegroundShutdownHandler(handle, "/fake/server.pid", {
      unlinkSync,
      exit,
    });
    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent: a second signal during shutdown does not re-run teardown or double-exit", async () => {
    let resolveStop!: () => void;
    const handle = {
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveStop = resolve;
          }),
      ),
    };
    const unlinkSync = vi.fn();
    const exit = vi.fn();

    const shutdown = createForegroundShutdownHandler(handle, "/fake/server.pid", {
      unlinkSync,
      exit,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT"); // races in while stop() is still pending

    resolveStop();
    await Promise.all([first, second]);

    // Only the first signal's invocation should have driven teardown.
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(unlinkSync).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
