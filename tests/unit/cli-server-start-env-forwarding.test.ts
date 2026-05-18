import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const START_FILE = join(__dirname, "..", "..", "cli", "server", "start.ts");

const ENC_VARS = [
  "COORDINATOR_ENCRYPTION_KEY",
  "COORDINATOR_ALLOW_TOKEN_LOSS",
  "COORDINATOR_TOKEN_LOSS_CONFIRM",
  "COORDINATOR_ALLOW_KEY_ROTATION",
] as const;

/** Static-source assertions — the cheapest, most robust check that T06a's
 *  4 fwd() lines are in place and won't silently regress in a future edit. */
describe("cli/server/start.ts — Phase 3 encryption env forwarding (source-level)", () => {
  const source = readFileSync(START_FILE, "utf8");

  for (const v of ENC_VARS) {
    it(`forwards ${v} via fwd()`, () => {
      const needle = `fwd("${v}", process.env.${v})`;
      expect(source).toContain(needle);
    });
  }

  it("fwd('COORDINATOR_*', ...) count matches the expected total (existing + 4 new)", () => {
    const matches = source.match(/fwd\("COORDINATOR_/g) ?? [];
    // Snapshot existing-count assumption: count must be at least 4 (the new
    // Phase 3 vars) AND must not have dropped below 14 (the V3 baseline of
    // ~10 existing COORDINATOR_* lines + 4 new). The exact upper bound is
    // intentionally loose to tolerate unrelated env additions in future
    // tasks; the strict lower bound is what defends T06a's contribution.
    expect(matches.length).toBeGreaterThanOrEqual(14);
  });
});

/** Behavioral assertion — exercise the daemon path through Commander with a
 *  mocked spawn + filesystem and assert the constructed childEnv. */
describe("cli/server/start.ts — daemon-spawn env forwarding (behavioral)", () => {
  const envSnapshot: Record<string, string | undefined> = {};
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let spawnMock: ReturnType<typeof vi.fn>;
  let openSyncMock: ReturnType<typeof vi.fn>;
  let writeFileSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    for (const v of ENC_VARS) {
      envSnapshot[v] = process.env[v];
      delete process.env[v];
    }
    envSnapshot.PORT = process.env.PORT;
    envSnapshot.COORDINATOR_DATA_DIR = process.env.COORDINATOR_DATA_DIR;

    spawnMock = vi.fn().mockReturnValue({
      pid: 12345,
      unref: () => {},
    });
    openSyncMock = vi.fn().mockReturnValue(3);
    writeFileSyncMock = vi.fn();

    vi.doMock("child_process", () => ({ spawn: spawnMock }));
    // The action imports fs dynamically for openSync; preserve the rest of fs.
    vi.doMock("fs", async () => {
      const real = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...real,
        openSync: openSyncMock,
        writeFileSync: writeFileSyncMock,
        unlinkSync: real.unlinkSync,
      };
    });

    // process.exit short-circuits the action; surface as a known throw.
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

  async function runDaemon(): Promise<void> {
    // Re-import so mocks resolve fresh.
    const mod = await import("../../cli/server/start.js");
    const cmd = mod.createServerStartCommand();
    try {
      await cmd.parseAsync(["node", "start", "--daemon", "--port", "3199"]);
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__process_exit_called__") {
        throw e;
      }
    }
  }

  it("forwards each Phase 3 encryption env var when set in the parent process", async () => {
    process.env.COORDINATOR_ENCRYPTION_KEY = "test-key-value";
    process.env.COORDINATOR_ALLOW_TOKEN_LOSS = "1";
    process.env.COORDINATOR_TOKEN_LOSS_CONFIRM = "I_UNDERSTAND_THIS_NULLS_5_ROWS";
    process.env.COORDINATOR_ALLOW_KEY_ROTATION = "1";

    await runDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    expect(spawnOpts.env.COORDINATOR_ENCRYPTION_KEY).toBe("test-key-value");
    expect(spawnOpts.env.COORDINATOR_ALLOW_TOKEN_LOSS).toBe("1");
    expect(spawnOpts.env.COORDINATOR_TOKEN_LOSS_CONFIRM).toBe(
      "I_UNDERSTAND_THIS_NULLS_5_ROWS",
    );
    expect(spawnOpts.env.COORDINATOR_ALLOW_KEY_ROTATION).toBe("1");
  });

  it("omits each Phase 3 encryption env var when unset in the parent process", async () => {
    // All 4 deleted in beforeEach.
    await runDaemon();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , spawnOpts] = spawnMock.mock.calls[0];
    for (const v of ENC_VARS) {
      expect(spawnOpts.env).not.toHaveProperty(v);
    }
  });
});
