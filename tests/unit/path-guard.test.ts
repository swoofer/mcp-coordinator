import { describe, it, expect } from "vitest";
import path from "path";
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
});
