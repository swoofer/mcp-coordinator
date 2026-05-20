// Compile-time shim for the optional native module imported at src/tree-sitter-extractor.ts:227.

declare module "tree-sitter" {
  const Parser: any;
  export = Parser;
}
