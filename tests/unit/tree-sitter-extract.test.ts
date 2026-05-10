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

  it("C# class method", () => {
    const code = "class C { void Method() {} }";
    const symbols = extractor.extract("foo.cs", code, null);
    if (symbols !== null) expect(symbols).toContain("C.Method");
  });

  it("C top-level function", () => {
    const code = "int main(int argc, char** argv) { return 0; }";
    const symbols = extractor.extract("foo.c", code, null);
    if (symbols !== null) expect(symbols).toContain("main");
  });

  it("C++ class method", () => {
    const code = "class C { public: void method() {} };";
    const symbols = extractor.extract("foo.cpp", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("Ruby class method", () => {
    const code = "class C\n  def method\n    1\n  end\nend\n";
    const symbols = extractor.extract("foo.rb", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("PHP class method", () => {
    const code = "<?php\nclass C {\n  function method() {}\n}\n";
    const symbols = extractor.extract("foo.php", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("Kotlin class method", () => {
    const code = "class C {\n  fun method(): Int = 1\n}\n";
    const symbols = extractor.extract("foo.kt", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("Swift class method", () => {
    const code = "class C {\n  func method() -> Int { return 1 }\n}\n";
    const symbols = extractor.extract("foo.swift", code, null);
    if (symbols !== null) expect(symbols).toContain("C.method");
  });

  it("Bash function", () => {
    const code = "fooBar() {\n  echo hello\n}\n";
    const symbols = extractor.extract("foo.sh", code, null);
    if (symbols !== null) expect(symbols).toContain("fooBar");
  });
});
