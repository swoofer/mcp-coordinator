import path from "path";

/**
 * Resolve a request URL into a safe filesystem path within a known root.
 *
 * Defends against path traversal: a request like `/dashboard/../../etc/passwd`
 * would otherwise escape the dashboard directory because `path.join` does not
 * validate that the result stays under the root.
 *
 * Returns the resolved absolute path on success, or `null` if the path would
 * escape the root, contains a null byte, or is otherwise invalid.
 *
 * `urlPath` should already have the route prefix stripped (e.g. for
 * `/dashboard/app.js` pass `"app.js"`).
 */
export function safeJoinUnderRoot(root: string, urlPath: string): string | null {
  // Reject null bytes (NUL injection that some libs/OS handle inconsistently).
  if (urlPath.includes("\0")) return null;

  // Decode percent-encoding so "%2e%2e/foo" cannot bypass the literal ".." check.
  // decodeURIComponent throws on malformed sequences — treat as invalid.
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  // Strip leading slashes so absolute-path injection ("//etc/passwd") becomes relative.
  const trimmed = decoded.replace(/^[/\\]+/, "");

  // Empty after strip → caller decides what default file to serve.
  if (trimmed === "") return null;

  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, trimmed);

  // The resolved candidate MUST be either equal to the root or live below it.
  // Append separator before comparison to avoid the "/var/data" vs "/var/data-evil" trap.
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (candidate !== rootResolved && !candidate.startsWith(rootWithSep)) {
    return null;
  }

  return candidate;
}
