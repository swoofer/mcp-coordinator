import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_FILE = join(__dirname, "..", "..", "cli", "server", "start.ts");

describe("cli/server/start.ts — --log-json flag (source-level)", () => {
  const source = readFileSync(START_FILE, "utf8");

  it("declares the --log-json option via commander", () => {
    expect(source).toContain("--log-json");
  });

  it("documents --log-json in the option description (visible in --help)", () => {
    expect(source).toMatch(/--log-json[^"]*",\s*"[^"]*NDJSON/i);
  });

  it('sets COORDINATOR_LOG_JSON="true" when --log-json is passed', () => {
    expect(source).toContain('process.env.COORDINATOR_LOG_JSON = "true"');
  });

  it("forwards COORDINATOR_LOG_JSON to the daemon child env via fwd()", () => {
    // architecture-05: env forwarding lives in buildDaemonEnv(parentEnv), so the
    // fwd() call reads from `parentEnv`, not `process.env` directly.
    expect(source).toContain('fwd("COORDINATOR_LOG_JSON", parentEnv.COORDINATOR_LOG_JSON)');
  });
});

describe("cli/server/start.ts — --log-json flag (behavioral)", () => {
  const envSnapshot: Record<string, string | undefined> = {};
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let openSyncMock: ReturnType<typeof vi.fn>;
  let writeFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    envSnapshot.COORDINATOR_LOG_JSON = process.env.COORDINATOR_LOG_JSON;
    delete process.env.COORDINATOR_LOG_JSON;
    envSnapshot.PORT = process.env.PORT;
    envSnapshot.COORDINATOR_DATA_DIR = process.env.COORDINATOR_DATA_DIR;

    spawnMock = vi.fn().mockReturnValue({ pid: 12345, unref: () => {} });
    // issue #273: the daemon path now waits for the child to accept a
    // connection before reporting success. `spawn` is mocked here, so
    // nothing will ever listen on 3199 — collapse the window rather than
    // sit through the real one.
    envSnapshot.COORDINATOR_DAEMON_BIND_TIMEOUT_MS = process.env.COORDINATOR_DAEMON_BIND_TIMEOUT_MS;
    process.env.COORDINATOR_DAEMON_BIND_TIMEOUT_MS = "50";
    openSyncMock = vi.fn().mockReturnValue(3);
    writeFileSyncMock = vi.fn();

    vi.doMock("child_process", () => ({ spawn: spawnMock }));
    vi.doMock("fs", async () => {
      const real = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...real,
        openSync: openSyncMock,
        writeFileSync: writeFileSyncMock,
        unlinkSync: real.unlinkSync,
      };
    });

    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__process_exit_called__");
    }) as never);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    exitSpy.mockRestore();
    vi.doUnmock("child_process");
    vi.doUnmock("fs");
    vi.resetModules();
  });

  async function runDaemon(extraArgs: string[] = []): Promise<void> {
    const mod = await import("../../cli/server/start.js");
    const cmd = mod.createServerStartCommand();
    try {
      await cmd.parseAsync(["node", "start", "--daemon", "--port", "3199", ...extraArgs]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__process_exit_called__") {
        throw e;
      }
    }
  }

  it("sets COORDINATOR_LOG_JSON=true on process.env when --log-json is passed", async () => {
    await runDaemon(["--log-json"]);
    expect(process.env.COORDINATOR_LOG_JSON).toBe("true");
  });

  it("forwards COORDINATOR_LOG_JSON=true to the daemon child env when --log-json is passed", async () => {
    await runDaemon(["--log-json"]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnOpts.env.COORDINATOR_LOG_JSON).toBe("true");
  });

  it("omits COORDINATOR_LOG_JSON from the daemon child env when --log-json is NOT passed", async () => {
    await runDaemon([]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnOpts.env).not.toHaveProperty("COORDINATOR_LOG_JSON");
  });

  it("--help output lists --log-json", async () => {
    const mod = await import("../../cli/server/start.js");
    const cmd = mod.createServerStartCommand();
    const help = cmd.helpInformation();
    expect(help).toContain("--log-json");
    expect(help.toLowerCase()).toContain("ndjson");
  });
});

describe("createLogger — json option (adopted from #151)", () => {
  it("createLogger reads COORDINATOR_LOG_JSON env as the json fallback", async () => {
    // Source-level guard: createLogger derives `json` from the env var when the
    // option is not supplied (the wiring --log-json → env → logger relies on it).
    const loggerSrc = readFileSync(join(__dirname, "..", "..", "src", "logger.ts"), "utf8");
    expect(loggerSrc).toContain('process.env.COORDINATOR_LOG_JSON === "true"');
    // createPinoLogger disables pino-pretty when json is set.
    expect(loggerSrc).toMatch(/isDev && !stdio && !json/);
  });
});
