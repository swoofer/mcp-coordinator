import { execFileSync } from "node:child_process";

/**
 * Every filesystem root whose paths belong to this repository (#379).
 *
 * `COORDINATOR_REPO_ROOT` is one process-wide value, and until this module
 * existed it was the ONLY root `normalizePath` would strip. That produced two
 * failure modes, and the issue only names the first:
 *
 *  - **Loud.** A worktree outside the root (`git worktree add ../feature-x`,
 *    which this project's own docs recommend) sends an absolute path, gets
 *    "outside repoRoot", and the REST routes turn it into a 400.
 *  - **Silent, and worse.** Claude Code's native worktrees live INSIDE the
 *    root, at `.claude/worktrees/<name>/`. An absolute path from one does not
 *    trip the outside-root check at all — it normalizes to
 *    `.claude/worktrees/<name>/src/foo.ts` while the main checkout stores
 *    `src/foo.ts`. `hot_files`, `checkFileConflict` and Layer 1 all join by
 *    exact equality, so that agent silently stops existing to the coordinator.
 *    No error, no log, nothing to search for.
 *
 * Asking git is what makes both go away at once, and it needs no schema
 * column, no registration contract, and nothing the agent has to get right:
 * `git worktree list --porcelain` enumerates in-root and out-of-root worktrees
 * alike, and the coordinator reads it from git rather than trusting a value an
 * agent reported about itself.
 */

/** How long an enumeration stays good. Worktrees are created by hand or by an
 * orchestrator, not per request, so a minute of staleness costs nothing. */
const TTL_MS = 60_000;

let cached: { roots: string[]; at: number; key: string } | null = null;

/** Strip a trailing slash and normalize separators, the way normalizePath does. */
function tidy(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Worktree roots known to git, or `[]` if git cannot tell us.
 *
 * Every failure is the same answer — an empty list, leaving the configured
 * root to behave exactly as it did before this module. Not a git repo, git not
 * installed, a repo so broken the command errors: none of those are worth
 * failing a coordination call over, and all of them are the operator's
 * business rather than the caller's.
 */
function worktreeRoots(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => tidy(l.slice("worktree ".length).trim()))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The roots to try when normalizing a declared path, longest first.
 *
 * Longest first is the whole trick for the silent case: a native worktree at
 * `<root>/.claude/worktrees/<name>` is a strict extension of the configured
 * root, so both match its absolute paths and only the longer one yields the
 * repo-relative key the main checkout would produce for the same file.
 *
 * Returns `[]` when no root is configured, which normalizePath already treats
 * as "store what you were given".
 */
export function repoRoots(): string[] {
  const configured = process.env.COORDINATOR_REPO_ROOT;
  if (!configured) return [];
  const root = tidy(configured);

  // Re-enumerate when the TTL lapses or the configured root moves under us
  // (the test suite does exactly that, and so does a daemon restart).
  const now = Date.now();
  if (!cached || cached.key !== root || now - cached.at > TTL_MS) {
    const found = worktreeRoots(root);
    const all = found.includes(root) ? found : [root, ...found];
    cached = { roots: all.sort((a, b) => b.length - a.length), at: now, key: root };
  }
  return cached.roots;
}

/** Drop the cache. For tests, and for anything that moves the root at runtime. */
export function resetRepoRootsCache(): void {
  cached = null;
}
