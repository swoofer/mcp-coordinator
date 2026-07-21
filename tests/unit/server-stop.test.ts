import { describe, it, expect } from "vitest";
import {
  stopServer,
  parseTimeoutSeconds,
  type StopDeps,
  type StopOptions,
} from "../../cli/server/stop.js";

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

interface Harness {
  deps: StopDeps;
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
  logs: string[];
  errors: string[];
  removed: () => boolean;
}

function makeHarness(overrides: Partial<StopDeps> = {}): Harness {
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  let removed = false;
  let clock = 1000;
  const deps: StopDeps = {
    readPidFile: () => "1234",
    isAlive: () => true,
    kill: (pid, signal) => kills.push({ pid, signal }),
    removePidFile: () => {
      removed = true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (m) => logs.push(m),
    logError: (m) => errors.push(m),
    exit: ((code: number) => {
      throw new ExitError(code);
    }) as (code: number) => never,
    ...overrides,
  };
  return { deps, kills, logs, errors, removed: () => removed };
}

async function run(h: Harness, opts: StopOptions = {}): Promise<number | null> {
  try {
    await stopServer(h.deps, opts);
    return null;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

describe("stopServer", () => {
  it("exits 1 when no PID file exists", async () => {
    const h = makeHarness({ readPidFile: () => null });
    const code = await run(h);
    expect(code).toBe(1);
    expect(h.errors.join("\n")).toMatch(/No server PID file/);
    expect(h.kills).toHaveLength(0);
  });

  it("exits 1 and removes the file on an invalid PID", async () => {
    const h = makeHarness({ readPidFile: () => "not-a-number" });
    const code = await run(h);
    expect(code).toBe(1);
    expect(h.errors.join("\n")).toMatch(/Invalid PID file/);
    expect(h.removed()).toBe(true);
    expect(h.kills).toHaveLength(0);
  });

  it("cleans up without signalling when the process is already dead", async () => {
    const h = makeHarness({ isAlive: () => false });
    const code = await run(h);
    expect(code).toBeNull();
    expect(h.kills).toHaveLength(0);
    expect(h.removed()).toBe(true);
  });

  it("graceful: SIGTERM only when the process dies within the grace period", async () => {
    let calls = 0;
    // alive on the pre-check, dead on the first poll after SIGTERM
    const h = makeHarness({
      isAlive: () => {
        calls++;
        return calls <= 1;
      },
    });
    await run(h);
    expect(h.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
    expect(h.removed()).toBe(true);
  });

  it("graceful timeout: SIGTERM then SIGKILL when it never dies", async () => {
    const h = makeHarness(); // isAlive always true
    await run(h, { timeoutSeconds: 1 });
    expect(h.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.removed()).toBe(true);
  });

  it("--force: SIGKILL immediately, no SIGTERM", async () => {
    const h = makeHarness();
    await run(h, { force: true });
    expect(h.kills.map((k) => k.signal)).toEqual(["SIGKILL"]);
    expect(h.removed()).toBe(true);
  });

  it("passes the parsed PID to kill", async () => {
    const h = makeHarness({ readPidFile: () => "  4242  " });
    await run(h, { force: true });
    expect(h.kills[0].pid).toBe(4242);
  });
});

describe("parseTimeoutSeconds", () => {
  it("defaults to 5 when undefined", () => {
    expect(parseTimeoutSeconds(undefined)).toBe(5);
  });

  it("accepts a valid non-negative number", () => {
    expect(parseTimeoutSeconds("30")).toBe(30);
    expect(parseTimeoutSeconds("0")).toBe(0);
  });

  it("rejects negative or non-numeric input", () => {
    expect(parseTimeoutSeconds("-1")).toBeNull();
    expect(parseTimeoutSeconds("abc")).toBeNull();
  });
});
