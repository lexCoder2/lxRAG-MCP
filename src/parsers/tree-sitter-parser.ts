/**
 * Tree-sitter–based language parsers.
 *
 * Uses the native `tree-sitter` npm package for accurate AST-based extraction
 * of functions, classes, and imports from Python, Go, Rust, and Java source
 * files.  All grammar packages are listed as `optionalDependencies` so the
 * server starts normally even when the native bindings are unavailable
 * (e.g., in environments without build tools) — the orchestrator falls back to
 * the regex parsers in that case.
 *
 * Loading strategy: use `createRequire` to bridge ESM → CJS for native addons.
 */

import { createRequire } from "module";
import * as path from "path";
import type {
  LanguageParser,
  ParseResult,
  ParsedSymbol,
} from "./parser-interface.js";

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Safe loader — returns null instead of throwing if the module is missing
// ---------------------------------------------------------------------------
function tryRequire(name: string): unknown {
  try {
    return _require(name);
  } catch {
    return null;
  }
}

/**
 * Resolve the tree-sitter Language object from a grammar package.
 * Grammar packages export either `{ language }` or a bare language object
 * depending on the version.
 */
function resolveLanguage(mod: unknown): unknown {
  if (!mod) return null;
  if (typeof (mod as any).language !== "undefined") return (mod as any).language;
  return mod;
}

// ---------------------------------------------------------------------------
// Tree-sitter node helpers
// ---------------------------------------------------------------------------
type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  namedChildCount: number;
  child(i: number): TSNode | null;
  namedChild(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  children: TSNode[];
  namedChildren: TSNode[];
};

/** Recursively walk the tree, calling visitor on every node. */
function walk(node: TSNode, visitor: (n: TSNode) => void): void {
  visitor(node);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walk(child, visitor);
  }
}

/** Return the text of a named child field, or empty string. */
function fieldText(node: TSNode, field: string): string {
  return node.childForFieldName(field)?.text ?? "";
}

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------
abstract class TreeSitterParser implements LanguageParser {
  abstract readonly language: string;
  abstract readonly extensions: string[];
  protected abstract readonly grammarPkg: string;

  private _parser: {
    setLanguage(lang: unknown): void;
    parse(source: string): { rootNode: TSNode };
  } | null = null;

  private _initialized = false;

  /** Attempt to load tree-sitter and the grammar. Returns true on success. */
  protected initParser(): boolean {
    if (this._initialized) return this._parser !== null;
    this._initialized = true;

    const TreeSitter = tryRequire("tree-sitter") as any;
    if (!TreeSitter) return false;

    const grammarMod = tryRequire(this.grammarPkg);
    const lang = resolveLanguage(grammarMod);
    if (!lang) return false;

    try {
      const p = new (TreeSitter as any)();
      p.setLanguage(lang);
      this._parser = p;
      return true;
    } catch {
      return false;
    }
  }

  get isAvailable(): boolean {
    return this.initParser();
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    if (!this.initParser() || !this._parser) {
      // Tree-sitter not available — return empty result; caller uses regex fallback
      return { file: path.basename(filePath), language: this.language, symbols: [] };
    }

    try {
      const tree = this._parser.parse(content);
      const symbols = this.extractSymbols(tree.rootNode, content);
      return { file: path.basename(filePath), language: this.language, symbols };
    } catch {
      return { file: path.basename(filePath), language: this.language, symbols: [] };
    }
  }

  protected abstract extractSymbols(root: TSNode, source: string): ParsedSymbol[];

  /** Helper: find all descendants matching a set of node types. */
  protected findAll(root: TSNode, types: Set<string>): TSNode[] {
    const results: TSNode[] = [];
    walk(root, (n) => {
      if (types.has(n.type)) results.push(n);
    });
    return results;
  }
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
export class TreeSitterPythonParser extends TreeSitterParser {
  readonly language = "python";
  readonly extensions = [".py"];
  protected readonly grammarPkg = "tree-sitter-python";

  protected extractSymbols(root: TSNode, _source: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "function_definition":
        case "async_function_definition": {
          const name = fieldText(node, "name");
          if (!name) break;
          symbols.push({
            type: "function",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "class_definition": {
          const name = fieldText(node, "name");
          if (!name) break;
          symbols.push({
            type: "class",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "import_statement": {
          // import foo, bar
          walk(node, (child) => {
            if (child.type === "dotted_name" || child.type === "aliased_import") {
              const name = child.childForFieldName("name")?.text ?? child.text;
              if (name && !symbols.some((s) => s.name === name && s.type === "import")) {
                symbols.push({ type: "import", name, startLine: node.startPosition.row + 1, endLine: node.startPosition.row + 1 });
              }
            }
          });
          break;
        }
        case "import_from_statement": {
          const mod = fieldText(node, "module_name");
          if (mod) {
            symbols.push({ type: "import", name: mod, startLine: node.startPosition.row + 1, endLine: node.startPosition.row + 1 });
          }
          break;
        }
      }
    });

    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------
export class TreeSitterGoParser extends TreeSitterParser {
  readonly language = "go";
  readonly extensions = [".go"];
  protected readonly grammarPkg = "tree-sitter-go";

  protected extractSymbols(root: TSNode, _source: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "function_declaration":
        case "method_declaration": {
          const nameNode = node.childForFieldName("name");
          const name = nameNode?.text ?? "";
          if (!name) break;
          symbols.push({
            type: "function",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "type_spec": {
          const nameNode = node.childForFieldName("name");
          const typeNode = node.childForFieldName("type");
          if (!nameNode) break;
          const kind = typeNode?.type;
          const symType =
            kind === "interface_type" ? "interface" : "class";
          symbols.push({
            type: symType,
            name: nameNode.text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "import_spec": {
          // Quoted path string
          const pathNode = node.childForFieldName("path") ?? node.namedChild(0);
          const raw = pathNode?.text ?? "";
          const name = raw.replace(/^"|"$/g, "");
          if (name) {
            symbols.push({ type: "import", name, startLine: node.startPosition.row + 1, endLine: node.startPosition.row + 1 });
          }
          break;
        }
      }
    });

    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------
export class TreeSitterRustParser extends TreeSitterParser {
  readonly language = "rust";
  readonly extensions = [".rs"];
  protected readonly grammarPkg = "tree-sitter-rust";

  protected extractSymbols(root: TSNode, _source: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "function_item": {
          const name = fieldText(node, "name");
          if (!name) break;
          symbols.push({
            type: "function",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "struct_item":
        case "enum_item": {
          const name = fieldText(node, "name");
          if (!name) break;
          symbols.push({
            type: "class",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "trait_item": {
          const name = fieldText(node, "name");
          if (!name) break;
          symbols.push({
            type: "interface",
            name,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "use_declaration": {
          // Grab the path identifier up to the last segment
          const arg = node.namedChild(0);
          if (arg) {
            const name = arg.text.replace(/::.*$/, "").replace(/^::/,"");
            if (name) {
              symbols.push({ type: "import", name, startLine: node.startPosition.row + 1, endLine: node.startPosition.row + 1 });
            }
          }
          break;
        }
      }
    });

    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------
export class TreeSitterJavaParser extends TreeSitterParser {
  readonly language = "java";
  readonly extensions = [".java"];
  protected readonly grammarPkg = "tree-sitter-java";

  private static readonly RESERVED = new Set([
    "if", "for", "while", "switch", "catch", "try", "else",
  ]);

  protected extractSymbols(root: TSNode, _source: string): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "class_declaration":
        case "interface_declaration":
        case "enum_declaration":
        case "record_declaration": {
          const nameNode = node.childForFieldName("name");
          if (!nameNode) break;
          symbols.push({
            type: node.type === "interface_declaration" ? "interface" : "class",
            name: nameNode.text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "method_declaration":
        case "constructor_declaration": {
          const nameNode = node.childForFieldName("name");
          if (!nameNode) break;
          if (TreeSitterJavaParser.RESERVED.has(nameNode.text)) break;
          symbols.push({
            type: "function",
            name: nameNode.text,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });
          break;
        }
        case "import_declaration": {
          // Collapse to the full dotted name
          const name = node.text
            .replace(/^import\s+(static\s+)?/, "")
            .replace(/;$/, "")
            .trim();
          if (name) {
            symbols.push({ type: "import", name, startLine: node.startPosition.row + 1, endLine: node.startPosition.row + 1 });
          }
          break;
        }
      }
    });

    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/** All tree-sitter parsers, instantiated lazily. */
let _parsers: TreeSitterParser[] | null = null;

export function getTreeSitterParsers(): TreeSitterParser[] {
  if (_parsers) return _parsers;
  _parsers = [
    new TreeSitterPythonParser(),
    new TreeSitterGoParser(),
    new TreeSitterRustParser(),
    new TreeSitterJavaParser(),
  ];
  return _parsers;
}

/**
 * Returns true at least one grammar loaded successfully.
 * Call this at startup to log the availability status once.
 */
export function checkTreeSitterAvailability(): Record<string, boolean> {
  const parsers = getTreeSitterParsers();
  const status: Record<string, boolean> = {};
  for (const p of parsers) {
    status[p.language] = p.isAvailable;
  }
  return status;
}
