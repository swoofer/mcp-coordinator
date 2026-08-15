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
  repoRoot: string | null,
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
