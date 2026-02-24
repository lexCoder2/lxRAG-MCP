import { describe, expect, it, vi } from "vitest";
import type { LanguageParser, ParseResult } from "./parser-interface.js";
import { ParserRegistry } from "./parser-registry.js";

function makeParser(
  language: string,
  extensions: string[],
  parseResult?: ParseResult,
): LanguageParser {
  return {
    language,
    extensions,
    parse: vi.fn(
      async () =>
        parseResult ?? {
          file: "sample.ts",
          language,
          symbols: [],
        },
    ),
  };
}

describe("ParserRegistry", () => {
  it("register normalizes extension case and resolves parser by file path", () => {
    const registry = new ParserRegistry();
    const parser = makeParser("typescript", [".TS", ".Tsx"]);

    registry.register(parser);

    expect(registry.getParserForFile("src/example.ts")).toBe(parser);
    expect(registry.getParserForFile("src/component.TSX")).toBe(parser);
  });

  it("getParserForFile returns null for unregistered extensions", () => {
    const registry = new ParserRegistry();

    expect(registry.getParserForFile("src/example.py")).toBeNull();
  });

  it("parse returns null when no parser is registered for extension", async () => {
    const registry = new ParserRegistry();

    const result = await registry.parse("src/example.go", "package main");

    expect(result).toBeNull();
  });

  it("parse delegates to matching parser and returns parser output", async () => {
    const registry = new ParserRegistry();
    const parseResult: ParseResult = {
      file: "index.ts",
      language: "typescript",
      symbols: [{ type: "function", name: "main", startLine: 1, endLine: 3 }],
    };
    const parser = makeParser("typescript", [".ts"], parseResult);

    registry.register(parser);
    const result = await registry.parse(
      "src/index.ts",
      "export function main() {}",
    );

    expect(parser.parse).toHaveBeenCalledWith(
      "src/index.ts",
      "export function main() {}",
    );
    expect(result).toEqual(parseResult);
  });
});
