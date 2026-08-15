import { describe, it, expect } from "vitest";
import { pidFileName, pidFilePath, existingPidFilePath } from "../../cli/pid-file.js";
import { portFromArgs } from "../../cli/server/restart.js";
import { join } from "path";

/**
 * issue #279 — one PID file per instance.
 *
 * All eight PID sites used a fixed `join(configDir, "server.pid")`, independent
 * of --port and --data-dir. Starting a second daemon overwrote the first's PID
 * file, so `server stop` killed the wrong process and `server status` could
 * only ever describe the most recently started instance. docs/usage.md
 * documented that as a known limitation and told operators to kill by hand.
 */
describe("pidFileName", () => {
  it("keeps the historical name on the default port", () => {
    // Load-bearing, not cosmetic: an operator who upgrades while a daemon is
    // running must still be able to stop it, and anything scripted against
    // ~/.mcp-coordinator/server.pid keeps working.
    expect(pidFileName(3100)).toBe("server.pid");
  });

  it("names a non-default instance after its port", () => {
    expect(pidFileName(3200)).toBe("server-3200.pid");
    expect(pidFileName(3110)).toBe("server-3110.pid");
  });

  it("gives two instances two different files — the whole point", () => {
    const dir = "/cfg";
    expect(pidFilePath(dir, 3110)).not.toBe(pidFilePath(dir, 3120));
  });

  it("resolves under the config dir", () => {
    expect(pidFilePath("/cfg", 3100)).toBe(join("/cfg", "server.pid"));
  });
});

describe("portFromArgs", () => {
  // `restart` forwards its passthrough args to `start`, so the port it will
  // START on is the port whose daemon it must STOP. Reading it from config
  // instead would make `restart --port 3200` stop the default instance and
  // then start a second one alongside it.
  it("reads the separated form", () => {
    expect(portFromArgs(["--daemon", "--port", "3200"])).toBe(3200);
  });

  it("reads the equals form", () => {
    expect(portFromArgs(["--port=3200", "--daemon"])).toBe(3200);
  });

  it("returns null when absent, so the caller falls back to config", () => {
    expect(portFromArgs(["--daemon"])).toBeNull();
    expect(portFromArgs([])).toBeNull();
  });

  it("returns null rather than NaN on a malformed value", () => {
    expect(portFromArgs(["--port", "abc"])).toBeNull();
    expect(portFromArgs(["--port="])).toBeNull();
  });

  it("ignores a trailing --port with no value", () => {
    expect(portFromArgs(["--daemon", "--port"])).toBeNull();
  });
});

describe("existingPidFilePath — upgrading must not strand a running daemon", () => {
  const dir = "/cfg";
  const scoped = join(dir, "server-3199.pid");
  const legacy = join(dir, "server.pid");

  it("prefers the per-instance file when it exists", () => {
    expect(existingPidFilePath(dir, 3199, (p) => p === scoped)).toBe(scoped);
  });

  it("falls back to the historical name when that is what is on disk", () => {
    // The upgrade case: config.json sets port 3199, a daemon started by an
    // older binary recorded itself in server.pid. Looking only for the scoped
    // name would report "stopped" and refuse to stop a live process.
    expect(existingPidFilePath(dir, 3199, (p) => p === legacy)).toBe(legacy);
  });

  it("prefers the per-instance file when BOTH exist", () => {
    expect(existingPidFilePath(dir, 3199, () => true)).toBe(scoped);
  });

  it("returns the per-instance path when neither exists, so errors name the right place", () => {
    expect(existingPidFilePath(dir, 3199, () => false)).toBe(scoped);
  });

  it("is a no-op on the default port, where both names are the same file", () => {
    expect(existingPidFilePath(dir, 3100, () => false)).toBe(join(dir, "server.pid"));
  });
});
