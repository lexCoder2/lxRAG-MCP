export interface ParsedSymbol {
  type:
    | "function"
    | "class"
    | "method"
    | "variable"
    | "interface"
    | "import";
  name: string;
  startLine: number;
  endLine: number;
  kind?: string;
  scopePath?: string;
  calls?: string[];
  imports?: string[];
}

export interface ParseResult {
  file: string;
  language: string;
  symbols: ParsedSymbol[];
}

export interface LanguageParser {
  readonly language: string;
  readonly extensions: string[];
  parse(filePath: string, content: string): Promise<ParseResult>;
}
