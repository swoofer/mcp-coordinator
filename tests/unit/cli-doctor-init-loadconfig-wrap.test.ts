import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression test for https://github.com/swoofer/mcp-coordinator/issues/109
 *
 * Background: PR #108 changed `loadConfig()` to **throw** on malformed
 * config.json instead of silently returning defaults. That's correct at
 * the contract level, but two call sites have UX regressions:
 *
 *   - `doctor` exists to *diagnose* problems. A malformed config should
 *     produce a "[FAIL] config.json invalid: ..." diagnostic line (red),
 *     NOT an unhandled exception with a stack trace. Doctor must continue
 *     the remaining checks and exit non-zero at the end.
 *
 *   - `init` exists to *write a fresh config*. A malformed existing
 *     config.json should print a warning to stderr and proceed; init's
 *     whole point is to recover from this state.
 *
 * The throw in cli/config.ts is correct and stays untouched. Only the
 * doctor + init call sites are wrapped.
 */

const MALFORMED = "{ this is :: not ]] valid json";

describe("cli/doctor — malformed config.json is a diagnostic, not a crash (issue #109)", () => {
  let tmpConfigDir: string;
  let originalExitCode: typeof process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "mcp-coord-doctor-malformed-"));
    // Write a malformed config.json into the redirected config dir.
    writeFileSync(join(tmpConfigDir, "config.json"), MALFORMED);

    originalExitCode = process.exitCode;
    process.exitCode = 0;

    // Redirect both getConfigDir AND loadConfig so doctor scans our temp dir.
    // We must redirect loadConfig too, because the real loadConfig calls
    // its own module-local getConfigDir when no arg is passed — and vi.doMock
    // only intercepts the exported reference seen by *callers*, not intra-
    // module references inside cli/config.ts. We delegate to the real
    // loadConfig with an explicit configDir so the throw path is exercised
    // for real (no mocking of the throw itself).
    vi.doMock("../../cli/config.js", async () => {
      const real = await vi.importActual<typeof import("../../cli/config.js")>(
        "../../cli/config.js",
      );
      return {
        ...real,
        getConfigDir: () => tmpConfigDir,
        loadConfig: () => real.loadConfig(tmpConfigDir),
      };
    });

    // Capture process.exit so the test doesn't actually terminate vitest
    // when doctor decides anyFail=true and calls process.exit(2).
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      // Forward into exitCode so the assertion can read it.
      process.exitCode = code ?? 0;
      // Throwing keeps doctor's `process.exit(2); ...` from continuing past
      // the call site if there is any follow-up code, matching the real
      // semantics where `exit` is terminal.
      throw new Error(`__test_process_exit_${code ?? 0}__`);
    }) as never);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    exitSpy.mockRestore();
    logSpy.mockRestore();
    vi.doUnmock("../../cli/config.js");
    vi.resetModules();
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it("reports the parse error as a [FAIL] config.json diagnostic line", async () => {
    const mod = await import("../../cli/doctor.js");
    const cmd = mod.createDoctorCommand();

    // Doctor calls process.exit(2) on anyFail. Our spy throws — swallow it.
    try {
      await cmd.parseAsync(["node", "doctor"]);
    } catch (err) {
      // Expected: our mocked process.exit threw a sentinel.
      expect((err as Error).message).toMatch(/__test_process_exit_/);
    }

    // The combined stdout should include a FAIL diagnostic for config.json,
    // and the parse-error text from loadConfig() must appear in the detail.
    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/\[FAIL\]\s+config\.json/);
    expect(out).toMatch(/invalid:.*Failed to parse/);
  });

  it("exits non-zero (does NOT bubble the throw as an unhandled exception)", async () => {
    const mod = await import("../../cli/doctor.js");
    const cmd = mod.createDoctorCommand();

    let unexpectedThrow: unknown = null;
    try {
      await cmd.parseAsync(["node", "doctor"]);
    } catch (err) {
      // Only the process.exit-sentinel should escape. Anything else means
      // doctor failed to catch the loadConfig throw and is the bug we fix.
      if ((err as Error).message?.match(/__test_process_exit_/)) {
        // expected
      } else {
        unexpectedThrow = err;
      }
    }

    expect(unexpectedThrow).toBeNull();
    expect(process.exitCode).not.toBe(0);
  });

  it("continues running remaining checks instead of aborting on the parse error", async () => {
    const mod = await import("../../cli/doctor.js");
    const cmd = mod.createDoctorCommand();

    try {
      await cmd.parseAsync(["node", "doctor"]);
    } catch {
      // expected: process.exit sentinel
    }

    const out = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // The pid-file check runs after the config.json check. If doctor aborted
    // on the loadConfig throw, this line would be absent.
    expect(out).toMatch(/pid-file/);
  });
});

describe("cli/init — malformed config.json is overwritten with a warning (issue #109)", () => {
  let tmpConfigDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), "mcp-coord-init-malformed-"));
    // Pre-existing malformed config.json — init must recover, not throw.
    writeFileSync(join(tmpConfigDir, "config.json"), MALFORMED);

    // Redirect getConfigDir, ensureConfigDir, loadConfig, and saveConfig so
    // init operates against our temp dir. We must redirect loadConfig /
    // saveConfig explicitly because their default branch calls config.ts's
    // own module-internal getConfigDir, which vi.doMock cannot intercept.
    // We delegate to the real implementations with an explicit configDir,
    // so the parse-throw path and the on-disk write are both genuine.
    vi.doMock("../../cli/config.js", async () => {
      const real = await vi.importActual<typeof import("../../cli/config.js")>(
        "../../cli/config.js",
      );
      return {
        ...real,
        getConfigDir: () => tmpConfigDir,
        ensureConfigDir: () => {
          mkdirSync(tmpConfigDir, { recursive: true });
          return tmpConfigDir;
        },
        loadConfig: (dir?: string) => real.loadConfig(dir ?? tmpConfigDir),
        saveConfig: (cfg: import("../../cli/config.js").CoordinatorConfig, dir?: string) =>
          real.saveConfig(cfg, dir ?? tmpConfigDir),
      };
    });

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.doUnmock("../../cli/config.js");
    vi.resetModules();
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it("does not throw when the existing config.json is malformed", async () => {
    const mod = await import("../../cli/init.js");
    const cmd = mod.createInitCommand();

    // The whole point: init must complete successfully and recover.
    await expect(cmd.parseAsync(["node", "init"])).resolves.toBeDefined();
  });

  it("warns the user that the existing malformed config is being overwritten", async () => {
    const mod = await import("../../cli/init.js");
    const cmd = mod.createInitCommand();

    await cmd.parseAsync(["node", "init"]);

    // Warning may go to console.warn or console.error (stderr) — accept either.
    const warnCalls = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const errCalls = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    const combined = warnCalls + "\n" + errCalls;
    expect(combined).toMatch(/malformed|invalid|overwrit/i);
    expect(combined).toMatch(/config\.json|Failed to parse/);
  });

  it("rewrites config.json with a valid default config", async () => {
    const mod = await import("../../cli/init.js");
    const cmd = mod.createInitCommand();

    await cmd.parseAsync(["node", "init"]);

    const configPath = join(tmpConfigDir, "config.json");
    expect(existsSync(configPath)).toBe(true);

    // The file must now be valid JSON with the expected default shape.
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      server: { port: number; data_dir: string };
      defaults: { coordinator_url: string };
    };
    expect(parsed.server.port).toBe(3100);
    expect(typeof parsed.defaults.coordinator_url).toBe("string");
  });
});
