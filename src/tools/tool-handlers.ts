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
import CoordinationEngine, {
  type ClaimType,
} from "../engines/coordination-engine.js";
import CommunityDetector from "../engines/community-detector.js";
import { runPPR } from "../graph/ppr.js";
import HybridRetriever from "../graph/hybrid-retriever.js";
import FileWatcher, { type WatcherState } from "../graph/watcher.js";
import { DocsEngine } from "../engines/docs-engine.js";
import { DocsParser, findMarkdownFiles, type ParsedSection } from "../parsers/docs-parser.js";
import {
  estimateTokens,
  makeBudget,
  type ResponseProfile,
} from "../response/budget.js";

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
  private coordinationEngine?: CoordinationEngine;
  private communityDetector?: CommunityDetector;
  private hybridRetriever?: HybridRetriever;
  private docsEngine?: DocsEngine;
  private embeddingsReady = false;
  private lastGraphRebuildAt?: string;
  private lastGraphRebuildMode?: "full" | "incremental";
  private defaultActiveProjectContext: ProjectContext;
  private sessionProjectContexts = new Map<string, ProjectContext>();
  private sessionWatchers = new Map<string, FileWatcher>();

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

  private watcherEnabledForRuntime(): boolean {
    return (
      process.env.MCP_TRANSPORT === "http" ||
      process.env.CODE_GRAPH_ENABLE_WATCHER === "true"
    );
  }

  private watcherKey(): string {
    return this.getCurrentSessionId() || "__default__";
  }

  private getActiveWatcher(): FileWatcher | undefined {
    return this.sessionWatchers.get(this.watcherKey());
  }

  private async stopActiveWatcher(): Promise<void> {
    const key = this.watcherKey();
    const existing = this.sessionWatchers.get(key);
    if (!existing) {
      return;
    }

    await existing.stop();
    this.sessionWatchers.delete(key);
  }

  private async startActiveWatcher(context: ProjectContext): Promise<void> {
    if (!this.watcherEnabledForRuntime()) {
      return;
    }

    await this.stopActiveWatcher();

    const watcher = new FileWatcher(
      {
        workspaceRoot: context.workspaceRoot,
        sourceDir: context.sourceDir,
        projectId: context.projectId,
        debounceMs: 500,
        ignorePatterns: (process.env.CODE_GRAPH_IGNORE_PATTERNS || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      },
      async ({ projectId, workspaceRoot, sourceDir, changedFiles }) => {
        await this.runWatcherIncrementalRebuild({
          projectId,
          workspaceRoot,
          sourceDir,
          changedFiles,
        });
      },
    );

    watcher.start();
    this.sessionWatchers.set(this.watcherKey(), watcher);
  }

  private async runWatcherIncrementalRebuild(
    context: ProjectContext & { changedFiles?: string[] },
  ): Promise<void> {
    if (!this.orchestrator) {
      return;
    }

    const txTimestamp = Date.now();
    const txId = `tx-${txTimestamp}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.context.memgraph.isConnected()) {
      await this.context.memgraph.executeCypher(
        `CREATE (tx:GRAPH_TX {id: $id, projectId: $projectId, type: $type, timestamp: $timestamp, mode: $mode, sourceDir: $sourceDir})`,
        {
          id: txId,
          projectId: context.projectId,
          type: "incremental_rebuild",
          timestamp: txTimestamp,
          mode: "incremental",
          sourceDir: context.sourceDir,
        },
      );
    }

    await this.orchestrator.build({
      mode: "incremental",
      verbose: false,
      workspaceRoot: context.workspaceRoot,
      projectId: context.projectId,
      sourceDir: context.sourceDir,
      changedFiles: context.changedFiles,
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
    });

    this.lastGraphRebuildAt = new Date().toISOString();
    this.lastGraphRebuildMode = "incremental";
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
    this.progressEngine = new ProgressEngine(
      this.context.index,
      this.context.memgraph,
    );
    this.episodeEngine = new EpisodeEngine(this.context.memgraph);
    this.coordinationEngine = new CoordinationEngine(this.context.memgraph);
    this.communityDetector = new CommunityDetector(this.context.memgraph);

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
    this.hybridRetriever = new HybridRetriever(
      this.context.index,
      this.embeddingEngine,
      this.context.memgraph,
    );
    this.docsEngine = new DocsEngine(this.context.memgraph, {
      qdrant: this.qdrant,
    });

    void this.qdrant.connect().catch((error) => {
      console.warn("[ToolHandlers] Qdrant connection skipped:", error);
    });

    if (!process.env.CODE_GRAPH_SUMMARIZER_URL) {
      console.warn(
        "[summarizer] CODE_GRAPH_SUMMARIZER_URL is not set. " +
          "Heuristic local summaries will be used, reducing vector search quality and " +
          "compact-profile accuracy. " +
          "Point this to an OpenAI-compatible /v1/chat/completions endpoint for production use.",
      );
    }
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

  private toSafeNumber(value: unknown): number | null {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === "bigint") {
      return Number(value);
    }

    if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    if (
      value &&
      typeof value === "object" &&
      "low" in (value as Record<string, unknown>)
    ) {
      const low = Number((value as Record<string, unknown>).low);
      const highRaw = (value as Record<string, unknown>).high;
      const high = typeof highRaw === "number" ? highRaw : Number(highRaw || 0);

      if (Number.isFinite(low) && Number.isFinite(high)) {
        return high * 4294967296 + low;
      }
    }

    return null;
  }

  private validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null {
    const type = String(args.type || "").toUpperCase();
    const entities = Array.isArray(args.entities) ? args.entities : [];
    const metadata = args.metadata || {};

    if (type === "DECISION") {
      const outcome = String(args.outcome || "").toLowerCase();
      if (!outcome || !["success", "failure", "partial"].includes(outcome)) {
        return "DECISION episodes require outcome: success | failure | partial.";
      }
      if (
        typeof metadata.rationale !== "string" &&
        typeof metadata.reason !== "string"
      ) {
        return "DECISION episodes require metadata.rationale (or metadata.reason).";
      }
    }

    if (type === "EDIT") {
      if (!entities.length) {
        return "EDIT episodes require at least one entity reference.";
      }
    }

    if (type === "TEST_RESULT") {
      const outcome = String(args.outcome || "").toLowerCase();
      if (!outcome || !["success", "failure", "partial"].includes(outcome)) {
        return "TEST_RESULT episodes require outcome: success | failure | partial.";
      }
      if (
        typeof metadata.testName !== "string" &&
        typeof metadata.testFile !== "string"
      ) {
        return "TEST_RESULT episodes require metadata.testName or metadata.testFile.";
      }
    }

    if (type === "ERROR") {
      if (
        typeof metadata.errorCode !== "string" &&
        typeof metadata.stack !== "string"
      ) {
        return "ERROR episodes require metadata.errorCode or metadata.stack.";
      }
    }

    return null;
  }

  private async inferEpisodeEntityHints(
    query: string,
    limit: number,
  ): Promise<string[]> {
    if (!this.embeddingEngine || !query.trim()) {
      return [];
    }

    try {
      await this.ensureEmbeddings();
      const topK = Math.max(1, Math.min(limit, 10));
      const [functions, classes, files] = await Promise.all([
        this.embeddingEngine.findSimilar(query, "function", topK),
        this.embeddingEngine.findSimilar(query, "class", topK),
        this.embeddingEngine.findSimilar(query, "file", topK),
      ]);

      return [...functions, ...classes, ...files]
        .map((item) => String(item.id || ""))
        .filter(Boolean)
        .slice(0, topK * 2);
    } catch {
      return [];
    }
  }

  private async resolveSinceAnchor(
    since: string,
    projectId: string,
  ): Promise<{
    sinceTs: number;
    mode: "txId" | "timestamp" | "gitCommit" | "agentId";
    anchorValue: string;
  } | null> {
    const trimmed = since.trim();
    if (!trimmed) {
      return null;
    }

    const txIdPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (txIdPattern.test(trimmed) || trimmed.startsWith("tx-")) {
      const txLookup = await this.context.memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId, id: $id}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
        { projectId, id: trimmed },
      );
      const ts = this.toSafeNumber(txLookup.data?.[0]?.timestamp);
      if (ts !== null) {
        return { sinceTs: ts, mode: "txId", anchorValue: trimmed };
      }
      return null;
    }

    const timestamp = this.toEpochMillis(trimmed);
    if (timestamp !== null) {
      return { sinceTs: timestamp, mode: "timestamp", anchorValue: trimmed };
    }

    if (/^[a-f0-9]{7,40}$/i.test(trimmed)) {
      const commitLookup = await this.context.memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId, gitCommit: $gitCommit}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
        { projectId, gitCommit: trimmed },
      );
      const ts = this.toSafeNumber(commitLookup.data?.[0]?.timestamp);
      if (ts !== null) {
        return { sinceTs: ts, mode: "gitCommit", anchorValue: trimmed };
      }
      return null;
    }

    const agentLookup = await this.context.memgraph.executeCypher(
      "MATCH (tx:GRAPH_TX {projectId: $projectId, agentId: $agentId}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
      { projectId, agentId: trimmed },
    );
    const agentTs = this.toSafeNumber(agentLookup.data?.[0]?.timestamp);
    if (agentTs !== null) {
      return { sinceTs: agentTs, mode: "agentId", anchorValue: trimmed };
    }

    return null;
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

  private buildTemporalPredicateForVars(variables: string[]): string {
    const unique = [...new Set(variables.filter(Boolean))];
    return unique
      .map(
        (name) =>
          `(${name}.validFrom <= $asOfTs AND (${name}.validTo IS NULL OR ${name}.validTo > $asOfTs))`,
      )
      .join(" AND ");
  }

  private extractMatchVariables(segment: string): string[] {
    const vars: string[] = [];
    const regex = /\(([A-Za-z_][A-Za-z0-9_]*)\s*(?::|\)|\{)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(segment)) !== null) {
      vars.push(match[1]);
    }
    return vars;
  }

  private applyTemporalFilterToCypher(query: string): string {
    const matchSegmentRegex =
      /((?:OPTIONAL\s+MATCH|MATCH)\b[\s\S]*?)(?=\n\s*(?:OPTIONAL\s+MATCH|MATCH|WITH|RETURN|UNWIND|CALL|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|ORDER\s+BY|LIMIT|SKIP|UNION)\b|$)/gi;

    let touched = false;
    const rewritten = query.replace(matchSegmentRegex, (segment) => {
      const vars = this.extractMatchVariables(segment);
      if (!vars.length) {
        return segment;
      }

      const predicate = this.buildTemporalPredicateForVars(vars);
      if (!predicate) {
        return segment;
      }

      touched = true;
      const inlineClauseRegex =
        /\b(?:WITH|RETURN|UNWIND|CALL|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|ORDER\s+BY|LIMIT|SKIP|UNION)\b/i;
      const boundaryIndex = segment.search(inlineClauseRegex);
      const whereMatch = /\bWHERE\b/i.exec(segment);

      if (whereMatch) {
        if (boundaryIndex > whereMatch.index) {
          const head = segment.slice(0, boundaryIndex).trimEnd();
          const tail = segment.slice(boundaryIndex).trimStart();
          return `${head} AND ${predicate}\n${tail}`;
        }
        return `${segment} AND ${predicate}`;
      }

      if (boundaryIndex > 0) {
        const head = segment.slice(0, boundaryIndex).trimEnd();
        const tail = segment.slice(boundaryIndex).trimStart();
        return `${head} WHERE ${predicate}\n${tail}`;
      }

      return `${segment}\nWHERE ${predicate}`;
    });

    return touched ? rewritten : query;
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
      mode = "local",
    } = args;

    try {
      let result;
      const { projectId, workspaceRoot } = this.getActiveProjectContext();
      const asOfTs = this.toEpochMillis(asOf);
      const queryMode = mode === "global" || mode === "hybrid" ? mode : "local";

      if (language === "cypher") {
        const cypherQuery =
          asOfTs !== null ? this.applyTemporalFilterToCypher(query) : query;

        result =
          asOfTs !== null
            ? await this.context.memgraph.executeCypher(cypherQuery, {
                asOfTs,
              })
            : await this.context.memgraph.executeCypher(cypherQuery);
      } else {
        if (queryMode === "global" || queryMode === "hybrid") {
          const globalRows = await this.fetchGlobalCommunityRows(
            query,
            projectId,
            limit,
          );

          if (queryMode === "global") {
            result = { data: globalRows };
          } else {
            const localResults = await this.hybridRetriever!.retrieve({
              query,
              projectId,
              limit,
              mode: "hybrid",
            });
            const filteredLocal = this.filterTemporalResults(
              localResults,
              asOfTs,
            );
            result = {
              data: [
                {
                  section: "global",
                  communities: globalRows,
                },
                {
                  section: "local",
                  results: filteredLocal,
                },
              ],
            };
          }
        } else {
          const localResults = await this.hybridRetriever!.retrieve({
            query,
            projectId,
            limit,
            mode: "hybrid",
          });
          const filteredLocal = this.filterTemporalResults(
            localResults,
            asOfTs,
          );
          result = { data: filteredLocal };
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
          mode: queryMode,
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

  private filterTemporalResults(
    rows: Array<{ nodeId?: string }>,
    asOfTs?: number | null,
  ): Array<{ nodeId?: string }> {
    if (asOfTs === null || asOfTs === undefined) {
      return rows;
    }

    return rows.filter((row) => {
      if (!row.nodeId) {
        return true;
      }

      const node = this.context.index.getNode(row.nodeId);
      const validFrom = Number(node?.properties?.validFrom);
      const validToRaw = node?.properties?.validTo;
      const validTo =
        validToRaw === null || validToRaw === undefined
          ? undefined
          : Number(validToRaw);

      if (!Number.isFinite(validFrom)) {
        return true;
      }

      return (
        validFrom <= asOfTs &&
        (!Number.isFinite(validTo) ||
          (validTo !== undefined && validTo > asOfTs))
      );
    });
  }

  private async fetchGlobalCommunityRows(
    query: string,
    projectId: string,
    limit: number,
  ): Promise<any[]> {
    const keywordHint = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .find((token) => token.length >= 4);

    const params: Record<string, unknown> = {
      projectId,
      limit,
      keywordHint: keywordHint || null,
      labels: this.deriveLabelHints(query),
    };

    const scoped = await this.context.memgraph.executeCypher(
      `MATCH (c:COMMUNITY {projectId: $projectId})
       WHERE ($keywordHint IS NOT NULL AND toLower(c.summary) CONTAINS $keywordHint)
          OR toLower(c.label) IN $labels
       RETURN c.id AS id, c.label AS label, c.summary AS summary, c.memberCount AS memberCount
       ORDER BY c.memberCount DESC
       LIMIT $limit`,
      params,
    );

    if (scoped.data.length > 0) {
      return scoped.data;
    }

    const fallback = await this.context.memgraph.executeCypher(
      `MATCH (c:COMMUNITY {projectId: $projectId})
       RETURN c.id AS id, c.label AS label, c.summary AS summary, c.memberCount AS memberCount
       ORDER BY c.memberCount DESC
       LIMIT $limit`,
      { projectId, limit },
    );

    return fallback.data;
  }

  private deriveLabelHints(query: string): string[] {
    const raw = query.toLowerCase();
    const hints = ["tools", "engines", "graph", "parsers", "vector", "config"];
    return hints.filter((hint) => raw.includes(hint));
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

      const postActions: Record<string, unknown> = {};
      if (String(status || "").toLowerCase() === "completed") {
        const sessionId = this.getCurrentSessionId() || "session-unknown";
        const runtimeAgentId = String(
          assignee ||
            args?.agentId ||
            process.env.CODE_GRAPH_AGENT_ID ||
            "agent-local",
        );
        const { projectId } = this.getActiveProjectContext();

        try {
          await this.coordinationEngine!.onTaskCompleted(
            String(taskId),
            runtimeAgentId,
            projectId,
          );
          postActions.claimsReleased = true;
        } catch (error) {
          postActions.claimsReleased = false;
          postActions.claimReleaseError = String(error);
        }

        try {
          const reflection = await this.episodeEngine!.reflect({
            taskId: String(taskId),
            agentId: runtimeAgentId,
            projectId,
            limit: 20,
          });
          postActions.reflection = {
            reflectionId: reflection.reflectionId,
            learningsCreated: reflection.learningsCreated,
          };
        } catch (error) {
          postActions.reflectionError = String(error);
        }

        try {
          const decisionEpisodeId = await this.episodeEngine!.add(
            {
              type: "DECISION",
              content:
                `Task ${taskId} marked completed. ${notes ? `Notes: ${String(notes)}` : ""}`.trim(),
              taskId: String(taskId),
              outcome: "success",
              agentId: runtimeAgentId,
              sessionId,
              metadata: {
                source: "task_update",
                status: String(status),
              },
            },
            projectId,
          );
          postActions.decisionEpisodeId = decisionEpisodeId;
        } catch (error) {
          postActions.decisionEpisodeError = String(error);
        }
      }

      return this.formatSuccess(
        { success: true, task: updated, notes, postActions },
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
      await this.startActiveWatcher(nextContext);

      const watcher = this.getActiveWatcher();

      return this.formatSuccess(
        {
          success: true,
          projectContext: this.getActiveProjectContext(),
          watcherEnabled: this.watcherEnabledForRuntime(),
          watcherState: (watcher?.state || "not_started") as
            | WatcherState
            | "not_started",
          pendingChanges: watcher?.pendingChanges ?? 0,
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
    const { mode = "incremental", verbose = false, profile = "compact", indexDocs = true } = args;

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
          indexDocs,
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
        .then(async () => {
          const invalidated =
            await this.coordinationEngine!.invalidateStaleClaims(projectId);
          if (invalidated > 0) {
            console.error(
              `[coordination] Invalidated ${invalidated} stale claim(s) post-rebuild for project ${projectId}`,
            );
          }

          if (mode === "full") {
            const bm25Result = await this.hybridRetriever?.ensureBM25Index();
            if (bm25Result?.created) {
              console.error(
                `[bm25] Created text_search symbol_index for project ${projectId}`,
              );
            } else if (bm25Result?.error) {
              console.error(
                `[bm25] symbol_index unavailable: ${bm25Result.error}`,
              );
            }

            const communityRun = await this.communityDetector!.run(projectId);
            console.error(
              `[community] ${communityRun.mode}: ${communityRun.communities} communities across ${communityRun.members} member node(s) for project ${projectId}`,
            );
          }
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
      const watcher = this.getActiveWatcher();

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
          retrieval: {
            bm25IndexExists: this.hybridRetriever?.bm25Mode === "native",
            mode: this.hybridRetriever?.bm25Mode ?? "not_initialized",
          },
          summarizer: {
            configured: !!process.env.CODE_GRAPH_SUMMARIZER_URL,
            endpoint: process.env.CODE_GRAPH_SUMMARIZER_URL
              ? "[configured]"
              : null,
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
          pendingChanges: watcher?.pendingChanges ?? 0,
          watcherState: watcher?.state || "not_started",
        },
        profile,
        "Graph health is OK.",
        "graph_health",
      );
    } catch (error) {
      return this.errorEnvelope("GRAPH_HEALTH_FAILED", String(error), true);
    }
  }

  async diff_since(args: any): Promise<string> {
    const {
      since,
      types = ["FILE", "FUNCTION", "CLASS"],
      profile = "compact",
    } = args || {};

    if (!since || typeof since !== "string") {
      return this.errorEnvelope(
        "DIFF_SINCE_INVALID_INPUT",
        "Field 'since' is required and must be a string.",
        true,
        "Provide txId, ISO timestamp, git commit SHA, or agentId.",
      );
    }

    try {
      const active = this.getActiveProjectContext();
      const projectId =
        typeof args?.projectId === "string" && args.projectId.trim().length > 0
          ? args.projectId
          : active.projectId;

      const normalizedTypes = Array.isArray(types)
        ? types
            .map((item) => String(item).toUpperCase())
            .filter((item) => ["FILE", "FUNCTION", "CLASS"].includes(item))
        : ["FILE", "FUNCTION", "CLASS"];

      if (!normalizedTypes.length) {
        return this.errorEnvelope(
          "DIFF_SINCE_INVALID_TYPES",
          "Field 'types' must include at least one of FILE, FUNCTION, CLASS.",
          true,
        );
      }

      const anchor = await this.resolveSinceAnchor(since, projectId);
      if (!anchor) {
        return this.errorEnvelope(
          "DIFF_SINCE_ANCHOR_NOT_FOUND",
          `Unable to resolve 'since' anchor: ${since}`,
          true,
          "Use a known txId, ISO timestamp, git commit SHA, or agentId with recorded GRAPH_TX entries.",
        );
      }

      const txResult = await this.context.memgraph.executeCypher(
        `MATCH (tx:GRAPH_TX {projectId: $projectId})
         WHERE tx.timestamp >= $sinceTs
         RETURN tx.id AS id
         ORDER BY tx.timestamp ASC`,
        { projectId, sinceTs: anchor.sinceTs },
      );
      const txIds = (txResult.data || [])
        .map((row) => String(row.id || ""))
        .filter(Boolean);

      const addedResult = await this.context.memgraph.executeCypher(
        `MATCH (n)
         WHERE n.projectId = $projectId
           AND labels(n)[0] IN $types
           AND n.validFrom IS NOT NULL
           AND n.validFrom >= $sinceTs
         RETURN labels(n)[0] AS type,
                n.id AS scip_id,
                coalesce(n.path, n.relativePath, '') AS path,
                n.name AS symbolName,
                n.validFrom AS validFrom,
                n.validTo AS validTo
         ORDER BY n.validFrom DESC
         LIMIT 500`,
        { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
      );

      const removedResult = await this.context.memgraph.executeCypher(
        `MATCH (n)
         WHERE n.projectId = $projectId
           AND labels(n)[0] IN $types
           AND n.validTo IS NOT NULL
           AND n.validTo >= $sinceTs
         RETURN labels(n)[0] AS type,
                n.id AS scip_id,
                coalesce(n.path, n.relativePath, '') AS path,
                n.name AS symbolName,
                n.validFrom AS validFrom,
                n.validTo AS validTo
         ORDER BY n.validTo DESC
         LIMIT 500`,
        { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
      );

      const modifiedResult = await this.context.memgraph.executeCypher(
        `MATCH (newer)
         WHERE newer.projectId = $projectId
           AND labels(newer)[0] IN $types
           AND newer.validFrom IS NOT NULL
           AND newer.validFrom >= $sinceTs
         MATCH (older)
         WHERE older.projectId = $projectId
           AND labels(older)[0] IN $types
           AND older.id = newer.id
           AND older.validTo IS NOT NULL
           AND older.validTo >= $sinceTs
         RETURN DISTINCT labels(newer)[0] AS type,
                newer.id AS scip_id,
                coalesce(newer.path, newer.relativePath, '') AS path,
                newer.name AS symbolName,
                newer.validFrom AS validFrom,
                newer.validTo AS validTo
         ORDER BY validFrom DESC
         LIMIT 500`,
        { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
      );

      const mapDelta = (rows: any[]) =>
        (rows || []).map((row) => ({
          scip_id: String(row.scip_id || ""),
          type: String(row.type || "UNKNOWN"),
          path: String(row.path || ""),
          symbolName: row.symbolName ? String(row.symbolName) : undefined,
          validFrom: this.toSafeNumber(row.validFrom),
          validTo: this.toSafeNumber(row.validTo) ?? undefined,
        }));

      const added = mapDelta(addedResult.data || []);
      const removed = mapDelta(removedResult.data || []);
      const modified = mapDelta(modifiedResult.data || []);

      const summary = `${added.length} added, ${removed.length} removed, ${modified.length} modified since ${anchor.anchorValue}.`;

      return this.formatSuccess(
        {
          summary,
          projectId,
          since: {
            input: since,
            resolvedMode: anchor.mode,
            resolvedTimestamp: anchor.sinceTs,
          },
          added,
          removed,
          modified,
          txIds,
        },
        profile,
        summary,
        "diff_since",
      );
    } catch (error) {
      return this.errorEnvelope("DIFF_SINCE_FAILED", String(error), true);
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

    const normalizedType = String(type).toUpperCase();
    const normalizedEntities = Array.isArray(entities)
      ? entities.map((item) => String(item))
      : [];
    const normalizedMetadata =
      metadata && typeof metadata === "object" ? metadata : undefined;
    const validationError = this.validateEpisodeInput({
      type: normalizedType,
      outcome,
      entities: normalizedEntities,
      metadata: normalizedMetadata,
    });
    if (validationError) {
      return this.errorEnvelope(
        "EPISODE_ADD_INVALID_METADATA",
        validationError,
        true,
      );
    }

    try {
      const contextSessionId = this.getCurrentSessionId() || "session-unknown";
      const runtimeAgentId = String(
        agentId || process.env.CODE_GRAPH_AGENT_ID || "agent-local",
      );
      const { projectId } = this.getActiveProjectContext();

      const episodeId = await this.episodeEngine!.add(
        {
          type: normalizedType as EpisodeType,
          content: String(content),
          entities: normalizedEntities,
          taskId: taskId ? String(taskId) : undefined,
          outcome,
          metadata: normalizedMetadata,
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
      const explicitEntities = Array.isArray(entities)
        ? entities.map((item) => String(item))
        : [];
      const embeddingEntityHints = await this.inferEpisodeEntityHints(
        query,
        limit,
      );
      const mergedEntities = [
        ...new Set([...explicitEntities, ...embeddingEntityHints]),
      ];
      const episodes = await this.episodeEngine!.recall({
        query,
        projectId,
        agentId,
        taskId,
        types: Array.isArray(types)
          ? types.map((item) => String(item).toUpperCase() as EpisodeType)
          : undefined,
        entities: mergedEntities.length ? mergedEntities : undefined,
        limit,
        since: sinceMs || undefined,
      });

      return this.formatSuccess(
        {
          query,
          projectId,
          entityHints: profile === "debug" ? embeddingEntityHints : undefined,
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

  // ============================================================================
  // COORDINATION TOOLS (4)
  // ============================================================================

  async agent_claim(args: any): Promise<string> {
    const {
      targetId,
      claimType = "task",
      intent,
      taskId,
      agentId,
      sessionId,
      profile = "compact",
    } = args || {};

    if (!targetId || !intent) {
      return this.errorEnvelope(
        "AGENT_CLAIM_INVALID_INPUT",
        "Fields 'targetId' and 'intent' are required.",
        true,
      );
    }

    try {
      const runtimeSessionId = this.getCurrentSessionId() || "session-unknown";
      const runtimeAgentId = String(
        agentId || process.env.CODE_GRAPH_AGENT_ID || "agent-local",
      );
      const { projectId } = this.getActiveProjectContext();

      const result = await this.coordinationEngine!.claim({
        targetId: String(targetId),
        claimType: String(claimType).toLowerCase() as ClaimType,
        intent: String(intent),
        taskId: taskId ? String(taskId) : undefined,
        agentId: runtimeAgentId,
        sessionId: String(sessionId || runtimeSessionId),
        projectId,
      });

      return this.formatSuccess(
        {
          projectId,
          ...result,
        },
        profile,
        result.status === "CONFLICT"
          ? `Conflict detected for target ${targetId}.`
          : `Claim ${result.claimId} created for ${targetId}.`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_CLAIM_FAILED", String(error), true);
    }
  }

  async agent_release(args: any): Promise<string> {
    const { claimId, outcome, profile = "compact" } = args || {};

    if (!claimId) {
      return this.errorEnvelope(
        "AGENT_RELEASE_INVALID_INPUT",
        "Field 'claimId' is required.",
        true,
      );
    }

    try {
      await this.coordinationEngine!.release(String(claimId), outcome);

      return this.formatSuccess(
        {
          claimId: String(claimId),
          released: true,
          outcome: outcome || null,
        },
        profile,
        `Claim ${claimId} released.`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_RELEASE_FAILED", String(error), true);
    }
  }

  async agent_status(args: any): Promise<string> {
    const { agentId, profile = "compact" } = args || {};

    if (!agentId || typeof agentId !== "string") {
      return this.errorEnvelope(
        "AGENT_STATUS_INVALID_INPUT",
        "Field 'agentId' is required.",
        true,
      );
    }

    try {
      const { projectId } = this.getActiveProjectContext();
      const status = await this.coordinationEngine!.status(agentId, projectId);

      return this.formatSuccess(
        {
          projectId,
          ...status,
        },
        profile,
        `Agent ${agentId} has ${status.activeClaims.length} active claim(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_STATUS_FAILED", String(error), true);
    }
  }

  async coordination_overview(args: any): Promise<string> {
    const { profile = "compact" } = args || {};

    try {
      const { projectId } = this.getActiveProjectContext();
      const overview = await this.coordinationEngine!.overview(projectId);

      return this.formatSuccess(
        {
          projectId,
          ...overview,
        },
        profile,
        `Coordination overview: ${overview.activeClaims.length} active claim(s), ${overview.staleClaims.length} stale claim(s).`,
      );
    } catch (error) {
      return this.errorEnvelope(
        "COORDINATION_OVERVIEW_FAILED",
        String(error),
        true,
      );
    }
  }

  async context_pack(args: any): Promise<string> {
    const {
      task,
      taskId,
      agentId,
      profile = "compact",
      includeDecisions = true,
      includeLearnings = true,
      includeEpisodes = true,
    } = args || {};

    if (!task || typeof task !== "string") {
      return this.errorEnvelope(
        "CONTEXT_PACK_INVALID_INPUT",
        "Field 'task' is required.",
        true,
      );
    }

    try {
      const runtimeAgentId = String(
        agentId || process.env.CODE_GRAPH_AGENT_ID || "agent-local",
      );
      const { projectId, workspaceRoot } = this.getActiveProjectContext();

      const seedIds = this.findSeedNodeIds(task, 5);
      const expandedSeedIds = await this.expandInterfaceSeeds(
        seedIds,
        projectId,
      );
      const pprResults = await runPPR(
        {
          projectId,
          seedIds: expandedSeedIds.length ? expandedSeedIds : seedIds,
          maxResults: 60,
        },
        this.context.memgraph,
      );

      const codeCandidates = pprResults.filter((item) =>
        ["FUNCTION", "CLASS", "FILE"].includes(
          String(item.type || "").toUpperCase(),
        ),
      );
      const coreSymbols = await this.materializeCoreSymbols(
        codeCandidates,
        workspaceRoot,
      );

      const selectedIds = coreSymbols.map((item) => item.nodeId);
      const activeBlockers = await this.findActiveBlockers(
        selectedIds,
        runtimeAgentId,
        projectId,
      );
      const decisions = includeDecisions
        ? await this.findDecisionEpisodes(selectedIds, projectId)
        : [];
      const learnings = includeLearnings
        ? await this.findLearnings(selectedIds, projectId)
        : [];
      const episodes = includeEpisodes
        ? await this.findRecentEpisodes(taskId, runtimeAgentId, projectId)
        : [];

      const entryPoint =
        coreSymbols[0]?.symbolName ||
        coreSymbols[0]?.file ||
        "No entry point found";
      const summary = `Task briefing for '${task}': start at ${entryPoint}. Focus on ${coreSymbols.length} high-relevance symbol(s) and resolve ${activeBlockers.length} active blocker(s).`;

      const pack: Record<string, unknown> = {
        summary,
        entryPoint,
        task,
        taskId: taskId || null,
        projectId,
        coreSymbols,
        dependencies: coreSymbols.flatMap((item) => [
          ...item.incomingCallers.map((caller: any) => ({
            from: caller.id,
            to: item.nodeId,
            type: "CALLS",
          })),
          ...item.outgoingCalls.map((callee: any) => ({
            from: item.nodeId,
            to: callee.id,
            type: "CALLS",
          })),
        ]),
        decisions,
        learnings,
        episodes,
        activeBlockers,
        plan: taskId
          ? {
              taskId,
              status: "unknown",
              note: "Plan-node integration deferred to later phase.",
            }
          : null,
        pprScores:
          profile === "debug"
            ? Object.fromEntries(
                pprResults.map((item) => [item.nodeId, item.score]),
              )
            : undefined,
      };

      const safeProfile: ResponseProfile =
        profile === "balanced" || profile === "debug" ? profile : "compact";
      const budget = makeBudget(safeProfile);
      this.trimContextPackToBudget(pack, budget.maxTokens);
      pack.tokenEstimate = estimateTokens(pack);

      return this.formatSuccess(pack, safeProfile, summary, "context_pack");
    } catch (error) {
      return this.errorEnvelope("CONTEXT_PACK_FAILED", String(error), true);
    }
  }

  async semantic_slice(args: any): Promise<string> {
    const {
      file,
      symbol,
      query,
      context = "body",
      pprScore,
      profile = "compact",
    } = args || {};

    if (!symbol && !query && !file) {
      return this.errorEnvelope(
        "SEMANTIC_SLICE_INVALID_INPUT",
        "Provide at least one of: symbol, query, or file.",
        true,
      );
    }

    try {
      const { workspaceRoot, projectId } = this.getActiveProjectContext();
      const resolved = this.resolveSemanticSliceAnchor({ file, symbol, query });
      if (!resolved) {
        return this.errorEnvelope(
          "SEMANTIC_SLICE_NOT_FOUND",
          "Unable to resolve a symbol or file anchor for semantic slicing.",
          true,
          "Provide symbol + file for exact lookup or a more specific query.",
        );
      }

      const { node, filePath, startLine, endLine } = resolved;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath);

      const sliceContext =
        context === "signature" ||
        context === "body" ||
        context === "with-deps" ||
        context === "full"
          ? context
          : "body";

      const [rangeStart, rangeEnd] = this.computeSliceRange(
        startLine,
        endLine,
        sliceContext,
      );
      const code = this.readExactLines(absolutePath, rangeStart, rangeEnd);

      const incomingCallers =
        sliceContext === "with-deps" || sliceContext === "full"
          ? this.context.index
              .getRelationshipsTo(node.id)
              .filter((rel) => rel.type === "CALLS")
              .slice(0, 10)
              .map((rel) => ({
                id: rel.from,
                name:
                  this.context.index.getNode(rel.from)?.properties?.name ||
                  rel.from,
              }))
          : [];

      const outgoingCalls =
        sliceContext === "with-deps" || sliceContext === "full"
          ? this.context.index
              .getRelationshipsFrom(node.id)
              .filter((rel) => rel.type === "CALLS")
              .slice(0, 10)
              .map((rel) => ({
                id: rel.to,
                name:
                  this.context.index.getNode(rel.to)?.properties?.name ||
                  rel.to,
              }))
          : [];

      const includeKnowledge = sliceContext === "full";
      const decisions = includeKnowledge
        ? await this.findDecisionEpisodes([node.id], projectId)
        : [];
      const learnings = includeKnowledge
        ? await this.findLearnings([node.id], projectId)
        : [];

      const response = {
        file: filePath,
        startLine: rangeStart,
        endLine: rangeEnd,
        code,
        symbolName: String(node.properties.name || path.basename(filePath)),
        pprScore: typeof pprScore === "number" ? pprScore : undefined,
        incomingCallers,
        outgoingCalls,
        relevantDecisions: decisions,
        relevantLearnings: learnings,
        validFrom: node.properties.validFrom || null,
        context: sliceContext,
        projectId,
      };

      const summary = `Semantic slice resolved ${response.symbolName} in ${response.file}:${response.startLine}-${response.endLine}.`;

      return this.formatSuccess(response, profile, summary, "semantic_slice");
    } catch (error) {
      return this.errorEnvelope("SEMANTIC_SLICE_FAILED", String(error), true);
    }
  }

  private findSeedNodeIds(task: string, limit: number): string[] {
    const tokens = task
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3);

    const candidates = [
      ...this.context.index.getNodesByType("FUNCTION"),
      ...this.context.index.getNodesByType("CLASS"),
      ...this.context.index.getNodesByType("FILE"),
    ];

    const scored = candidates
      .map((node) => {
        const haystack =
          `${node.id} ${node.properties.name || ""} ${node.properties.path || ""}`.toLowerCase();
        const score = tokens.reduce(
          (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
          0,
        );
        return { nodeId: node.id, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = scored.filter((item) => item.score > 0).slice(0, limit);
    if (selected.length) {
      return selected.map((item) => item.nodeId);
    }

    return candidates.slice(0, limit).map((node) => node.id);
  }

  private async expandInterfaceSeeds(
    seedIds: string[],
    projectId: string,
  ): Promise<string[]> {
    if (!seedIds.length) {
      return [];
    }

    const expanded = new Set(seedIds);
    const relationExpansion = await this.context.memgraph.executeCypher(
      `MATCH (iface {projectId: $projectId})
       WHERE iface.id IN $seedIds
         AND (toLower(coalesce(iface.kind, '')) IN ['interface', 'abstract'])
       OPTIONAL MATCH (iface)-[:IMPLEMENTED_BY]->(impl {projectId: $projectId})
       RETURN collect(DISTINCT impl.id) AS implIds`,
      { projectId, seedIds },
    );

    const implIds = relationExpansion.data?.[0]?.implIds;
    if (Array.isArray(implIds)) {
      for (const implId of implIds) {
        if (implId) {
          expanded.add(String(implId));
        }
      }
    }

    return [...expanded];
  }

  private async materializeCoreSymbols(
    pprResults: Array<{ nodeId: string; score: number }>,
    workspaceRoot: string,
  ): Promise<any[]> {
    const maxSymbols = 8;
    const selected = pprResults.slice(0, maxSymbols);
    const slices: any[] = [];

    for (const item of selected) {
      const resolved = this.resolveNodeForSlice(item.nodeId);
      if (!resolved) {
        continue;
      }

      const { node, filePath, startLine, endLine } = resolved;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath);

      const code = this.readCodeSnippet(absolutePath, startLine, endLine, 800);
      const incomingCallers = this.context.index
        .getRelationshipsTo(node.id)
        .filter((rel) => rel.type === "CALLS")
        .slice(0, 5)
        .map((rel) => ({ id: rel.from }));
      const outgoingCalls = this.context.index
        .getRelationshipsFrom(node.id)
        .filter((rel) => rel.type === "CALLS")
        .slice(0, 5)
        .map((rel) => ({ id: rel.to }));

      slices.push({
        nodeId: node.id,
        file: filePath,
        startLine,
        endLine,
        code,
        symbolName: String(node.properties.name || path.basename(filePath)),
        pprScore: Number(item.score.toFixed(6)),
        incomingCallers,
        outgoingCalls,
        validFrom: node.properties.validFrom || null,
        relevantDecisions: [],
        relevantLearnings: [],
      });
    }

    return slices;
  }

  private resolveNodeForSlice(nodeId: string): {
    node: GraphNode;
    filePath: string;
    startLine: number;
    endLine: number;
  } | null {
    const node = this.context.index.getNode(nodeId);
    if (!node) {
      return null;
    }

    let filePath = String(
      node.properties.path || node.properties.filePath || "",
    );
    if (!filePath) {
      const parents = this.context.index
        .getRelationshipsTo(node.id)
        .filter((rel) => rel.type === "CONTAINS");
      const fileNode = parents
        .map((rel) => this.context.index.getNode(rel.from))
        .find((candidate) => candidate?.type === "FILE");
      filePath = String(
        fileNode?.properties.path || fileNode?.properties.filePath || "",
      );
    }

    if (!filePath) {
      filePath = node.id;
    }

    const startLine = Number(
      node.properties.startLine || node.properties.line || 1,
    );
    const endLine = Number(node.properties.endLine || startLine + 40);

    return {
      node,
      filePath,
      startLine,
      endLine,
    };
  }

  private readCodeSnippet(
    absolutePath: string,
    startLine: number,
    endLine: number,
    maxChars: number,
  ): string {
    try {
      if (!fs.existsSync(absolutePath)) {
        return "";
      }
      const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
      const snippet = lines
        .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
        .join("\n");
      return snippet.length > maxChars
        ? `${snippet.slice(0, maxChars - 3)}...`
        : snippet;
    } catch {
      return "";
    }
  }

  private async findActiveBlockers(
    selectedIds: string[],
    requestingAgentId: string,
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const blockers = await this.context.memgraph.executeCypher(
      `MATCH (c:CLAIM)-[:TARGETS]->(t)
       WHERE c.projectId = $projectId
         AND t.projectId = $projectId
         AND c.validTo IS NULL
         AND t.id IN $selectedIds
         AND c.agentId <> $requestingAgentId
       RETURN c.id AS claimId, c.agentId AS agentId, c.intent AS intent, t.id AS targetId, c.validFrom AS since
       ORDER BY c.validFrom DESC
       LIMIT 20`,
      { projectId, selectedIds, requestingAgentId },
    );

    return (blockers.data || []).map((row) => ({
      claimId: String(row.claimId || ""),
      agentId: String(row.agentId || "unknown"),
      intent: String(row.intent || ""),
      targetId: String(row.targetId || ""),
      since: Number(row.since || Date.now()),
    }));
  }

  private async findDecisionEpisodes(
    selectedIds: string[],
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (e:EPISODE {projectId: $projectId, type: 'DECISION'})-[:INVOLVES]->(n)
       WHERE n.projectId = $projectId AND n.id IN $selectedIds
       RETURN e.id AS id, e.content AS content, e.timestamp AS timestamp
       ORDER BY e.timestamp DESC
       LIMIT 10`,
      { projectId, selectedIds },
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      content: String(row.content || ""),
      timestamp: Number(row.timestamp || Date.now()),
    }));
  }

  private async findLearnings(
    selectedIds: string[],
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (l:LEARNING {projectId: $projectId})-[:APPLIES_TO]->(n)
       WHERE n.projectId = $projectId AND n.id IN $selectedIds
       RETURN l.id AS id, l.content AS content, l.confidence AS confidence
       ORDER BY l.confidence DESC
       LIMIT 10`,
      { projectId, selectedIds },
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      content: String(row.content || ""),
      confidence: Number(row.confidence || 0),
    }));
  }

  private async findRecentEpisodes(
    taskId: string | undefined,
    agentId: string,
    projectId: string,
  ): Promise<any[]> {
    const conditions: string[] = ["e.projectId = $projectId"];
    const params: Record<string, unknown> = { projectId };

    if (taskId) {
      conditions.push("e.taskId = $taskId");
      params.taskId = taskId;
    } else {
      conditions.push("e.agentId = $agentId");
      params.agentId = agentId;
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (e:EPISODE)
       WHERE ${conditions.join(" AND ")}
       RETURN e.id AS id, e.type AS type, e.content AS content, e.timestamp AS timestamp
       ORDER BY e.timestamp DESC
       LIMIT 10`,
      params,
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      type: String(row.type || "OBSERVATION"),
      content: String(row.content || ""),
      timestamp: Number(row.timestamp || Date.now()),
    }));
  }

  private trimContextPackToBudget(
    pack: Record<string, any>,
    budget: number,
  ): void {
    if (!Number.isFinite(budget)) {
      return;
    }

    const pruneStep = () => {
      if (Array.isArray(pack.coreSymbols) && pack.coreSymbols.length > 1) {
        pack.coreSymbols.pop();
        return true;
      }
      if (Array.isArray(pack.decisions) && pack.decisions.length > 2) {
        pack.decisions.pop();
        return true;
      }
      if (Array.isArray(pack.learnings) && pack.learnings.length > 2) {
        pack.learnings.pop();
        return true;
      }
      if (Array.isArray(pack.episodes) && pack.episodes.length > 2) {
        pack.episodes.pop();
        return true;
      }
      if (Array.isArray(pack.coreSymbols)) {
        for (const symbol of pack.coreSymbols) {
          if (typeof symbol.code === "string" && symbol.code.length > 220) {
            symbol.code = `${symbol.code.slice(0, 217)}...`;
            return true;
          }
        }
      }
      return false;
    };

    let estimated = estimateTokens(pack);
    let guard = 0;
    while (estimated > budget && guard < 200) {
      const changed = pruneStep();
      if (!changed) {
        break;
      }
      estimated = estimateTokens(pack);
      guard += 1;
    }
  }

  private resolveSemanticSliceAnchor(input: {
    file?: string;
    symbol?: string;
    query?: string;
  }): {
    node: GraphNode;
    filePath: string;
    startLine: number;
    endLine: number;
  } | null {
    const normalizedFile = input.file ? String(input.file) : undefined;
    const normalizedSymbol = input.symbol ? String(input.symbol) : undefined;

    if (normalizedSymbol?.includes("::")) {
      const exact = this.resolveNodeForSlice(normalizedSymbol);
      if (exact) {
        return exact;
      }
    }

    if (normalizedSymbol && normalizedFile) {
      const fileNode = this.context.index
        .getNodesByType("FILE")
        .find((candidate) => {
          const candidatePath = String(
            candidate.properties.path || candidate.properties.filePath || "",
          );
          return (
            candidatePath === normalizedFile ||
            candidatePath.endsWith(normalizedFile) ||
            normalizedFile.endsWith(candidatePath)
          );
        });

      if (fileNode) {
        const childIds = this.context.index
          .getRelationshipsFrom(fileNode.id)
          .filter((rel) => rel.type === "CONTAINS")
          .map((rel) => rel.to);
        const targetName =
          normalizedSymbol.split(".").pop() || normalizedSymbol;
        const child = childIds
          .map((id) => this.context.index.getNode(id))
          .find((node) => node?.properties?.name === targetName);
        if (child) {
          return this.resolveNodeForSlice(child.id);
        }
      }
    }

    if (normalizedSymbol) {
      const targetName = normalizedSymbol.split(".").pop() || normalizedSymbol;
      const direct = [
        ...this.context.index.getNodesByType("FUNCTION"),
        ...this.context.index.getNodesByType("CLASS"),
        ...this.context.index.getNodesByType("FILE"),
      ].find((node) => {
        const name = String(node.properties.name || node.properties.path || "");
        return name === targetName || name.includes(targetName);
      });

      if (direct) {
        return this.resolveNodeForSlice(direct.id);
      }
    }

    if (input.query) {
      const fallbackId = this.findSeedNodeIds(String(input.query), 1)[0];
      if (fallbackId) {
        return this.resolveNodeForSlice(fallbackId);
      }
    }

    if (normalizedFile) {
      const fileNode = this.context.index
        .getNodesByType("FILE")
        .find((candidate) => {
          const candidatePath = String(
            candidate.properties.path || candidate.properties.filePath || "",
          );
          return (
            candidatePath === normalizedFile ||
            candidatePath.endsWith(normalizedFile) ||
            normalizedFile.endsWith(candidatePath)
          );
        });
      if (fileNode) {
        return this.resolveNodeForSlice(fileNode.id);
      }
    }

    return null;
  }

  private computeSliceRange(
    startLine: number,
    endLine: number,
    context: "signature" | "body" | "with-deps" | "full",
  ): [number, number] {
    if (context === "signature") {
      return [startLine, startLine];
    }
    return [startLine, Math.max(startLine, endLine)];
  }

  private readExactLines(
    absolutePath: string,
    startLine: number,
    endLine: number,
  ): string {
    if (!fs.existsSync(absolutePath)) {
      return "";
    }
    const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
    return lines
      .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
      .join("\n");
  }

  // ── Docs/ADR tools ───────────────────────────────────────────────────────────

  async index_docs(args: any): Promise<string> {
    const { workspaceRoot: argsRoot, projectId: argsProject, incremental = true, withEmbeddings = false } = args ?? {};
    try {
      const { workspaceRoot, projectId } = this.resolveProjectContext({
        workspaceRoot: argsRoot,
        projectId: argsProject,
      });
      if (!this.docsEngine) {
        return this.errorEnvelope("ENGINE_UNAVAILABLE", "DocsEngine not initialised", false);
      }
      const result = await this.docsEngine.indexWorkspace(workspaceRoot, projectId, {
        incremental,
        withEmbeddings,
      });
      return this.formatSuccess(
        {
          ok: true,
          indexed: result.indexed,
          skipped: result.skipped,
          errorCount: result.errors.length,
          errors: result.errors.slice(0, 10),
          durationMs: result.durationMs,
          projectId,
          workspaceRoot,
        },
        "compact",
      );
    } catch (err) {
      return this.errorEnvelope(
        "INDEX_DOCS_ERROR",
        err instanceof Error ? err.message : String(err),
        true,
      );
    }
  }

  async search_docs(args: any): Promise<string> {
    const { query, symbol, limit = 10, projectId: argsProject } = args ?? {};
    try {
      const { projectId } = this.resolveProjectContext({ projectId: argsProject });
      if (!this.docsEngine) {
        return this.errorEnvelope("ENGINE_UNAVAILABLE", "DocsEngine not initialised", false);
      }
      let results;
      if (typeof symbol === "string" && symbol.trim().length > 0) {
        results = await this.docsEngine.getDocsBySymbol(symbol.trim(), projectId, { limit });
      } else if (typeof query === "string" && query.trim().length > 0) {
        results = await this.docsEngine.searchDocs(query.trim(), projectId, { limit });
      } else {
        return this.errorEnvelope(
          "MISSING_PARAM",
          "Provide either `query` (full-text search) or `symbol` (symbol lookup)",
          true,
        );
      }
      return this.formatSuccess(
        {
          ok: true,
          count: results.length,
          results: results.map((r) => ({
            heading: r.heading,
            doc: r.docRelativePath,
            kind: r.kind,
            startLine: r.startLine,
            score: r.score,
            excerpt: r.content.slice(0, 200),
          })),
          projectId,
        },
        "compact",
      );
    } catch (err) {
      return this.errorEnvelope(
        "SEARCH_DOCS_ERROR",
        err instanceof Error ? err.message : String(err),
        true,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // ref_query — query a reference repository on the same machine
  // ──────────────────────────────────────────────────────────────────────────

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
      return this.errorEnvelope(
        "REF_REPO_MISSING",
        "repoPath is required",
        false,
        "Provide the absolute path to the reference repository on this machine.",
      );
    }

    const resolvedRepo = path.resolve(repoPath);
    if (!fs.existsSync(resolvedRepo)) {
      return this.errorEnvelope(
        "REF_REPO_NOT_FOUND",
        `Path does not exist: ${resolvedRepo}`,
        false,
        "Ensure the repository is cloned and the path is accessible from this machine/container.",
      );
    }

    try {
      const repoName = path.basename(resolvedRepo);
      const findings: any[] = [];

      // Determine effective mode
      const effectiveMode =
        mode === "auto" ? this.inferRefMode(query, symbol) : mode;

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
              const score = this.scoreRefSection(sec, queryTerms, symbol);
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
        const sourceFiles = this.scanRefSourceFiles(resolvedRepo, sourceExts);
        const queryTerms = query
          .toLowerCase()
          .split(/\s+/)
          .filter((t: string) => t.length > 2);

        for (const filePath of sourceFiles.slice(0, 120)) {
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const relPath = path.relative(resolvedRepo, filePath);
            const score = this.scoreRefCode(
              content,
              queryTerms,
              symbol,
              relPath,
            );
            if (score > 0) {
              const excerpt = this.extractRefExcerpt(
                content,
                queryTerms,
                symbol,
                6,
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
        const tree = this.buildRefDirTree(resolvedRepo, 3);
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

      return this.formatSuccess(
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
        "ref_query",
      );
    } catch (error) {
      return this.errorEnvelope(
        "REF_QUERY_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  // ── private helpers for ref_query ────────────────────────────────────────

  private inferRefMode(
    query: string,
    symbol?: string,
  ): "docs" | "code" | "architecture" | "patterns" | "all" {
    if (symbol) return "code";
    const lower = (query || "").toLowerCase();
    if (
      /(architect|structure|pattern|design|layer|module|overview|convention|best.?practice)/.test(
        lower,
      )
    )
      return "architecture";
    if (/(how to|example|guide|decision|adr|changelog)/.test(lower))
      return "docs";
    if (
      /(function|class|method|import|export|interface|type|impl|usage)/.test(
        lower,
      )
    )
      return "code";
    return "all";
  }

  private scoreRefSection(
    section: ParsedSection,
    queryTerms: string[],
    symbol?: string,
  ): number {
    let score = 0;
    const text = `${section.heading} ${section.content}`.toLowerCase();
    for (const term of queryTerms) {
      const re = new RegExp(
        term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "g",
      );
      const count = (text.match(re) ?? []).length;
      if (count > 0) {
        score +=
          count *
          (section.heading.toLowerCase().includes(term) ? 3 : 1);
      }
    }
    if (symbol) {
      const symLower = symbol.toLowerCase();
      if (
        section.backtickRefs.some((r) =>
          r.toLowerCase().includes(symLower),
        )
      )
        score += 10;
      else if (text.includes(symLower)) score += 5;
    }
    return score;
  }

  private scoreRefCode(
    content: string,
    queryTerms: string[],
    symbol: string | undefined,
    relPath: string,
  ): number {
    let score = 0;
    const lower = content.toLowerCase();
    const pathLower = relPath.toLowerCase();
    for (const term of queryTerms) {
      const re = new RegExp(
        term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "g",
      );
      const count = (lower.match(re) ?? []).length;
      score += count;
      if (pathLower.includes(term)) score += 3;
    }
    if (symbol) {
      const symLower = symbol.toLowerCase();
      const symCount = (
        lower.match(
          new RegExp(
            symLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "g",
          ),
        ) ?? []
      ).length;
      score += symCount * 5;
    }
    return score;
  }

  private extractRefExcerpt(
    content: string,
    queryTerms: string[],
    symbol: string | undefined,
    contextLines: number,
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

  private scanRefSourceFiles(
    rootPath: string,
    extensions: string[],
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
            if (
              !ignoreDirs.has(entry.name) &&
              !entry.name.startsWith(".")
            ) {
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

  private buildRefDirTree(rootPath: string, maxDepth: number): any {
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

  // ──────────────────────────────────────────────────────────────────────────
  // init_project_setup — one-shot initialization: set workspace + rebuild
  // ──────────────────────────────────────────────────────────────────────────

  async init_project_setup(args: any): Promise<string> {
    const {
      workspaceRoot,
      sourceDir,
      projectId,
      rebuildMode = "incremental",
      withDocs = true,
      profile = "compact",
    } = args ?? {};

    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      return this.errorEnvelope(
        "INIT_MISSING_WORKSPACE",
        "workspaceRoot is required",
        false,
        "Provide the absolute path to the project you want to initialize.",
      );
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedRoot)) {
      return this.errorEnvelope(
        "INIT_WORKSPACE_NOT_FOUND",
        `Workspace path does not exist: ${resolvedRoot}`,
        false,
        "Ensure the project is accessible from this machine/container.",
      );
    }

    const steps: Array<{ step: string; status: string; detail?: string }> = [];

    try {
      // Step 1 — graph_set_workspace
      const setArgs: any = { workspaceRoot: resolvedRoot, profile };
      if (sourceDir) setArgs.sourceDir = sourceDir;
      if (projectId) setArgs.projectId = projectId;

      let setResult: string;
      try {
        setResult = await this.graph_set_workspace(setArgs);
        const setJson = JSON.parse(setResult);
        if (setJson?.error) {
          steps.push({ step: "graph_set_workspace", status: "failed", detail: setJson.error });
          return this.formatSuccess({ steps, abortedAt: "graph_set_workspace" }, profile, "Initialization aborted at workspace setup", "init_project_setup");
        }
        const ctx = setJson?.data?.projectContext ?? setJson?.data ?? {};
        steps.push({ step: "graph_set_workspace", status: "ok", detail: `projectId=${ctx.projectId ?? "?"}, sourceDir=${ctx.sourceDir ?? "?"}` });
      } catch (err) {
        steps.push({ step: "graph_set_workspace", status: "failed", detail: String(err) });
        return this.formatSuccess({ steps, abortedAt: "graph_set_workspace" }, profile, "Initialization aborted at workspace setup", "init_project_setup");
      }

      // Step 2 — graph_rebuild
      const rebuildArgs: any = {
        workspaceRoot: resolvedRoot,
        mode: rebuildMode,
        indexDocs: withDocs,
        profile,
      };
      if (sourceDir) rebuildArgs.sourceDir = sourceDir;
      if (projectId) rebuildArgs.projectId = projectId;

      try {
        const rebuildResult = await this.graph_rebuild(rebuildArgs);
        const rebuildJson = JSON.parse(rebuildResult);
        if (rebuildJson?.error) {
          steps.push({ step: "graph_rebuild", status: "failed", detail: rebuildJson.error });
        } else {
          steps.push({ step: "graph_rebuild", status: "queued", detail: `mode=${rebuildMode}, indexDocs=${withDocs}` });
        }
      } catch (err) {
        steps.push({ step: "graph_rebuild", status: "failed", detail: String(err) });
      }

      // Step 3 — setup_copilot_instructions (generate if not present)
      const copilotPath = path.join(resolvedRoot, ".github", "copilot-instructions.md");
      if (!fs.existsSync(copilotPath)) {
        try {
          await this.setup_copilot_instructions({
            targetPath: resolvedRoot,
            dryRun: false,
            overwrite: false,
            profile: "compact",
          });
          steps.push({ step: "setup_copilot_instructions", status: "created", detail: ".github/copilot-instructions.md" });
        } catch (err) {
          steps.push({ step: "setup_copilot_instructions", status: "skipped", detail: String(err) });
        }
      } else {
        steps.push({ step: "setup_copilot_instructions", status: "exists", detail: "File already present — skipped" });
      }

      const ctx = this.resolveProjectContext({
        workspaceRoot: resolvedRoot,
        ...(sourceDir ? { sourceDir } : {}),
        ...(projectId ? { projectId } : {}),
      });

      return this.formatSuccess(
        {
          projectId: ctx.projectId,
          workspaceRoot: ctx.workspaceRoot,
          sourceDir: ctx.sourceDir,
          steps,
          nextAction: "Call graph_health to confirm the rebuild completed, then graph_query to start exploring.",
        },
        profile,
        `Project ${ctx.projectId} initialized — graph rebuild queued`,
        "init_project_setup",
      );
    } catch (error) {
      return this.errorEnvelope(
        "INIT_PROJECT_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // setup_copilot_instructions — generate .github/copilot-instructions.md
  // ──────────────────────────────────────────────────────────────────────────

  async setup_copilot_instructions(args: any): Promise<string> {
    const {
      targetPath,
      projectName: forceProjectName,
      dryRun = false,
      overwrite = false,
      profile = "compact",
    } = args ?? {};

    // Resolve target (defaults to active workspace root)
    let resolvedTarget: string;
    if (targetPath && typeof targetPath === "string") {
      resolvedTarget = path.resolve(targetPath);
    } else {
      const ctx = this.resolveProjectContext({});
      resolvedTarget = ctx.workspaceRoot;
    }

    if (!fs.existsSync(resolvedTarget)) {
      return this.errorEnvelope(
        "COPILOT_INSTR_TARGET_NOT_FOUND",
        `Target path does not exist: ${resolvedTarget}`,
        false,
        "Provide an accessible absolute path via targetPath parameter.",
      );
    }

    const destFile = path.join(resolvedTarget, ".github", "copilot-instructions.md");
    if (fs.existsSync(destFile) && !overwrite && !dryRun) {
      return this.formatSuccess(
        {
          status: "already_exists",
          path: destFile,
          hint: "Pass overwrite=true to replace it.",
        },
        profile,
        ".github/copilot-instructions.md already exists — skipped",
        "setup_copilot_instructions",
      );
    }

    try {
      // ------ Gather project intelligence ------
      const repoName = forceProjectName || path.basename(resolvedTarget);
      const pkgPath = path.join(resolvedTarget, "package.json");
      const pkgJson: any = fs.existsSync(pkgPath)
        ? JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
        : null;

      const name = forceProjectName || pkgJson?.name || repoName;
      const description = pkgJson?.description || "";
      const deps: Record<string, string> = {
        ...(pkgJson?.dependencies ?? {}),
        ...(pkgJson?.devDependencies ?? {}),
      };

      // Detect stack
      const stack: string[] = [];
      const isTypeScript =
        fs.existsSync(path.join(resolvedTarget, "tsconfig.json")) ||
        !!deps["typescript"];
      const isNode =
        !!pkgJson ||
        fs.existsSync(path.join(resolvedTarget, "package.json"));
      const isPython =
        fs.existsSync(path.join(resolvedTarget, "pyproject.toml")) ||
        fs.existsSync(path.join(resolvedTarget, "setup.py")) ||
        fs.existsSync(path.join(resolvedTarget, "requirements.txt"));
      const isGo = fs.existsSync(path.join(resolvedTarget, "go.mod"));
      const isRust = fs.existsSync(path.join(resolvedTarget, "Cargo.toml"));
      const isJava =
        fs.existsSync(path.join(resolvedTarget, "pom.xml")) ||
        fs.existsSync(path.join(resolvedTarget, "build.gradle"));
      const isReact = !!deps["react"];
      const isNextJs = !!deps["next"];
      const isDocker =
        fs.existsSync(path.join(resolvedTarget, "Dockerfile")) ||
        fs.existsSync(path.join(resolvedTarget, "docker-compose.yml"));

      if (isTypeScript) stack.push("TypeScript");
      else if (isNode) stack.push("JavaScript / Node.js");
      if (isPython) stack.push("Python");
      if (isGo) stack.push("Go");
      if (isRust) stack.push("Rust");
      if (isJava) stack.push("Java");
      if (isNextJs) stack.push("Next.js");
      else if (isReact) stack.push("React");
      if (isDocker) stack.push("Docker");

      // Key scripts
      const scripts = pkgJson?.scripts
        ? Object.entries(pkgJson.scripts)
            .slice(0, 10)
            .map(([k, v]) => `- \`${k}\`: \`${v}\``)
            .join("\n")
        : "";

      // Detect source dir
      const candidateSrcDirs = ["src", "lib", "app", "packages", "source"];
      const srcDir =
        candidateSrcDirs.find((d) =>
          fs.existsSync(path.join(resolvedTarget, d)),
        ) ?? "src";

      // Detect key sub-dirs
      const srcPath = path.join(resolvedTarget, srcDir);
      let subDirs: string[] = [];
      if (fs.existsSync(srcPath)) {
        try {
          subDirs = fs
            .readdirSync(srcPath, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .slice(0, 10);
        } catch { /* ignore */ }
      }

      // MCP endpoint detection
      const isMcpServer =
        !!deps["@modelcontextprotocol/sdk"] ||
        fs.existsSync(path.join(resolvedTarget, "src", "mcp-server.ts")) ||
        fs.existsSync(path.join(resolvedTarget, "src", "server.ts"));

      // Compose the instructions doc
      const lines: string[] = [
        `# Copilot Instructions for ${name}`,
        "",
      ];
      if (description) {
        lines.push(description, "");
      }

      lines.push("## Primary Goal", "");
      lines.push(
        "Understand the codebase before making changes. Use graph-backed tools first for code intelligence, then fall back to file reads only when needed.",
        "",
      );

      if (stack.length > 0) {
        lines.push("## Runtime Truths", "");
        lines.push(`- **Stack**: ${stack.join(", ")}`);
        lines.push(`- **Source root**: \`${srcDir}/\``);
        if (subDirs.length > 0) {
          lines.push(`- **Key directories**: ${subDirs.map((d) => `\`${srcDir}/${d}\``).join(", ")}`);
        }
      }
      if (scripts) {
        lines.push("", "## Available Commands", "", scripts);
      }

      if (isMcpServer) {
        lines.push(
          "",
          "## Required Session Flow (HTTP)",
          "",
          "1. Send `initialize`",
          "2. Capture `mcp-session-id` from response header",
          "3. Include `mcp-session-id` on all subsequent requests",
          "4. Call `graph_set_workspace` — or use `init_project_setup` for a one-shot setup",
          "5. Call `graph_rebuild`",
          "6. Validate via `graph_health` and `graph_query`",
        );
      } else {
        lines.push(
          "",
          "## Required Session Flow",
          "",
          "1. Call `init_project_setup` with the workspace path — this sets context, triggers graph rebuild, and creates copilot instructions in one step.",
          "2. Validate with `graph_health`",
          "3. Explore with `graph_query`",
        );
      }

      lines.push(
        "",
        "## Tool Priority",
        "",
        "- Discovery/counts/listing: `graph_query`",
        "- Dependency context: `code_explain`",
        "- Architecture checks: `arch_validate`, `arch_suggest`",
        "- Test impact: `impact_analyze`, `test_select`",
        "- Similarity/search: `semantic_search`, `find_similar_code`",
        "- Reference patterns: `ref_query` — query another repo on the same machine",
        "- Docs: `search_docs`, `index_docs`",
        "- Init: `init_project_setup` — one-shot workspace initialization",
      );

      lines.push(
        "",
        "## Output Requirements",
        "",
        "Always include:",
        "",
        "1. Active context (`projectId`, `workspaceRoot`)",
        "2. Whether results are final or pending async rebuild",
        "3. The single best next action",
      );

      lines.push("", `## Source of Truth`, "", `For configuration and setup details, see \`README.md\` and \`QUICK_START.md\`.`);

      const content = lines.join("\n") + "\n";

      if (dryRun) {
        return this.formatSuccess(
          {
            dryRun: true,
            targetPath: destFile,
            content,
          },
          profile,
          "Dry run — copilot-instructions.md content generated (not written)",
          "setup_copilot_instructions",
        );
      }

      // Write the file
      const githubDir = path.join(resolvedTarget, ".github");
      if (!fs.existsSync(githubDir)) {
        fs.mkdirSync(githubDir, { recursive: true });
      }
      fs.writeFileSync(destFile, content, "utf-8");

      return this.formatSuccess(
        {
          status: "created",
          path: destFile,
          projectName: name,
          stackDetected: stack,
          overwritten: overwrite && fs.existsSync(destFile),
        },
        profile,
        `Copilot instructions written to ${path.relative(resolvedTarget, destFile)}`,
        "setup_copilot_instructions",
      );
    } catch (error) {
      return this.errorEnvelope(
        "SETUP_COPILOT_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}

export default ToolHandlers;
