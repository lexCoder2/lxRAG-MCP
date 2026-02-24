/**
 * Tool Handler Base Class
 * Shared state, interfaces, and helper methods for tool implementations
 * Phase 5: Long file decomposition - extract base infrastructure
 */

import * as fs from "fs";
import * as path from "path";
import * as env from "../env.js";
import { generateSecureId } from "../utils/validation.js";
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
import EpisodeEngine from "../engines/episode-engine.js";
import CoordinationEngine from "../engines/coordination-engine.js";
import CommunityDetector from "../engines/community-detector.js";
import HybridRetriever from "../graph/hybrid-retriever.js";
import FileWatcher from "../graph/watcher.js";
import { DocsEngine } from "../engines/docs-engine.js";

export interface ToolContext {
  index: GraphIndexManager;
  memgraph: MemgraphClient;
  config: any;
  orchestrator?: GraphOrchestrator;
}

export interface ProjectContext {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
}

/**
 * Abstract base class for tool handlers
 * Contains all shared state, session management, and helper methods
 * Subclasses (ToolHandlers) add the actual tool implementations
 */
export abstract class ToolHandlerBase {
  // ─────── Engines (Phase 4.6: Configurable, instantiated in constructor) ───────
  protected archEngine?: ArchitectureEngine;
  protected testEngine?: TestEngine;
  protected progressEngine?: ProgressEngine;
  protected orchestrator?: GraphOrchestrator;
  protected qdrant?: QdrantClient;
  protected embeddingEngine?: EmbeddingEngine;
  protected episodeEngine?: EpisodeEngine;
  protected coordinationEngine?: CoordinationEngine;
  protected communityDetector?: CommunityDetector;
  protected hybridRetriever?: HybridRetriever;
  protected docsEngine?: DocsEngine;

  // ─────── Session and Project State ─────────────────────────────────────────────
  // Phase 4.3: Per-project embedding readiness to prevent race conditions
  protected projectEmbeddingsReady = new Map<string, boolean>();
  protected lastGraphRebuildAt?: string;
  protected lastGraphRebuildMode?: "full" | "incremental";

  // Phase 4.5: Track background build errors for diagnostics
  protected backgroundBuildErrors = new Map<
    string,
    Array<{ timestamp: number; error: string; context?: string }>
  >();
  protected readonly maxBuildErrorsPerProject = 10;

  protected defaultActiveProjectContext: ProjectContext;
  protected sessionProjectContexts = new Map<string, ProjectContext>();
  protected sessionWatchers = new Map<string, FileWatcher>();

  constructor(protected context: ToolContext) {
    this.defaultActiveProjectContext = this.defaultProjectContext();
    this.initializeEngines();
    // Phase 2c: Load index from Memgraph on startup (fire and forget)
    void this.initializeIndexFromMemgraph();
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Session and Context Management
  // ──────────────────────────────────────────────────────────────────────────────

  protected getCurrentSessionId(): string | undefined {
    const sessionId = getRequestContext().sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return undefined;
    }

    return sessionId;
  }

  protected getActiveProjectContext(): ProjectContext {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      return this.defaultActiveProjectContext;
    }

    return (
      this.sessionProjectContexts.get(sessionId) ||
      this.defaultActiveProjectContext
    );
  }

  protected setActiveProjectContext(context: ProjectContext): void {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      this.defaultActiveProjectContext = context;
    } else {
      this.sessionProjectContexts.set(sessionId, context);
    }

    // Reload engines with new project context
    this.reloadEnginesForContext(context);
  }

  protected reloadEnginesForContext(context: ProjectContext): void {
    console.error(
      `[ToolHandlers] Reloading engines for project context: ${context.projectId}`,
    );

    try {
      this.progressEngine?.reload(this.context.index, context.projectId);
      this.testEngine?.reload(this.context.index, context.projectId);
      if (this.archEngine) {
        this.archEngine.reload(
          this.context.index,
          context.projectId,
          context.workspaceRoot,
        );
      }

      // Phase 4.3: Reset embedding flag per-project to prevent race conditions
      this.clearProjectEmbeddingsReady(context.projectId);
    } catch (error) {
      console.error("[ToolHandlers] Failed to reload engines:", error);
    }
  }

  protected defaultProjectContext(): ProjectContext {
    const workspaceRoot = env.LXRAG_WORKSPACE_ROOT;
    const sourceDir = env.GRAPH_SOURCE_DIR;
    const projectId = env.LXRAG_PROJECT_ID;

    return {
      workspaceRoot,
      sourceDir,
      projectId,
    };
  }

  protected resolveProjectContext(overrides: any = {}): ProjectContext {
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
        : env.LXRAG_PROJECT_ID) ||
      path.basename(workspaceRoot);

    return {
      workspaceRoot,
      sourceDir,
      projectId,
    };
  }

  protected adaptWorkspaceForRuntime(context: ProjectContext): {
    context: ProjectContext;
    usedFallback: boolean;
    fallbackReason?: string;
  } {
    if (fs.existsSync(context.workspaceRoot)) {
      return { context, usedFallback: false };
    }

    const fallbackRoot = env.LXRAG_WORKSPACE_ROOT;
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

  protected runtimePathFallbackAllowed(): boolean {
    return env.LXRAG_ALLOW_RUNTIME_PATH_FALLBACK;
  }

  protected watcherEnabledForRuntime(): boolean {
    return env.MCP_TRANSPORT === "http" || env.LXRAG_ENABLE_WATCHER;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // File Watcher Management
  // ──────────────────────────────────────────────────────────────────────────────

  protected watcherKey(): string {
    return this.getCurrentSessionId() || "__default__";
  }

  protected getActiveWatcher(): FileWatcher | undefined {
    return this.sessionWatchers.get(this.watcherKey());
  }

  protected async stopActiveWatcher(): Promise<void> {
    const key = this.watcherKey();
    const existing = this.sessionWatchers.get(key);
    if (!existing) {
      return;
    }

    await existing.stop();
    this.sessionWatchers.delete(key);
  }

  protected async startActiveWatcher(context: ProjectContext): Promise<void> {
    if (!this.watcherEnabledForRuntime()) {
      return;
    }

    await this.stopActiveWatcher();

    const watcher = new FileWatcher(
      {
        workspaceRoot: context.workspaceRoot,
        sourceDir: context.sourceDir,
        projectId: context.projectId,
        debounceMs: env.LXRAG_WATCHER_DEBOUNCE_MS,
        ignorePatterns: env.LXRAG_IGNORE_PATTERNS,
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

  // ──────────────────────────────────────────────────────────────────────────────
  // Session Lifecycle Management
  // ──────────────────────────────────────────────────────────────────────────────

  /**
   * Phase 4.1: Clean up session resources when a session ends
   * Prevents memory leaks from unbounded session map growth
   */
  async cleanupSession(sessionId: string): Promise<void> {
    if (!sessionId) return;

    try {
      // Stop watcher for this session
      const watcherKey = sessionId;
      const watcher = this.sessionWatchers.get(watcherKey);
      if (watcher) {
        await watcher.stop();
        this.sessionWatchers.delete(watcherKey);
        console.error(
          `[ToolHandlers] Session cleanup: stopped watcher for ${sessionId}`,
        );
      }

      // Remove project context for this session
      if (this.sessionProjectContexts.has(sessionId)) {
        this.sessionProjectContexts.delete(sessionId);
        console.error(
          `[ToolHandlers] Session cleanup: removed project context for ${sessionId}`,
        );
      }
    } catch (error) {
      console.error(
        `[ToolHandlers] Error cleaning up session ${sessionId}:`,
        error,
      );
    }
  }

  /**
   * Clean up all session resources
   * Called during server shutdown or restart
   */
  async cleanupAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessionProjectContexts.keys());
    const watcherKeys = Array.from(this.sessionWatchers.keys());

    // Clean up watchers
    for (const key of watcherKeys) {
      try {
        const watcher = this.sessionWatchers.get(key);
        if (watcher) {
          await watcher.stop();
        }
      } catch (error) {
        console.error(`[ToolHandlers] Error stopping watcher ${key}:`, error);
      }
    }

    this.sessionWatchers.clear();
    this.sessionProjectContexts.clear();
    console.error(
      `[ToolHandlers] Cleaned up all ${sessionIds.length} session contexts`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Engine Initialization
  // ──────────────────────────────────────────────────────────────────────────────

  protected initializeEngines(): void {
    console.error("[initializeEngines] Starting engine initialization...");
    console.error(
      `[initializeEngines] projectId=${this.defaultActiveProjectContext.projectId} workspaceRoot=${this.defaultActiveProjectContext.workspaceRoot}`,
    );
    console.error(
      `[initializeEngines] memgraphConnected=${this.context.memgraph.isConnected?.() ?? "unknown"}`,
    );

    if (this.context.config.architecture) {
      this.archEngine = new ArchitectureEngine(
        this.context.config.architecture.layers,
        this.context.config.architecture.rules,
        this.context.index,
        this.defaultActiveProjectContext.workspaceRoot,
      );
      console.error(
        `[initializeEngines] archEngine=ready layers=${this.context.config.architecture.layers?.length ?? 0}`,
      );
    } else {
      console.error(
        "[initializeEngines] archEngine=skipped (no architecture config)",
      );
    }

    this.testEngine = new TestEngine(this.context.index);
    console.error("[initializeEngines] testEngine=ready");

    this.progressEngine = new ProgressEngine(
      this.context.index,
      this.context.memgraph,
    );
    console.error("[initializeEngines] progressEngine=ready");

    this.episodeEngine = new EpisodeEngine(this.context.memgraph);
    console.error("[initializeEngines] episodeEngine=ready");

    this.coordinationEngine = new CoordinationEngine(this.context.memgraph);
    console.error("[initializeEngines] coordinationEngine=ready");

    this.communityDetector = new CommunityDetector(this.context.memgraph);
    console.error("[initializeEngines] communityDetector=ready");

    // Initialize GraphOrchestrator if not provided
    this.orchestrator =
      this.context.orchestrator ||
      new GraphOrchestrator(this.context.memgraph, false, this.context.index);
    console.error(
      `[initializeEngines] orchestrator=${this.context.orchestrator ? "provided" : "created"}`,
    );

    this.initializeVectorEngine();
    console.error("[initializeEngines] All engines initialized.");
  }

  protected initializeVectorEngine(): void {
    const host = env.QDRANT_HOST;
    const port = env.QDRANT_PORT;
    console.error(`[initializeVectorEngine] qdrant=${host}:${port}`);
    console.error(
      `[initializeVectorEngine] summarizerUrl=${env.LXRAG_SUMMARIZER_URL ?? "(not set)"}`,
    );
    this.qdrant = new QdrantClient(host, port);
    this.embeddingEngine = new EmbeddingEngine(this.context.index, this.qdrant);
    console.error("[initializeVectorEngine] embeddingEngine=created");
    this.hybridRetriever = new HybridRetriever(
      this.context.index,
      this.embeddingEngine,
      this.context.memgraph,
    );
    console.error("[initializeVectorEngine] hybridRetriever=created");
    this.docsEngine = new DocsEngine(this.context.memgraph, {
      qdrant: this.qdrant,
    });
    console.error("[initializeVectorEngine] docsEngine=created");

    void this.qdrant
      .connect()
      .then(() => {
        console.error("[initializeVectorEngine] qdrant=CONNECTED");
      })
      .catch((error: unknown) => {
        console.warn("[initializeVectorEngine] qdrant=FAILED:", String(error));
      });

    // Ensure the Memgraph text_search BM25 index exists at startup.
    // Fire-and-forget: failure is non-fatal; retrieval falls back to lexical mode.
    // Deferred with setImmediate so it runs after the current microtask queue
    // (important for test isolation — avoids polluting executeCypher call counts).
    setImmediate(() => {
      if (!this.hybridRetriever) return;
      if (!this.context.memgraph.isConnected?.()) return;
      if (typeof (this.hybridRetriever as any).ensureBM25Index !== "function")
        return;
      void this.hybridRetriever
        .ensureBM25Index()
        .then((result) => {
          if (result.created) {
            console.error("[bm25] Created text_search symbol_index at startup");
          } else if (result.error) {
            console.warn(
              `[bm25] BM25 index unavailable at startup: ${result.error}`,
            );
          }
        })
        .catch(() => {
          // Memgraph not yet connected at startup — index will be created on next rebuild
        });
    });

    if (!env.LXRAG_SUMMARIZER_URL) {
      console.warn(
        "[summarizer] LXRAG_SUMMARIZER_URL is not set. " +
          "Heuristic local summaries will be used, reducing vector search quality and " +
          "compact-profile accuracy. " +
          "Point this to an OpenAI-compatible /v1/chat/completions endpoint for production use.",
      );
    }
  }

  /**
   * Phase 2c: Load index from Memgraph on startup
   * Populates the in-memory index with data from the database
   * This enables tools to work immediately without requiring a rebuild first
   */
  protected async initializeIndexFromMemgraph(): Promise<void> {
    try {
      if (!this.context.memgraph.isConnected()) {
        console.error(
          "[Phase2c] Memgraph not connected, skipping index initialization from database",
        );
        return;
      }

      const projectId = this.defaultActiveProjectContext.projectId;
      console.error(
        `[Phase2c] Loading index from Memgraph for project ${projectId}...`,
      );

      const graphData = await this.context.memgraph.loadProjectGraph(projectId);
      const { nodes, relationships } = graphData;

      if (nodes.length === 0 && relationships.length === 0) {
        console.error(
          `[Phase2c] No data found in Memgraph for project ${projectId}, index remains empty`,
        );
        return;
      }

      // Add all nodes to the index
      for (const node of nodes) {
        this.context.index.addNode(node.id, node.type, node.properties);
      }

      // Add all relationships to the index
      for (const rel of relationships) {
        this.context.index.addRelationship(
          rel.id,
          rel.from,
          rel.to,
          rel.type,
          rel.properties,
        );
      }

      console.error(
        `[Phase2c] Index loaded from Memgraph: ${nodes.length} nodes, ${relationships.length} relationships for project ${projectId}`,
      );
    } catch (error) {
      console.error(
        "[Phase2c] Failed to initialize index from Memgraph:",
        error,
      );
      // Continue regardless - index is optional for startup
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Response Formatting
  // ──────────────────────────────────────────────────────────────────────────────

  protected errorEnvelope(
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

  protected canonicalizePaths(text: string): string {
    return text
      .replaceAll("/workspace/", "")
      .replace(/\/home\/[^/]+\/stratSolver\//g, "")
      .replaceAll("//", "/");
  }

  protected compactValue(value: unknown): unknown {
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

  protected formatSuccess(
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

  // ──────────────────────────────────────────────────────────────────────────────
  // Input Processing and Normalization
  // ──────────────────────────────────────────────────────────────────────────────

  protected classifyIntent(
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

  protected normalizeToolArgs(
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
    console.error(
      `[callTool] ENTER tool=${toolName} args=${JSON.stringify(rawArgs ?? {}).slice(0, 256)}`,
    );
    const { normalized, warnings } = this.normalizeToolArgs(toolName, rawArgs);
    const target = (this as any)[toolName];

    if (typeof target !== "function") {
      console.error(
        `[callTool] TOOL_NOT_FOUND tool=${toolName} — method does not exist on ToolHandlers`,
      );
      const registered = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
        .filter(
          (k) => typeof (this as any)[k] === "function" && !k.startsWith("_"),
        )
        .join(", ");
      console.error(`[callTool] Registered methods: ${registered}`);
      return this.errorEnvelope(
        "TOOL_NOT_FOUND",
        `Tool not found in handler registry: ${toolName}`,
        false,
      );
    }

    let result: string;
    try {
      result = await target.call(this, normalized);
    } catch (err) {
      console.error(
        `[callTool] UNCAUGHT_EXCEPTION tool=${toolName} error=${String(err)}`,
      );
      throw err;
    }

    try {
      const parsed = JSON.parse(result);
      const ok = parsed?.ok ?? true;
      const code = parsed?.error?.code ?? (ok ? "ok" : "error");
      console.error(
        `[callTool] EXIT tool=${toolName} status=${ok} code=${code}`,
      );
    } catch {
      console.error(
        `[callTool] EXIT tool=${toolName} result-length=${result.length}`,
      );
    }

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

  // ──────────────────────────────────────────────────────────────────────────────
  // Utility Conversions
  // ──────────────────────────────────────────────────────────────────────────────

  protected toEpochMillis(asOf?: string): number | null {
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

  protected toSafeNumber(value: unknown): number | null {
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

  // ──────────────────────────────────────────────────────────────────────────────
  // Episode and Entity Validation
  // ──────────────────────────────────────────────────────────────────────────────

  protected validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null {
    const type = String(args.type || "").toUpperCase();
    const entities = Array.isArray(args.entities) ? args.entities : [];
    const metadata = args.metadata || {};
    console.error(
      `[validateEpisodeInput] type=${type} outcome=${String(args.outcome ?? "")} entities=${entities.length} metadataKeys=${Object.keys(metadata).join(",") || "none"}`,
    );

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

  protected async inferEpisodeEntityHints(
    query: string,
    limit: number,
  ): Promise<string[]> {
    if (!this.embeddingEngine || !query.trim()) {
      return [];
    }

    try {
      await this.ensureEmbeddings();
      const { projectId } = this.getActiveProjectContext();
      const topK = Math.max(1, Math.min(limit, 10));
      const [functions, classes, files] = await Promise.all([
        this.embeddingEngine.findSimilar(query, "function", topK, projectId),
        this.embeddingEngine.findSimilar(query, "class", topK, projectId),
        this.embeddingEngine.findSimilar(query, "file", topK, projectId),
      ]);

      return [...functions, ...classes, ...files]
        .map((item) => String(item.id || ""))
        .filter(Boolean)
        .slice(0, topK * 2);
    } catch {
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Temporal Query Helpers
  // ──────────────────────────────────────────────────────────────────────────────

  protected async resolveSinceAnchor(
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

  // ──────────────────────────────────────────────────────────────────────────────
  // Embedding Management
  // ──────────────────────────────────────────────────────────────────────────────

  // Phase 4.3: Project-scoped embedding readiness check to prevent race conditions
  // Phase 4.5: Improved error handling for Qdrant operations
  protected async ensureEmbeddings(projectId?: string): Promise<void> {
    const activeProjectId =
      projectId || this.getActiveProjectContext().projectId;

    console.error(
      `[ensureEmbeddings] projectId=${activeProjectId} embeddingEngineReady=${!!this.embeddingEngine} alreadyReady=${this.isProjectEmbeddingsReady(activeProjectId)} qdrantConnected=${this.qdrant?.isConnected?.() ?? "unknown"}`,
    );

    if (
      this.isProjectEmbeddingsReady(activeProjectId) ||
      !this.embeddingEngine
    ) {
      console.error(
        `[ensureEmbeddings] SKIP — embeddingEngine=${!!this.embeddingEngine} alreadyReady=${this.isProjectEmbeddingsReady(activeProjectId)}`,
      );
      return;
    }

    try {
      const generated = await this.embeddingEngine.generateAllEmbeddings();
      if (generated.functions + generated.classes + generated.files === 0) {
        throw new Error("No indexed symbols found. Run graph_rebuild first.");
      }

      try {
        await this.embeddingEngine.storeInQdrant();
      } catch (qdrantError) {
        const errorMsg =
          qdrantError instanceof Error
            ? qdrantError.message
            : String(qdrantError);
        console.error(
          `[Phase4.5] Qdrant storage failed for project ${activeProjectId}: ${errorMsg}`,
        );
        // Don't throw - continue with embeddings ready flag set locally
        // Qdrant failures are non-critical for indexing functionality
        console.warn(
          `[Phase4.5] Continuing without Qdrant - semantic search may be unavailable for project ${activeProjectId}`,
        );
      }

      this.setProjectEmbeddingsReady(activeProjectId, true);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[Phase4.5] Embedding generation failed for project ${activeProjectId}: ${errorMsg}`,
      );
      throw error;
    }
  }

  protected isProjectEmbeddingsReady(projectId: string): boolean {
    return this.projectEmbeddingsReady.get(projectId) ?? false;
  }

  protected setProjectEmbeddingsReady(projectId: string, ready: boolean): void {
    this.projectEmbeddingsReady.set(projectId, ready);
  }

  protected clearProjectEmbeddingsReady(projectId: string): void {
    this.projectEmbeddingsReady.delete(projectId);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Build Error Tracking (Phase 4.5)
  // ──────────────────────────────────────────────────────────────────────────────

  protected recordBuildError(
    projectId: string,
    error: unknown,
    context?: string,
  ): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errors = this.backgroundBuildErrors.get(projectId) || [];

    errors.push({
      timestamp: Date.now(),
      error: errorMsg,
      context,
    });

    // Keep history bounded
    if (errors.length > this.maxBuildErrorsPerProject) {
      errors.shift();
    }

    this.backgroundBuildErrors.set(projectId, errors);
  }

  protected getRecentBuildErrors(
    projectId: string,
    limit: number = 5,
  ): Array<{ timestamp: number; error: string; context?: string }> {
    const errors = this.backgroundBuildErrors.get(projectId) || [];
    return errors.slice(-limit);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Element Resolution
  // ──────────────────────────────────────────────────────────────────────────────

  protected resolveElement(elementId: string): GraphNode | undefined {
    const requested = String(elementId || "").trim();
    if (!requested) {
      return undefined;
    }

    const exact = this.context.index.getNode(requested);
    if (exact) {
      return exact;
    }

    const normalizedPath = requested.replace(/\\/g, "/");
    const basename = path.basename(normalizedPath);
    const scopedTail = requested.includes(":")
      ? requested.split(":").slice(-1)[0]
      : requested;
    const symbolTail = requested.includes("::")
      ? requested.split("::").slice(-1)[0]
      : scopedTail;

    const files = this.context.index.getNodesByType("FILE");
    const functions = this.context.index.getNodesByType("FUNCTION");
    const classes = this.context.index.getNodesByType("CLASS");

    return (
      files.find((node) => {
        const nodePath = String(
          node.properties.path ||
            node.properties.filePath ||
            node.properties.relativePath ||
            "",
        ).replace(/\\/g, "/");
        return (
          nodePath === normalizedPath ||
          nodePath.endsWith(normalizedPath) ||
          normalizedPath.endsWith(nodePath) ||
          path.basename(nodePath) === basename ||
          node.id === requested ||
          node.id.endsWith(`:${normalizedPath}`)
        );
      }) ||
      functions.find((node) => {
        const name = String(node.properties.name || "");
        return (
          name === requested ||
          name === scopedTail ||
          name === symbolTail ||
          node.id === requested ||
          node.id.endsWith(`:${requested}`)
        );
      }) ||
      classes.find((node) => {
        const name = String(node.properties.name || "");
        return (
          name === requested ||
          name === scopedTail ||
          name === symbolTail ||
          node.id === requested ||
          node.id.endsWith(`:${requested}`)
        );
      })
    );
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Temporal Query Building
  // ──────────────────────────────────────────────────────────────────────────────

  protected buildTemporalPredicateForVars(variables: string[]): string {
    const unique = [...new Set(variables.filter(Boolean))];
    return unique
      .map(
        (name) =>
          `(${name}.validFrom <= $asOfTs AND (${name}.validTo IS NULL OR ${name}.validTo > $asOfTs))`,
      )
      .join(" AND ");
  }

  protected extractMatchVariables(segment: string): string[] {
    const vars: string[] = [];
    const regex = /\(([A-Za-z_][A-Za-z0-9_]*)\s*(?::|\)|\{)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(segment)) !== null) {
      vars.push(match[1]);
    }
    return vars;
  }

  protected applyTemporalFilterToCypher(query: string): string {
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

  // ──────────────────────────────────────────────────────────────────────────────
  // Watcher-driven Incremental Rebuild
  // ──────────────────────────────────────────────────────────────────────────────

  protected async runWatcherIncrementalRebuild(
    context: ProjectContext & { changedFiles?: string[] },
  ): Promise<void> {
    if (!this.orchestrator) {
      return;
    }

    // Phase 4.2: Use crypto-secure random ID generation instead of Math.random()
    const txTimestamp = Date.now();
    const txId = generateSecureId("tx", 4);

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
        ".lxrag",
        "__tests__",
        "coverage",
        ".git",
      ],
    });

    // Phase 2a & 4.3: Reset embeddings for watcher-driven incremental builds (per-project to prevent race conditions)
    this.setProjectEmbeddingsReady(context.projectId, false);
    console.error(
      `[Phase2a] Embeddings flag reset for watcher incremental rebuild of project ${context.projectId}`,
    );

    this.lastGraphRebuildAt = new Date().toISOString();
    this.lastGraphRebuildMode = "incremental";
  }
}
