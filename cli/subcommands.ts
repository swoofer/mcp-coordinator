import type { Command } from "commander";

/**
 * One dynamic importer per subcommand, keyed by the name the command registers
 * itself under (`new Command("<key>")`). Nothing here is imported until it is
 * called — that is the whole point (#278).
 *
 * The CLI used to import all nine eagerly. `cli/init.ts` pulls
 * `src/boot.js`, which loads the entire server graph at module scope: every
 * IdP provider, ProviderRegistry, MembershipCache, both rate limiters, the
 * audit queue, the audit chain, the Sweeper, boot-encryption. So printing a
 * version string loaded the whole authentication graph.
 *
 * Measured interleaved (both variants sampled in one process, alternating, so
 * machine load hits them equally), p50 over 9 cold processes each, Node floor
 * 52 ms: `--version` 1175 ms -> 82 ms, `server --help` 1247 ms -> 116 ms.
 *
 * Keep this map in sync with the names the factories register; a test derives
 * both sides and fails if they drift.
 */
export const SUBCOMMANDS: Record<string, () => Promise<Command>> = {
  init: async () => (await import("./init.js")).createInitCommand(),
  server: async () => (await import("./server/index.js")).createServerProgram(),
  stdio: async () => (await import("./stdio.js")).createStdioCommand(),
  channel: async () => (await import("./channel.js")).createChannelCommand(),
  dashboard: async () => (await import("./dashboard.js")).createDashboardCommand(),
  doctor: async () => (await import("./doctor.js")).createDoctorCommand(),
  uninstall: async () => (await import("./uninstall.js")).createUninstallCommand(),
  "service-token": async () => (await import("./service-tokens.js")).createServiceTokensCommand(),
  "rotate-jwt-secret": async () =>
    (await import("./rotate-jwt-secret.js")).createRotateJwtSecretCommand(),
  encryption: async () => (await import("./encryption/index.js")).createEncryptionCommand(),
};

/**
 * Which subcommands to load for this argv.
 *
 * A named subcommand loads only itself. Anything else — `--help`, no
 * arguments, an unknown word — loads all of them, because Commander can only
 * list or reject against commands it knows about. `--version` needs none:
 * `program.version()` answers it before dispatch.
 *
 * Returning the full set for the unknown case matters. Loading nothing would
 * make `mcp-coordinator srever` exit with a bare usage line instead of
 * Commander's "unknown command" plus the list the user needs.
 */
export function subcommandsFor(argv: readonly string[]): string[] {
  const first = argv[2];
  if (first === undefined) return Object.keys(SUBCOMMANDS);
  if (first === "--version" || first === "-V") return [];
  if (first in SUBCOMMANDS) return [first];
  return Object.keys(SUBCOMMANDS);
}
