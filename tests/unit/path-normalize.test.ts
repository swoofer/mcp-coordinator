import { describe, it, expect } from "vitest";
import path from "path";
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
});
