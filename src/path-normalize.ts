import path from "path";

/**
 * Normalize a file path for matching/correctness — NOT security.
 *
 * Returns POSIX (forward slash), repo-relative when repoRoot is provided,
 * lower-cased on Windows for case-insensitive FS detection. Collapses ./
 * and .. segments via path.posix.normalize.
 *
 * Throws when an absolute path falls outside repoRoot. Security path
 * traversal checks are separate (see path-guard.ts:safeJoinUnderRoot).
 */
export function normalizePath(repoRoot: string | null, input: string): string {
  const isWindows = process.platform === "win32";

  // 1. Forward slash always.
  let p = input.replace(/\\/g, "/");

  // 2. Resolve against repoRoot when supplied.
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
      // Absolute path: must live under root.
      const lowerP = isWindows ? p.toLowerCase() : p;
      const lowerRoot = isWindows ? root.toLowerCase() : root;
      if (!lowerP.startsWith(lowerRoot + "/") && lowerP !== lowerRoot) {
        throw new Error(`path is outside repoRoot: ${input}`);
      }
      p = p.slice(root.length).replace(/^\/+/, "");
    }
  }

  // 3. Collapse ./ and .. segments.
  p = path.posix.normalize(p).replace(/^\.\//, "");

  // 4. Lower-case on Windows (case-insensitive FS).
  if (isWindows) p = p.toLowerCase();

  return p;
}
