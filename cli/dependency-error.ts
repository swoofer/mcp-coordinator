/**
 * Turn a module-resolution failure into something an operator can act on.
 *
 * issue #282: when `node_modules` loses a link, the daemon dies on a raw
 * `cjs/loader` stack — twelve lines of Node internals naming a package nobody
 * declared (`@babel/runtime`, four levels below `mqtt`) and no indication of
 * what to do. The repair is a single command; finding it took twenty minutes.
 *
 * The reported causes are environmental and outside this repo: concurrent pnpm
 * activity against the shared global store, and — reproduced twice on
 * 2026-08-15 — `git worktree remove --force` following a `node_modules`
 * junction and deleting the target's contents rather than the link.
 *
 * `doctor` already probes for this ahead of time (checkDependencyTree). This
 * covers the other half: the moment it actually bites, on a start nobody ran
 * `doctor` before.
 */

const MISSING_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

/**
 * The missing package name, when `err` is a module-resolution failure.
 *
 * Node phrases it two ways: "Cannot find module 'x'" from the CJS loader (the
 * #282 case, thrown deep inside a transitive require) and "Cannot find package
 * 'x' imported from y" from the ESM loader.
 */
export function missingModuleFrom(err: unknown): string | null {
  const e = err as NodeJS.ErrnoException & { message?: string };
  const message = e?.message ?? "";
  const looksMissing =
    MISSING_CODES.has(e?.code ?? "") || /Cannot find module|Cannot find package/.test(message);
  if (!looksMissing) return null;
  const m = /Cannot find (?:module|package) '([^']+)'/.exec(message);
  return m?.[1] ?? "unknown";
}

/**
 * An actionable message, or null when this is not a dependency failure and the
 * caller should rethrow. Returning null rather than a generic string matters:
 * swallowing an unrelated crash behind a "run pnpm install" banner would send
 * the operator down the wrong path, which is the very failure being fixed.
 */
export function explainDependencyFailure(err: unknown): string | null {
  const missing = missingModuleFrom(err);
  if (missing === null) return null;
  return [
    `Dependency tree incomplete: cannot resolve '${missing}'.`,
    "",
    "  Fix: pnpm install --frozen-lockfile",
    "       (restores the tree without touching package.json or the lockfile)",
    "",
    "  This is usually not your code. A concurrent package-manager run, or a",
    "  worktree removal that followed a node_modules junction, can leave the",
    "  tree missing a link mid-flight. `mcp-coordinator doctor` reports it",
    "  without waiting for a failed start.",
  ].join("\n");
}
