/**
 * Docs Parser
 * Parses markdown files (README, ADRs, docs/) into structured sections.
 * Pure: no I/O, no external dependencies beyond node:crypto and node:path.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Public types ─────────────────────────────────────────────────────────────

export type DocKind = "readme" | "adr" | "changelog" | "guide" | "architecture" | "other";

export interface CodeFence {
  /** Language tag (may be empty string) */
  lang: string;
  /** Raw code inside the fence */
  code: string;
  /** 1-based start line of the opening ``` within the document */
  startLine: number;
}

export interface DocLink {
  text: string;
  href: string;
}

export interface ParsedSection {
  /** 0-based position within the document */
  index: number;
  /** Heading text without leading `#` marks */
  heading: string;
  /** Heading depth 1 = H1, 2 = H2, 3 = H3 (deeper headings are grouped into the H3 bucket) */
  level: 1 | 2 | 3;
  /** All body text below the heading, down to the next heading of equal or higher level */
  content: string;
  /** 1-based line number of the heading line */
  startLine: number;
  wordCount: number;
  /** All names enclosed in backticks in this section's content */
  backtickRefs: string[];
  codeFences: CodeFence[];
  links: DocLink[];
}

export interface ParsedDoc {
  filePath: string;
  relativePath: string;
  title: string;
  kind: DocKind;
  /** SHA-256 hex digest of raw file content */
  hash: string;
  wordCount: number;
  sections: ParsedSection[];
}

// ─── DocsParser ───────────────────────────────────────────────────────────────

export class DocsParser {
  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Parse a markdown file from disk.
   * @param filePath    Absolute path to the .md file.
   * @param workspaceRoot  Used to derive relativePath only.
   */
  parseFile(filePath: string, workspaceRoot: string): ParsedDoc {
    const content = fs.readFileSync(filePath, "utf-8");
    return this.parseContent(content, filePath, workspaceRoot);
  }

  /**
   * Parse markdown content directly (no I/O — fully unit-testable).
   * @param content       Raw file content.
   * @param filePath      Absolute or arbitrary path (used for id and kind inference).
   * @param workspaceRoot Used to compute relativePath.
   */
  parseContent(content: string, filePath: string, workspaceRoot: string): ParsedDoc {
    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

    const hash = crypto.createHash("sha256").update(content, "utf-8").digest("hex");

    const lines = content.split("\n");
    const sections = this.splitSections(lines);
    const title = this.inferTitle(sections, relativePath);
    const kind = this.inferKind(relativePath);
    const wordCount = sections.reduce((sum, s) => sum + s.wordCount, 0);

    return { filePath, relativePath, title, kind, hash, wordCount, sections };
  }

  /**
   * Classify a markdown file by its relative path.
   */
  inferKind(relativePath: string): DocKind {
    const lower = relativePath.toLowerCase().replace(/\\/g, "/");
    const basename = path.basename(lower);

    if (/readme/i.test(basename)) return "readme";
    if (/^changelog|^history/.test(basename)) return "changelog";
    if (/^architecture|^arch\./.test(basename)) return "architecture";
    if (
      /adr[-_\s]?\d+/.test(lower) ||
      /(?:^|\/)decisions?\//i.test(lower) ||
      /(?:^|\/)adr\//i.test(lower)
    )
      return "adr";
    if (/\/docs\//i.test(`/${lower}`) || lower.startsWith("docs/")) return "guide";

    return "other";
  }

  /**
   * Extract all `symbol` backtick-quoted names from a text string.
   * Returns deduplicated names, non-empty, trimmed.
   */
  extractBacktickRefs(text: string): string[] {
    const seen = new Set<string>();
    const pattern = /`([^`\n]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const ref = match[1].trim();
      if (ref.length > 0 && ref.length <= 120) {
        seen.add(ref);
      }
    }
    return Array.from(seen);
  }

  // ── Section splitting ────────────────────────────────────────────────────────

  /**
   * Split document lines into sections at H1/H2/H3 boundaries.
   * Lines before the first heading are grouped into an implicit section
   * with heading = "" and level = 1.
   */
  private splitSections(lines: string[]): ParsedSection[] {
    const sections: ParsedSection[] = [];
    let currentHeading = "";
    let currentLevel: 1 | 2 | 3 = 1;
    let currentStartLine = 1; // 1-based
    let currentBodyLines: string[] = [];
    let inCodeFence = false;
    let fenceMarker = "";

    const flush = (nextStartLine: number): void => {
      const body = currentBodyLines.join("\n");
      if (currentHeading.length > 0 || body.trim().length > 0) {
        sections.push(
          this.buildSection(sections.length, currentHeading, currentLevel, currentStartLine, body),
        );
      }
      currentBodyLines = [];
      currentStartLine = nextStartLine;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1; // 1-based

      // Track code fence state (don't parse headings inside fences)
      const fenceMatch = line.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        if (!inCodeFence) {
          inCodeFence = true;
          fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length); // normalize
        } else if (line.startsWith(fenceMarker)) {
          inCodeFence = false;
          fenceMarker = "";
        }
        currentBodyLines.push(line);
        continue;
      }

      if (inCodeFence) {
        currentBodyLines.push(line);
        continue;
      }

      // ATX heading detection
      const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headingMatch) {
        const depth = headingMatch[1].length;
        const headingText = headingMatch[2].trim();

        // Only split at H1-H3 (deeper headings become body content)
        if (depth <= 3) {
          flush(lineNumber);
          currentHeading = headingText;
          currentLevel = Math.min(depth, 3) as 1 | 2 | 3;
          currentStartLine = lineNumber;
          continue;
        }
      }

      // Setext H1 / H2 detection
      if (i > 0 && !inCodeFence) {
        const prevLine = currentBodyLines[currentBodyLines.length - 1] ?? "";
        if (/^={3,}\s*$/.test(line) && prevLine.trim().length > 0) {
          // Previous line is the heading text — move it from body to heading
          const headingText = currentBodyLines.pop()?.trim() ?? "";
          flush(lineNumber - 1);
          currentHeading = headingText;
          currentLevel = 1;
          currentStartLine = lineNumber - 1;
          continue;
        }
        if (/^-{3,}\s*$/.test(line) && prevLine.trim().length > 0 && !prevLine.startsWith("#")) {
          const headingText = currentBodyLines.pop()?.trim() ?? "";
          flush(lineNumber - 1);
          currentHeading = headingText;
          currentLevel = 2;
          currentStartLine = lineNumber - 1;
          continue;
        }
      }

      currentBodyLines.push(line);
    }

    // Flush final section
    flush(lines.length + 1);

    // Ensure at least one section for empty / heading-free documents
    if (sections.length === 0) {
      sections.push(this.buildSection(0, "", 1, 1, ""));
    }

    return sections;
  }

  // ── Section builder ─────────────────────────────────────────────────────────

  private buildSection(
    index: number,
    heading: string,
    level: 1 | 2 | 3,
    startLine: number,
    body: string,
  ): ParsedSection {
    const codeFences = this.extractCodeFences(body, startLine);
    // Remove code fence content from body before extracting prose references
    const proseBody = this.stripCodeFences(body);

    return {
      index,
      heading,
      level,
      content: body,
      startLine,
      wordCount: this.countWords(heading + " " + body),
      backtickRefs: this.extractBacktickRefs(proseBody + " " + heading),
      codeFences,
      links: this.extractLinks(proseBody),
    };
  }

  // ── Extraction helpers ───────────────────────────────────────────────────────

  private extractCodeFences(body: string, sectionStartLine: number): CodeFence[] {
    const fences: CodeFence[] = [];
    const lines = body.split("\n");
    let inFence = false;
    let fenceMarker = "";
    let lang = "";
    let fenceLines: string[] = [];
    let fenceStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const openMatch = line.match(/^(`{3,}|~{3,})(\S*)/);

      if (!inFence && openMatch) {
        inFence = true;
        fenceMarker = openMatch[1][0].repeat(openMatch[1].length);
        lang = openMatch[2] ?? "";
        fenceLines = [];
        fenceStart = sectionStartLine + i;
        continue;
      }

      if (inFence) {
        if (line.startsWith(fenceMarker)) {
          fences.push({
            lang,
            code: fenceLines.join("\n"),
            startLine: fenceStart,
          });
          inFence = false;
          fenceMarker = "";
          fenceLines = [];
        } else {
          fenceLines.push(line);
        }
      }
    }

    return fences;
  }

  private stripCodeFences(body: string): string {
    return body.replace(/^(`{3,}|~{3,})[\s\S]*?\1/gm, "");
  }

  private extractLinks(text: string): DocLink[] {
    const links: DocLink[] = [];
    // Markdown inline links: [text](href)
    const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      links.push({ text: match[1].trim(), href: match[2].trim() });
    }
    return links;
  }

  private countWords(text: string): number {
    return (text.match(/\S+/g) ?? []).length;
  }

  // ── Title / kind helpers ─────────────────────────────────────────────────────

  private inferTitle(sections: ParsedSection[], relativePath: string): string {
    const h1 = sections.find((s) => s.level === 1 && s.heading.length > 0);
    if (h1) return h1.heading;
    // Fall back to filename without extension
    return path.basename(relativePath, path.extname(relativePath));
  }
}

// ─── File walker (used by DocsEngine, exported for testing) ──────────────────

/**
 * Returns absolute paths to all markdown files within workspaceRoot
 * that belong to conventional documentation locations.
 * Excludes node_modules, dist, .git, .lxdig.
 */
export function findMarkdownFiles(workspaceRoot: string): string[] {
  const results: string[] = [];
  const excluded = new Set([
    "node_modules",
    "dist",
    ".git",
    ".lxdig",
    ".next",
    "build",
    "coverage",
  ]);

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return; // Don't recurse infinitely
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Only recurse into known doc directories at any depth,
        // or at root depth 0 (to pick up top-level README/CHANGELOG)
        const nameLower = entry.name.toLowerCase();
        const isDocDir =
          nameLower === "docs" ||
          nameLower === "doc" ||
          nameLower === "adr" ||
          nameLower === "adrs" ||
          nameLower === "decisions" ||
          nameLower === "rfcs" ||
          nameLower === "wiki" ||
          nameLower === ".github";
        if (depth === 0 || isDocDir) {
          walk(fullPath, depth + 1);
        }
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
  };

  walk(workspaceRoot, 0);
  return results;
}
