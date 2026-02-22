import * as fs from "fs";
import * as path from "path";
import * as env from "../env.js";
// import Parser from 'web-tree-sitter'; // Optional dependency

export interface ASTNode {
  type: string;
  name?: string;
  kind?: string;
  startLine: number;
  endLine: number;
  text: string;
  children?: ASTNode[];
  properties?: Record<string, any>;
}

export interface ParsedFile {
  filePath: string;
  relativePath: string;
  language: string;
  LOC: number;
  hash: string;
  ast: ASTNode;
  functions: FunctionNode[];
  classes: ClassNode[];
  variables: VariableNode[];
  imports: ImportNode[];
  exports: ExportNode[];
  testSuites?: TestSuiteNode[];
  testCases?: TestCaseNode[];
}

interface ParseFileOptions {
  workspaceRoot?: string;
}

export interface FunctionNode {
  id: string;
  name: string;
  kind: "function" | "arrow" | "method";
  startLine: number;
  endLine: number;
  LOC: number;
  parameters: string[];
  isExported: boolean;
}

export interface ClassNode {
  id: string;
  name: string;
  kind: "class" | "interface" | "type";
  startLine: number;
  endLine: number;
  LOC: number;
  isExported: boolean;
  extends?: string;
  implements?: string[];
}

export interface VariableNode {
  id: string;
  name: string;
  kind: "const" | "let" | "var";
  startLine: number;
  endLine: number;
  isExported: boolean;
  type?: string;
}

export interface ImportNode {
  id: string;
  source: string;
  specifiers: {
    name: string;
    imported: string;
    isDefault: boolean;
  }[];
  startLine: number;
}

export interface ExportNode {
  id: string;
  name: string;
  source?: string;
  isDefault: boolean;
  startLine: number;
}

export interface TestSuiteNode {
  id: string;
  name: string;
  type: "describe" | "test" | "it";
  startLine: number;
  endLine?: number;
  category?: "unit" | "integration" | "performance" | "e2e";
  filePath?: string;
}

export interface TestCaseNode {
  id: string;
  name: string;
  startLine: number;
  endLine?: number;
  parentSuiteId?: string;
}

export class TypeScriptParser {
  // private parser: Parser | null = null;
  // private language: Parser.Language | null = null;

  async initialize(): Promise<void> {
    // Tree-sitter initialization removed for MVP
    // Will be added back when web-tree-sitter is properly configured
    console.log("TypeScriptParser initialized with regex fallback");
  }

  parseFile(filePath: string, options?: ParseFileOptions): ParsedFile {
    const content = fs.readFileSync(filePath, "utf-8");
    const workspaceRoot = options?.workspaceRoot || env.LXRAG_WORKSPACE_ROOT;
    const relativePath = path.relative(workspaceRoot, filePath);
    const hash = this.hashContent(content);
    const lines = content.split("\n");
    const LOC = lines.length;

    // Parse using regex-based fallback for MVP (Tree-sitter integration follows)
    const functions = this.extractFunctions(content, filePath);
    const classes = this.extractClasses(content, filePath);
    const variables = this.extractVariables(content, filePath);
    const imports = this.extractImports(content, filePath);
    const exports = this.extractExports(content, filePath);
    const testSuites = this.extractTestSuites(content, filePath);
    const testCases = this.extractTestCases(content, filePath);

    return {
      filePath,
      relativePath,
      language: "TypeScript",
      LOC,
      hash,
      ast: {
        type: "file",
        name: path.basename(filePath),
        startLine: 1,
        endLine: LOC,
        text: content,
        children: [],
      },
      functions,
      classes,
      variables,
      imports,
      exports,
      testSuites,
      testCases,
    };
  }

  private extractFunctions(content: string, filePath: string): FunctionNode[] {
    const functions: FunctionNode[] = [];
    const lines = content.split("\n");

    // Control flow keywords to exclude (Phase 7.2)
    const controlFlowKeywords = new Set([
      "if",
      "for",
      "while",
      "switch",
      "catch",
      "else",
      "do",
      "with",
    ]);

    // Match: function name, const name =, => style
    const patterns = [
      /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)/gm,
      /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\((.*?)\)\s*=>/gm,
      /^\s*(?:async\s+)?(\w+)\s*\((.*?)\)\s*{/gm, // method in class
    ];

    content.split("\n").forEach((line, index) => {
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const name = match[1];

          // Skip control flow keywords (Phase 7.2 - false positive fix)
          if (controlFlowKeywords.has(name.toLowerCase())) {
            continue;
          }

          const params =
            match[2]
              ?.split(",")
              .map((p) => p.trim())
              .filter(Boolean) || [];
          const isExported = line.includes("export");

          functions.push({
            id: `${path.basename(filePath)}:${name}:${index}`,
            name,
            kind: line.includes("=>") ? "arrow" : "function",
            startLine: index + 1,
            endLine: this.findBlockEnd(lines, index),
            LOC: this.findBlockEnd(lines, index) - index,
            parameters: params,
            isExported,
          });
        }
      }
    });

    return functions;
  }

  private extractClasses(content: string, filePath: string): ClassNode[] {
    const classes: ClassNode[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const classMatch =
        /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+(?:extends|implements)\s+(.+?))?(?:\s*{|$)/.exec(
          line,
        );
      if (classMatch) {
        classes.push({
          id: `${path.basename(filePath)}:${classMatch[1]}`,
          name: classMatch[1],
          kind: "class",
          startLine: index + 1,
          endLine: this.findBlockEnd(lines, index),
          LOC: this.findBlockEnd(lines, index) - index,
          isExported: line.includes("export"),
          extends: classMatch[2]?.includes("extends")
            ? classMatch[2]?.split(/extends|implements/)[0].trim()
            : undefined,
        });
      }

      const interfaceMatch =
        /^\s*(?:export\s+)?interface\s+(\w+)(?:\s+(?:extends)\s+(.+?))?(?:\s*{|$)/.exec(
          line,
        );
      if (interfaceMatch) {
        classes.push({
          id: `${path.basename(filePath)}:${interfaceMatch[1]}`,
          name: interfaceMatch[1],
          kind: "interface",
          startLine: index + 1,
          endLine: this.findBlockEnd(lines, index),
          LOC: this.findBlockEnd(lines, index) - index,
          isExported: line.includes("export"),
          extends: interfaceMatch[2]?.trim(),
        });
      }

      const typeMatch = /^\s*(?:export\s+)?type\s+(\w+)\s*=/.exec(line);
      if (typeMatch) {
        classes.push({
          id: `${path.basename(filePath)}:${typeMatch[1]}`,
          name: typeMatch[1],
          kind: "type",
          startLine: index + 1,
          endLine: index + 1,
          LOC: 1,
          isExported: line.includes("export"),
        });
      }
    });

    return classes;
  }

  private extractVariables(content: string, filePath: string): VariableNode[] {
    const variables: VariableNode[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const match =
        /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*(.+?))?\s*=/.exec(
          line,
        );
      if (match && !line.includes("(")) {
        // Don't match function declarations
        variables.push({
          id: `${path.basename(filePath)}:${match[1]}`,
          name: match[1],
          kind: line.includes("const")
            ? "const"
            : line.includes("let")
              ? "let"
              : "var",
          startLine: index + 1,
          endLine: index + 1,
          isExported: line.includes("export"),
          type: match[2]?.trim(),
        });
      }
    });

    return variables;
  }

  private extractImports(content: string, filePath: string): ImportNode[] {
    const imports: ImportNode[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      const match =
        /^import\s+(?:{([^}]+)}|(\w+)|(\w+)\s*,\s*{([^}]+)})\s+from\s+['"]([^'"]+)['"]/gm.exec(
          line,
        );
      if (match) {
        const source = match[5];
        const specifierStr = match[1] || match[4] || "";
        const defaultImport = match[2] || (match[3] ? match[3] : "");

        const specifiers = [
          ...(defaultImport
            ? [{ name: defaultImport, imported: "default", isDefault: true }]
            : []),
          ...specifierStr
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => {
              const [imported, name] = s.includes(" as ")
                ? s.split(" as ").map((x) => x.trim())
                : [s, s];
              return { name, imported, isDefault: false };
            }),
        ];

        imports.push({
          id: `${path.basename(filePath)}:import:${index}`,
          source,
          specifiers,
          startLine: index + 1,
        });
      }
    });

    return imports;
  }

  private extractExports(content: string, filePath: string): ExportNode[] {
    const exports: ExportNode[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      // export default
      const defaultMatch = /^export\s+default\s+(.+)/.exec(line);
      if (defaultMatch) {
        exports.push({
          id: `${path.basename(filePath)}:export:default`,
          name: defaultMatch[1].split(/[({]/)[0].trim(),
          isDefault: true,
          startLine: index + 1,
        });
      }

      // named exports
      const namedMatch =
        /^export\s+(?:const|function|class|interface|type)\s+(\w+)/.exec(line);
      if (namedMatch) {
        exports.push({
          id: `${path.basename(filePath)}:export:${namedMatch[1]}`,
          name: namedMatch[1],
          isDefault: false,
          startLine: index + 1,
        });
      }

      // export from
      const reexportMatch =
        /^export\s+(?:{([^}]+)}|\*)\s+from\s+['"]([^'"]+)['"]/.exec(line);
      if (reexportMatch) {
        const items = reexportMatch[1]?.split(",").map((s) => s.trim()) || [
          "*",
        ];
        items.forEach((item) => {
          exports.push({
            id: `${path.basename(filePath)}:export:${item}`,
            name: item,
            source: reexportMatch[2],
            isDefault: false,
            startLine: index + 1,
          });
        });
      }
    });

    return exports;
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let foundOpen = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === "{") {
          braceCount++;
          foundOpen = true;
        } else if (char === "}") {
          braceCount--;
          if (foundOpen && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return lines.length;
  }

  private extractTestSuites(
    content: string,
    filePath: string,
  ): TestSuiteNode[] {
    const testSuites: TestSuiteNode[] = [];
    const lines = content.split("\n");

    lines.forEach((line, index) => {
      let match;
      // Match: describe|test|it( "name" or 'name' or `name`
      const regex = new RegExp(
        /^\s*(describe|test|it)\s*\(\s*['"`]([^'"`]+)['"`]/,
      );
      match = regex.exec(line);

      if (match) {
        const type = match[1] as "describe" | "test" | "it";
        const name = match[2];

        // Determine category based on file path
        let category:
          | "unit"
          | "integration"
          | "performance"
          | "e2e"
          | undefined = undefined;
        if (filePath.includes(".integration.test.")) {
          category = "integration";
        } else if (filePath.includes(".performance.test.")) {
          category = "performance";
        } else if (filePath.includes("e2e")) {
          category = "e2e";
        } else if (filePath.includes(".test.")) {
          category = "unit";
        }

        testSuites.push({
          id: `${path.basename(filePath)}:${type}:${index}:${name}`,
          name,
          type,
          startLine: index + 1,
          endLine: this.findBlockEnd(lines, index),
          category,
          filePath,
        });
      }
    });

    return testSuites;
  }

  /**
   * Phase 3.1: Extract individual test cases (it/test blocks)
   */
  private extractTestCases(content: string, filePath: string): TestCaseNode[] {
    const testCases: TestCaseNode[] = [];
    const lines = content.split("\n");

    // Match individual it() or test() blocks (inside describe blocks)
    lines.forEach((line, index) => {
      // Match: it|test( "name" or 'name' or `name`
      const regex = new RegExp(
        /^\s*(it|test)\s*\(\s*['"`]([^'"`]+)['"`]/,
      );
      const match = regex.exec(line);

      if (match) {
        const name = match[2];
        // Generate a parent suite ID based on context
        // Find the nearest describe block above this test
        let parentSuiteId: string | undefined;
        for (let i = index - 1; i >= 0; i--) {
          const describeMatch = /^\s*describe\s*\(\s*['"`]([^'"`]+)['"`]/.exec(
            lines[i],
          );
          if (describeMatch) {
            parentSuiteId = `${path.basename(filePath)}:describe:${i}:${describeMatch[1]}`;
            break;
          }
        }

        testCases.push({
          id: `${path.basename(filePath)}:it:${index}:${name}`,
          name,
          startLine: index + 1,
          endLine: this.findBlockEnd(lines, index),
          parentSuiteId,
        });
      }
    });

    return testCases;
  }

  private hashContent(content: string): string {
    // Simple hash for MVP - replace with crypto.createHash in production
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }
}

export default TypeScriptParser;
