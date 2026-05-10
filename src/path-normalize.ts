import path from "path";

/**
 * Normalize a file path for matching/correctness — NOT security.
 *
 * Returns POSIX (forward slash), repo-relative when repoRoot is provided,
 * lower-cased when the path is Windows-style (drive letter prefix in repoRoot
 * or input, or backslash in input). Collapses ./ and .. segments via
 * path.posix.normalize.
 *
 * The lowercase pass is anchored to path SHAPE rather than `process.platform`
 * so a Linux coordinator processing paths from a Windows agent (or a CI run
 * exercising Windows-shaped fixtures) still produces consistent canonical
 * forms.
 *
 * Throws when an absolute path falls outside repoRoot. Security path
 * traversal checks are separate (see path-guard.ts:safeJoinUnderRoot).
 */
export function normalizePath(repoRoot: string | null, input: string): string {
  const isWindowsStyle =
    (repoRoot != null && (/^[a-zA-Z]:/.test(repoRoot) || repoRoot.includes("\\"))) ||
    /^[a-zA-Z]:/.test(input) ||
    input.includes("\\");

  let p = input.replace(/\\/g, "/");

  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
      const lowerP = isWindowsStyle ? p.toLowerCase() : p;
      const lowerRoot = isWindowsStyle ? root.toLowerCase() : root;
      if (!lowerP.startsWith(lowerRoot + "/") && lowerP !== lowerRoot) {
        throw new Error(`path is outside repoRoot: ${input}`);
      }
      p = p.slice(root.length).replace(/^\/+/, "");
    }
  }

  p = path.posix.normalize(p).replace(/^\.\//, "");

  if (isWindowsStyle) p = p.toLowerCase();

  return p;
}
