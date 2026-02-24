/**
 * Graph Orchestrator
 * Coordinates parsing, building, and persisting the code graph
 */

import * as fs from "fs";
import * as path from "path";
import * as env from "../env.js";
import TypeScriptParser, {
  type ParsedFile,
} from "../parsers/typescript-parser.js";
import ParserRegistry from "../parsers/parser-registry.js";
import type { ParseResult } from "../parsers/parser-interface.js";
import {
  PythonParser,
  GoParser,
  RustParser,
  JavaParser,
} from "../parsers/regex-language-parsers.js";
import {
  getTreeSitterParsers,
  checkTreeSitterAvailability,
} from "../parsers/tree-sitter-parser.js";
import {
  getTreeSitterTypeScriptParser,
  getTreeSitterTSXParser,
  getTreeSitterJavaScriptParser,
  getTreeSitterJSXParser,
  checkTsTreeSitterAvailability,
  checkJsTreeSitterAvailability,
  type TreeSitterTypeScriptParser,
  type TreeSitterTSXParser,
  type TreeSitterJavaScriptParser,
  type TreeSitterJSXParser,
} from "../parsers/tree-sitter-typescript-parser.js";
import GraphBuilder, { type CypherStatement } from "./builder.js";
import GraphIndexManager from "./index.js";
import CacheManager from "./cache.js";
import MemgraphClient from "./client.js";
import CodeSummarizer from "../response/summarizer.js";
import { DocsEngine } from "../engines/docs-engine.js";

export interface BuildOptions {
  mode: "full" | "incremental";
  verbose: boolean;
  workspaceRoot: string;
  projectId: string;
  sourceDir: string;
  exclude: string[];
  changedFiles?: string[];
  txId?: string;
  txTimestamp?: number;
  /** Index markdown documentation files into DOCUMENT/SECTION nodes (default: true for full builds) */
  indexDocs?: boolean;
}

export interface BuildResult {
  success: boolean;
  duration: number;
  filesProcessed: number;
  nodesCreated: number;
  relationshipsCreated: number;
  filesChanged: number;
  errors: string[];
  warnings: string[];
  txId?: string;
  txTimestamp?: number;
}

export class GraphOrchestrator {
  private parser: TypeScriptParser;
  private tsTsParser: TreeSitterTypeScriptParser | null = null;
  private tsTsxParser: TreeSitterTSXParser | null = null;
  private tsJsParser: TreeSitterJavaScriptParser | null = null;
  private tsJsxParser: TreeSitterJSXParser | null = null;
  private useTsTreeSitter: boolean;
  private useJsTreeSitter: boolean;
  private parserRegistry: ParserRegistry;
  private builder: GraphBuilder;
  private index: GraphIndexManager;
  private sharedIndex?: GraphIndexManager;
  private cache: CacheManager;
  private memgraph: MemgraphClient;
  private verbose: boolean;
  private summarizer: CodeSummarizer;

  constructor(
    memgraph?: MemgraphClient,
    verbose = false,
    sharedIndex?: GraphIndexManager,
  ) {
    this.parser = new TypeScriptParser();
    this.parserRegistry = new ParserRegistry();
    this.sharedIndex = sharedIndex;

    // ── Tree-sitter TypeScript / TSX ────────────────────────────────────────
    // Enable when CODE_GRAPH_USE_TREE_SITTER=true AND native binding compiled.
    const wantTsTs = env.LXRAG_USE_TREE_SITTER;
    const tsAvailability = checkTsTreeSitterAvailability();
    this.useTsTreeSitter = false;
    if (wantTsTs) {
      if (tsAvailability.typescript) {
        this.tsTsParser = getTreeSitterTypeScriptParser();
      }
      if (tsAvailability.tsx) {
        this.tsTsxParser = getTreeSitterTSXParser();
      }
      this.useTsTreeSitter = tsAvailability.typescript || tsAvailability.tsx;
    }

    // ── Tree-sitter JavaScript / JSX ───────────────────────────────────────
    // Shares the same grammar (tree-sitter-javascript); both dialects load it.
    const jsAvailability = checkJsTreeSitterAvailability();
    this.useJsTreeSitter = false;
    if (wantTsTs) {
      if (jsAvailability.javascript) {
        this.tsJsParser = getTreeSitterJavaScriptParser();
      }
      if (jsAvailability.jsx) {
        this.tsJsxParser = getTreeSitterJSXParser();
      }
      this.useJsTreeSitter = jsAvailability.javascript;
    }

    // ── Python / Go / Rust / Java ────────────────────────────────────────────
    // Register tree-sitter parsers (AST-accurate); fall back per language to
    // regex parsers when the native binding is unavailable.
    const tsParsers = getTreeSitterParsers();
    const availability = checkTreeSitterAvailability();
    const regexFallbacks = [
      new PythonParser(),
      new GoParser(),
      new RustParser(),
      new JavaParser(),
    ];

    const tsByLang = new Map(tsParsers.map((p) => [p.language, p]));
    for (const fallback of regexFallbacks) {
      const tsParser = tsByLang.get(fallback.language);
      if (tsParser && availability[fallback.language]) {
        this.parserRegistry.register(tsParser);
      } else {
        this.parserRegistry.register(fallback);
      }
    }

    // ── Startup log ─────────────────────────────────────────────────────────
    const allAvailable: string[] = [];
    const allFallback: string[] = [];
    if (wantTsTs) {
      if (tsAvailability.typescript) allAvailable.push("typescript");
      else allFallback.push("typescript");
      if (tsAvailability.tsx) allAvailable.push("tsx");
      else allFallback.push("tsx");
      if (jsAvailability.javascript) allAvailable.push("javascript", "jsx");
      else allFallback.push("javascript", "jsx");
    } else {
      // TS/JS tree-sitter disabled by env — always regex
      allFallback.push("typescript", "tsx", "javascript", "jsx");
    }
    for (const [lang, ok] of Object.entries(availability)) {
      if (ok) allAvailable.push(lang);
      else allFallback.push(lang);
    }
    if (allAvailable.length > 0) {
      console.error(
        `[parsers] tree-sitter active for: ${allAvailable.join(", ")}`,
      );
    }
    if (allFallback.length > 0) {
      console.error(
        `[parsers] regex fallback for: ${allFallback.join(", ")} (install tree-sitter grammar packages for AST accuracy)`,
      );
    }

    this.builder = new GraphBuilder();
    this.index = new GraphIndexManager();
    this.cache = new CacheManager();
    this.memgraph = memgraph || new MemgraphClient();
    this.verbose = verbose;
    this.summarizer = new CodeSummarizer(env.LXRAG_SUMMARIZER_URL);
  }

  /**
   * Build the entire code graph
   */
  async build(options: Partial<BuildOptions> = {}): Promise<BuildResult> {
    const startTime = Date.now();
    const opts: BuildOptions = {
      mode: options.mode || "incremental",
      verbose: options.verbose ?? this.verbose,
      workspaceRoot: options.workspaceRoot || env.LXRAG_WORKSPACE_ROOT,
      projectId:
        options.projectId ||
        env.LXRAG_PROJECT_ID ||
        path.basename(options.workspaceRoot || env.LXRAG_WORKSPACE_ROOT),
      sourceDir: options.sourceDir || "src",
      exclude: options.exclude || ["node_modules", "dist", ".next", ".lxrag"],
      txId: options.txId,
      txTimestamp: options.txTimestamp,
    };

    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (opts.verbose) {
        console.error("[GraphOrchestrator] Starting build...");
        console.error(`[GraphOrchestrator] Mode: ${opts.mode}`);
      }

      // Get all source files across supported languages
      const files = await this.findSourceFiles(
        opts.sourceDir,
        opts.exclude,
        opts.workspaceRoot,
      );

      if (opts.verbose) {
        console.error(`[GraphOrchestrator] Found ${files.length} source files`);
      }

      // Determine which files to process
      let filesToProcess = files;
      let filesChanged = 0;

      if (opts.mode === "incremental") {
        const scopedChangedFiles = this.normalizeChangedFiles(
          opts.changedFiles,
          opts.workspaceRoot,
        );

        if (scopedChangedFiles.length > 0) {
          filesToProcess = scopedChangedFiles.filter(
            (filePath) => fs.existsSync(filePath) && files.includes(filePath),
          );
          filesChanged = filesToProcess.length;

          if (opts.verbose) {
            console.error(
              `[GraphOrchestrator] Incremental (explicit): ${filesToProcess.length} existing of ${filesChanged} changed file(s)`,
            );
          }
        } else {
          const hashes = await Promise.all(
            files.map(async (f) => ({
              path: f,
              hash: await this.hashFile(f),
              LOC: (fs.readFileSync(f, "utf-8").match(/\n/g) || []).length + 1,
            })),
          );

          filesToProcess = hashes
            .filter((f) => this.cache.hasChanged(f.path, f.hash))
            .map((f) => f.path);
          filesChanged = filesToProcess.length;

          if (opts.verbose) {
            console.error(
              `[GraphOrchestrator] Incremental: ${filesChanged} changed of ${files.length}`,
            );
          }
        }
      } else {
        // Full rebuild
        this.cache.clear();
        filesChanged = files.length;
      }

      // Parse files and build graph
      let nodesCreated = 0;
      let statementsToExecute: CypherStatement[] = [];
      const parsedFiles: Array<{ filePath: string; parsed: ParsedFile }> = [];
      this.builder = new GraphBuilder(
        opts.projectId,
        opts.workspaceRoot,
        opts.txId,
        opts.txTimestamp,
      );

      for (const filePath of filesToProcess) {
        try {
          const parsed = await this.parseSourceFile(
            filePath,
            opts.workspaceRoot,
          );
          await this.attachSummaries(parsed);
          parsedFiles.push({ filePath, parsed });
          const adaptedParsed = this.adaptParsedFile(parsed);
          const statements = this.builder.buildFromParsedFile(adaptedParsed);

          statementsToExecute.push(...statements);

          // Update cache
          this.cache.set(filePath, parsed.hash, parsed.LOC);

          // Track for index
          this.addToIndex(parsed);
          nodesCreated += this.countNodesInStatements(statements);

          if (opts.verbose && filesToProcess.indexOf(filePath) % 50 === 0) {
            console.error(
              `[GraphOrchestrator] Processed ${filesToProcess.indexOf(filePath)}/${filesToProcess.length} files`,
            );
          }
        } catch (error) {
          errors.push(`Failed to parse ${filePath}: ${error}`);
        }
      }

      // Build TEST_SUITE-[:TESTS]->FILE relationships (Phase 3.3)
      const testRelationships = this.buildTestRelationships(
        parsedFiles,
        opts.workspaceRoot,
        opts.projectId,
      );
      statementsToExecute.push(...testRelationships);

      // Seed progress nodes if config has progress section (Phase 5.2)
      if (opts.verbose) {
        console.error("[GraphOrchestrator] Seeding progress tracking nodes...");
      }
      const progressStatements = this.seedProgressNodes(opts.projectId);
      statementsToExecute.push(...progressStatements);

      // Execute statements against Memgraph (MVP: in offline mode, just count)
      const relationshipsCreated = statementsToExecute.length;

      if (this.memgraph.isConnected()) {
        if (opts.verbose) {
          console.error(
            `[GraphOrchestrator] Executing ${statementsToExecute.length} Cypher statements...`,
          );
        }
        const results = await this.memgraph.executeBatch(statementsToExecute);
        const failedStatements = results.filter((r) => r.error).length;
        if (failedStatements > 0) {
          warnings.push(`${failedStatements} Cypher statements failed`);
        }
      } else {
        if (opts.verbose) {
          console.error(
            `[GraphOrchestrator] Memgraph offline - statements prepared but not executed`,
          );
        }
      }

      // Index documentation files (Phase 6 — Docs/ADR Indexing)
      const shouldIndexDocs =
        (opts.indexDocs ?? true) &&
        opts.mode === "full" &&
        this.memgraph.isConnected();
      if (shouldIndexDocs) {
        if (opts.verbose) {
          console.error("[GraphOrchestrator] Indexing documentation files...");
        }
        try {
          const docsEngine = new DocsEngine(this.memgraph);
          const docsResult = await docsEngine.indexWorkspace(
            opts.workspaceRoot,
            opts.projectId,
            { incremental: true, txId: opts.txId },
          );
          if (opts.verbose) {
            console.error(
              `[GraphOrchestrator] Docs indexed: ${docsResult.indexed} files, ` +
                `${docsResult.skipped} skipped, ${docsResult.errors.length} errors`,
            );
          }
          if (docsResult.errors.length > 0) {
            for (const e of docsResult.errors) {
              warnings.push(`[docs] ${e.file}: ${e.error}`);
            }
          }
        } catch (docsErr) {
          warnings.push(
            `[docs] Indexing failed: ${docsErr instanceof Error ? docsErr.message : String(docsErr)}`,
          );
        }
      }

      // Save cache
      this.cache.save();

      // SYNC: Propagate internal index to shared context index
      if (this.sharedIndex) {
        try {
          const syncResult = this.sharedIndex.syncFrom(this.index);
          if (opts.verbose) {
            console.error(
              `[GraphOrchestrator] Index synced: ${syncResult.nodesSynced} nodes, ${syncResult.relationshipsSynced} relationships`,
            );
          }
        } catch (syncError) {
          warnings.push(
            `[sync] Failed to sync index: ${syncError instanceof Error ? syncError.message : String(syncError)}`,
          );
        }
      }

      const duration = Date.now() - startTime;

      if (opts.verbose) {
        const stats = this.index.getStatistics();
        console.error("[GraphOrchestrator] Build complete!");
        console.error(`[GraphOrchestrator] Duration: ${duration}ms`);
        console.error(
          `[GraphOrchestrator] Files processed: ${filesToProcess.length}`,
        );
        console.error(`[GraphOrchestrator] Nodes created: ${nodesCreated}`);
        console.error(
          `[GraphOrchestrator] Relationships: ${relationshipsCreated}`,
        );
        console.error(`[GraphOrchestrator] Statistics:`, stats);
      }

      return {
        success: errors.length === 0,
        duration,
        filesProcessed: filesToProcess.length,
        nodesCreated,
        relationshipsCreated,
        filesChanged,
        errors,
        warnings,
        txId: opts.txId,
        txTimestamp: opts.txTimestamp,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      errors.push(`Build failed: ${error}`);
      return {
        success: false,
        duration,
        filesProcessed: 0,
        nodesCreated: 0,
        relationshipsCreated: 0,
        filesChanged: 0,
        errors,
        warnings,
        txId: opts.txId,
        txTimestamp: opts.txTimestamp,
      };
    }
  }

  /**
   * Find all supported source files in source directory
   */
  private async findSourceFiles(
    sourceDir: string,
    exclude: string[],
    workspaceRoot: string,
  ): Promise<string[]> {
    const files: string[] = [];
    // If sourceDir is absolute, use it directly; otherwise resolve relative to workspace root
    const basePath = path.isAbsolute(sourceDir)
      ? sourceDir
      : path.resolve(workspaceRoot, sourceDir);

    if (fs.existsSync(basePath)) {
      console.error(`[GraphOrchestrator] Scanning directory: ${basePath}`);
    } else {
      console.warn(
        `[GraphOrchestrator] Source directory not found: ${basePath}`,
      );
      return files;
    }

    const shouldExclude = (filePath: string): boolean => {
      const rel = path.relative(basePath, filePath);
      return exclude.some((ex) => rel.includes(ex));
    };

    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (shouldExclude(fullPath)) continue;

          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (
            entry.isFile() &&
            /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/.test(entry.name)
          ) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        console.warn(
          `[GraphOrchestrator] Error scanning directory ${dir}: ${error}`,
        );
      }
    };

    walk(basePath);
    return files;
  }

  private normalizeChangedFiles(
    changedFiles: string[] | undefined,
    workspaceRoot: string,
  ): string[] {
    if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
      return [];
    }

    const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
    const seen = new Set<string>();

    return changedFiles
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .map((entry) =>
        path.isAbsolute(entry)
          ? path.normalize(entry)
          : path.resolve(workspaceRoot, entry),
      )
      .filter((filePath) => {
        const relative = path.relative(normalizedWorkspaceRoot, filePath);
        return (
          relative.length > 0 &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative)
        );
      })
      .filter((filePath) =>
        /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/.test(filePath),
      )
      .filter((filePath) => {
        if (seen.has(filePath)) {
          return false;
        }
        seen.add(filePath);
        return true;
      });
  }

  private async parseSourceFile(
    filePath: string,
    workspaceRoot: string,
  ): Promise<ParsedFile> {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".ts" || extension === ".tsx") {
      // Prefer tree-sitter when available and opted in
      if (this.useTsTreeSitter) {
        const tsParser =
          extension === ".tsx" ? this.tsTsxParser : this.tsTsParser;
        if (tsParser?.isAvailable) {
          const content = fs.readFileSync(filePath, "utf-8");
          const result = await tsParser.parse(filePath, content);
          if (result.symbols.length > 0) {
            return this.adaptLanguageParseResult(
              filePath,
              workspaceRoot,
              content,
              result,
            );
          }
        }
      }
      return this.parser.parseFile(filePath, { workspaceRoot });
    }

    if (
      extension === ".js" ||
      extension === ".jsx" ||
      extension === ".mjs" ||
      extension === ".cjs"
    ) {
      if (this.useJsTreeSitter) {
        const jsParser =
          extension === ".jsx" ? this.tsJsxParser : this.tsJsParser;
        if (jsParser?.isAvailable) {
          const content = fs.readFileSync(filePath, "utf-8");
          const result = await jsParser.parse(filePath, content);
          if (result.symbols.length > 0) {
            return this.adaptLanguageParseResult(
              filePath,
              workspaceRoot,
              content,
              result,
            );
          }
        }
      }
      // Fallback: FILE node only (no regex parser for plain JS)
      const content = fs.readFileSync(filePath, "utf-8");
      return this.adaptLanguageParseResult(filePath, workspaceRoot, content, {
        file: path.basename(filePath),
        language: this.languageFromExtension(extension),
        symbols: [],
      });
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = await this.parserRegistry.parse(filePath, content);
    if (parsed) {
      return this.adaptLanguageParseResult(
        filePath,
        workspaceRoot,
        content,
        parsed,
      );
    }

    return this.adaptLanguageParseResult(filePath, workspaceRoot, content, {
      file: path.basename(filePath),
      language: this.languageFromExtension(extension),
      symbols: [],
    });
  }

  private async attachSummaries(parsed: ParsedFile): Promise<void> {
    const fileHash = parsed.hash || "no-hash";
    const relativePath = parsed.relativePath || parsed.filePath;

    (parsed as ParsedFile & { summary?: string }).summary =
      await this.summarizer.summarize({
        kind: "file",
        cacheKey: `file:${relativePath}:${fileHash}`,
        name: path.basename(parsed.filePath),
        path: relativePath,
        language: parsed.language,
        loc: parsed.LOC,
        metadata: {
          functionCount: parsed.functions.length,
          classCount: parsed.classes.length,
          importCount: parsed.imports.length,
        },
      });

    for (const [index, fn] of parsed.functions.entries()) {
      (fn as typeof fn & { summary?: string }).summary =
        await this.summarizer.summarize({
          kind: "function",
          cacheKey: `function:${relativePath}:${fn.name}:${index}:${fileHash}`,
          name: fn.name,
          path: relativePath,
          language: parsed.language,
          loc: fn.LOC,
          metadata: { startLine: fn.startLine, endLine: fn.endLine },
        });
    }

    for (const [index, cls] of parsed.classes.entries()) {
      (cls as typeof cls & { summary?: string }).summary =
        await this.summarizer.summarize({
          kind: "class",
          cacheKey: `class:${relativePath}:${cls.name}:${index}:${fileHash}`,
          name: cls.name,
          path: relativePath,
          language: parsed.language,
          loc: cls.LOC,
          metadata: { kind: cls.kind, extends: cls.extends },
        });
    }

    for (const [index, imp] of parsed.imports.entries()) {
      (imp as typeof imp & { summary?: string }).summary =
        await this.summarizer.summarize({
          kind: "import",
          cacheKey: `import:${relativePath}:${imp.source}:${index}:${fileHash}`,
          name: imp.source,
          path: relativePath,
          language: parsed.language,
          metadata: { specifierCount: imp.specifiers.length },
        });
    }
  }

  private adaptLanguageParseResult(
    filePath: string,
    workspaceRoot: string,
    content: string,
    parsed: ParseResult,
  ): ParsedFile {
    const relativePath = path
      .relative(workspaceRoot, filePath)
      .replace(/\\/g, "/");
    const hash = this.simpleHash(content);
    const LOC = content.split("\n").length;

    const imports = parsed.symbols
      .filter((symbol) => symbol.type === "import")
      .map((symbol, index) => ({
        id: `${relativePath}:import:${index}`,
        source: symbol.name,
        specifiers: [
          {
            name: symbol.name,
            imported: symbol.name,
            isDefault: false,
          },
        ],
        startLine: symbol.startLine,
      }));

    const functions = parsed.symbols
      .filter(
        (symbol) => symbol.type === "function" || symbol.type === "method",
      )
      .map((symbol, index) => ({
        id: `${relativePath}:function:${symbol.name}:${index}`,
        name: symbol.name,
        // Preserve kind from symbol ("arrow", "method", etc.) when present
        kind:
          (symbol.kind as "function" | "arrow" | "method" | undefined) ??
          ("function" as const),
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        LOC: Math.max(1, symbol.endLine - symbol.startLine + 1),
        parameters: [],
        isExported: false,
        // Preserve scopePath for SCIP method-ID generation (builder uses (fn as any).scopePath)
        scopePath: symbol.scopePath,
      }));

    const classes = parsed.symbols
      .filter(
        (symbol) =>
          symbol.type === "class" ||
          symbol.type === "interface" ||
          symbol.kind === "interface" ||
          symbol.kind === "type" ||
          symbol.kind === "enum",
      )
      .map((symbol, index) => ({
        id: `${relativePath}:class:${symbol.name}:${index}`,
        name: symbol.name,
        kind:
          symbol.kind === "interface" || symbol.type === "interface"
            ? ("interface" as const)
            : ("class" as const),
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        LOC: Math.max(1, symbol.endLine - symbol.startLine + 1),
        isExported: false,
      }));

    return {
      filePath,
      relativePath,
      language: parsed.language,
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
      variables: [],
      imports,
      exports: [],
      testSuites: [],
    };
  }

  private languageFromExtension(extension: string): string {
    const table: Record<string, string> = {
      ".py": "python",
      ".go": "go",
      ".rs": "rust",
      ".java": "java",
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    };
    return table[extension] || "unknown";
  }

  /**
   * Calculate hash of file contents
   */
  private async hashFile(filePath: string): Promise<string> {
    const content = fs.readFileSync(filePath, "utf-8");
    return this.simpleHash(content);
  }

  private simpleHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Add parsed file to in-memory index
   */
  private addToIndex(parsed: ParsedFile): void {
    // FILE node
    this.index.addNode(`file:${parsed.relativePath}`, "FILE", {
      path: parsed.filePath,
      relativePath: parsed.relativePath,
      language: parsed.language,
      LOC: parsed.LOC,
      hash: parsed.hash,
      summary: (parsed as ParsedFile & { summary?: string }).summary,
    });

    // FUNCTION nodes
    parsed.functions.forEach((fn) => {
      this.index.addNode(fn.id, "FUNCTION", {
        name: fn.name,
        kind: fn.kind,
        startLine: fn.startLine,
        endLine: fn.endLine,
        LOC: fn.LOC,
        parameters: fn.parameters,
        isExported: fn.isExported,
        summary: (fn as typeof fn & { summary?: string }).summary,
      });
      this.index.addRelationship(
        `contains:${fn.id}`,
        `file:${parsed.relativePath}`,
        fn.id,
        "CONTAINS",
      );
    });

    // CLASS nodes
    parsed.classes.forEach((cls) => {
      this.index.addNode(cls.id, "CLASS", {
        name: cls.name,
        kind: cls.kind,
        startLine: cls.startLine,
        endLine: cls.endLine,
        LOC: cls.LOC,
        isExported: cls.isExported,
        extends: cls.extends,
        summary: (cls as typeof cls & { summary?: string }).summary,
      });
      this.index.addRelationship(
        `contains:${cls.id}`,
        `file:${parsed.relativePath}`,
        cls.id,
        "CONTAINS",
      );
    });

    // IMPORT nodes
    parsed.imports.forEach((imp) => {
      this.index.addNode(imp.id, "IMPORT", {
        source: imp.source,
        specifiers: imp.specifiers,
        summary: (imp as typeof imp & { summary?: string }).summary,
      });
      this.index.addRelationship(
        `imports:${imp.id}`,
        `file:${parsed.relativePath}`,
        imp.id,
        "IMPORTS",
      );
    });
  }

  /**
   * Count nodes created in Cypher statements
   */
  private countNodesInStatements(statements: CypherStatement[]): number {
    let count = 0;
    for (const stmt of statements) {
      // Rough count: each MERGE with a node type
      if (stmt.query.includes("MERGE (") || stmt.query.includes("CREATE (")) {
        count++;
      }
    }
    return Math.max(count, 1); // At least 1 node per file
  }

  /**
   * Adapt TypeScriptParser ParsedFile to GraphBuilder ParsedFile interface
   */
  private adaptParsedFile(parsed: ParsedFile): any {
    return {
      path: parsed.relativePath,
      filePath: parsed.filePath,
      relativePath: parsed.relativePath,
      language: parsed.language,
      LOC: parsed.LOC,
      hash: parsed.hash,
      summary: (parsed as ParsedFile & { summary?: string }).summary,
      imports: parsed.imports.map((imp) => ({
        id: imp.id,
        source: imp.source,
        specifiers: imp.specifiers.map((spec) => spec.imported || spec.name),
        startLine: imp.startLine,
        summary: (imp as typeof imp & { summary?: string }).summary,
      })),
      exports: parsed.exports.map((exp) => ({
        id: exp.id,
        name: exp.name,
        type: exp.isDefault ? "default" : "named",
        isDefault: exp.isDefault,
        startLine: exp.startLine,
      })),
      functions: parsed.functions.map((fn) => ({
        id: fn.id,
        name: fn.name,
        kind: fn.kind,
        parameters: fn.parameters.map((p) => ({ name: p, type: undefined })),
        returnType: undefined,
        async: false,
        line: fn.startLine,
        startLine: fn.startLine,
        endLine: fn.endLine,
        LOC: fn.LOC,
        isExported: fn.isExported,
        summary: (fn as typeof fn & { summary?: string }).summary,
      })),
      classes: parsed.classes.map((cls) => ({
        id: cls.id,
        name: cls.name,
        methods: [],
        properties: [],
        line: cls.startLine,
        startLine: cls.startLine,
        endLine: cls.endLine,
        LOC: cls.LOC,
        isExported: cls.isExported,
        implements: cls.implements,
        extends: cls.extends,
        summary: (cls as typeof cls & { summary?: string }).summary,
      })),
      variables: parsed.variables || [],
    };
  }

  /**
   * Build TEST_SUITE-[:TESTS]->FILE relationships (Phase 3.3)
   * For each test file with test suites, find what source files it imports
   * and create TESTS relationships to those files
   */
  private buildTestRelationships(
    parsedFiles: Array<{ filePath: string; parsed: ParsedFile }>,
    workspaceRoot: string,
    projectId: string,
  ): CypherStatement[] {
    const statements: CypherStatement[] = [];

    // Filter test files
    const testFiles = parsedFiles.filter((f) => this.isTestFile(f.filePath));

    for (const testFile of testFiles) {
      const testSuites = testFile.parsed.testSuites || [];
      if (testSuites.length === 0) continue;

      // Get imports from test file
      const imports = testFile.parsed.imports || [];

      for (const imp of imports) {
        // Try to find the imported file in our parsed files
        const importedFile = this.resolveImportedFile(
          imp.source,
          testFile.filePath,
          parsedFiles,
          workspaceRoot,
        );
        if (!importedFile) continue;

        // Create TEST_SUITE-[:TESTS]->FILE relationships
        for (const suite of testSuites) {
          statements.push({
            query: `
              MATCH (ts:TEST_SUITE {id: $testSuiteId})
              MATCH (f:FILE {id: $targetFileId})
              MERGE (ts)-[:TESTS]->(f)
            `,
            params: {
              testSuiteId: `${projectId}:test_suite:${suite.id}`,
              targetFileId: `${projectId}:file:${importedFile}`,
            },
          });
        }
      }
    }

    return statements;
  }

  /**
   * Check if a file is a test file
   */
  private isTestFile(filePath: string): boolean {
    return (
      filePath.includes(".test.") ||
      filePath.includes(".spec.") ||
      filePath.includes("/e2e/") ||
      filePath.includes("/__tests__/")
    );
  }

  /**
   * Resolve an import statement to an actual file path
   */
  private resolveImportedFile(
    source: string,
    fromFile: string,
    parsedFiles: Array<{ filePath: string; parsed: ParsedFile }>,
    workspaceRoot: string,
  ): string | null {
    // Skip external imports
    if (!source.startsWith(".") && !source.startsWith("src/")) {
      return null;
    }

    let resolvedPath: string;

    if (source.startsWith(".")) {
      // Relative import
      const dir = path.dirname(fromFile);
      resolvedPath = path.resolve(dir, source);
    } else if (source.startsWith("src/")) {
      // Absolute src import
      resolvedPath = path.resolve(workspaceRoot, source);
    } else {
      return null;
    }

    // Try to find matching file in parsed files
    const candidates = [
      resolvedPath,
      `${resolvedPath}.ts`,
      `${resolvedPath}.tsx`,
      path.join(resolvedPath, "index.ts"),
      path.join(resolvedPath, "index.tsx"),
    ];

    for (const candidate of candidates) {
      const parsed = parsedFiles.find((f) => f.filePath === candidate);
      if (parsed) {
        return path.relative(workspaceRoot, candidate).replace(/\\/g, "/");
      }
    }

    return null;
  }

  /**
   * Seed progress nodes from config (Phase 5.2)
   */
  private seedProgressNodes(projectId: string): CypherStatement[] {
    const statements: CypherStatement[] = [];

    // Skip if no progress config
    if (!this.memgraph || !this.memgraph.isConnected()) {
      return statements;
    }

    // This would normally read from config.progress
    // For MVP, create sample feature nodes
    const features = [
      {
        id: "phase-1",
        name: "Code Graph MVP",
        status: "completed",
        priority: "high",
      },
      {
        id: "phase-2",
        name: "Architecture Validation",
        status: "completed",
        priority: "high",
      },
      {
        id: "phase-3",
        name: "Test Intelligence",
        status: "completed",
        priority: "high",
      },
      {
        id: "phase-4",
        name: "MCP Tools",
        status: "completed",
        priority: "high",
      },
      {
        id: "phase-5",
        name: "Progress Tracking",
        status: "in-progress",
        priority: "medium",
      },
    ];

    for (const feature of features) {
      statements.push({
        query: `
          MERGE (f:FEATURE {id: $id})
          ON CREATE SET
            f.name = $name,
            f.status = $status,
            f.priority = $priority,
            f.projectId = $projectId,
            f.createdAt = timestamp()
          ON MATCH DO NOTHING
        `,
        params: {
          id: `${projectId}:feature:${feature.id}`,
          name: feature.name,
          status: feature.status,
          priority: feature.priority,
          projectId,
        },
      });
    }

    return statements;
  }

  /**
   * Get current graph statistics
   */
  getStatistics(): GraphIndexManager["getStatistics"] {
    return () => this.index.getStatistics();
  }

  /**
   * Export graph snapshot
   */
  exportSnapshot(outputPath: string): void {
    const snapshot = {
      timestamp: new Date().toISOString(),
      statistics: this.index.getStatistics(),
      cacheStats: this.cache.getStats(),
    };
    fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  }
}

export default GraphOrchestrator;
