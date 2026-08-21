import path from "path";

/**
 * Normalize a file path for matching/correctness — NOT security.
 *
 * Returns POSIX (forward slash), repo-relative when any root is provided,
 * lower-cased when the path is Windows-style (drive letter prefix in a root or
 * in the input, or backslash in either). Collapses ./ and .. segments via
 * path.posix.normalize.
 *
 * The lowercase pass is anchored to path SHAPE rather than `process.platform`
 * so a Linux coordinator processing paths from a Windows agent (or a CI run
 * exercising Windows-shaped fixtures) still produces consistent canonical
 * forms.
 *
 * `repoRoot` accepts one root or many (#379). Many is what `repoRoots()`
 * returns: the configured root plus every worktree git knows about, so an
 * agent in a worktree lands on the same key as the main checkout instead of
 * being rejected (worktree outside the root) or silently filed under a second
 * key (worktree inside it, e.g. `.claude/worktrees/<name>/`).
 *
 * Throws when an absolute path falls under none of them. Security path
 * traversal checks are separate (see path-guard.ts:safeJoinUnderRoot).
 */
export function normalizePath(repoRoot: string | string[] | null, input: string): string {
  // #379: one root became many. A path may sit under the configured root OR
  // under any worktree git knows about, so try them longest-first and keep the
  // first that matches. Longest-first is the whole trick: a native worktree at
  // `<root>/.claude/worktrees/<name>` is a strict extension of the configured
  // root, so both match its absolute paths, and only the longer one yields the
  // same repo-relative key the main checkout produces for that file.
  const given = Array.isArray(repoRoot) ? repoRoot : repoRoot == null ? [] : [repoRoot];
  const roots = given
    .map((r) => r.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  // Test the roots AS GIVEN, not the slash-normalized copies: the copies can
  // no longer contain a backslash, so checking them would quietly drop the
  // UNC case (`\\server\share` has no drive letter and would stop counting as
  // Windows-shaped).
  const isWindowsStyle =
    given.some((r) => /^[a-zA-Z]:/.test(r) || r.includes("\\")) ||
    /^[a-zA-Z]:/.test(input) ||
    input.includes("\\");

  let p = input.replace(/\\/g, "/");

  if (roots.length > 0) {
    if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
      const lowerP = isWindowsStyle ? p.toLowerCase() : p;
      const root = roots.find((r) => {
        const lowerRoot = isWindowsStyle ? r.toLowerCase() : r;
        return lowerP.startsWith(lowerRoot + "/") || lowerP === lowerRoot;
      });
      if (root === undefined) {
        // #379 shipped a diagnostic here that named the rule and then told the
        // reader the remedy did not apply to them: "Paths in another checkout
        // or worktree cannot be expressed today". That was false — declaring
        // `src/foo.ts` relative produces exactly the key the main checkout
        // produces — and it is the sentence a reader in a worktree would act
        // on, by giving up. Absolute paths from worktrees git knows about now
        // normalize, so what still lands here really is outside the repository.
        throw new Error(
          `path is outside repoRoot: ${input} (known roots: ${roots.join(", ")}). ` +
            `Pass a repo-relative forward-slash path — that always works, including from ` +
            `a second worktree — or an absolute path under one of those roots. ` +
            `Worktrees come from \`git worktree list\`, so one created just now may take ` +
            `up to a minute to be recognised.`,
        );
      }
      p = p.slice(root.length).replace(/^\/+/, "");
    }
  }

  p = path.posix.normalize(p).replace(/^\.\//, "");

  if (isWindowsStyle) p = p.toLowerCase();

  return p;
}

/** A declared path that could not be normalized, and why. */
export interface DeclaredPathRejection {
  path: string;
  message: string;
}

export type DeclaredPathsResult =
  { ok: true; paths: string[] } | { ok: false; rejected: DeclaredPathRejection };

/**
 * Normalize a list of DECLARED paths — what an agent says it will touch —
 * into the same canonical form the OBSERVED side is already stored in.
 *
 * issue #275: `normalizePath` had exactly three call sites, all on the
 * observed side (`/api/file-activity`, `/api/working-files/{start,stop}`).
 * The declared side (`announce_work`, `POST /api/announce`,
 * `check_file_conflict`) passed raw strings straight through to queries that
 * match observed columns by exact SQL equality. On Windows the normalizer
 * lower-cases, so an agent announcing `src/Types.ts` never joined against its
 * own activity — Layer 1, the strongest signal in the scoring, silently
 * returned nothing. `./src/types.ts` and a backslash path missed the same way.
 *
 * Returns the first rejection rather than throwing, so each caller can answer
 * in its own idiom (HTTP 400, or a structured MCP tool error).
 */
export function normalizeDeclaredPaths(
  repoRoot: string | string[] | null,
  paths: readonly string[] | undefined,
): DeclaredPathsResult {
  if (!paths || paths.length === 0) return { ok: true, paths: [] };
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(normalizePath(repoRoot, p));
    } catch (err) {
      return { ok: false, rejected: { path: p, message: (err as Error).message } };
    }
  }
  return { ok: true, paths: out };
}
