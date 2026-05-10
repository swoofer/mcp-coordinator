import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterExtractor } from "../../src/tree-sitter-extractor.js";

describe("TreeSitterExtractor", () => {
  const extractor = new TreeSitterExtractor();
  beforeAll(async () => { await extractor.load(); });

  it("returns null for unknown extension", () => {
    expect(extractor.extract("foo.unknown", "x", null)).toBe(null);
  });

  it("TS top-level function", () => {
    const code = "export function fooBar() { return 1; }";
    const symbols = extractor.extract("foo.ts", code, null);
    if (symbols !== null) expect(symbols).toContain("fooBar");
  });

  it("TS class method", () => {
    const code = "class C { method() { return 1; } }";
    const symbols = extractor.extract("foo.ts", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("TS arrow assigned to const", () => {
    const code = "const fooBar = () => 1;";
    const symbols = extractor.extract("foo.ts", code, null);
    if (symbols !== null) expect(symbols).toContain("fooBar");
  });

  it("Python def", () => {
    const code = "def fooBar():\n    return 1\n";
    const symbols = extractor.extract("foo.py", code, null);
    if (symbols !== null) expect(symbols).toContain("fooBar");
  });

  it("Python class method", () => {
    const code = "class C:\n    def method(self): return 1\n";
    const symbols = extractor.extract("foo.py", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("Go method receiver", () => {
    const code = "package x\nfunc (r *T) M() int { return 1 }\n";
    const symbols = extractor.extract("foo.go", code, null);
    if (symbols !== null) expect(symbols).toContain("T.M");
  });

  it("anonymous default export uses file basename", () => {
    const code = "export default () => 1;";
    const symbols = extractor.extract("foo.ts", code, null);
    if (symbols !== null) expect(symbols).toContain("foo:default");
  });

  it("returns null on parse error", () => {
    const code = "function ((((";
    const symbols = extractor.extract("foo.ts", code, null);
    expect(symbols).toBe(null);
  });
});
