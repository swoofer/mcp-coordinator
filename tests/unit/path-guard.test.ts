import { describe, it, expect } from "vitest";
import path from "path";
import fc from "fast-check";
import { safeJoinUnderRoot } from "../../src/path-guard.js";

const ROOT = path.resolve("/dashboard-root");

describe("safeJoinUnderRoot (B5 fix - path traversal guard)", () => {
  it("allows a normal file under root", () => {
    const result = safeJoinUnderRoot(ROOT, "app.js");
    expect(result).toBe(path.resolve(ROOT, "app.js"));
  });

  it("allows a nested file under root", () => {
    const result = safeJoinUnderRoot(ROOT, "assets/css/main.css");
    expect(result).toBe(path.resolve(ROOT, "assets/css/main.css"));
  });

  it("rejects parent-directory traversal", () => {
    expect(safeJoinUnderRoot(ROOT, "../../etc/passwd")).toBeNull();
    expect(safeJoinUnderRoot(ROOT, "../secret")).toBeNull();
  });

  it("rejects deeply nested traversal", () => {
    expect(safeJoinUnderRoot(ROOT, "subdir/../../etc/passwd")).toBeNull();
  });

  it("rejects URL-encoded traversal", () => {
    expect(safeJoinUnderRoot(ROOT, "%2e%2e/etc/passwd")).toBeNull();
    expect(safeJoinUnderRoot(ROOT, "%2e%2e%2fetc%2fpasswd")).toBeNull();
  });

  it("rejects double-encoded traversal", () => {
    // %252e = literal "%2e"; decoded once → "%2e" which doesn't break out;
    // but if a downstream decoded again it would. We handle by decoding ONCE.
    expect(safeJoinUnderRoot(ROOT, "%252e%252e/etc/passwd")).not.toBeNull();
    // The above resolves to "%2e%2e/etc/passwd" under root — safe because
    // those literal chars stay as filename, not interpreted as `..`.
  });

  it("treats absolute-path injection as relative under root", () => {
    // Leading slash is stripped, making "/etc/passwd" become relative file
    // "etc/passwd" UNDER root. Safe because it stays in the dashboard dir.
    expect(safeJoinUnderRoot(ROOT, "/etc/passwd")).toBe(path.resolve(ROOT, "etc/passwd"));
    expect(safeJoinUnderRoot(ROOT, "//etc/passwd")).toBe(path.resolve(ROOT, "etc/passwd"));
  });

  it("rejects null-byte injection", () => {
    expect(safeJoinUnderRoot(ROOT, "app.js\0.png")).toBeNull();
  });

  it("rejects malformed percent encoding", () => {
    expect(safeJoinUnderRoot(ROOT, "%E0%A4%A")).toBeNull();
  });

  it("returns null for empty path (caller picks default)", () => {
    expect(safeJoinUnderRoot(ROOT, "")).toBeNull();
    expect(safeJoinUnderRoot(ROOT, "/")).toBeNull();
  });

  it("rejects sibling-directory escape (root-suffix trap)", () => {
    // If root is "/dashboard-root", path "../dashboard-root-evil/x" must be rejected
    const result = safeJoinUnderRoot(ROOT, "../dashboard-root-evil/x");
    expect(result).toBeNull();
  });

  // tests-09: fast-check invariants — safeJoinUnderRoot is the security
  // boundary (path-normalize.ts explicitly is NOT), so it's the ideal
  // fuzzing target: "never escapes root" must hold for ANY input, not just
  // the handful of traversal strings hand-picked above.
  describe("property: never escapes root, never leaves a residual '..' segment", () => {
    const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

    function invariantHolds(result: string | null): boolean {
      if (result === null) return true;
      const staysUnderRoot = result === ROOT || result.startsWith(rootWithSep);
      // Split on the OS path separator only. On POSIX, `\` is a legitimate
      // filename character, so an input like `..\..` resolves to a single
      // literal filename SAFELY under root — splitting on `[\\/]` there would
      // wrongly see a residual `..` segment (fast-check found this on Linux CI).
      // The resolved path is OS-native, so path.sep gives its real segments.
      const noResidualDotDot = !result.split(path.sep).includes("..");
      return staysUnderRoot && noResidualDotDot;
    }

    it("holds for arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (input) =>
          invariantHolds(safeJoinUnderRoot(ROOT, input)),
        ),
      );
    });

    it("holds for adversarial traversal-heavy paths (repeated '..', mixed separators, percent-encoding)", () => {
      const segment = fc.constantFrom(
        "..",
        "a",
        "b",
        ".",
        "sub",
        "%2e%2e",
        "%2e%2e%2f",
        "etc",
        "passwd",
      );
      const sep = fc.constantFrom("/", "\\");
      fc.assert(
        fc.property(fc.array(segment, { minLength: 1, maxLength: 12 }), sep, (segments, s) =>
          invariantHolds(safeJoinUnderRoot(ROOT, segments.join(s))),
        ),
      );
    });
  });
});
