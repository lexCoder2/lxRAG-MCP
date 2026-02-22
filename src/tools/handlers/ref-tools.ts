/**
 * Reference Query Tools
 * Phase 5 Step 2: Extract self-contained ref_query tool and helpers
 *
 * Tools:
 * - ref_query: search external reference repositories for documentation and code patterns
 *
 * This module is completely self-contained with no engine dependencies.
 * It only uses the file system and DocsParser for scanning and parsing.
 */

import * as fs from "fs";
import * as path from "path";
import {
  DocsParser,
  findMarkdownFiles,
  type ParsedSection,
} from "../../parsers/docs-parser.js";

/**
 * Minimal context interface required by ref tools
 */
interface RefToolContext {
  errorEnvelope(
    code: string,
    reason: string,
    recoverable?: boolean,
    hint?: string
  ): string;
  formatSuccess(
    data: unknown,
    profile?: string,
    summary?: string,
    toolName?: string
  ): string;
}

/**
 * Create reference query tools
 * @param ctx - Context object providing errorEnvelope and formatSuccess methods
 */
export function createRefTools(ctx: RefToolContext) {
  return {
    /**
     * Query external reference repositories for documentation and code patterns
     */
    async ref_query(args: any): Promise<string> {
      const {
        repoPath,
        query = "",
        mode = "auto",
        symbol,
        limit = 10,
        profile = "compact",
      } = args ?? {};

      if (!repoPath || typeof repoPath !== "string") {
        return ctx.errorEnvelope(
          "REF_REPO_MISSING",
          "repoPath is required",
          false,
          "Provide the absolute path to the reference repository on this machine."
        );
      }

      const resolvedRepo = path.resolve(repoPath);
      if (!fs.existsSync(resolvedRepo)) {
        return ctx.errorEnvelope(
          "REF_REPO_NOT_FOUND",
          `Path does not exist: ${resolvedRepo}`,
          false,
          "Ensure the repository is cloned and the path is accessible from this machine/container."
        );
      }

      try {
        const repoName = path.basename(resolvedRepo);
        const findings: any[] = [];

        // Determine effective mode
        const effectiveMode =
          mode === "auto" ? inferRefMode(query, symbol) : mode;

        // --- DOCS / ARCHITECTURE: parse markdown files ---
        if (
          effectiveMode === "docs" ||
          effectiveMode === "architecture" ||
          effectiveMode === "all"
        ) {
          const parser = new DocsParser();
          const mdFiles = findMarkdownFiles(resolvedRepo);
          const queryTerms = query
            .toLowerCase()
            .split(/\s+/)
            .filter((t: string) => t.length > 2);

          for (const mdFile of mdFiles.slice(0, 60)) {
            try {
              const doc = parser.parseFile(mdFile, resolvedRepo);
              for (const sec of doc.sections) {
                const score = scoreRefSection(sec, queryTerms, symbol);
                if (score > 0 || queryTerms.length === 0) {
                  findings.push({
                    type: "doc",
                    file: doc.relativePath,
                    kind: doc.kind,
                    heading: sec.heading || doc.title,
                    score,
                    excerpt: sec.content.slice(0, 300).trim(),
                    line: sec.startLine,
                  });
                }
              }
            } catch {
              // skip unreadable files
            }
          }
        }

        // --- CODE / PATTERNS: scan source files ---
        if (
          effectiveMode === "code" ||
          effectiveMode === "patterns" ||
          effectiveMode === "all"
        ) {
          const sourceExts = [
            ".ts",
            ".tsx",
            ".js",
            ".mjs",
            ".cjs",
            ".py",
            ".go",
            ".java",
            ".rs",
            ".rb",
            ".cs",
          ];
          const sourceFiles = scanRefSourceFiles(resolvedRepo, sourceExts);
          const queryTerms = query
            .toLowerCase()
            .split(/\s+/)
            .filter((t: string) => t.length > 2);

          for (const filePath of sourceFiles.slice(0, 120)) {
            try {
              const content = fs.readFileSync(filePath, "utf-8");
              const relPath = path.relative(resolvedRepo, filePath);
              const score = scoreRefCode(
                content,
                queryTerms,
                symbol,
                relPath
              );
              if (score > 0) {
                const excerpt = extractRefExcerpt(
                  content,
                  queryTerms,
                  symbol,
                  6
                );
                findings.push({
                  type: "code",
                  file: relPath,
                  score,
                  excerpt: excerpt || content.slice(0, 300),
                });
              }
            } catch {
              // skip unreadable files
            }
          }
        }

        // --- STRUCTURE: always included for mode "all" or when no query ---
        if (effectiveMode === "all" || effectiveMode === "structure") {
          const tree = buildRefDirTree(resolvedRepo, 3);
          findings.push({ type: "structure", file: ".", score: 0, tree });
        }

        // Sort by score (structure last), slice to limit
        const sorted = findings
          .sort((a, b) => {
            if (a.type === "structure") return 1;
            if (b.type === "structure") return -1;
            return (b.score ?? 0) - (a.score ?? 0);
          })
          .slice(0, limit);

        return ctx.formatSuccess(
          {
            repoName,
            repoPath: resolvedRepo,
            query,
            symbol: symbol ?? null,
            mode: effectiveMode,
            resultCount: sorted.length,
            findings: sorted,
          },
          profile,
          `${sorted.length} result(s) from reference repo ${repoName}`,
          "ref_query"
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "REF_QUERY_FAILED",
          error instanceof Error ? error.message : String(error),
          true
        );
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Private Helpers (internal to this module)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Infer the search mode based on query content
 */
function inferRefMode(
  query: string,
  symbol?: string
): "docs" | "code" | "architecture" | "patterns" | "all" {
  if (symbol) return "code";
  const lower = (query || "").toLowerCase();
  if (
    /(architect|structure|pattern|design|layer|module|overview|convention|best.?practice)/.test(
      lower
    )
  )
    return "architecture";
  if (/(how to|example|guide|decision|adr|changelog)/.test(lower))
    return "docs";
  if (
    /(function|class|method|import|export|interface|type|impl|usage)/.test(
      lower
    )
  )
    return "code";
  return "all";
}

/**
 * Score a documentation section based on query terms
 */
function scoreRefSection(
  section: ParsedSection,
  queryTerms: string[],
  symbol?: string
): number {
  let score = 0;
  const text = `${section.heading} ${section.content}`.toLowerCase();
  for (const term of queryTerms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (text.match(re) ?? []).length;
    if (count > 0) {
      score += count * (section.heading.toLowerCase().includes(term) ? 3 : 1);
    }
  }
  if (symbol) {
    const symLower = symbol.toLowerCase();
    if (section.backtickRefs.some((r) => r.toLowerCase().includes(symLower)))
      score += 10;
    else if (text.includes(symLower)) score += 5;
  }
  return score;
}

/**
 * Score source code based on query terms
 */
function scoreRefCode(
  content: string,
  queryTerms: string[],
  symbol: string | undefined,
  relPath: string
): number {
  let score = 0;
  const lower = content.toLowerCase();
  const pathLower = relPath.toLowerCase();
  for (const term of queryTerms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    const count = (lower.match(re) ?? []).length;
    score += count;
    if (pathLower.includes(term)) score += 3;
  }
  if (symbol) {
    const symLower = symbol.toLowerCase();
    const symCount = (
      lower.match(
        new RegExp(symLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
      ) ?? []
    ).length;
    score += symCount * 5;
  }
  return score;
}

/**
 * Extract a meaningful excerpt from code based on query terms
 */
function extractRefExcerpt(
  content: string,
  queryTerms: string[],
  symbol: string | undefined,
  contextLines: number
): string {
  const lines = content.split("\n");
  let bestLine = 0;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let score = 0;
    if (symbol && lower.includes(symbol.toLowerCase())) score += 10;
    for (const term of queryTerms) {
      if (lower.includes(term)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  if (bestScore === 0) return lines.slice(0, contextLines * 2).join("\n");
  const start = Math.max(0, bestLine - contextLines);
  const end = Math.min(lines.length, bestLine + contextLines + 1);
  return lines.slice(start, end).join("\n");
}

/**
 * Recursively scan for source files matching given extensions
 */
function scanRefSourceFiles(
  rootPath: string,
  extensions: string[]
): string[] {
  const results: string[] = [];
  const ignoreDirs = new Set([
    "node_modules",
    "dist",
    ".git",
    ".next",
    "coverage",
    "__pycache__",
    ".venv",
    "vendor",
    "build",
    ".turbo",
  ]);

  const walk = (dir: string, depth: number) => {
    if (depth > 7) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignoreDirs.has(entry.name) && !entry.name.startsWith(".")) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            results.push(path.join(dir, entry.name));
          }
        }
      }
    } catch {
      // skip permission errors
    }
  };

  walk(rootPath, 0);
  return results;
}

/**
 * Build a directory tree structure for display
 */
function buildRefDirTree(rootPath: string, maxDepth: number): any {
  const ignoreDirs = new Set([
    "node_modules",
    "dist",
    ".git",
    ".next",
    "coverage",
    "__pycache__",
    ".venv",
    "vendor",
    "build",
    ".turbo",
  ]);

  const walk = (dir: string, depth: number): any => {
    if (depth > maxDepth) return null;
    const name = path.basename(dir);
    const children: any[] = [];
    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .slice(0, 40);
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !ignoreDirs.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          const child = walk(path.join(dir, entry.name), depth + 1);
          if (child) children.push(child);
        } else if (entry.isFile()) {
          children.push({ name: entry.name });
        }
      }
    } catch {
      // skip
    }
    return children.length > 0 ? { name, children } : { name };
  };

  return walk(rootPath, 0);
}
