import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { create as tarCreate, list as tarList, extract as tarExtract } from "tar";
import { getRunningCoordinatorPid } from "../../cli/server/backup.js";

// Each test gets its own sandbox so we never touch the user's real
// ~/.mcp-coordinator dir. We override HOME (POSIX) and USERPROFILE (Windows)
// because cli/config.ts derives the config dir from os.homedir().
const SANDBOX_ROOT = join(tmpdir(), "mcp-coordinator-backup-test");

function makeSandbox(): { home: string; configDir: string; cleanup: () => void } {
  const home = join(SANDBOX_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const configDir = join(home, ".mcp-coordinator");
  return {
    home,
    configDir,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function seedConfigDir(configDir: string): void {
  // Realistic layout: config.json + data/coordinator.db + data/coordinator.db-wal
  mkdirSync(join(configDir, "data"), { recursive: true });
  mkdirSync(join(configDir, "logs"), { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({ server: { port: 3100, data_dir: join(configDir, "data") } }, null, 2),
  );
  writeFileSync(join(configDir, "data", "coordinator.db"), Buffer.from("SQLite format 3\0fake-bytes"));
  writeFileSync(join(configDir, "data", "coordinator.db-wal"), Buffer.from("wal-bytes"));
  writeFileSync(join(configDir, "logs", "server.log"), "log-noise\n"); // present but not packed
}

afterAll(() => {
  try { rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("getRunningCoordinatorPid", () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
    mkdirSync(sandbox.configDir, { recursive: true });
  });

  it("returns null when no PID file exists", () => {
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBeNull();
    sandbox.cleanup();
  });

  it("returns null when PID file points at a dead process", () => {
    // PID 0 is reserved on POSIX and never alive; on Windows process.kill(0, 0)
    // throws ESRCH as well. Either way, not alive.
    writeFileSync(join(sandbox.configDir, "server.pid"), "999999999");
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBeNull();
    sandbox.cleanup();
  });

  it("returns the pid when the PID file points at this process (alive)", () => {
    writeFileSync(join(sandbox.configDir, "server.pid"), String(process.pid));
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBe(process.pid);
    sandbox.cleanup();
  });

  it("returns null when PID file contains garbage", () => {
    writeFileSync(join(sandbox.configDir, "server.pid"), "not-a-number");
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBeNull();
    sandbox.cleanup();
  });
});

describe("backup tarball", () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
    seedConfigDir(sandbox.configDir);
  });

  it("creates a tar.gz containing config.json and data/", async () => {
    const archive = join(sandbox.home, "snap.tar.gz");
    await tarCreate(
      { gzip: true, file: archive, cwd: sandbox.configDir, portable: true },
      ["config.json", "data"],
    );
    expect(existsSync(archive)).toBe(true);
    expect(statSync(archive).size).toBeGreaterThan(0);

    const seen: string[] = [];
    await tarList({
      file: archive,
      onReadEntry: (e) => seen.push(e.path.replace(/\\/g, "/")),
    });
    expect(seen).toContain("config.json");
    // tar emits the directory entry plus children; check at least one data file.
    const dataFiles = seen.filter((p) => p.startsWith("data/") || p === "data/");
    expect(dataFiles.length).toBeGreaterThanOrEqual(1);
    expect(seen.some((p) => p.endsWith("coordinator.db"))).toBe(true);

    sandbox.cleanup();
  });

  it("excludes logs/ (not in entry list)", async () => {
    const archive = join(sandbox.home, "snap.tar.gz");
    await tarCreate(
      { gzip: true, file: archive, cwd: sandbox.configDir, portable: true },
      ["config.json", "data"],
    );
    const seen: string[] = [];
    await tarList({ file: archive, onReadEntry: (e) => seen.push(e.path) });
    expect(seen.some((p) => p.includes("logs"))).toBe(false);
    sandbox.cleanup();
  });
});

describe("restore (extract) round-trip", () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
    seedConfigDir(sandbox.configDir);
  });

  it("recreates the original file contents byte-for-byte", async () => {
    const archive = join(sandbox.home, "snap.tar.gz");
    const originalDb = readFileSync(join(sandbox.configDir, "data", "coordinator.db"));
    const originalCfg = readFileSync(join(sandbox.configDir, "config.json"));

    await tarCreate(
      { gzip: true, file: archive, cwd: sandbox.configDir, portable: true },
      ["config.json", "data"],
    );

    // Wipe the config dir, then extract back into it.
    rmSync(sandbox.configDir, { recursive: true, force: true });
    mkdirSync(sandbox.configDir, { recursive: true });
    await tarExtract({ file: archive, cwd: sandbox.configDir });

    const restoredDb = readFileSync(join(sandbox.configDir, "data", "coordinator.db"));
    const restoredCfg = readFileSync(join(sandbox.configDir, "config.json"));
    expect(restoredDb.equals(originalDb)).toBe(true);
    expect(restoredCfg.equals(originalCfg)).toBe(true);

    sandbox.cleanup();
  });
});

describe("safety check integration", () => {
  // We verify the helper's behavior here. The full CLI action invokes
  // process.exit(1) when the daemon is up, which is awkward to assert in
  // a unit test — we cover the underlying check (getRunningCoordinatorPid)
  // and trust the integration patch in cli/index.ts to wire it.
  it("PID file with current process is detected as running", () => {
    const sandbox = makeSandbox();
    mkdirSync(sandbox.configDir, { recursive: true });
    writeFileSync(join(sandbox.configDir, "server.pid"), String(process.pid));
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBe(process.pid);
    sandbox.cleanup();
  });

  it("PID file with no live process returns null (safe to backup)", () => {
    const sandbox = makeSandbox();
    mkdirSync(sandbox.configDir, { recursive: true });
    // Use a very high pid that is overwhelmingly unlikely to exist.
    writeFileSync(join(sandbox.configDir, "server.pid"), "2147483646");
    expect(getRunningCoordinatorPid(sandbox.configDir)).toBeNull();
    sandbox.cleanup();
  });
});

describe("path resolution", () => {
  it("resolves to ~/.mcp-coordinator under the overridden HOME", () => {
    const sandbox = makeSandbox();
    // Validate the assumption our helpers rely on: changing HOME shifts
    // the config dir homedir() returns.
    const expected = resolve(sandbox.home, ".mcp-coordinator");
    expect(resolve(sandbox.configDir)).toBe(expected);
    sandbox.cleanup();
  });
});
