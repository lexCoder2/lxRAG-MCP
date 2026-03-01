/**
 * Tool Handler Base Class
 * Thin orchestrator: engine lifecycle, session/watcher management, and tool
 * dispatch.  All domain logic has been extracted to focused collaborators
 * following the Single Responsibility Principle:
 *
 *   ResponseFormatter     — wire serialisation
 *   TemporalQueryBuilder  — Cypher temporal rewrites & anchor resolution
 *   EpisodeValidator      — episode schema validation & hint inference
 *   ElementResolver       — graph-node ID → GraphNode lookup
 *   EmbeddingManager      — per-project embedding readiness & ensure pipeline
 */

import * as env from "../env";
import ArchitectureEngine from "../engines/architecture-engine";
import TestEngine from "../engines/test-engine";
import ProgressEngine from "../engines/progress-engine";
import GraphOrchestrator from "../graph/orchestrator";
import QdrantClient from "../vector/qdrant-client";
import EmbeddingEngine from "../vector/embedding-engine";
import type { GraphNode } from "../graph/index";
import EpisodeEngine from "../engines/episode-engine";
import CoordinationEngine from "../engines/coordination-engine";
import CommunityDetector from "../engines/community-detector";
import HybridRetriever from "../graph/hybrid-retriever";
import FileWatcher from "../graph/watcher";
import { DocsEngine } from "../engines/docs-engine";
import type { EngineSet } from "./types";
import {
  validateToolArgs as _validateToolArgs,
  type ContractValidation,
} from "./contract-validator";
import { logger } from "../utils/logger";
import type { ProjectContext, ToolContext, NormalizedToolArgs } from "./handler.interface";
import { SessionManager } from "./session-manager";
import { generateSecureId } from "../utils/validation.js";

// ── Collaborators ──────────────────────────────────────────────────────────────
import { ResponseFormatter } from "./response-formatter";
import { TemporalQueryBuilder } from "./temporal-query-builder";
import { EpisodeValidator } from "./episode-validator";
import { ElementResolver } from "./element-resolver";
import { EmbeddingManager } from "./embedding-manager";

/**
 * Abstract base class for tool handlers.
 * Manages engine instances, session/watcher lifecycle, and tool dispatch.
 * Domain logic (formatting, Cypher building, validation, resolution) lives in
 * the dedicated collaborator classes above.
 */
export abstract class ToolHandlerBase extends SessionManager {
  // ── Engines ───────────────────────────────────────────────────────────────────
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

  // ── Collaborators ─────────────────────────────────────────────────────────────
  protected readonly responseFormatter = new ResponseFormatter();
  protected readonly temporalQueryBuilder = new TemporalQueryBuilder();
  protected readonly episodeValidator = new EpisodeValidator();
  protected readonly elementResolver = new ElementResolver();
  protected readonly embeddingMgr = new EmbeddingManager();

  // ── Session / Build state ─────────────────────────────────────────────────────
  protected lastGraphRebuildAt?: string;
  protected lastGraphRebuildMode?: "full" | "incremental";

  public backgroundBuildErrors = new Map<
    string,
    Array<{ timestamp: number; error: string; context?: string }>
  >();
  protected readonly maxBuildErrorsPerProject = 10;

  protected sessionWatchers = new Map<string, FileWatcher>();

  constructor(public readonly context: ToolContext) {
    super(context);
    this.initializeEngines();
    // Load index from Memgraph on startup (fire and forget)
    void this.initializeIndexFromMemgraph();
  }

  public get engines(): EngineSet {
    return {
      arch: this.archEngine,
      test: this.testEngine,
      progress: this.progressEngine,
      orchestrator: this.orchestrator,
      qdrant: this.qdrant,
      embedding: this.embeddingEngine,
      episode: this.episodeEngine,
      coordination: this.coordinationEngine,
      community: this.communityDetector,
      hybrid: this.hybridRetriever,
      docs: this.docsEngine,
    };
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

  public async stopActiveWatcher(): Promise<void> {
    const key = this.watcherKey();
    const existing = this.sessionWatchers.get(key);
    if (!existing) return;
    await existing.stop();
    this.sessionWatchers.delete(key);
  }

  public async startActiveWatcher(context: ProjectContext): Promise<void> {
    if (!this.watcherEnabledForRuntime()) return;

    await this.stopActiveWatcher();

    const watcher = new FileWatcher(
      {
        workspaceRoot: context.workspaceRoot,
        sourceDir: context.sourceDir,
        projectId: context.projectId,
        debounceMs: env.LXDIG_WATCHER_DEBOUNCE_MS,
        ignorePatterns: env.LXDIG_IGNORE_PATTERNS,
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

  async cleanupSession(sessionId: string): Promise<void> {
    if (!sessionId) return;

    try {
      const watcher = this.sessionWatchers.get(sessionId);
      if (watcher) {
        await watcher.stop();
        this.sessionWatchers.delete(sessionId);
        logger.error(`[ToolHandlers] Session cleanup: stopped watcher for ${sessionId}`);
      }

      if (this.sessionProjectContexts.has(sessionId)) {
        this.sessionProjectContexts.delete(sessionId);
        logger.error(`[ToolHandlers] Session cleanup: removed project context for ${sessionId}`);
      }
    } catch (error) {
      logger.error(`[ToolHandlers] Error cleaning up session ${sessionId}:`, error);
    }
  }

  async cleanupAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessionProjectContexts.keys());
    const watcherKeys = Array.from(this.sessionWatchers.keys());

    for (const key of watcherKeys) {
      try {
        const watcher = this.sessionWatchers.get(key);
        if (watcher) await watcher.stop();
      } catch (error) {
        logger.error(`[ToolHandlers] Error stopping watcher ${key}:`, error);
      }
    }

    this.sessionWatchers.clear();
    this.sessionProjectContexts.clear();
    logger.error(`[ToolHandlers] Cleaned up all ${sessionIds.length} session contexts`);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Engine Initialization
  // ──────────────────────────────────────────────────────────────────────────────

  protected initializeEngines(): void {
    logger.error("[initializeEngines] Starting engine initialization...");
    logger.error(
      `[initializeEngines] projectId=${this.defaultActiveProjectContext.projectId} workspaceRoot=${this.defaultActiveProjectContext.workspaceRoot}`,
    );
    logger.error(
      `[initializeEngines] memgraphConnected=${this.context.memgraph.isConnected?.() ?? "unknown"}`,
    );

    if (this.context.config.architecture) {
      this.archEngine = new ArchitectureEngine(
        this.context.config.architecture
          .layers as unknown as import("../engines/architecture-engine.js").LayerDefinition[],
        this.context.config.architecture.rules,
        this.context.index,
        this.defaultActiveProjectContext.workspaceRoot,
        {
          sourceGlobs: this.context.config.testing?.sourceGlobs,
          defaultExtension: this.context.config.testing?.defaultExtension,
        },
      );
      logger.error(
        `[initializeEngines] archEngine=ready layers=${this.context.config.architecture.layers?.length ?? 0}`,
      );
    } else {
      logger.error("[initializeEngines] archEngine=skipped (no architecture config)");
    }

    this.testEngine = new TestEngine(this.context.index);
    logger.error("[initializeEngines] testEngine=ready");

    this.progressEngine = new ProgressEngine(this.context.index, this.context.memgraph);
    logger.error("[initializeEngines] progressEngine=ready");

    this.episodeEngine = new EpisodeEngine(this.context.memgraph);
    logger.error("[initializeEngines] episodeEngine=ready");

    this.coordinationEngine = new CoordinationEngine(this.context.memgraph);
    logger.error("[initializeEngines] coordinationEngine=ready");

    this.communityDetector = new CommunityDetector(this.context.memgraph);
    logger.error("[initializeEngines] communityDetector=ready");

    this.orchestrator =
      this.context.orchestrator ||
      new GraphOrchestrator(this.context.memgraph, false, this.context.index);
    logger.error(
      `[initializeEngines] orchestrator=${this.context.orchestrator ? "provided" : "created"}`,
    );

    this.initializeVectorEngine();
    logger.error("[initializeEngines] All engines initialized.");
  }

  protected initializeVectorEngine(): void {
    const host = env.QDRANT_HOST;
    const port = env.QDRANT_PORT;
    logger.error(`[initializeVectorEngine] qdrant=${host}:${port}`);
    logger.error(
      `[initializeVectorEngine] summarizerUrl=${env.LXDIG_SUMMARIZER_URL ?? "(not set)"}`,
    );
    this.qdrant = new QdrantClient(host, port);
    this.embeddingEngine = new EmbeddingEngine(this.context.index, this.qdrant);
    logger.error("[initializeVectorEngine] embeddingEngine=created");
    this.hybridRetriever = new HybridRetriever(
      this.context.index,
      this.embeddingEngine,
      this.context.memgraph,
    );
    logger.error("[initializeVectorEngine] hybridRetriever=created");
    this.docsEngine = new DocsEngine(this.context.memgraph, { qdrant: this.qdrant });
    logger.error("[initializeVectorEngine] docsEngine=created");

    void this.qdrant
      .connect()
      .then(() => {
        logger.error("[initializeVectorEngine] qdrant=CONNECTED");
      })
      .catch((error: unknown) => {
        logger.warn("[initializeVectorEngine] qdrant=FAILED:", String(error));
      });

    // Ensure the Memgraph text_search BM25 index exists at startup.
    // Fire-and-forget; deferred so it runs after the current microtask queue
    // (important for test isolation — avoids polluting executeCypher call counts).
    setImmediate(() => {
      if (!this.hybridRetriever) return;
      if (!this.context.memgraph.isConnected?.()) return;
      if (
        typeof (this.hybridRetriever as unknown as { ensureBM25Index?: () => void })
          .ensureBM25Index !== "function"
      )
        return;
      void this.hybridRetriever
        .ensureBM25Index()
        .then((result) => {
          if (result.created) {
            logger.error("[bm25] Created text_search symbol_index at startup");
          } else if (result.error) {
            logger.warn(`[bm25] BM25 index unavailable at startup: ${result.error}`);
          }
        })
        .catch(() => {
          // Memgraph not yet connected at startup — index will be created on next rebuild
        });
    });

    if (!env.LXDIG_SUMMARIZER_URL) {
      logger.warn(
        "[summarizer] LXDIG_SUMMARIZER_URL is not set. " +
          "Heuristic local summaries will be used, reducing vector search quality and " +
          "compact-profile accuracy. " +
          "Point this to an OpenAI-compatible /v1/chat/completions endpoint for production use.",
      );
    }
  }

  protected async initializeIndexFromMemgraph(): Promise<void> {
    try {
      if (!this.context.memgraph.isConnected()) {
        logger.error(
          "[Phase2c] Memgraph not connected, skipping index initialization from database",
        );
        return;
      }

      const projectId = this.defaultActiveProjectContext.projectId;
      logger.error(`[Phase2c] Loading index from Memgraph for project ${projectId}...`);

      const graphData = await this.context.memgraph.loadProjectGraph(projectId);
      const { nodes, relationships } = graphData;

      if (nodes.length === 0 && relationships.length === 0) {
        logger.error(
          `[Phase2c] No data found in Memgraph for project ${projectId}, index remains empty`,
        );
        return;
      }

      for (const node of nodes) {
        this.context.index.addNode(node.id, node.type, node.properties);
      }
      for (const rel of relationships) {
        this.context.index.addRelationship(rel.id, rel.from, rel.to, rel.type, rel.properties);
      }

      logger.error(
        `[Phase2c] Index loaded from Memgraph: ${nodes.length} nodes, ${relationships.length} relationships for project ${projectId}`,
      );
    } catch (error) {
      logger.error("[Phase2c] Failed to initialize index from Memgraph:", error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Tool Dispatch
  // ──────────────────────────────────────────────────────────────────────────────

  public classifyIntent(
    query: string,
  ): "structure" | "dependency" | "test-impact" | "progress" | "general" {
    const lower = query.toLowerCase();
    if (/(test|coverage|spec|affected)/.test(lower)) return "test-impact";
    if (/(progress|feature|task|blocked|milestone)/.test(lower)) return "progress";
    if (/(import|dependency|depends|caller|called by|uses)/.test(lower)) return "dependency";
    if (/(file|folder|class|function|structure|tree|list)/.test(lower)) return "structure";
    return "general";
  }

  protected normalizeToolArgs(
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): { normalized: Record<string, unknown>; warnings: string[] } {
    const warnings: string[] = [];
    const normalized = { ...(rawArgs || {}) };

    if (toolName === "impact_analyze") {
      const files = Array.isArray(normalized.files)
        ? normalized.files
        : Array.isArray(normalized.changedFiles)
          ? normalized.changedFiles
          : [];
      if (Array.isArray(normalized.changedFiles) && !Array.isArray(normalized.files)) {
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

  normalizeForDispatch(toolName: string, rawArgs: Record<string, unknown>): NormalizedToolArgs {
    return this.normalizeToolArgs(toolName, rawArgs);
  }

  validateToolArgs(toolName: string, args: unknown): ContractValidation {
    return _validateToolArgs(toolName, args);
  }

  async callTool(toolName: string, rawArgs: Record<string, unknown>): Promise<string> {
    logger.error(
      `[callTool] ENTER tool=${toolName} args=${JSON.stringify(rawArgs ?? {}).slice(0, 256)}`,
    );
    const { normalized, warnings } = this.normalizeToolArgs(toolName, rawArgs);
    const target = (this as Record<string, unknown>)[toolName];

    if (typeof target !== "function") {
      logger.error(
        `[callTool] TOOL_NOT_FOUND tool=${toolName} — method does not exist on ToolHandlers`,
      );
      const registered = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
        .filter(
          (k) => typeof (this as Record<string, unknown>)[k] === "function" && !k.startsWith("_"),
        )
        .join(", ");
      logger.error(`[callTool] Registered methods: ${registered}`);
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
      logger.error(`[callTool] UNCAUGHT_EXCEPTION tool=${toolName} error=${String(err)}`);
      throw err;
    }

    try {
      const parsed = JSON.parse(result);
      const ok = parsed?.ok ?? true;
      const code = parsed?.error?.code ?? (ok ? "ok" : "error");
      logger.error(`[callTool] EXIT tool=${toolName} status=${ok} code=${code}`);
    } catch {
      logger.error(`[callTool] EXIT tool=${toolName} result-length=${result.length}`);
    }

    if (!warnings.length) return result;

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
  // Build Error Tracking
  // ──────────────────────────────────────────────────────────────────────────────

  public recordBuildError(projectId: string, error: unknown, context?: string): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errors = this.backgroundBuildErrors.get(projectId) || [];
    errors.push({ timestamp: Date.now(), error: errorMsg, context });
    if (errors.length > this.maxBuildErrorsPerProject) errors.shift();
    this.backgroundBuildErrors.set(projectId, errors);
  }

  public getRecentBuildErrors(
    projectId: string,
    limit = 5,
  ): Array<{ timestamp: number; error: string; context?: string }> {
    return (this.backgroundBuildErrors.get(projectId) || []).slice(-limit);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Watcher-driven Incremental Rebuild
  // ──────────────────────────────────────────────────────────────────────────────

  protected async runWatcherIncrementalRebuild(
    context: ProjectContext & { changedFiles?: string[] },
  ): Promise<void> {
    if (!this.orchestrator) return;

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
      exclude: ["node_modules", "dist", ".next", ".lxdig", "coverage", ".git"],
    });

    this.embeddingMgr.setReady(context.projectId, false);
    logger.error(
      `[Phase2a] Embeddings flag reset for watcher incremental rebuild of project ${context.projectId}`,
    );

    this.lastGraphRebuildAt = new Date().toISOString();
    this.lastGraphRebuildMode = "incremental";
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Delegation: ResponseFormatter
  // ──────────────────────────────────────────────────────────────────────────────

  public errorEnvelope(code: string, reason: string, recoverable = true, hint?: string): string {
    return this.responseFormatter.errorEnvelope(code, reason, recoverable, hint);
  }

  public canonicalizePaths(text: string): string {
    return this.responseFormatter.canonicalizePaths(text);
  }

  protected compactValue(value: unknown): unknown {
    return this.responseFormatter.compactValue(value);
  }

  public formatSuccess(
    data: unknown,
    profile: string = "compact",
    summary?: string,
    toolName?: string,
  ): string {
    return this.responseFormatter.formatSuccess(data, profile, summary, toolName);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Delegation: TemporalQueryBuilder
  // ──────────────────────────────────────────────────────────────────────────────

  public applyTemporalFilterToCypher(query: string): string {
    return this.temporalQueryBuilder.applyTemporalFilterToCypher(query);
  }

  protected buildTemporalPredicateForVars(variables: string[]): string {
    return this.temporalQueryBuilder.buildTemporalPredicateForVars(variables);
  }

  protected extractMatchVariables(segment: string): string[] {
    return this.temporalQueryBuilder.extractMatchVariables(segment);
  }

  public async resolveSinceAnchor(
    since: string,
    projectId: string,
  ): Promise<{
    sinceTs: number;
    mode: "txId" | "timestamp" | "gitCommit" | "agentId";
    anchorValue: string;
  } | null> {
    return this.temporalQueryBuilder.resolveSinceAnchor(since, projectId, this.context.memgraph);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Delegation: EpisodeValidator
  // ──────────────────────────────────────────────────────────────────────────────

  public validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null {
    return this.episodeValidator.validateEpisodeInput(args);
  }

  public async inferEpisodeEntityHints(query: string, limit: number): Promise<string[]> {
    const { projectId } = this.getActiveProjectContext();
    return this.episodeValidator.inferEntityHints(
      query,
      limit,
      this.embeddingEngine,
      projectId,
      () => this.ensureEmbeddings(),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Delegation: ElementResolver
  // ──────────────────────────────────────────────────────────────────────────────

  public resolveElement(elementId: string): GraphNode | undefined {
    const { projectId } = this.getActiveProjectContext();
    return this.elementResolver.resolve(elementId, this.context.index, projectId);
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Delegation: EmbeddingManager
  // ──────────────────────────────────────────────────────────────────────────────

  public async ensureEmbeddings(projectId?: string): Promise<void> {
    const activeId = projectId || this.getActiveProjectContext().projectId;
    return this.embeddingMgr.ensureEmbeddings(activeId, this.embeddingEngine);
  }

  public isProjectEmbeddingsReady(projectId: string): boolean {
    return this.embeddingMgr.isReady(projectId);
  }

  public setProjectEmbeddingsReady(projectId: string, ready: boolean): void {
    this.embeddingMgr.setReady(projectId, ready);
  }

  protected clearProjectEmbeddingsReady(projectId: string): void {
    this.embeddingMgr.clear(projectId);
  }
}
