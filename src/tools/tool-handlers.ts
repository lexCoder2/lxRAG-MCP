/**
 * Tool Implementations
 * Concrete implementations for all 14 MCP tools
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { GraphIndexManager } from "../graph/index.js";
import type MemgraphClient from "../graph/client.js";
import ArchitectureEngine from "../engines/architecture-engine.js";
import TestEngine from "../engines/test-engine.js";
import ProgressEngine from "../engines/progress-engine.js";
import GraphOrchestrator from "../graph/orchestrator.js";
import QdrantClient from "../vector/qdrant-client.js";
import EmbeddingEngine from "../vector/embedding-engine.js";
import type { GraphNode } from "../graph/index.js";
import { getRequestContext } from "../request-context.js";
import { formatResponse, errorResponse } from "../response/shaper.js";
import EpisodeEngine, { type EpisodeType } from "../engines/episode-engine.js";

export interface ToolContext {
  index: GraphIndexManager;
  memgraph: MemgraphClient;
  config: any;
  orchestrator?: GraphOrchestrator;
}

interface ProjectContext {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
}

export class ToolHandlers {
  private archEngine?: ArchitectureEngine;
  private testEngine?: TestEngine;
  private progressEngine?: ProgressEngine;
  private orchestrator?: GraphOrchestrator;
  private qdrant?: QdrantClient;
  private embeddingEngine?: EmbeddingEngine;
  private episodeEngine?: EpisodeEngine;
  private embeddingsReady = false;
  private lastGraphRebuildAt?: string;
  private lastGraphRebuildMode?: "full" | "incremental";
  private defaultActiveProjectContext: ProjectContext;
  private sessionProjectContexts = new Map<string, ProjectContext>();

  constructor(private context: ToolContext) {
    this.defaultActiveProjectContext = this.defaultProjectContext();
    this.initializeEngines();
  }

  private getCurrentSessionId(): string | undefined {
    const sessionId = getRequestContext().sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return undefined;
    }

    return sessionId;
  }

  private getActiveProjectContext(): ProjectContext {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      return this.defaultActiveProjectContext;
    }

    return (
      this.sessionProjectContexts.get(sessionId) ||
      this.defaultActiveProjectContext
    );
  }

  private setActiveProjectContext(context: ProjectContext): void {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      this.defaultActiveProjectContext = context;
      return;
    }

    this.sessionProjectContexts.set(sessionId, context);
  }

  private defaultProjectContext(): ProjectContext {
    const workspaceRoot = path.resolve(
      process.env.CODE_GRAPH_WORKSPACE_ROOT || process.cwd(),
    );
    const sourceDir = path.resolve(
      process.env.GRAPH_SOURCE_DIR || path.join(workspaceRoot, "src"),
    );
    const projectId =
      process.env.CODE_GRAPH_PROJECT_ID || path.basename(workspaceRoot);

    return {
      workspaceRoot,
      sourceDir,
      projectId,
    };
  }

  private resolveProjectContext(overrides: any = {}): ProjectContext {
    const base = this.getActiveProjectContext() || this.defaultProjectContext();
    const workspaceProvided =
      typeof overrides.workspaceRoot === "string" &&
      overrides.workspaceRoot.trim().length > 0;
    const workspaceInput = workspaceProvided
      ? overrides.workspaceRoot
      : base.workspaceRoot;
    const workspaceRoot = path.resolve(workspaceInput);
    const sourceInput = overrides.sourceDir || path.join(workspaceRoot, "src");
    const sourceDir = path.isAbsolute(sourceInput)
      ? sourceInput
      : path.resolve(workspaceRoot, sourceInput);
    const projectId =
      overrides.projectId ||
      (workspaceProvided
        ? path.basename(workspaceRoot)
        : process.env.CODE_GRAPH_PROJECT_ID) ||
      path.basename(workspaceRoot);

    return {
      workspaceRoot,
      sourceDir,
      projectId,
    };
  }

  private adaptWorkspaceForRuntime(context: ProjectContext): {
    context: ProjectContext;
    usedFallback: boolean;
    fallbackReason?: string;
  } {
    if (fs.existsSync(context.workspaceRoot)) {
      return { context, usedFallback: false };
    }

    const fallbackRoot = process.env.CODE_GRAPH_WORKSPACE_ROOT;
    if (!fallbackRoot || !fs.existsSync(fallbackRoot)) {
      return { context, usedFallback: false };
    }

    let mappedSourceDir = context.sourceDir;
    if (
      path.isAbsolute(context.sourceDir) &&
      context.sourceDir.startsWith(context.workspaceRoot)
    ) {
      const relativeSource = path.relative(
        context.workspaceRoot,
        context.sourceDir,
      );
      mappedSourceDir = path.resolve(fallbackRoot, relativeSource);
    }

    return {
      usedFallback: true,
      fallbackReason:
        "Requested workspace path is not directly accessible in current runtime; using mounted workspace root.",
      context: {
        ...context,
        workspaceRoot: fallbackRoot,
        sourceDir: mappedSourceDir,
      },
    };
  }

  private runtimePathFallbackAllowed(): boolean {
    return process.env.CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK === "true";
  }

  private initializeEngines(): void {
    if (this.context.config.architecture) {
      this.archEngine = new ArchitectureEngine(
        this.context.config.architecture.layers,
        this.context.config.architecture.rules,
        this.context.index,
      );
    }

    this.testEngine = new TestEngine(this.context.index);
    this.progressEngine = new ProgressEngine(this.context.index);
    this.episodeEngine = new EpisodeEngine(this.context.memgraph);

    // Initialize GraphOrchestrator if not provided
    this.orchestrator =
      this.context.orchestrator ||
      new GraphOrchestrator(this.context.memgraph, false);

    this.initializeVectorEngine();
  }

  private initializeVectorEngine(): void {
    const host = process.env.QDRANT_HOST || "localhost";
    const port = parseInt(process.env.QDRANT_PORT || "6333", 10);
    this.qdrant = new QdrantClient(host, port);
    this.embeddingEngine = new EmbeddingEngine(this.context.index, this.qdrant);

    void this.qdrant.connect().catch((error) => {
      console.warn("[ToolHandlers] Qdrant connection skipped:", error);
    });
  }

  private errorEnvelope(
    code: string,
    reason: string,
    recoverable = true,
    hint?: string,
  ): string {
    const response = errorResponse(
      code,
      reason,
      hint || "Review tool input and retry.",
    ) as unknown as Record<string, unknown>;
    response.error = {
      code,
      reason,
      recoverable,
      hint,
    };
    return JSON.stringify(response, null, 2);
  }

  private canonicalizePaths(text: string): string {
    return text
      .replaceAll("/workspace/", "")
      .replace(/\/home\/[^/]+\/stratSolver\//g, "")
      .replaceAll("//", "/");
  }

  private compactValue(value: unknown): unknown {
    if (typeof value === "string") {
      const normalized = this.canonicalizePaths(value);
      return normalized.length > 320
        ? `${normalized.slice(0, 317)}...`
        : normalized;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 10).map((item) => this.compactValue(item));
    }

    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).slice(
        0,
        20,
      );
      return Object.fromEntries(
        entries.map(([key, val]) => [key, this.compactValue(val)]),
      );
    }

    return value;
  }

  private formatSuccess(
    data: unknown,
    profile: string = "compact",
    summary?: string,
    toolName?: string,
  ): string {
    const shaped = profile === "debug" ? data : this.compactValue(data);
    const safeProfile =
      profile === "balanced" || profile === "debug" ? profile : "compact";
    return JSON.stringify(
      formatResponse(
        summary || "Operation completed successfully.",
        shaped,
        safeProfile,
        toolName,
      ),
      null,
      2,
    );
  }

  private classifyIntent(
    query: string,
  ): "structure" | "dependency" | "test-impact" | "progress" | "general" {
    const lower = query.toLowerCase();

    if (/(test|coverage|spec|affected)/.test(lower)) {
      return "test-impact";
    }

    if (/(progress|feature|task|blocked|milestone)/.test(lower)) {
      return "progress";
    }

    if (/(import|dependency|depends|caller|called by|uses)/.test(lower)) {
      return "dependency";
    }

    if (/(file|folder|class|function|structure|tree|list)/.test(lower)) {
      return "structure";
    }

    return "general";
  }

  private normalizeToolArgs(
    toolName: string,
    rawArgs: any,
  ): { normalized: any; warnings: string[] } {
    const warnings: string[] = [];
    const normalized = { ...(rawArgs || {}) };

    if (toolName === "impact_analyze") {
      const files = Array.isArray(normalized.files)
        ? normalized.files
        : Array.isArray(normalized.changedFiles)
          ? normalized.changedFiles
          : [];

      if (
        Array.isArray(normalized.changedFiles) &&
        !Array.isArray(normalized.files)
      ) {
        warnings.push("mapped changedFiles -> files");
      }

      normalized.files = files;
      delete normalized.changedFiles;
    }

    if (toolName === "progress_query") {
      if (typeof normalized.type !== "string") {
        const queryText = String(normalized.query || "task").toLowerCase();
        normalized.type = queryText.includes("feature") ? "feature" : "task";
        warnings.push("derived type from query text");
      }

      if (normalized.status === "active") {
        normalized.status = "in-progress";
        warnings.push("mapped status active -> in-progress");
      }

      if (normalized.status === "all") {
        delete normalized.status;
        warnings.push("mapped status all -> undefined");
      }
    }

    if (toolName === "task_update") {
      if (normalized.status === "active") {
        normalized.status = "in-progress";
        warnings.push("mapped status active -> in-progress");
      }
    }

    if (toolName === "graph_set_workspace" || toolName === "graph_rebuild") {
      if (
        typeof normalized.workspacePath === "string" &&
        typeof normalized.workspaceRoot !== "string"
      ) {
        normalized.workspaceRoot = normalized.workspacePath;
        warnings.push("mapped workspacePath -> workspaceRoot");
      }
      delete normalized.workspacePath;
    }

    return { normalized, warnings };
  }

  normalizeForDispatch(
    toolName: string,
    rawArgs: any,
  ): { normalized: any; warnings: string[] } {
    return this.normalizeToolArgs(toolName, rawArgs);
  }

  async callTool(toolName: string, rawArgs: any): Promise<string> {
    const { normalized, warnings } = this.normalizeToolArgs(toolName, rawArgs);
    const target = (this as any)[toolName];

    if (typeof target !== "function") {
      return this.errorEnvelope(
        "TOOL_NOT_FOUND",
        `Tool not found in handler registry: ${toolName}`,
        false,
      );
    }

    const result = await target.call(this, normalized);

    if (!warnings.length) {
      return result;
    }

    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === "object") {
        parsed.contractWarnings = warnings;
        return JSON.stringify(parsed, null, 2);
      }
      return result;
    } catch {
      return result;
    }
  }

  private routeNaturalToCypher(query: string, projectId: string): string {
    const intent = this.classifyIntent(query);
    const sanitized = query.replace(/["']/g, "");

    if (intent === "structure") {
      return `MATCH (f:FILE) WHERE f.projectId = '${projectId}' RETURN f.path, f.LOC ORDER BY f.path LIMIT 100`;
    }

    if (intent === "dependency") {
      const tokenMatch =
        /(\w+(?:Context|Service|Hook|Provider|Manager|Factory|State)?)/.exec(
          sanitized,
        );
      const token = tokenMatch ? tokenMatch[1] : "";
      return token
        ? `MATCH (f:FILE)-[:IMPORTS]->(imp:IMPORT) WHERE f.projectId = '${projectId}' AND imp.projectId = '${projectId}' AND imp.source CONTAINS '${token}' RETURN f.path, imp.source ORDER BY f.path LIMIT 100`
        : `MATCH (f:FILE)-[:IMPORTS]->(imp:IMPORT) WHERE f.projectId = '${projectId}' AND imp.projectId = '${projectId}' RETURN f.path, imp.source ORDER BY f.path LIMIT 100`;
    }

    if (intent === "test-impact") {
      return `MATCH (t:TEST_CASE)-[:TESTS]->(n) WHERE t.projectId = '${projectId}' AND n.projectId = '${projectId}' RETURN t.name, labels(n)[0] AS targetType, n.name AS target ORDER BY t.name LIMIT 100`;
    }

    if (intent === "progress") {
      return `MATCH (n:FEATURE|TASK) WHERE n.projectId = '${projectId}' RETURN labels(n)[0] AS type, n.id AS id, n.status AS status ORDER BY type, id LIMIT 100`;
    }

    return `MATCH (n) WHERE n.projectId = '${projectId}' RETURN labels(n)[0] as type, count(n) as count ORDER BY count DESC`;
  }

  private toEpochMillis(asOf?: string): number | null {
    if (!asOf || typeof asOf !== "string") {
      return null;
    }

    if (/^\d+$/.test(asOf)) {
      const numeric = Number(asOf);
      return Number.isFinite(numeric) ? numeric : null;
    }

    const parsed = Date.parse(asOf);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private async ensureEmbeddings(): Promise<void> {
    if (this.embeddingsReady || !this.embeddingEngine) {
      return;
    }

    const generated = await this.embeddingEngine.generateAllEmbeddings();
    if (generated.functions + generated.classes + generated.files === 0) {
      throw new Error("No indexed symbols found. Run graph_rebuild first.");
    }

    await this.embeddingEngine.storeInQdrant();
    this.embeddingsReady = true;
  }

  private resolveElement(elementId: string): GraphNode | undefined {
    const exact = this.context.index.getNode(elementId);
    if (exact) {
      return exact;
    }

    const files = this.context.index.getNodesByType("FILE");
    const functions = this.context.index.getNodesByType("FUNCTION");
    const classes = this.context.index.getNodesByType("CLASS");

    return (
      files.find((node) => node.properties.path?.includes(elementId)) ||
      functions.find((node) => node.properties.name === elementId) ||
      classes.find((node) => node.properties.name === elementId)
    );
  }

  // ============================================================================
  // GRAPHRAG TOOLS (3)
  // ============================================================================

  async graph_query(args: any): Promise<string> {
    const {
      query,
      language = "natural",
      limit = 100,
      profile = "compact",
      asOf,
    } = args;

    try {
      let result;
      const { projectId, workspaceRoot } = this.getActiveProjectContext();
      const asOfTs = this.toEpochMillis(asOf);
      if (language === "cypher") {
        if (asOfTs) {
          return this.errorEnvelope(
            "GRAPH_QUERY_ASOF_UNSUPPORTED_FOR_CYPHER",
            "asOf is currently supported only for language='natural'.",
            true,
            "Use language='natural' with asOf, or include temporal filtering directly in your Cypher query.",
          );
        }

        result = await this.context.memgraph.executeCypher(query);
      } else {
        const cypher = this.routeNaturalToCypher(query, projectId);
        if (asOfTs) {
          const temporalCypher = `MATCH (n) WHERE n.projectId = '${projectId}' AND n.validFrom <= ${asOfTs} AND (n.validTo IS NULL OR n.validTo > ${asOfTs}) RETURN labels(n)[0] as type, count(n) as count ORDER BY count DESC`;
          result = await this.context.memgraph.executeCypher(temporalCypher);
        } else {
          result = await this.context.memgraph.executeCypher(cypher);
        }
      }

      if (result.error) {
        return this.errorEnvelope(
          "GRAPH_QUERY_FAILED",
          result.error,
          true,
          "Try using language='cypher' with an explicit query.",
        );
      }

      const limited = result.data.slice(0, limit);
      return this.formatSuccess(
        {
          intent:
            language === "natural" ? this.classifyIntent(query) : "cypher",
          projectId,
          workspaceRoot,
          asOf: asOfTs,
          count: limited.length,
          results: limited,
        },
        profile,
        `Query returned ${limited.length} row(s).`,
        "graph_query",
      );
    } catch (error) {
      return this.errorEnvelope("GRAPH_QUERY_EXCEPTION", String(error), true);
    }
  }

  async code_explain(args: any): Promise<string> {
    const { element, depth = 2, profile = "compact" } = args;

    try {
      // Find the element in the graph
      const files = this.context.index.getNodesByType("FILE");
      const funcs = this.context.index.getNodesByType("FUNCTION");
      const classes = this.context.index.getNodesByType("CLASS");

      let targetNode =
        files.find((n) => n.properties.path?.includes(element)) ||
        funcs.find((n) => n.properties.name === element) ||
        classes.find((n) => n.properties.name === element);

      if (!targetNode) {
        return this.errorEnvelope(
          "ELEMENT_NOT_FOUND",
          `Element not found: ${element}`,
          true,
          "Provide a file path, class name, or function name present in the index.",
        );
      }

      // Gather context
      const explanation: any = {
        element: targetNode.properties.name || targetNode.properties.path,
        type: targetNode.type,
        properties: targetNode.properties,
        dependencies: [] as any[],
        dependents: [] as any[],
      };

      // Get incoming and outgoing relationships
      const outgoing = this.context.index.getRelationshipsFrom(targetNode.id);
      for (const rel of outgoing.slice(0, depth * 10)) {
        const target = this.context.index.getNode(rel.to);
        if (target) {
          explanation.dependencies.push({
            type: rel.type,
            target:
              target.properties.name || target.properties.path || target.id,
          });
        }
      }

      return this.formatSuccess(explanation, profile);
    } catch (error) {
      return this.errorEnvelope("CODE_EXPLAIN_FAILED", String(error), true);
    }
  }

  async find_pattern(args: any): Promise<string> {
    const { pattern, type = "pattern", profile = "compact" } = args;

    try {
      const results: any = {
        pattern,
        type,
        matches: [] as any[],
      };

      if (type === "violation") {
        if (!this.archEngine) {
          return "Architecture engine not initialized";
        }
        const result = await this.archEngine.validate();
        results.matches = result.violations.slice(0, 10);
      } else if (type === "unused") {
        // Find files with no relationships
        const files = this.context.index.getNodesByType("FILE");
        for (const file of files) {
          const rels = this.context.index.getRelationshipsFrom(file.id);
          if (rels.length === 0) {
            results.matches.push({
              path: file.properties.path,
              reason: "No incoming or outgoing relationships",
            });
          }
        }
      } else if (type === "circular") {
        // Find circular dependencies (simplified)
        results.matches.push({
          note: "Circular dependency detection requires full graph traversal",
          status: "not-implemented",
        });
      } else {
        // Generic pattern search
        results.matches.push({
          pattern,
          status: "search-implemented",
        });
      }

      return this.formatSuccess(results, profile);
    } catch (error) {
      return this.errorEnvelope("PATTERN_SEARCH_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // ARCHITECTURE TOOLS (2)
  // ============================================================================

  async arch_validate(args: any): Promise<string> {
    const { files, strict = false, profile = "compact" } = args;

    if (!this.archEngine) {
      return this.errorEnvelope(
        "ARCH_ENGINE_UNAVAILABLE",
        "Architecture engine not initialized",
        true,
      );
    }

    try {
      const result = await this.archEngine.validate(files);

      const output = {
        success: result.success,
        violations: result.violations.slice(0, 20), // Top 20 violations
        statistics: result.statistics,
        severity: strict ? "error" : "warning",
      };

      return this.formatSuccess(output, profile);
    } catch (error) {
      return this.errorEnvelope("ARCH_VALIDATE_FAILED", String(error), true);
    }
  }

  async arch_suggest(args: any): Promise<string> {
    const { name, type, dependencies = [], profile = "compact" } = args;

    if (!this.archEngine) {
      return this.errorEnvelope(
        "ARCH_ENGINE_UNAVAILABLE",
        "Architecture engine not initialized",
        true,
      );
    }

    try {
      const suggestion = this.archEngine.getSuggestion(
        name,
        type,
        dependencies,
      );

      if (!suggestion) {
        return this.formatSuccess(
          {
            success: false,
            message: "No suitable layer found for this code",
            reason: `No layer can import from all dependencies: ${dependencies.join(", ")}`,
          },
          profile,
        );
      }

      return this.formatSuccess(
        {
          success: true,
          suggestedLayer: suggestion.suggestedLayer,
          suggestedPath: suggestion.suggestedPath,
          reasoning: suggestion.reasoning,
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("ARCH_SUGGEST_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // TEST INTELLIGENCE TOOLS (4)
  // ============================================================================

  async test_select(args: any): Promise<string> {
    const {
      changedFiles,
      includeIntegration = true,
      profile = "compact",
    } = args;

    try {
      const result = this.testEngine!.selectAffectedTests(
        changedFiles,
        includeIntegration,
      );

      return this.formatSuccess(result, profile);
    } catch (error) {
      return this.errorEnvelope("TEST_SELECT_FAILED", String(error), true);
    }
  }

  async test_categorize(args: any): Promise<string> {
    const { testFiles = [], profile = "compact" } = args;

    try {
      console.log(`[Test] Categorizing ${testFiles.length} test files...`);
      const stats = this.testEngine!.getStatistics();

      return this.formatSuccess(
        {
          statistics: stats,
          categorization: {
            unit: {
              count: stats.unitTests,
              pattern: "**/__tests__/**/*.test.ts",
              timeout: 5000,
            },
            integration: {
              count: stats.integrationTests,
              pattern: "**/__tests__/**/*.integration.test.ts",
              timeout: 15000,
            },
            performance: {
              count: stats.performanceTests,
              pattern: "**/*.performance.test.ts",
              timeout: 30000,
            },
            e2e: {
              count: stats.e2eTests,
              pattern: "**/e2e/**/*.test.ts",
              timeout: 60000,
            },
          },
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("TEST_CATEGORIZE_FAILED", String(error), true);
    }
  }

  async impact_analyze(args: any): Promise<string> {
    const profile = args?.profile || "compact";
    const depth = typeof args?.depth === "number" ? args.depth : 2;
    const changedFiles: string[] = Array.isArray(args?.files)
      ? args.files
      : Array.isArray(args?.changedFiles)
        ? args.changedFiles
        : [];

    if (!changedFiles.length) {
      return this.formatSuccess(
        {
          changedFiles: [],
          analysis: {
            directImpact: [],
            estimatedTestTime: 0,
            coverage: {
              percentage: 0,
              testsSelected: 0,
              totalTests: 0,
            },
            blastRadius: {
              testsAffected: 0,
              percentage: 0,
              recommendation: "Provide at least one changed file",
            },
          },
          warning: "No changed files were provided",
        },
        profile,
      );
    }

    try {
      const result = this.testEngine!.selectAffectedTests(
        changedFiles,
        true,
        depth,
      );

      return this.formatSuccess(
        {
          changedFiles,
          analysis: {
            directImpact: result.selectedTests.slice(0, 10),
            estimatedTestTime: result.estimatedTime,
            coverage: result.coverage,
            blastRadius: {
              testsAffected: result.selectedTests.length,
              percentage: result.coverage.percentage,
              recommendation:
                result.coverage.percentage > 50
                  ? "Run full suite"
                  : "Run affected tests",
            },
          },
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("IMPACT_ANALYZE_FAILED", String(error), true);
    }
  }

  async test_run(args: any): Promise<string> {
    const { testFiles = [], parallel = true, profile = "compact" } = args;

    try {
      if (!testFiles || testFiles.length === 0) {
        return this.formatSuccess(
          {
            status: "error",
            message: "No test files specified",
            executed: 0,
            passed: 0,
            failed: 0,
          },
          profile,
        );
      }

      // Build vitest command (Phase 3.5 - actual execution)
      const cmd = [
        "npx vitest run",
        parallel ? "--reporter=verbose" : "--reporter=verbose --no-coverage",
        ...testFiles,
      ].join(" ");

      console.log(`[ToolHandlers] Executing: ${cmd}`);

      // Execute vitest
      try {
        const output = execSync(cmd, {
          cwd: process.cwd(),
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });

        return this.formatSuccess(
          {
            status: "passed",
            message: "All tests passed",
            output: output.substring(0, 1000), // First 1000 chars
            testsRun: testFiles.length,
          },
          profile,
        );
      } catch (execError: any) {
        // Tests failed but command executed
        return this.formatSuccess(
          {
            status: "failed",
            message: "Some tests failed",
            error: execError.message.substring(0, 500),
            output: execError.stdout?.toString().substring(0, 500) || "",
            testsRun: testFiles.length,
          },
          profile,
        );
      }
    } catch (error) {
      return this.errorEnvelope(
        "TEST_RUN_FAILED",
        `Test execution failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  // ============================================================================
  // PROGRESS TRACKING TOOLS (4)
  // ============================================================================

  async progress_query(args: any): Promise<string> {
    const profile = args?.profile || "compact";
    const status = args?.status || args?.filter?.status;
    const queryText = String(args?.query || args?.type || "task").toLowerCase();
    const type: "feature" | "task" = queryText.includes("feature")
      ? "feature"
      : "task";

    const normalizedStatus =
      status === "active"
        ? "in-progress"
        : status === "all"
          ? undefined
          : status;

    const filter = {
      ...(args?.filter || {}),
      ...(normalizedStatus ? { status: normalizedStatus } : {}),
    };

    try {
      const result = this.progressEngine!.query(type, filter);

      return this.formatSuccess(result, profile);
    } catch (error) {
      return this.errorEnvelope("PROGRESS_QUERY_FAILED", String(error), true);
    }
  }

  async task_update(args: any): Promise<string> {
    const {
      taskId,
      status,
      assignee,
      dueDate,
      notes,
      profile = "compact",
    } = args;

    try {
      const updated = this.progressEngine!.updateTask(taskId, {
        status,
        assignee,
        dueDate,
      });

      if (!updated) {
        return this.formatSuccess(
          { success: false, error: `Task not found: ${taskId}` },
          profile,
        );
      }

      return this.formatSuccess(
        { success: true, task: updated, notes },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("TASK_UPDATE_FAILED", String(error), true);
    }
  }

  async feature_status(args: any): Promise<string> {
    const { featureId, profile = "compact" } = args;

    try {
      const status = this.progressEngine!.getFeatureStatus(featureId);

      if (!status) {
        return this.formatSuccess(
          { success: false, error: `Feature not found: ${featureId}` },
          profile,
        );
      }

      return this.formatSuccess(status, profile);
    } catch (error) {
      return this.errorEnvelope("FEATURE_STATUS_FAILED", String(error), true);
    }
  }

  async blocking_issues(args: any): Promise<string> {
    const type = args?.type || (args?.context ? "all" : "all");
    const profile = args?.profile || "compact";

    try {
      const issues = this.progressEngine!.getBlockingIssues(type);

      return this.formatSuccess(
        {
          type,
          blockingIssues: issues.slice(0, 20),
          totalBlocked: issues.length,
          recommendation:
            issues.length > 0
              ? `Address ${issues.length} blocking issue(s)`
              : "No blocking issues",
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("BLOCKING_ISSUES_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // UTILITY TOOLS (2)
  // ============================================================================

  async graph_set_workspace(args: any): Promise<string> {
    const { profile = "compact" } = args || {};

    try {
      let nextContext = this.resolveProjectContext(args || {});
      const adapted = this.adaptWorkspaceForRuntime(nextContext);
      const explicitWorkspaceProvided =
        typeof args?.workspaceRoot === "string" &&
        args.workspaceRoot.trim().length > 0;

      if (
        adapted.usedFallback &&
        explicitWorkspaceProvided &&
        !this.runtimePathFallbackAllowed()
      ) {
        return this.errorEnvelope(
          "WORKSPACE_PATH_SANDBOXED",
          `Requested workspaceRoot is not accessible from this runtime: ${nextContext.workspaceRoot}`,
          true,
          "Mount the target project into the container (e.g. CODE_GRAPH_TARGET_WORKSPACE) and restart docker-compose, or set CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
        );
      }

      nextContext = adapted.context;

      if (!fs.existsSync(nextContext.workspaceRoot)) {
        return this.errorEnvelope(
          "WORKSPACE_NOT_FOUND",
          `Workspace root does not exist: ${nextContext.workspaceRoot}`,
          true,
          "Pass an existing absolute path as workspaceRoot (or workspacePath).",
        );
      }

      if (!fs.existsSync(nextContext.sourceDir)) {
        return this.errorEnvelope(
          "SOURCE_DIR_NOT_FOUND",
          `Source directory does not exist: ${nextContext.sourceDir}`,
          true,
          "Pass sourceDir explicitly if your source folder is not <workspaceRoot>/src.",
        );
      }

      this.setActiveProjectContext(nextContext);

      return this.formatSuccess(
        {
          success: true,
          projectContext: this.getActiveProjectContext(),
          runtimePathFallback: adapted.usedFallback,
          runtimePathFallbackReason: adapted.fallbackReason || null,
          message:
            "Workspace context updated. Subsequent graph tools will use this project.",
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope(
        "SET_WORKSPACE_FAILED",
        String(error),
        true,
        "Retry with workspaceRoot and sourceDir values.",
      );
    }
  }

  async graph_rebuild(args: any): Promise<string> {
    const { mode = "incremental", verbose = false, profile = "compact" } = args;

    try {
      if (!this.orchestrator) {
        return this.errorEnvelope(
          "GRAPH_ORCHESTRATOR_UNAVAILABLE",
          "Graph orchestrator not initialized",
          true,
        );
      }

      let resolvedContext = this.resolveProjectContext(args || {});
      const adapted = this.adaptWorkspaceForRuntime(resolvedContext);
      const explicitWorkspaceProvided =
        typeof args?.workspaceRoot === "string" &&
        args.workspaceRoot.trim().length > 0;

      if (
        adapted.usedFallback &&
        explicitWorkspaceProvided &&
        !this.runtimePathFallbackAllowed()
      ) {
        return this.errorEnvelope(
          "WORKSPACE_PATH_SANDBOXED",
          `Requested workspaceRoot is not accessible from this runtime: ${resolvedContext.workspaceRoot}`,
          true,
          "Mount the target project into the container (e.g. CODE_GRAPH_TARGET_WORKSPACE) and restart docker-compose, or set CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
        );
      }

      resolvedContext = adapted.context;
      this.setActiveProjectContext(resolvedContext);
      const { workspaceRoot, sourceDir, projectId } = resolvedContext;
      const txTimestamp = Date.now();
      const txId = `tx-${txTimestamp}-${Math.random().toString(36).slice(2, 8)}`;

      if (this.context.memgraph.isConnected()) {
        await this.context.memgraph.executeCypher(
          `CREATE (tx:GRAPH_TX {id: $id, projectId: $projectId, type: $type, timestamp: $timestamp, mode: $mode, sourceDir: $sourceDir})`,
          {
            id: txId,
            projectId,
            type: mode === "full" ? "full_rebuild" : "incremental_rebuild",
            timestamp: txTimestamp,
            mode,
            sourceDir,
          },
        );
      }

      if (!fs.existsSync(workspaceRoot)) {
        return this.errorEnvelope(
          "WORKSPACE_NOT_FOUND",
          `Workspace root does not exist: ${workspaceRoot}`,
          true,
          "Call graph_set_workspace first with a valid path.",
        );
      }

      if (!fs.existsSync(sourceDir)) {
        return this.errorEnvelope(
          "SOURCE_DIR_NOT_FOUND",
          `Source directory does not exist: ${sourceDir}`,
          true,
          "Provide sourceDir in graph_rebuild or graph_set_workspace.",
        );
      }

      // Start the build process WITHOUT waiting for it to complete
      // This prevents the MCP tool from blocking/timing out
      // Fire and forget - the build happens in background
      this.orchestrator
        .build({
          mode,
          verbose,
          workspaceRoot,
          projectId,
          sourceDir,
          txId,
          txTimestamp,
          exclude: [
            "node_modules",
            "dist",
            ".next",
            ".code-graph",
            "__tests__",
            "coverage",
            ".git",
          ],
        })
        .catch((err) =>
          console.error("[GraphOrchestrator] Background build error:", err),
        );

      this.lastGraphRebuildAt = new Date().toISOString();
      this.lastGraphRebuildMode = mode;

      // Return immediately with status
      return this.formatSuccess(
        {
          success: true,
          status: "QUEUED",
          mode,
          verbose,
          sourceDir,
          workspaceRoot,
          projectId,
          txId,
          txTimestamp,
          runtimePathFallback: adapted.usedFallback,
          runtimePathFallbackReason: adapted.fallbackReason || null,
          message: `Graph rebuild ${mode} mode initiated. Processing ${mode === "full" ? "all" : "changed"} files in background...`,
          note: "Use graph_query tool to check progress or query results",
        },
        profile,
        `Graph rebuild queued in ${mode} mode for project ${projectId}.`,
        "graph_rebuild",
      );
    } catch (error) {
      return this.errorEnvelope(
        "GRAPH_REBUILD_FAILED",
        `Graph rebuild failed to start: ${String(error)}`,
        true,
      );
    }
  }

  async graph_health(args: any): Promise<string> {
    const profile = args?.profile || "compact";

    try {
      const stats = this.context.index.getStatistics();
      const functionCount =
        this.context.index.getNodesByType("FUNCTION").length;
      const classCount = this.context.index.getNodesByType("CLASS").length;
      const fileCount = this.context.index.getNodesByType("FILE").length;
      const indexedSymbols = functionCount + classCount + fileCount;

      const embeddingCount =
        this.embeddingEngine?.getAllEmbeddings().length || 0;
      const embeddingCoverage =
        indexedSymbols > 0
          ? Number((embeddingCount / indexedSymbols).toFixed(3))
          : 0;
      const { workspaceRoot, sourceDir, projectId } =
        this.getActiveProjectContext();

      const latestTxResult = await this.context.memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId}) RETURN tx.id AS id, tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
        { projectId },
      );
      const txCountResult = await this.context.memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId}) RETURN count(tx) AS txCount",
        { projectId },
      );
      const latestTxRow = latestTxResult.data?.[0] || {};
      const txCountRow = txCountResult.data?.[0] || {};

      return this.formatSuccess(
        {
          status: "ok",
          projectId,
          workspaceRoot,
          sourceDir,
          memgraphConnected: this.context.memgraph.isConnected(),
          qdrantConnected: this.qdrant?.isConnected() || false,
          graphIndex: {
            totalNodes: stats.totalNodes,
            totalRelationships: stats.totalRelationships,
            indexedFiles: fileCount,
            indexedFunctions: functionCount,
            indexedClasses: classCount,
          },
          embeddings: {
            ready: this.embeddingsReady,
            generated: embeddingCount,
            coverage: embeddingCoverage,
          },
          rebuild: {
            lastRequestedAt: this.lastGraphRebuildAt || null,
            lastMode: this.lastGraphRebuildMode || null,
            latestTxId: latestTxRow.id ?? null,
            latestTxTimestamp: latestTxRow.timestamp ?? null,
            txCount: txCountRow.txCount ?? 0,
          },
          freshness: {
            staleFileEstimate: null,
            note: "Use graph_rebuild incremental to refresh changed files.",
          },
        },
        profile,
        "Graph health is OK.",
        "graph_health",
      );
    } catch (error) {
      return this.errorEnvelope("GRAPH_HEALTH_FAILED", String(error), true);
    }
  }

  async contract_validate(args: any): Promise<string> {
    const { tool, arguments: inputArgs = {}, profile = "compact" } = args || {};

    if (!tool || typeof tool !== "string") {
      return this.errorEnvelope(
        "CONTRACT_VALIDATE_INVALID_INPUT",
        "Field 'tool' is required and must be a string",
        true,
      );
    }

    try {
      const { normalized, warnings } = this.normalizeToolArgs(tool, inputArgs);
      return this.formatSuccess(
        {
          tool,
          input: inputArgs,
          normalized,
          warnings,
          valid: true,
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope(
        "CONTRACT_VALIDATE_FAILED",
        String(error),
        true,
      );
    }
  }

  async semantic_search(args: any): Promise<string> {
    const { query, type = "function", limit = 5, profile = "compact" } = args;

    try {
      await this.ensureEmbeddings();
      const results = await this.embeddingEngine!.findSimilar(
        query,
        type,
        limit,
      );

      return this.formatSuccess(
        {
          query,
          type,
          count: results.length,
          results: results.map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            path: item.metadata.path,
          })),
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("SEMANTIC_SEARCH_FAILED", String(error), true);
    }
  }

  async find_similar_code(args: any): Promise<string> {
    const {
      elementId,
      threshold = 0.7,
      limit = 10,
      profile = "compact",
    } = args;

    try {
      await this.ensureEmbeddings();
      const results = await this.embeddingEngine!.findSimilar(
        elementId,
        "function",
        limit,
      );
      const filtered = results.slice(0, limit);

      return this.formatSuccess(
        {
          elementId,
          threshold,
          count: filtered.length,
          similar: filtered.map((item) => ({
            id: item.id,
            name: item.name,
            type: item.type,
            path: item.metadata.path,
          })),
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope(
        "FIND_SIMILAR_CODE_FAILED",
        String(error),
        true,
      );
    }
  }

  async code_clusters(args: any): Promise<string> {
    const { type, count = 5, profile = "compact" } = args;

    try {
      await this.ensureEmbeddings();
      const embeddings = this.embeddingEngine!.getAllEmbeddings()
        .filter((item) => item.type === type)
        .slice(0, 200);

      const clusters: Record<string, string[]> = {};
      for (const item of embeddings) {
        const path = item.metadata.path || "unknown";
        const key = path.split("/").slice(0, 2).join("/") || "root";
        if (!clusters[key]) {
          clusters[key] = [];
        }
        clusters[key].push(item.name);
      }

      const clusterRows = Object.entries(clusters)
        .map(([clusterId, names]) => ({
          clusterId,
          size: names.length,
          sample: names.slice(0, 5),
        }))
        .sort((a, b) => b.size - a.size)
        .slice(0, count);

      return this.formatSuccess(
        { type, count: clusterRows.length, clusters: clusterRows },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("CODE_CLUSTERS_FAILED", String(error), true);
    }
  }

  async semantic_diff(args: any): Promise<string> {
    const { elementId1, elementId2, profile = "compact" } = args;

    try {
      const left = this.resolveElement(elementId1);
      const right = this.resolveElement(elementId2);

      if (!left || !right) {
        return this.errorEnvelope(
          "SEMANTIC_DIFF_ELEMENT_NOT_FOUND",
          `Could not resolve one or both elements: ${elementId1}, ${elementId2}`,
          true,
        );
      }

      const leftProps = left.properties || {};
      const rightProps = right.properties || {};
      const leftKeys = new Set(Object.keys(leftProps));
      const rightKeys = new Set(Object.keys(rightProps));
      const commonKeys = [...leftKeys].filter((key) => rightKeys.has(key));

      const changedKeys = commonKeys.filter(
        (key) =>
          JSON.stringify(leftProps[key]) !== JSON.stringify(rightProps[key]),
      );

      return this.formatSuccess(
        {
          left: left.properties.name || left.properties.path || left.id,
          right: right.properties.name || right.properties.path || right.id,
          leftType: left.type,
          rightType: right.type,
          changedKeys,
          leftOnlyKeys: [...leftKeys].filter((key) => !rightKeys.has(key)),
          rightOnlyKeys: [...rightKeys].filter((key) => !leftKeys.has(key)),
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("SEMANTIC_DIFF_FAILED", String(error), true);
    }
  }

  async suggest_tests(args: any): Promise<string> {
    const { elementId, limit = 5, profile = "compact" } = args;

    try {
      const resolved = this.resolveElement(elementId);
      const candidatePath = resolved?.properties.path;

      if (!candidatePath) {
        return this.errorEnvelope(
          "SUGGEST_TESTS_ELEMENT_NOT_FOUND",
          `Unable to resolve file path for element: ${elementId}`,
          true,
        );
      }

      const selection = this.testEngine!.selectAffectedTests(
        [candidatePath],
        true,
        2,
      );
      const suggested = selection.selectedTests.slice(0, limit);

      return this.formatSuccess(
        {
          elementId,
          file: candidatePath,
          suggestedTests: suggested,
          estimatedTime: selection.estimatedTime,
          coverage: selection.coverage,
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("SUGGEST_TESTS_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // EPISODE MEMORY TOOLS (4)
  // ============================================================================

  async episode_add(args: any): Promise<string> {
    const {
      type,
      content,
      entities = [],
      taskId,
      outcome,
      metadata,
      sensitive = false,
      profile = "compact",
      agentId,
      sessionId,
    } = args || {};

    if (!type || !content) {
      return this.errorEnvelope(
        "EPISODE_ADD_INVALID_INPUT",
        "Fields 'type' and 'content' are required.",
        true,
        "Provide type (e.g. OBSERVATION) and content.",
      );
    }

    try {
      const contextSessionId = this.getCurrentSessionId() || "session-unknown";
      const runtimeAgentId = String(agentId || process.env.CODE_GRAPH_AGENT_ID || "agent-local");
      const { projectId } = this.getActiveProjectContext();

      const episodeId = await this.episodeEngine!.add(
        {
          type: String(type).toUpperCase() as EpisodeType,
          content: String(content),
          entities: Array.isArray(entities) ? entities.map((item) => String(item)) : [],
          taskId: taskId ? String(taskId) : undefined,
          outcome,
          metadata: metadata && typeof metadata === "object" ? metadata : undefined,
          sensitive: Boolean(sensitive),
          agentId: runtimeAgentId,
          sessionId: String(sessionId || contextSessionId),
        },
        projectId,
      );

      return this.formatSuccess(
        {
          episodeId,
          type: String(type).toUpperCase(),
          projectId,
          taskId: taskId || null,
        },
        profile,
        `Episode ${episodeId} persisted.`,
      );
    } catch (error) {
      return this.errorEnvelope("EPISODE_ADD_FAILED", String(error), true);
    }
  }

  async episode_recall(args: any): Promise<string> {
    const {
      query,
      agentId,
      taskId,
      types,
      entities,
      limit = 5,
      since,
      profile = "compact",
    } = args || {};

    if (!query || typeof query !== "string") {
      return this.errorEnvelope(
        "EPISODE_RECALL_INVALID_INPUT",
        "Field 'query' is required.",
        true,
      );
    }

    try {
      const sinceMs = this.toEpochMillis(since);
      const { projectId } = this.getActiveProjectContext();
      const episodes = await this.episodeEngine!.recall({
        query,
        projectId,
        agentId,
        taskId,
        types: Array.isArray(types)
          ? types.map((item) => String(item).toUpperCase() as EpisodeType)
          : undefined,
        entities: Array.isArray(entities)
          ? entities.map((item) => String(item))
          : undefined,
        limit,
        since: sinceMs || undefined,
      });

      return this.formatSuccess(
        {
          query,
          projectId,
          count: episodes.length,
          episodes,
        },
        profile,
        `Recalled ${episodes.length} episode(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("EPISODE_RECALL_FAILED", String(error), true);
    }
  }

  async decision_query(args: any): Promise<string> {
    const {
      query,
      affectedFiles = [],
      limit = 5,
      taskId,
      agentId,
      profile = "compact",
    } = args || {};

    if (!query || typeof query !== "string") {
      return this.errorEnvelope(
        "DECISION_QUERY_INVALID_INPUT",
        "Field 'query' is required.",
        true,
      );
    }

    try {
      const { projectId } = this.getActiveProjectContext();
      const decisions = await this.episodeEngine!.decisionQuery({
        query,
        projectId,
        taskId,
        agentId,
        entities: Array.isArray(affectedFiles)
          ? affectedFiles.map((item) => String(item))
          : undefined,
        limit,
      });

      return this.formatSuccess(
        {
          query,
          projectId,
          count: decisions.length,
          decisions,
        },
        profile,
        `Found ${decisions.length} decision episode(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("DECISION_QUERY_FAILED", String(error), true);
    }
  }

  async reflect(args: any): Promise<string> {
    const { taskId, agentId, limit = 20, profile = "compact" } = args || {};

    try {
      const { projectId } = this.getActiveProjectContext();
      const result = await this.episodeEngine!.reflect({
        taskId,
        agentId,
        limit,
        projectId,
      });

      return this.formatSuccess(
        result,
        profile,
        `Reflection completed with ${result.learningsCreated} learning(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("REFLECT_FAILED", String(error), true);
    }
  }
}

export default ToolHandlers;
