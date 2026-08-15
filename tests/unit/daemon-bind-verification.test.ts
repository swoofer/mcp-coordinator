import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  waitForDaemonBind,
  tailFile,
  daemonBindTimeoutMs,
  DEFAULT_DAEMON_BIND_TIMEOUT_MS,
} from "../../cli/server/start.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * issue #273 — `server start --daemon` used to print success, write the PID and
 * exit 0 on the strength of a successful `spawn`. A spawn that returns a pid
 * proves a process was created, not that it bound the port.
 *
 * These cover the decision, not the plumbing: which of the three outcomes the
 * wait reports, and how fast it notices a child that dies. The probe is
 * injected so no test needs a real port.
 */
describe("waitForDaemonBind", () => {
  const never = async () => false;
  const always = async () => true;

  it("reports 'listening' as soon as the port answers", async () => {
    const child = new EventEmitter();
    expect(await waitForDaemonBind(child, 3100, 5000, always, 10)).toBe("listening");
  });

  it("reports 'exited' when the child dies during boot", async () => {
    // The EADDRINUSE case: the daemon is gone in milliseconds, long before any
    // port could ever answer. This is what used to be reported as success.
    const child = new EventEmitter();
    setTimeout(() => child.emit("exit", 1, null), 20);
    expect(await waitForDaemonBind(child, 3100, 5000, never, 10)).toBe("exited");
  });

  it("reports 'exited' when the spawn itself fails (error, never exit)", async () => {
    // ENOENT on the command emits `error` and no `exit`. Same conclusion.
    const child = new EventEmitter();
    setTimeout(() => child.emit("error", new Error("ENOENT")), 20);
    expect(await waitForDaemonBind(child, 3100, 5000, never, 10)).toBe("exited");
  });

  it("reports 'timeout' when the child neither binds nor dies", async () => {
    const child = new EventEmitter();
    expect(await waitForDaemonBind(child, 3100, 120, never, 10)).toBe("timeout");
  });

  it("notices a child that was already dead before the wait began", async () => {
    // once("exit") only fires for a death that happens after we attach. In
    // production the wait starts immediately after spawn so that is enough, but
    // the function should not depend on being called at exactly the right
    // moment — a stale listener on the port would otherwise read as success.
    const dead = Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null });
    let probed = false;
    const probe = async () => {
      probed = true;
      return true;
    };
    expect(await waitForDaemonBind(dead, 3100, 500, probe, 10)).toBe("exited");
    expect(probed).toBe(false);
  });

  it("does not wait a stingy amount of time by default", () => {
    // Boot runs schema migrations; calling a healthy daemon dead is its own lie.
    expect(DEFAULT_DAEMON_BIND_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
    expect(daemonBindTimeoutMs({})).toBe(DEFAULT_DAEMON_BIND_TIMEOUT_MS);
  });

  it("lets an operator raise the window for a slow first boot", () => {
    expect(daemonBindTimeoutMs({ COORDINATOR_DAEMON_BIND_TIMEOUT_MS: "60000" })).toBe(60000);
  });

  it("ignores a nonsense override rather than waiting zero or forever", () => {
    expect(daemonBindTimeoutMs({ COORDINATOR_DAEMON_BIND_TIMEOUT_MS: "nope" })).toBe(
      DEFAULT_DAEMON_BIND_TIMEOUT_MS,
    );
    expect(daemonBindTimeoutMs({ COORDINATOR_DAEMON_BIND_TIMEOUT_MS: "0" })).toBe(
      DEFAULT_DAEMON_BIND_TIMEOUT_MS,
    );
  });

  it("treats a child with no event API as one that never reports", async () => {
    // A mocked spawn hands back a bare { pid, unref }. Before this, the wait
    // threw on child.once and took the whole CLI down mid-test.
    const bare: { once?: never } = {};
    expect(await waitForDaemonBind(bare, 3199, 60, async () => false, 10)).toBe("timeout");
  });
});

describe("tailFile", () => {
  it("returns the last N non-empty lines", () => {
    const p = path.join(os.tmpdir(), `mcpc-tail-${process.pid}.log`);
    fs.writeFileSync(p, "a\nb\n\nc\nd\n");
    try {
      expect(tailFile(p, 2)).toBe("c\nd");
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  it("returns empty string for a missing file rather than throwing", () => {
    // The daemon failed to start; failing to read its log must not replace the
    // diagnosis with a second, unrelated crash.
    expect(tailFile(path.join(os.tmpdir(), "mcpc-does-not-exist.log"), 5)).toBe("");
  });
});
