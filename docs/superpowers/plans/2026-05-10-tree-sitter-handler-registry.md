# TreeSitterExtractor Handler Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/tree-sitter-extractor.ts` to use a declarative `HANDLERS` registry replacing if/else chains, then add 8 new language grammars (C#, C, C++, Ruby, PHP, Kotlin, Swift, Bash).

**Architecture:** A `LanguageHandler` interface describes each language declaratively (class node types, function node types, container types, and optional special-case hooks). The `walk()` method consults the registry instead of if/else branches. New grammars are pure data additions — no imperative code changes.

**Tech Stack:** TypeScript (strict), tree-sitter (native Node bindings), vitest

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/tree-sitter-extractor.ts` | Modify | Add `LanguageHandler` interface + `HANDLERS` registry; refactor `walk()`; extend `extToKey()` and `load()`; bump `totalGrammars` |
| `package.json` | Modify | Add 8 new entries to `optionalDependencies` |
| `tests/unit/tree-sitter-extract.test.ts` | Modify | Append 8 new language tests |

---

## Task 1: Add `LanguageHandler` type and `HANDLERS` registry stubs (TypeScript only — no behavior change)

**Files:**
- Modify: `src/tree-sitter-extractor.ts`

- [ ] **Step 1: Read the current file**

Open `src/tree-sitter-extractor.ts` and keep the full current content in mind. The existing `walk()` has five logical sections:
1. Class-like containers (ts/tsx/js class_declaration, py class_definition, java class_declaration)
2. Rust impl_item container
3. Function-like leaves (`isFn` predicate)
4. `const X = arrow/function` variable declarators (ts/tsx/js only)
5. Default export anonymous (ts/tsx/js only)

- [ ] **Step 2: Insert types and registry above the class declaration**

Replace everything before `export class TreeSitterExtractor` with the following block (keep all imports intact above it):

```typescript
import path from "path";
import type { Metrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Language handler registry
// ---------------------------------------------------------------------------

/** Passed through walk() calls — mutable accumulator + read-only context. */
interface WalkCtx {
  out: string[];
  lang: string;
  basename: string;
}

interface LanguageHandler {
  /** Node types that introduce a class scope; descend children with classCtx = name field text. */
  classNodeTypes: Set<string>;
  /** Field name for the class identifier. Defaults to "name". */
  classNameField?: string;
  /** Node types that emit a symbol (qualified when inside a class scope). */
  fnNodeTypes: Set<string>;
  /**
   * Override symbol name extraction for function nodes.
   * Return null to suppress emission; return a string to emit it.
   * `rawName` is `node.childForFieldName("name")?.text ?? null`.
   */
  extractFnName?: (node: any, rawName: string | null, classCtx: string | null, ctx: WalkCtx) => string | null;
  /**
   * Node types that act as non-class containers (e.g. Rust impl, Ruby module).
   * Descend children with classCtx = extractContainerName(node).
   */
  containerNodeTypes?: Set<string>;
  extractContainerName?: (node: any) => string | null;
  /**
   * Node types for `const X = () => …` style declarations.
   * If value field is arrow_function or function_expression, emit name field text.
   */
  varDeclTypes?: Set<string>;
  /**
   * Node types for anonymous default exports (`export default () => …`).
   * When matched, emit `${basename}:default`.
   */
  exportStmtTypes?: Set<string>;
}

const HANDLERS: Record<string, LanguageHandler> = {
  // Stubs — filled in Tasks 2 and 3.
};
```

- [ ] **Step 3: Verify TypeScript compiles (no behavior change yet)**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc --noEmit 2>&1 | tail -10
```

Expected: 0 errors (the registry is empty so nothing references the new types yet).

- [ ] **Step 4: Commit stub**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add src/tree-sitter-extractor.ts
git commit -m "refactor(extractor): add LanguageHandler interface and empty HANDLERS registry"
```

---

## Task 2: Migrate existing 7 grammars into HANDLERS

**Files:**
- Modify: `src/tree-sitter-extractor.ts`

- [ ] **Step 1: Replace the empty `HANDLERS = {}` stub with the full 7-language registry**

```typescript
const HANDLERS: Record<string, LanguageHandler> = {
  ts: {
    classNodeTypes: new Set(["class_declaration"]),
    fnNodeTypes: new Set(["function_declaration", "method_definition"]),
    varDeclTypes: new Set(["variable_declarator"]),
    exportStmtTypes: new Set(["export_statement"]),
  },
  tsx: {
    classNodeTypes: new Set(["class_declaration"]),
    fnNodeTypes: new Set(["function_declaration", "method_definition"]),
    varDeclTypes: new Set(["variable_declarator"]),
    exportStmtTypes: new Set(["export_statement"]),
  },
  js: {
    classNodeTypes: new Set(["class_declaration"]),
    fnNodeTypes: new Set(["function_declaration", "method_definition"]),
    varDeclTypes: new Set(["variable_declarator"]),
    exportStmtTypes: new Set(["export_statement"]),
  },
  py: {
    classNodeTypes: new Set(["class_definition"]),
    fnNodeTypes: new Set(["function_definition"]),
  },
  go: {
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_declaration", "method_declaration"]),
    extractFnName: (node, rawName, classCtx, _ctx) => {
      if (node.type === "method_declaration") {
        const recv = node.childForFieldName?.("receiver");
        const recvType = goReceiverType(recv);
        if (recvType && rawName) return `${recvType}.${rawName}`;
        return rawName;
      }
      if (classCtx && rawName) return `${classCtx}.${rawName}`;
      return rawName;
    },
  },
  rust: {
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_item"]),
    containerNodeTypes: new Set(["impl_item"]),
    extractContainerName: (node) => node.childForFieldName?.("type")?.text ?? null,
  },
  java: {
    classNodeTypes: new Set(["class_declaration"]),
    fnNodeTypes: new Set(["method_declaration"]),
  },
};
```

Note: `goReceiverType` and `findGoTypeIdent` become **module-level** free functions (not class methods) since `extractFnName` is a plain function. Move them out of the class.

- [ ] **Step 2: Replace `walk()` method with a registry-driven implementation**

Replace the entire `private walk(...)` method (and the two private Go helper methods) with this single method (plus free functions above the class):

**Free functions to add above the class (before `const HANDLERS`):**

```typescript
function goReceiverType(recv: any): string | null {
  if (!recv) return null;
  for (let i = 0; i < recv.namedChildCount; i++) {
    const found = findGoTypeIdent(recv.namedChild(i));
    if (found) return found;
  }
  return null;
}

function findGoTypeIdent(node: any): string | null {
  if (!node) return null;
  if (node.type === "type_identifier") return node.text;
  if (node.type === "pointer_type") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const found = findGoTypeIdent(node.namedChild(i));
      if (found) return found;
    }
  }
  if (node.type === "parameter_declaration") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child.type !== "identifier") {
        const found = findGoTypeIdent(child);
        if (found) return found;
      }
    }
  }
  return null;
}
```

**New `walk()` method inside the class:**

```typescript
private walk(node: any, out: string[], lang: string, basename: string, classCtx: string | null = null): void {
  if (out.length >= 200) return;
  const handler = HANDLERS[lang];
  if (!handler) return;

  const type = node.type;
  const nameField = handler.classNameField ?? "name";
  const nameNode = node.childForFieldName?.(nameField);
  const ctx: WalkCtx = { out, lang, basename };

  // 1. Class-like containers
  if (handler.classNodeTypes.has(type)) {
    const className = nameNode?.text ?? null;
    for (let i = 0; i < node.namedChildCount; i++) {
      this.walk(node.namedChild(i), out, lang, basename, className);
    }
    return;
  }

  // 2. Non-class containers (Rust impl, Ruby module, etc.)
  if (handler.containerNodeTypes?.has(type)) {
    const containerName = handler.extractContainerName?.(node) ?? null;
    for (let i = 0; i < node.namedChildCount; i++) {
      this.walk(node.namedChild(i), out, lang, basename, containerName);
    }
    return;
  }

  // 3. Function-like leaves
  if (handler.fnNodeTypes.has(type)) {
    const rawName = node.childForFieldName?.("name")?.text ?? null;
    let emitted: string | null;
    if (handler.extractFnName) {
      emitted = handler.extractFnName(node, rawName, classCtx, ctx);
    } else {
      emitted = rawName;
      if (emitted && classCtx) emitted = `${classCtx}.${emitted}`;
    }
    if (emitted) out.push(emitted);
    return;
  }

  // 4. Variable declarators (const X = () => …)
  if (handler.varDeclTypes?.has(type)) {
    const valNode = node.childForFieldName?.("value");
    if (valNode && (valNode.type === "arrow_function" || valNode.type === "function_expression")) {
      const name = node.childForFieldName?.("name")?.text;
      if (name) out.push(name);
    }
    return;
  }

  // 5. Anonymous default exports
  if (handler.exportStmtTypes?.has(type)) {
    const decl = node.namedChild(0);
    if (decl && (
      decl.type === "arrow_function" ||
      (decl.type === "function_declaration" && !decl.childForFieldName?.("name"))
    )) {
      out.push(`${basename}:default`);
      return;
    }
    // Named export — fall through to recurse so class/fn inside are captured
  }

  // Recurse
  for (let i = 0; i < node.namedChildCount; i++) {
    this.walk(node.namedChild(i), out, lang, basename, classCtx);
  }
}
```

Also remove the two now-dead private methods `goReceiverType` and `findGoTypeIdent` from the class body.

- [ ] **Step 3: Run existing tests — all 9 must pass**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx vitest run tests/unit/tree-sitter-extract.test.ts 2>&1
```

Expected output: `9 passed`, 0 failed. If any test fails, check that the handler entry matches the original `if/else` logic exactly before proceeding.

- [ ] **Step 4: Type-check**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc --noEmit 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add src/tree-sitter-extractor.ts
git commit -m "refactor(extractor): migrate 7 existing grammars to HANDLERS registry; registry-driven walk()"
```

---

## Task 3: Add 8 new language handlers to the registry

**Files:**
- Modify: `src/tree-sitter-extractor.ts`

No grammar packages are installed yet — these are purely data additions. Tests will be guarded by `if (symbols !== null)` and will auto-skip if grammars are missing.

- [ ] **Step 1: Append 8 new handler entries to `HANDLERS`**

Add these entries after the `java` entry:

```typescript
  cs: {
    // C# — tree-sitter-c-sharp
    classNodeTypes: new Set(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration"]),
    fnNodeTypes: new Set(["method_declaration", "constructor_declaration", "property_declaration"]),
    containerNodeTypes: new Set(["namespace_declaration"]),
    // namespace does NOT contribute to qualified name — just descend transparently
    extractContainerName: (_node) => null,
  },
  c: {
    // C — tree-sitter-c (no classes)
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_definition"]),
  },
  cpp: {
    // C++ — tree-sitter-cpp
    classNodeTypes: new Set(["class_specifier", "struct_specifier"]),
    fnNodeTypes: new Set(["function_definition", "function_declarator"]),
  },
  ruby: {
    // Ruby — tree-sitter-ruby
    classNodeTypes: new Set(["class"]),
    fnNodeTypes: new Set(["method", "singleton_method"]),
    containerNodeTypes: new Set(["module"]),
    // module wraps names — use module name as classCtx
    extractContainerName: (node) => node.childForFieldName?.("name")?.text ?? null,
  },
  php: {
    // PHP — tree-sitter-php
    classNodeTypes: new Set(["class_declaration", "interface_declaration", "trait_declaration"]),
    fnNodeTypes: new Set(["method_declaration", "function_definition"]),
    containerNodeTypes: new Set(["namespace_definition"]),
    // namespace does NOT contribute to qualified name — just descend transparently
    extractContainerName: (_node) => null,
  },
  kotlin: {
    // Kotlin — tree-sitter-kotlin
    classNodeTypes: new Set(["class_declaration", "object_declaration"]),
    fnNodeTypes: new Set(["function_declaration"]),
  },
  swift: {
    // Swift — tree-sitter-swift
    classNodeTypes: new Set(["class_declaration", "struct_declaration", "protocol_declaration"]),
    fnNodeTypes: new Set(["function_declaration"]),
    containerNodeTypes: new Set(["extension_declaration"]),
    // extension wraps names with the type they extend
    extractContainerName: (node) => node.childForFieldName?.("type")?.text
      ?? node.namedChild(0)?.text
      ?? null,
  },
  bash: {
    // Bash — tree-sitter-bash (no classes)
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_definition"]),
  },
```

- [ ] **Step 2: Type-check (handlers are data only — no runnable side-effects)**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc --noEmit 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add src/tree-sitter-extractor.ts
git commit -m "feat(extractor): add C#/C/C++/Ruby/PHP/Kotlin/Swift/Bash handler stubs to HANDLERS registry"
```

---

## Task 4: Extend `extToKey()` and `load()` for new languages

**Files:**
- Modify: `src/tree-sitter-extractor.ts`

- [ ] **Step 1: Update `extToKey()`**

Replace the existing `extToKey` method with:

```typescript
private extToKey(ext: string): string | null {
  switch (ext) {
    case ".ts": return "ts";
    case ".tsx": return "tsx";
    case ".js": case ".jsx": case ".mjs": case ".cjs": return "js";
    case ".py": return "py";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".java": return "java";
    case ".cs": return "cs";
    case ".c": case ".h": return "c";
    case ".cpp": case ".cc": case ".cxx": case ".hpp": case ".hh": return "cpp";
    case ".rb": return "ruby";
    case ".php": return "php";
    case ".kt": case ".kts": return "kotlin";
    case ".swift": return "swift";
    case ".sh": case ".bash": return "bash";
    default: return null;
  }
}
```

- [ ] **Step 2: Update `load()` and `totalGrammars`**

Change `private totalGrammars = 7;` to `private totalGrammars = 15;` (7 existing parsers + 8 new ones; ts and tsx share one npm package but are separate parsers).

Append these `tryLoad` calls after `await tryLoad("java", "tree-sitter-java");`:

```typescript
await tryLoad("cs", "tree-sitter-c-sharp");
await tryLoad("c", "tree-sitter-c");
await tryLoad("cpp", "tree-sitter-cpp");
await tryLoad("ruby", "tree-sitter-ruby");
await tryLoad("php", "tree-sitter-php", "php");   // tree-sitter-php exports { php, php_only } sub-grammars
await tryLoad("kotlin", "tree-sitter-kotlin");
await tryLoad("swift", "tree-sitter-swift");
await tryLoad("bash", "tree-sitter-bash");
```

Note on PHP: `tree-sitter-php` typically exports `{ php }` as the named sub-grammar to handle `<?php` preamble correctly. The `tryLoad` 3rd arg is the sub-key.

- [ ] **Step 3: Type-check**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc --noEmit 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add src/tree-sitter-extractor.ts
git commit -m "feat(extractor): extend extToKey() and load() for 8 new language grammars"
```

---

## Task 5: Add new packages to `package.json` optionalDependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update `optionalDependencies` section**

Replace the current `optionalDependencies` block:

```json
"optionalDependencies": {
  "tree-sitter": "^0.21.1",
  "tree-sitter-typescript": "^0.21.2",
  "tree-sitter-javascript": "^0.21.4",
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-go": "^0.21.0",
  "tree-sitter-rust": "^0.21.2",
  "tree-sitter-java": "^0.21.0",
  "tree-sitter-c-sharp": "^0.21.3",
  "tree-sitter-c": "^0.21.0",
  "tree-sitter-cpp": "^0.22.0",
  "tree-sitter-ruby": "^0.21.0",
  "tree-sitter-php": "^0.22.0",
  "tree-sitter-kotlin": "^0.3.0",
  "tree-sitter-swift": "^0.6.0",
  "tree-sitter-bash": "^0.21.0"
}
```

- [ ] **Step 2: Run `npm install` to resolve and lock new packages**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npm install 2>&1 | tail -10
```

Expected: Some packages may warn "optional dep failed" on Windows — that is acceptable. Exit code 0.

- [ ] **Step 3: Commit**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add package.json package-lock.json
git commit -m "feat(extractor): add 8 new tree-sitter grammars to optionalDependencies"
```

---

## Task 6: Add 8 new language tests

**Files:**
- Modify: `tests/unit/tree-sitter-extract.test.ts`

- [ ] **Step 1: Append new tests inside the existing `describe` block, before the closing `});`**

```typescript
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
```

- [ ] **Step 2: Run all tests — 9 existing must pass; new ones may skip (symbols === null) if grammars absent**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx vitest run tests/unit/tree-sitter-extract.test.ts 2>&1
```

Expected: `17 passed` (or some skipped via `if (symbols !== null)` guard — no failures).

- [ ] **Step 3: Run full test suite**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npm test 2>&1 | grep -E "Test Files|Tests"
```

Expected: All test files green, 0 failed.

- [ ] **Step 4: Commit**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add tests/unit/tree-sitter-extract.test.ts
git commit -m "test(extractor): add 8 new language tests (C#/C/C++/Ruby/PHP/Kotlin/Swift/Bash)"
```

---

## Task 7: Grammar node-type validation and fixes

**Context:** Tree-sitter grammar node type names are guesses based on convention. If any new language test asserts a symbol but gets `null` instead, the grammar installed but the node types are wrong. This task fixes those discrepancies.

**Files:**
- Modify: `src/tree-sitter-extractor.ts` (HANDLERS entries only)

- [ ] **Step 1: After npm install, check which grammars actually loaded**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && node --input-type=module << 'EOF'
import { TreeSitterExtractor } from "./src/tree-sitter-extractor.js";
const e = new TreeSitterExtractor();
await e.load();
console.log(e.status());
EOF
```

This requires a build first:

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc 2>&1 | tail -5 && node --input-type=module << 'EOF'
import { TreeSitterExtractor } from "./dist/src/tree-sitter-extractor.js";
const e = new TreeSitterExtractor();
await e.load();
console.log(JSON.stringify(e.status(), null, 2));
EOF
```

Expected: `grammars_loaded` shows how many installed successfully. Total 15.

- [ ] **Step 2: For each failing test (grammar loaded but symbol not found), inspect the grammar**

For any language whose test fails with "received array does not contain expected value", check the grammar's actual node type names:

```bash
# Example for Ruby — check what class and method node types actually exist
node --input-type=module << 'EOF'
const mod = await import("tree-sitter-ruby");
const lang = mod.default || mod;
// Parse a simple snippet and inspect the tree
import Parser from "tree-sitter";
const p = new Parser();
p.setLanguage(lang);
const tree = p.parse("class C\n  def method\n    1\n  end\nend\n");
const walk = (n, depth=0) => {
  console.log(" ".repeat(depth*2) + n.type + " [" + n.text.slice(0,30).replace(/\n/g,"\\n") + "]");
  for(let i=0;i<n.namedChildCount;i++) walk(n.namedChild(i), depth+1);
};
walk(tree.rootNode);
EOF
```

- [ ] **Step 3: Update HANDLERS entry if node types differ**

Common known variations to watch for:

| Language | Guessed type | Possible actual type |
|---|---|---|
| Ruby | `method` | `method` (usually correct) |
| PHP | `method_declaration` | `method_declaration` ✓ or `function_definition` |
| Kotlin | `function_declaration` | `function_declaration` ✓ or `multiline_string_literal` (unlikely) |
| Swift | `function_declaration` | `function_declaration` ✓ |
| C++ | `function_definition` | `function_definition` ✓ |
| Bash | `function_definition` | `function_definition` ✓ |

If a node type is wrong, update only the relevant `HANDLERS` entry. Run the test again after each fix.

- [ ] **Step 4: Re-run tests after any fixes**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx vitest run tests/unit/tree-sitter-extract.test.ts 2>&1
```

Expected: 0 failures. Tests for grammars that failed to install are auto-skipped by `if (symbols !== null)`.

- [ ] **Step 5: Commit any fixes**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git add src/tree-sitter-extractor.ts
git commit -m "fix(extractor): correct node type names for new language handlers based on actual grammars"
```

(Skip this step if no fixes were needed.)

---

## Task 8: Final verification and push

**Files:** None modified — verification only.

- [ ] **Step 1: Full type check**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npx tsc --noEmit 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 2: Full test suite**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && npm test 2>&1 | grep -E "Test Files|Tests"
```

Expected: All passing, 0 failed.

- [ ] **Step 3: Check file size**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && wc -l src/tree-sitter-extractor.ts
```

Expected: ≤350 lines.

- [ ] **Step 4: Push the branch**

```bash
cd C:/Users/gagno/projet/mcp-coordinator-new && git push origin feat/v0.6-semantic-conflict
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Refactor walk() to use HANDLERS registry — Task 2
- [x] Preserve all existing 9 tests — Task 2 Step 3
- [x] 200-symbol cap preserved — inside new walk() method
- [x] _changedRanges reserved parameter preserved — untouched
- [x] TypeScript strict (no any in public API) — WalkCtx and LanguageHandler interfaces are fully typed; `any` used only on node params
- [x] File size ≤350 LOC — Task 8 Step 3 verifies
- [x] C# — Task 3 + Task 6
- [x] C — Task 3 + Task 6
- [x] C++ — Task 3 + Task 6
- [x] Ruby — Task 3 + Task 6
- [x] PHP (with `php` sub-grammar) — Task 3/4 + Task 6
- [x] Kotlin — Task 3 + Task 6
- [x] Swift — Task 3 + Task 6
- [x] Bash — Task 3 + Task 6
- [x] extToKey() extended — Task 4
- [x] load() extended with 8 new tryLoad calls — Task 4
- [x] totalGrammars bumped to 15 — Task 4
- [x] package.json optionalDependencies updated — Task 5
- [x] package-lock.json committed — Task 5

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency:**
- `WalkCtx` defined once in Task 1 and used in `LanguageHandler.extractFnName` signature — consistent.
- `extractContainerName` takes `any` node and returns `string | null` — used identically in Rust, C#, PHP, Ruby, Swift handlers.
- `goReceiverType` moved from class to module-level free function — called correctly from `go.extractFnName` closure in HANDLERS.
- `walk()` references `HANDLERS[lang]` which is `LanguageHandler | undefined` — guarded by `if (!handler) return`.
