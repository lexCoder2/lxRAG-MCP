import * as path from "path";
import type {
  LanguageParser,
  ParseResult,
  ParsedSymbol,
} from "./parser-interface.js";

abstract class BaseRegexParser implements LanguageParser {
  abstract readonly language: string;
  abstract readonly extensions: string[];

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const lines = content.split("\n");
    const symbols: ParsedSymbol[] = [
      ...this.extractImports(lines),
      ...this.extractClasses(lines),
      ...this.extractFunctions(lines),
    ];

    return {
      file: path.basename(filePath),
      language: this.language,
      symbols,
    };
  }

  protected abstract extractImports(lines: string[]): ParsedSymbol[];
  protected abstract extractClasses(lines: string[]): ParsedSymbol[];
  protected abstract extractFunctions(lines: string[]): ParsedSymbol[];

  protected findBraceBlockEnd(lines: string[], startLineIndex: number): number {
    let balance = 0;
    let seenOpening = false;

    for (let i = startLineIndex; i < lines.length; i++) {
      const line = lines[i];
      for (const ch of line) {
        if (ch === "{") {
          balance += 1;
          seenOpening = true;
        } else if (ch === "}") {
          balance -= 1;
          if (seenOpening && balance <= 0) {
            return i + 1;
          }
        }
      }
    }

    return Math.min(lines.length, startLineIndex + 1);
  }

  protected findPythonBlockEnd(
    lines: string[],
    startLineIndex: number,
  ): number {
    const startLine = lines[startLineIndex] || "";
    const indent = startLine.match(/^\s*/)?.[0].length || 0;

    for (let i = startLineIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) {
        continue;
      }
      const currentIndent = line.match(/^\s*/)?.[0].length || 0;
      if (currentIndent <= indent) {
        return i;
      }
    }

    return lines.length;
  }
}

export class PythonParser extends BaseRegexParser {
  readonly language = "python";
  readonly extensions = [".py"];

  protected extractImports(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const importMatch = /^\s*import\s+([a-zA-Z0-9_\.]+)/.exec(line);
      if (importMatch) {
        symbols.push({
          type: "import",
          name: importMatch[1],
          startLine: index + 1,
          endLine: index + 1,
        });
      }

      const fromMatch = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/.exec(line);
      if (fromMatch) {
        symbols.push({
          type: "import",
          name: fromMatch[1],
          startLine: index + 1,
          endLine: index + 1,
        });
      }
    });

    return symbols;
  }

  protected extractClasses(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: "class",
        name: match[1],
        startLine: index + 1,
        endLine: this.findPythonBlockEnd(lines, index),
      });
    });

    return symbols;
  }

  protected extractFunctions(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: "function",
        name: match[1],
        startLine: index + 1,
        endLine: this.findPythonBlockEnd(lines, index),
      });
    });

    return symbols;
  }
}

export class GoParser extends BaseRegexParser {
  readonly language = "go";
  readonly extensions = [".go"];

  protected extractImports(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const single = /^\s*import\s+"([^"]+)"/.exec(line);
      if (single) {
        symbols.push({
          type: "import",
          name: single[1],
          startLine: index + 1,
          endLine: index + 1,
        });
      }

      const blockEntry = /^\s*"([^"]+)"\s*$/.exec(line);
      if (blockEntry && index > 0 && lines[index - 1].includes("import")) {
        symbols.push({
          type: "import",
          name: blockEntry[1],
          startLine: index + 1,
          endLine: index + 1,
        });
      }
    });

    return symbols;
  }

  protected extractClasses(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match =
        /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: match[2] === "interface" ? "interface" : "class",
        name: match[1],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }

  protected extractFunctions(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match =
        /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: "function",
        name: match[1],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }
}

export class RustParser extends BaseRegexParser {
  readonly language = "rust";
  readonly extensions = [".rs"];

  protected extractImports(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match = /^\s*use\s+([^;]+);/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: "import",
        name: match[1].trim(),
        startLine: index + 1,
        endLine: index + 1,
      });
    });

    return symbols;
  }

  protected extractClasses(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match =
        /^\s*(?:pub\s+)?(struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
          line,
        );
      if (!match) {
        return;
      }

      symbols.push({
        type: match[1] === "trait" ? "interface" : "class",
        name: match[2],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }

  protected extractFunctions(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match = /^\s*(?:pub\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
        line,
      );
      if (!match) {
        return;
      }

      symbols.push({
        type: "function",
        name: match[1],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }
}

export class JavaParser extends BaseRegexParser {
  readonly language = "java";
  readonly extensions = [".java"];

  protected extractImports(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match = /^\s*import\s+([A-Za-z0-9_\.\*]+);/.exec(line);
      if (!match) {
        return;
      }

      symbols.push({
        type: "import",
        name: match[1],
        startLine: index + 1,
        endLine: index + 1,
      });
    });

    return symbols;
  }

  protected extractClasses(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];

    lines.forEach((line, index) => {
      const match =
        /^\s*(?:public|private|protected|abstract|final|static|\s)*\s*(class|interface|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(
          line,
        );
      if (!match) {
        return;
      }

      symbols.push({
        type: match[1] === "interface" ? "interface" : "class",
        name: match[2],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }

  protected extractFunctions(lines: string[]): ParsedSymbol[] {
    const symbols: ParsedSymbol[] = [];
    const reserved = new Set(["if", "for", "while", "switch", "catch"]);

    lines.forEach((line, index) => {
      const match =
        /^\s*(?:public|private|protected|static|final|synchronized|native|abstract|\s)+[A-Za-z0-9_<>,\[\]\.?\s]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
          line,
        );
      if (!match || reserved.has(match[1])) {
        return;
      }

      symbols.push({
        type: "function",
        name: match[1],
        startLine: index + 1,
        endLine: this.findBraceBlockEnd(lines, index),
      });
    });

    return symbols;
  }
}
