import path from "path";

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
  private totalGrammars = 7;

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
    catch { return null; }
    if (!tree || !tree.rootNode) return null;
    if (tree.rootNode.hasError) return null;
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
      default: return null;
    }
  }

  /**
   * Extract the type identifier from a Go receiver parameter_list node.
   * e.g. "(r *T)" → "T", "(t T)" → "T"
   */
  private goReceiverType(recv: any): string | null {
    if (!recv) return null;
    // Walk named children recursively to find type_identifier or pointer_type
    for (let i = 0; i < recv.namedChildCount; i++) {
      const child = recv.namedChild(i);
      const found = this.findGoTypeIdent(child);
      if (found) return found;
    }
    return null;
  }

  private findGoTypeIdent(node: any): string | null {
    if (!node) return null;
    if (node.type === "type_identifier") return node.text;
    if (node.type === "pointer_type") {
      // recurse into pointer_type children to find type_identifier
      for (let i = 0; i < node.namedChildCount; i++) {
        const found = this.findGoTypeIdent(node.namedChild(i));
        if (found) return found;
      }
    }
    // For parameter_declaration, skip the identifier (var name), look at remaining
    if (node.type === "parameter_declaration") {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child.type !== "identifier") {
          const found = this.findGoTypeIdent(child);
          if (found) return found;
        }
      }
    }
    return null;
  }

  private walk(node: any, out: string[], lang: string, basename: string, classCtx: string | null = null): void {
    if (out.length >= 200) return;  // cap enforced; further work would be discarded by slice anyway
    const type = node.type;
    const nameNode = node.childForFieldName?.("name");

    // Class-like containers — descend with classCtx
    if (
      ((lang === "ts" || lang === "tsx" || lang === "js") && type === "class_declaration") ||
      (lang === "py" && type === "class_definition") ||
      (lang === "java" && type === "class_declaration")
    ) {
      const className = nameNode?.text || null;
      for (let i = 0; i < node.namedChildCount; i++) {
        this.walk(node.namedChild(i)!, out, lang, basename, className);
      }
      return;
    }

    // Rust impl block: child "type" field gives the impl target
    if (lang === "rust" && type === "impl_item") {
      const targetNode = node.childForFieldName?.("type");
      const targetName = targetNode?.text || null;
      for (let i = 0; i < node.namedChildCount; i++) {
        this.walk(node.namedChild(i)!, out, lang, basename, targetName);
      }
      return;
    }

    // Function-like leaves
    const isFn =
      ((lang === "ts" || lang === "tsx" || lang === "js") && (type === "function_declaration" || type === "method_definition")) ||
      (lang === "py" && type === "function_definition") ||
      (lang === "go" && (type === "function_declaration" || type === "method_declaration")) ||
      (lang === "rust" && type === "function_item") ||
      (lang === "java" && type === "method_declaration");

    if (isFn) {
      let name = nameNode?.text || null;
      // Go method receiver: method_declaration has receiver field
      if (lang === "go" && type === "method_declaration") {
        const recv = node.childForFieldName?.("receiver");
        // receiver is parameter_list like "(r *T)" — find the type node within
        const recvType = this.goReceiverType(recv);
        if (recvType && name) name = `${recvType}.${name}`;
      }
      if (name && classCtx) name = `${classCtx}.${name}`;
      if (name) out.push(name);
      return;
    }

    // const X = () => / const X = function
    if ((lang === "ts" || lang === "tsx" || lang === "js") && type === "variable_declarator") {
      const valNode = node.childForFieldName?.("value");
      if (valNode && (valNode.type === "arrow_function" || valNode.type === "function_expression")) {
        const name = nameNode?.text;
        if (name) out.push(name);
        return;
      }
    }

    // Default exports: export default () => ... / export default function () { ... }
    if ((lang === "ts" || lang === "tsx" || lang === "js") && type === "export_statement") {
      const decl = node.namedChild(0);
      if (decl && (decl.type === "arrow_function" || (decl.type === "function_declaration" && !decl.childForFieldName?.("name")))) {
        out.push(`${basename}:default`);
        return;
      }
    }

    // Recurse
    for (let i = 0; i < node.namedChildCount; i++) {
      this.walk(node.namedChild(i)!, out, lang, basename, classCtx);
    }
  }
}
