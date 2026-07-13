/**
 * tests-08 — `cli/uninstall.ts` (createUninstallCommand) is a destructive
 * command with 3 `rmSync` call sites (empty .mcp.json, empty CLAUDE.md,
 * `--purge` of the whole ~/.mcp-coordinator dir) and had zero test coverage.
 *
 * These tests lock in the SAFE behavior: every case below is a security
 * assertion that the command removes only what it's explicitly told to
 * remove and leaves everything else — other MCP servers, user CLAUDE.md
 * content, non-existent paths, and (absent --force) the purge target on a
 * "no" answer — untouched.
 *
 * All destructive operations run against `mkdtempSync`-created temp
 * directories, cleaned up in `afterEach`. The real `~/.mcp-coordinator` is
 * NEVER touched: the `--purge` cases redirect `getConfigDir()` (via
 * `vi.doMock`, mirroring the pattern already used in
 * tests/unit/cli-doctor-init-loadconfig-wrap.test.ts) to a temp dir instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUninstallCommand } from "../../cli/uninstall.js";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("cli uninstall — --mcp-config (rmSync path 1: empty .mcp.json)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-coord-uninstall-mcpjson-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("SECURITY: removes only the 'coordinator' entry — a sibling MCP server is preserved, file is not deleted", async () => {
    const target = join(dir, ".mcp.json");
    writeFileSync(
      target,
      JSON.stringify(
        {
          mcpServers: {
            coordinator: { command: "npx", args: ["mcp-coordinator", "serve"] },
            "other-server": { command: "some-other-mcp", args: ["--flag"] },
          },
        },
        null,
        2,
      ) + "\n",
    );

    await createUninstallCommand().parseAsync(["node", "uninstall", "--mcp-config", dir]);

    expect(existsSync(target)).toBe(true);
    const json = readJson(target) as { mcpServers?: Record<string, unknown> };
    expect(json.mcpServers).toBeDefined();
    expect(json.mcpServers!.coordinator).toBeUndefined();
    expect(json.mcpServers!["other-server"]).toEqual({
      command: "some-other-mcp",
      args: ["--flag"],
    });
  });

  it("removes the file when coordinator was the only server (file becomes empty)", async () => {
    const target = join(dir, ".mcp.json");
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { coordinator: { command: "npx" } } }, null, 2) + "\n",
    );

    await createUninstallCommand().parseAsync(["node", "uninstall", "--mcp-config", dir]);

    expect(existsSync(target)).toBe(false);
  });

  it("SECURITY: no .mcp.json present — no crash, 'nothing to remove', nothing created or deleted", async () => {
    await expect(
      createUninstallCommand().parseAsync(["node", "uninstall", "--mcp-config", dir]),
    ).resolves.not.toThrow();

    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/nothing to remove/i);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    // The directory itself is untouched (still exists, we created it).
    expect(existsSync(dir)).toBe(true);
  });

  it("SECURITY: --mcp-config <nonexistent path> → validateDir error, exitCode 1, nothing deleted or created", async () => {
    const missing = join(dir, "does-not-exist-subdir");
    expect(existsSync(missing)).toBe(false);

    await createUninstallCommand().parseAsync(["node", "uninstall", "--mcp-config", missing]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOut = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(errOut).toMatch(/does not exist/i);
    // Still doesn't exist — nothing was created as a side effect of validation.
    expect(existsSync(missing)).toBe(false);
  });
});

describe("cli uninstall — --claude-md (rmSync path 2: empty CLAUDE.md)", () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mcp-coord-uninstall-claudemd-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("SECURITY: removes only the sentinel-delimited section — surrounding user content is preserved", async () => {
    const target = join(dir, "CLAUDE.md");
    const before =
      "# My Project\n\nSome important user notes here.\n\n" +
      "<!-- mcp-coordinator:coordination-section -->\n" +
      "Coordinator-injected instructions go here.\nMore coordinator lines.\n" +
      "<!-- mcp-coordinator:coordination-section -->\n\n" +
      "More user notes after the section.\n";
    writeFileSync(target, before);

    await createUninstallCommand().parseAsync(["node", "uninstall", "--claude-md", dir]);

    expect(existsSync(target)).toBe(true);
    const after = readFileSync(target, "utf-8");
    expect(after).toMatch(/Some important user notes here\./);
    expect(after).toMatch(/More user notes after the section\./);
    expect(after).not.toMatch(/Coordinator-injected instructions/);
    expect(after).not.toContain("<!-- mcp-coordinator:coordination-section -->");
  });

  it("removes the file when the sentinel section was the entire content", async () => {
    const target = join(dir, "CLAUDE.md");
    writeFileSync(
      target,
      "<!-- mcp-coordinator:coordination-section -->\nstuff\n<!-- mcp-coordinator:coordination-section -->\n",
    );

    await createUninstallCommand().parseAsync(["node", "uninstall", "--claude-md", dir]);

    expect(existsSync(target)).toBe(false);
  });

  it("SECURITY: no sentinel present → file left byte-for-byte unchanged, 'nothing to remove'", async () => {
    const target = join(dir, "CLAUDE.md");
    const original = "# My Project\n\nJust regular user content, no coordinator section.\n";
    writeFileSync(target, original);

    await createUninstallCommand().parseAsync(["node", "uninstall", "--claude-md", dir]);

    expect(readFileSync(target, "utf-8")).toBe(original);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/nothing to remove/i);
  });
});

describe("cli uninstall — --purge (rmSync path 3: whole config dir)", () => {
  let configDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "mcp-coord-uninstall-purge-"));
    mkdirSync(join(configDir, "data"), { recursive: true });
    mkdirSync(join(configDir, "logs"), { recursive: true });
    writeFileSync(join(configDir, "config.json"), "{}\n");
    writeFileSync(join(configDir, "coordinator.pid"), "1234\n");

    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // IMPORTANT: this file has a static top-level `import { createUninstallCommand }
    // from "../../cli/uninstall.js"` (used by the describe blocks above), which
    // pre-loads and caches cli/uninstall.js — and transitively the REAL
    // cli/config.js — before this beforeEach ever runs. Without resetModules()
    // here, the dynamic `import("../../cli/uninstall.js")` below would resolve
    // from that stale cache and silently use the REAL getConfigDir() (i.e. the
    // real ~/.mcp-coordinator), not our mock. Clear the cache first so the
    // dynamic import below re-evaluates the module graph against the mock.
    vi.resetModules();

    // Redirect getConfigDir() to our temp dir instead of the real
    // ~/.mcp-coordinator — same vi.doMock pattern as
    // tests/unit/cli-doctor-init-loadconfig-wrap.test.ts. This MUST stay in
    // place for the whole test: never let --purge touch the real homedir.
    vi.doMock("../../cli/config.js", async () => {
      const real =
        await vi.importActual<typeof import("../../cli/config.js")>("../../cli/config.js");
      return { ...real, getConfigDir: () => configDir };
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.doUnmock("../../cli/config.js");
    vi.resetModules();
    // Belt-and-suspenders: only ever rm the temp dir we created above, and
    // only if the test didn't already delete it.
    if (existsSync(configDir)) rmSync(configDir, { recursive: true, force: true });
  });

  it("--purge --force deletes the (redirected, temp) config dir", async () => {
    const mod = await import("../../cli/uninstall.js");
    expect(existsSync(configDir)).toBe(true);

    await mod.createUninstallCommand().parseAsync(["node", "uninstall", "--purge", "--force"]);

    expect(existsSync(configDir)).toBe(false);
    // Guard against the mock silently not taking effect (which would hit the
    // real, non-existent ~/.mcp-coordinator and log "nothing to purge"
    // instead of actually purging our temp dir) — see the resetModules()
    // comment above for why this previously happened.
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).not.toMatch(/nothing to purge/i);
    expect(out).toMatch(/Purged config dir/);
  });

  it("SECURITY: --purge without --force, answering 'N' to the confirmation prompt aborts — dir is NOT deleted", async () => {
    const mod = await import("../../cli/uninstall.js");
    expect(existsSync(configDir)).toBe(true);

    const parsePromise = mod.createUninstallCommand().parseAsync(["node", "uninstall", "--purge"]);

    // Let the action reach `process.stdin.once("data", ...)` before we answer.
    await new Promise((r) => setImmediate(r));
    process.stdin.emit("data", Buffer.from("N\n"));

    await parsePromise;

    expect(existsSync(configDir)).toBe(true);
    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/Aborted/);
  });

  it("SECURITY: no config dir at all (already absent) → 'nothing to purge', no crash", async () => {
    rmSync(configDir, { recursive: true, force: true });
    const mod = await import("../../cli/uninstall.js");

    await expect(
      mod.createUninstallCommand().parseAsync(["node", "uninstall", "--purge", "--force"]),
    ).resolves.not.toThrow();

    const out = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(out).toMatch(/nothing to purge/i);
  });
});
