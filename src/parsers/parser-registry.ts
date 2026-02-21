import * as path from "path";
import type { LanguageParser, ParseResult } from "./parser-interface.js";

export class ParserRegistry {
  private parsers = new Map<string, LanguageParser>();

  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) {
      this.parsers.set(ext.toLowerCase(), parser);
    }
  }

  getParserForFile(filePath: string): LanguageParser | null {
    const ext = path.extname(filePath).toLowerCase();
    return this.parsers.get(ext) || null;
  }

  async parse(filePath: string, content: string): Promise<ParseResult | null> {
    const parser = this.getParserForFile(filePath);
    if (!parser) {
      return null;
    }
    return parser.parse(filePath, content);
  }
}

export default ParserRegistry;
