import { describe, it, expect } from "vitest";
import { SUBCOMMANDS, subcommandsFor } from "../../cli/subcommands.js";

/**
 * issue #278 — the CLI imported all nine subcommands eagerly, and
 * cli/init.ts pulls src/boot.js, which builds the entire server graph at
 * module scope. So `mcp-coordinator --version` loaded every IdP provider, both
 * rate limiters, the audit queue and the Sweeper before printing a string.
 *
 * Measured interleaved on one machine, p50 over 9 cold processes each side
 * (Node floor 52 ms):
 *
 *   --version       1175 ms -> 82 ms   14.3x
 *   server --help   1247 ms -> 116 ms  10.8x
 *   doctor --help    111 ms -> 112 ms   unchanged
 *   --help          1215 ms -> 1228 ms  unchanged
 *
 * The two unchanged rows are the honest ones: --help has to know every command
 * to list it, and doctor already had a hand-written fast path (#282) that this
 * generalises without regressing.
 */

const argv = (...args: string[]) => ["node", "cli/index.js", ...args];

describe("subcommandsFor (#278)", () => {
  it("loads only the named subcommand", () => {
    expect(subcommandsFor(argv("server", "start", "--daemon"))).toEqual(["server"]);
    expect(subcommandsFor(argv("doctor"))).toEqual(["doctor"]);
    expect(subcommandsFor(argv("rotate-jwt-secret"))).toEqual(["rotate-jwt-secret"]);
  });

  it("loads nothing for --version", () => {
    // program.version() answers before dispatch, so no subcommand is needed.
    // This is the measured case: 1175 ms -> 82 ms.
    expect(subcommandsFor(argv("--version"))).toEqual([]);
    expect(subcommandsFor(argv("-V"))).toEqual([]);
  });

  it("loads everything for --help", () => {
    // Commander can only list commands it has been given.
    expect(subcommandsFor(argv("--help")).sort()).toEqual(Object.keys(SUBCOMMANDS).sort());
  });

  it("loads everything with no arguments", () => {
    expect(subcommandsFor(argv()).sort()).toEqual(Object.keys(SUBCOMMANDS).sort());
  });

  it("loads everything for an unknown word", () => {
    // Loading nothing here would turn Commander's "unknown command" plus the
    // list of real ones into a bare usage line — worse for the typo it is.
    expect(subcommandsFor(argv("srever")).sort()).toEqual(Object.keys(SUBCOMMANDS).sort());
  });

  it("does not mistake a flag on a subcommand for a subcommand", () => {
    expect(subcommandsFor(argv("server", "--help"))).toEqual(["server"]);
  });
});

describe("the lazy map matches what the commands call themselves (#278)", () => {
  // The map is keyed by name; a key that does not match the name the factory
  // registers would make that subcommand silently unreachable — argv[2] would
  // miss the map, fall through to "load everything", and still work. Slow and
  // invisible, which is the failure mode worth a test.
  it("every key equals the registered command name", async () => {
    for (const [key, load] of Object.entries(SUBCOMMANDS)) {
      const command = await load();
      expect(command.name(), `SUBCOMMANDS["${key}"] registers as "${command.name()}"`).toBe(key);
    }
  }, 60_000);

  // Nine, not the eleven the issue says — cli/index.ts had nine imports and
  // nine addCommand calls. Counting the nested `server` and `encryption`
  // sub-subcommands separately is presumably where eleven came from.
  it("covers the nine the CLI used to import eagerly, plus stdio (#277)", () => {
    expect(Object.keys(SUBCOMMANDS).sort()).toEqual([
      "channel",
      "dashboard",
      "doctor",
      "encryption",
      "init",
      "rotate-jwt-secret",
      "server",
      "service-token",
      "stdio",
      "uninstall",
    ]);
  });
});
