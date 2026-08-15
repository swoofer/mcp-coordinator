import { describe, it, expect } from "vitest";
import { serverUnreachableHint } from "../../cli/doctor.js";

/**
 * issue #273 — the second half of the loop. `server start --daemon` announced
 * success on a daemon that had died; `doctor` then printed pid-file [OK]
 * directly above tcp-<port> [FAIL] and advised starting the server whose PID it
 * had just shown. This pins the advice to the state.
 */
describe("serverUnreachableHint", () => {
  it("tells a first-time user to start the server", () => {
    const hint = serverUnreachableHint(3100, null, false);
    expect(hint).toContain("mcp-coordinator server start --daemon");
  });

  it("does NOT tell you to start a server that already died", () => {
    // The regression this issue is about. A PID was recorded, the process is
    // gone: starting again just repeats the failure.
    const hint = serverUnreachableHint(3100, 4242, false);
    expect(hint).not.toContain("mcp-coordinator server start");
    expect(hint).toContain("died during boot");
    expect(hint).toContain("server.log");
  });

  it("names the busy-port and sandbox cases, which both land in the log", () => {
    const hint = serverUnreachableHint(3100, 4242, false);
    expect(hint).toMatch(/busy port/i);
    expect(hint).toMatch(/sandbox/i);
  });

  it("distinguishes a live PID that is not listening from a dead one", () => {
    const hint = serverUnreachableHint(3100, 4242, true);
    expect(hint).toContain("4242");
    expect(hint).toContain("3100");
    expect(hint).toMatch(/stuck|different port/i);
    expect(hint).not.toContain("died during boot");
  });
});
