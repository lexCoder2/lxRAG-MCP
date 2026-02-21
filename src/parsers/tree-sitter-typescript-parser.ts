/**
 * Tree-sitter–based TypeScript / TSX parser.
 *
 * Replaces the regex-based `typescript-parser.ts` for symbol extraction when
 * the native `tree-sitter-typescript` grammar is available.  Both parsers can
 * coexist; the orchestrator selects tree-sitter when:
 *   1. `tree-sitter-typescript` native binding compiled successfully, AND
 *   2. `CODE_GRAPH_USE_TREE_SITTER=true` (or the instance reports isAvailable)
 *
 * The grammar package (`tree-sitter-typescript`) exports two Language objects:
 *   - `{ typescript: Language, tsx: Language }`
 * We derive a separate parser instance for each dialect.
 *
 * Extracted symbols:
 *   - function_declaration (top-level & nested)
 *   - arrow_function assigned to a const/let variable (top-level)
 *   - method_definition / method_signature (sets scopePath = parent class name)
 *   - class_declaration / abstract_class_declaration
 *   - interface_declaration  → type: 'class', kind: 'interface'
 *   - type_alias_declaration → type: 'class', kind: 'type'
 *   - import_statement
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
// Safe loader
// ---------------------------------------------------------------------------
function tryRequire(name: string): unknown {
  try {
    return _require(name);
  } catch {
    return null;
  }
}

/**
 * tree-sitter-typescript exports { typescript, tsx } where each value is
 * the Language object directly (NOT wrapped in { language }).
 * Handle both v0.20 (bare object) and v0.21 ({ language }) call conventions.
 */
function loadTsGrammar(dialect: "typescript" | "tsx"): unknown {
  // Try the idiomatic split-package path first
  const split = tryRequire(`tree-sitter-typescript/${dialect}`) as any;
  if (split) {
    return typeof split.language !== "undefined" ? split.language : split;
  }
  // Fall back to the combined package's named export
  const combined = tryRequire("tree-sitter-typescript") as any;
  if (!combined) return null;
  const lang = combined[dialect];
  if (!lang) return null;
  return typeof lang.language !== "undefined" ? lang.language : lang;
}

// ---------------------------------------------------------------------------
// Tree-sitter node shape (enough of the API we actually use)
// ---------------------------------------------------------------------------
type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(i: number): TSNode | null;
  childForFieldName(name: string): TSNode | null;
  namedChildren: TSNode[];
};

/** Depth-first walk, carrying a mutable context stack. */
function walkWithScope(
  node: TSNode,
  callback: (n: TSNode, scope: string[]) => void,
  scope: string[] = [],
): void {
  // When we enter a class body we push the class name onto the scope stack
  let newScope = scope;
  if (
    node.type === "class_declaration" ||
    node.type === "abstract_class_declaration" ||
    node.type === "class"
  ) {
    const nameNode = node.childForFieldName("name");
    if (nameNode?.text) {
      newScope = [...scope, nameNode.text];
    }
  }
  callback(node, newScope);
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkWithScope(child, callback, newScope);
  }
}

// ---------------------------------------------------------------------------
// Core extraction logic (shared between TS and TSX dialects)
// ---------------------------------------------------------------------------
function extractSymbols(root: TSNode): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];

  walkWithScope(root, (node, scope) => {
    switch (node.type) {
      // ── Functions ────────────────────────────────────────────────────────
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        symbols.push({
          type: "function",
          name: nameNode.text,
          kind: node.type === "generator_function_declaration" ? "generator" : undefined,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scopePath: scope[scope.length - 1],
        });
        break;
      }

      // ── Arrow / function expressions assigned to variables ───────────────
      case "lexical_declaration":
      case "variable_declaration": {
        // Look for: const/let foo = (...) => ... | function(...)
        for (const declarator of node.namedChildren) {
          if (declarator.type !== "variable_declarator") continue;
          const nameNode = declarator.childForFieldName("name");
          const value = declarator.childForFieldName("value");
          if (!nameNode?.text || !value) continue;
          if (
            value.type === "arrow_function" ||
            value.type === "function" ||
            value.type === "generator_function"
          ) {
            symbols.push({
              type: "function",
              name: nameNode.text,
              kind: "arrow",
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              scopePath: scope[scope.length - 1],
            });
          }
        }
        break;
      }

      // ── Methods ──────────────────────────────────────────────────────────
      case "method_definition":
      case "method_signature": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        const methodName = nameNode.text;
        // Skip constructors — they're part of the class node
        if (methodName === "constructor") break;
        symbols.push({
          type: "function",
          name: methodName,
          kind: "method",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          // scope contains the enclosing class name (if any)
          scopePath: scope[scope.length - 1],
        });
        break;
      }

      // ── Classes ──────────────────────────────────────────────────────────
      case "class_declaration":
      case "abstract_class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        symbols.push({
          type: "class",
          name: nameNode.text,
          kind:
            node.type === "abstract_class_declaration" ? "abstract" : "class",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // ── Interfaces ───────────────────────────────────────────────────────
      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        symbols.push({
          type: "class",
          name: nameNode.text,
          kind: "interface",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // ── Type aliases ─────────────────────────────────────────────────────
      case "type_alias_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        symbols.push({
          type: "class",
          name: nameNode.text,
          kind: "type",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // ── Enum declarations ────────────────────────────────────────────────
      case "enum_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode?.text) break;
        symbols.push({
          type: "class",
          name: nameNode.text,
          kind: "enum",
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
        break;
      }

      // ── Imports ──────────────────────────────────────────────────────────
      case "import_statement": {
        // source is the string literal: import ... from 'foo'
        const source = node.childForFieldName("source");
        if (!source) break;
        const moduleSpec = source.text.replace(/['"]/g, "");
        symbols.push({
          type: "import",
          name: moduleSpec,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          imports: [moduleSpec],
        });
        break;
      }
    }
  });

  return symbols;
}

// ---------------------------------------------------------------------------
// Base — shared between TS and TSX dialect parsers
// ---------------------------------------------------------------------------
abstract class TSDialectParser implements LanguageParser {
  abstract readonly language: string;
  abstract readonly extensions: string[];
  protected abstract readonly dialect: "typescript" | "tsx";

  private _parser: {
    setLanguage(lang: unknown): void;
    parse(source: string): { rootNode: TSNode };
  } | null = null;

  private _initialized = false;

  protected init(): boolean {
    if (this._initialized) return this._parser !== null;
    this._initialized = true;

    const TreeSitter = tryRequire("tree-sitter") as any;
    if (!TreeSitter) return false;

    const lang = loadTsGrammar(this.dialect);
    if (!lang) return false;

    try {
      const p = new TreeSitter();
      p.setLanguage(lang);
      this._parser = p;
      return true;
    } catch {
      return false;
    }
  }

  get isAvailable(): boolean {
    return this.init();
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    if (!this.init() || !this._parser) {
      return { file: path.basename(filePath), language: this.language, symbols: [] };
    }
    try {
      const tree = this._parser.parse(content);
      return {
        file: path.basename(filePath),
        language: this.language,
        symbols: extractSymbols(tree.rootNode),
      };
    } catch {
      return { file: path.basename(filePath), language: this.language, symbols: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// TypeScript (.ts)
// ---------------------------------------------------------------------------
export class TreeSitterTypeScriptParser extends TSDialectParser {
  readonly language = "typescript";
  readonly extensions = [".ts"];
  protected readonly dialect = "typescript" as const;
}

// ---------------------------------------------------------------------------
// TSX (.tsx)
// ---------------------------------------------------------------------------
export class TreeSitterTSXParser extends TSDialectParser {
  readonly language = "tsx";
  readonly extensions = [".tsx"];
  protected readonly dialect = "tsx" as const;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

let _tsParser: TreeSitterTypeScriptParser | null = null;
let _tsxParser: TreeSitterTSXParser | null = null;

export function getTreeSitterTypeScriptParser(): TreeSitterTypeScriptParser {
  if (!_tsParser) _tsParser = new TreeSitterTypeScriptParser();
  return _tsParser;
}

export function getTreeSitterTSXParser(): TreeSitterTSXParser {
  if (!_tsxParser) _tsxParser = new TreeSitterTSXParser();
  return _tsxParser;
}

/** Check whether tree-sitter TypeScript / TSX grammars are loadable. */
export function checkTsTreeSitterAvailability(): { typescript: boolean; tsx: boolean } {
  return {
    typescript: getTreeSitterTypeScriptParser().isAvailable,
    tsx: getTreeSitterTSXParser().isAvailable,
  };
}
