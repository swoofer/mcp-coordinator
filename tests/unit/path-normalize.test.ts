import { describe, it, expect } from "vitest";
import path from "path";
import fc from "fast-check";
import { normalizePath } from "../../src/path-normalize.js";

describe("normalizePath", () => {
  const winRoot = "C:\\Users\\me\\repo";
  const posixRoot = "/home/me/repo";

  it("Windows absolute → POSIX, repo-relative, lower-cased", () => {
    expect(normalizePath(winRoot, "C:\\Users\\me\\repo\\src\\Foo.ts")).toBe("src/foo.ts");
  });

  it("POSIX absolute → repo-relative, case preserved on POSIX", () => {
    if (path.sep === "/") {
      expect(normalizePath(posixRoot, "/home/me/repo/src/Foo.ts")).toBe("src/Foo.ts");
    }
  });

  it("relative ./src/foo.ts collapses leading ./", () => {
    expect(normalizePath(null, "./src/foo.ts")).toBe("src/foo.ts");
  });

  it("Windows backslash relative → forward slash", () => {
    expect(normalizePath(null, "src\\foo.ts")).toBe("src/foo.ts");
  });

  it("./.. segments collapsed", () => {
    expect(normalizePath(null, "src/../src/foo.ts")).toBe("src/foo.ts");
  });

  it("absolute path outside repoRoot throws", () => {
    expect(() => normalizePath(posixRoot, "/etc/passwd")).toThrow(/outside/i);
  });

  // tests-09: fast-check invariant. normalizePath is explicitly documented as
  // "NOT security" (path-guard.ts:safeJoinUnderRoot owns the traversal
  // guard) — its actual contract is: an absolute input that is genuinely
  // inside repoRoot always normalizes to a repo-relative, forward-slash,
  // lower-cased (Windows-shaped) path with no leading ".." and never throws.
  // Inputs are constructed to be inside repoRoot BY CONSTRUCTION (root +
  // random safe segments), so this only exercises the "stays inside" path —
  // the "outside repoRoot throws" branch is covered by the example test above.
  describe("property: any safe relative-segment chain under repoRoot normalizes cleanly", () => {
    const winRoot = "C:\\Users\\me\\repo";
    const segmentArb = fc.array(
      fc.constantFrom("src", "lib", "Foo", "BAR", "nested", "a1", "b2", "dashboard"),
      { minLength: 1, maxLength: 6 },
    );

    it("holds for Windows-shaped absolute inputs", () => {
      fc.assert(
        fc.property(segmentArb, (segments) => {
          const absoluteInput = `${winRoot}\\${segments.join("\\")}`;
          const result = normalizePath(winRoot, absoluteInput);
          const expected = segments.join("/").toLowerCase();
          return result === expected && !result.startsWith("..") && !result.includes("\\");
        }),
      );
    });
  });
});
