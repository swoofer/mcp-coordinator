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
   */
  extractFnName?: (node: any, rawName: string | null, classCtx: string | null, ctx: WalkCtx) => string | null;
  /**
   * Node types that act as non-class containers (e.g. Rust impl, Ruby module).
   * Descend children with classCtx = extractContainerName(node).
   */
  containerNodeTypes?: Set<string>;
  extractContainerName?: (node: any) => string | null;
  /** Node types for `const X = () => …` style declarations. */
  varDeclTypes?: Set<string>;
  /** Node types for anonymous default exports (`export default () => …`). */
  exportStmtTypes?: Set<string>;
}

// ---------------------------------------------------------------------------
// Go receiver helpers (module-level so HANDLERS closure can reference them)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HANDLERS registry — one entry per language key
// ---------------------------------------------------------------------------

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
  cs: {
    classNodeTypes: new Set(["class_declaration", "interface_declaration", "struct_declaration", "record_declaration"]),
    fnNodeTypes: new Set(["method_declaration", "constructor_declaration", "property_declaration"]),
    containerNodeTypes: new Set(["namespace_declaration"]),
    extractContainerName: (_node) => null,
  },
  c: {
    // C: function name lives in declarator field, not "name" field
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_definition"]),
    extractFnName: (node, _rawName, classCtx, _ctx) => {
      // function_definition -> declarator (function_declarator) -> declarator (identifier)
      const decl = node.childForFieldName?.("declarator");
      const name = decl?.childForFieldName?.("declarator")?.text ?? decl?.namedChild?.(0)?.text ?? null;
      if (name && classCtx) return `${classCtx}.${name}`;
      return name;
    },
  },
  cpp: {
    // C++: class_specifier has "name" field; function name via declarator chain
    classNodeTypes: new Set(["class_specifier", "struct_specifier"]),
    fnNodeTypes: new Set(["function_definition"]),
    extractFnName: (node, _rawName, classCtx, _ctx) => {
      const decl = node.childForFieldName?.("declarator");
      const name = decl?.childForFieldName?.("declarator")?.text ?? decl?.namedChild?.(0)?.text ?? null;
      if (name && classCtx) return `${classCtx}.${name}`;
      return name;
    },
  },
  ruby: {
    classNodeTypes: new Set(["class"]),
    fnNodeTypes: new Set(["method", "singleton_method"]),
    containerNodeTypes: new Set(["module"]),
    extractContainerName: (node) => node.childForFieldName?.("name")?.text ?? null,
  },
  php: {
    classNodeTypes: new Set(["class_declaration", "interface_declaration", "trait_declaration"]),
    fnNodeTypes: new Set(["method_declaration", "function_definition"]),
    containerNodeTypes: new Set(["namespace_definition"]),
    extractContainerName: (_node) => null,
  },
  kotlin: {
    // Kotlin: class/object have no "name" field — use namedChild(0) (type_identifier)
    // function_declaration has no "name" field — use namedChild(0) (simple_identifier)
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_declaration"]),
    containerNodeTypes: new Set(["class_declaration", "object_declaration"]),
    extractContainerName: (node) => node.namedChild(0)?.text ?? null,
    extractFnName: (node, _rawName, classCtx, _ctx) => {
      const name = node.namedChild(0)?.text ?? null;
      if (name && classCtx) return `${classCtx}.${name}`;
      return name;
    },
  },
  swift: {
    classNodeTypes: new Set(["class_declaration", "struct_declaration", "protocol_declaration"]),
    fnNodeTypes: new Set(["function_declaration"]),
    containerNodeTypes: new Set(["extension_declaration"]),
    extractContainerName: (node) => node.childForFieldName?.("type")?.text
      ?? node.namedChild(0)?.text
      ?? null,
  },
  bash: {
    classNodeTypes: new Set(),
    fnNodeTypes: new Set(["function_definition"]),
  },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface Grammar {
  parser: any;
  language: any;
}

/**
 * Tree-sitter symbol extractor.
 *
 * Loads grammars asynchronously at boot. extract() runs synchronously per call
 * so it slots into the existing synchronous file_activity ingest path.
 *
 * Naming table per language documented in the v0.6 spec:
 * - top-level fn / arrow assigned to const → `name`
 * - class member  → `Class.method`
 * - anonymous default export → `<file_basename>:default`
 * - re-exports, anonymous IIFE → not emitted
 */
export class TreeSitterExtractor {
  private grammars = new Map<string, Grammar>();
  private ready = false;
  private grammarsLoaded = 0;
  private totalGrammars = 15;
  private metrics?: Metrics;

  constructor(metrics?: Metrics) {
    this.metrics = metrics;
  }

  async load(): Promise<void> {
    const tryLoad = async (key: string, modName: string, sub?: string) => {
      try {
        const tsMod: any = await import("tree-sitter").catch(() => null);
        const langMod: any = await import(modName).catch(() => null);
        if (!tsMod || !langMod) return;
        const Parser = tsMod.default || tsMod;
        const parser = new Parser();
        const langObj = langMod.default || langMod;
        const language = sub ? langObj[sub] : langObj;
        if (!language) return;
        parser.setLanguage(language);
        this.grammars.set(key, { parser, language });
        this.grammarsLoaded++;
      } catch {
        // optionalDependency — silently skip when unavailable
      }
    };
    await tryLoad("ts", "tree-sitter-typescript", "typescript");
    await tryLoad("tsx", "tree-sitter-typescript", "tsx");
    await tryLoad("js", "tree-sitter-javascript");
    await tryLoad("py", "tree-sitter-python");
    await tryLoad("go", "tree-sitter-go");
    await tryLoad("rust", "tree-sitter-rust");
    await tryLoad("java", "tree-sitter-java");
    await tryLoad("cs", "tree-sitter-c-sharp");
    await tryLoad("c", "tree-sitter-c");
    await tryLoad("cpp", "tree-sitter-cpp");
    await tryLoad("ruby", "tree-sitter-ruby");
    await tryLoad("php", "tree-sitter-php", "php");
    await tryLoad("kotlin", "tree-sitter-kotlin");
    await tryLoad("swift", "tree-sitter-swift");
    await tryLoad("bash", "tree-sitter-bash");
    this.ready = true;
  }

  status(): { ok: boolean; grammars_loaded: number; total_grammars: number; optional: true } {
    return {
      ok: this.ready && this.grammarsLoaded > 0,
      grammars_loaded: this.grammarsLoaded,
      total_grammars: this.totalGrammars,
      optional: true,
    };
  }

  /**
   * Extract qualified symbol names from `content`. Returns null on parse
   * failure, unsupported extension, or grammar not loaded.
   * Caps output at 200 entries (per spec).
   */
  extract(filePath: string, content: string, _changedRanges: Array<[number, number]> | null): string[] | null {
    const ext = path.extname(filePath).toLowerCase();
    const key = this.extToKey(ext);
    if (!key) return null;
    const grammar = this.grammars.get(key);
    if (!grammar) return null;
    let tree: any;
    try { tree = grammar.parser.parse(content); }
    catch {
      this.metrics?.treeSitterParseFailures.inc();
      return null;
    }
    if (!tree || !tree.rootNode || tree.rootNode.hasError) {
      this.metrics?.treeSitterParseFailures.inc();
      return null;
    }
    const symbols: string[] = [];
    this.walk(tree.rootNode, symbols, key, path.basename(filePath, ext));
    return symbols.slice(0, 200);
  }

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

    // 2. Non-class containers (Rust impl, Ruby module, C# namespace, etc.)
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
}
