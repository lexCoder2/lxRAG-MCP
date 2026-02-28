/**
 * @file tools/types
 * @description Shared type contracts for tool registration and runtime dispatch.
 * @remarks These types define the bridge between registry definitions and handlers.
 */

import type * as z from "zod";
import type { GraphNode, GraphIndexManager } from "../graph/index.js";
import type MemgraphClient from "../graph/client.js";
import type GraphOrchestrator from "../graph/orchestrator.js";
import type HybridRetriever from "../graph/hybrid-retriever.js";
import type ArchitectureEngine from "../engines/architecture-engine.js";
import type TestEngine from "../engines/test-engine.js";
import type ProgressEngine from "../engines/progress-engine.js";
import type EpisodeEngine from "../engines/episode-engine.js";
import type CoordinationEngine from "../engines/coordination-engine.js";
import type CommunityDetector from "../engines/community-detector.js";
import type { DocsEngine } from "../engines/docs-engine.js";
import type QdrantClient from "../vector/qdrant-client.js";
import type EmbeddingEngine from "../vector/embedding-engine.js";
import type { Config } from "../config.js";

/**
 * Generic tool argument map – replaces `any` at the impl boundary.
 * Individual implementations narrow the type via destructuring + runtime checks.
 */
export type ToolArgs = Record<string, unknown>;

/**
 * High-level categories used to group tools in the registry and metadata output.
 */
export type ToolCategory =
  | "graph"
  | "code"
  | "task"
  | "memory"
  | "coordination"
  | "setup"
  | "utility"
  | "arch"
  | "docs"
  | "ref"
  | "test";

/**
 * Session-aware project context used for workspace-scoped operations.
 */
export interface ProjectContextLike {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
  /** 4-char alphanumeric hash of workspaceRoot — stable workspace identity fingerprint */
  projectFingerprint?: string;
}

/**
 * Collection of lazily-initialized engines available to tool implementations.
 */
export interface EngineSet {
  arch?: ArchitectureEngine;
  test?: TestEngine;
  progress?: ProgressEngine;
  orchestrator?: GraphOrchestrator;
  qdrant?: QdrantClient;
  embedding?: EmbeddingEngine;
  episode?: EpisodeEngine;
  coordination?: CoordinationEngine;
  community?: CommunityDetector;
  hybrid?: HybridRetriever;
  docs?: DocsEngine;
}

/**
 * Runtime bridge exposed to tool definitions.
 *
 * @remarks
 * Implementations use this bridge to access engines, context, formatting, and
 * utility helpers while keeping tool modules decoupled from class internals.
 */
export interface HandlerBridge {
  context: {
    memgraph: MemgraphClient;
    index: GraphIndexManager;
    config: Config;
    orchestrator?: unknown;
  };
  engines: EngineSet;
  // ─── Core session / context ───────────────────────────────────────────────
  getCurrentSessionId(): string | undefined;
  callTool(toolName: string, rawArgs: Record<string, unknown>): Promise<string>;
  getActiveProjectContext(): ProjectContextLike;
  setActiveProjectContext(context: ProjectContextLike): void;
  resolveProjectContext(overrides?: Partial<ProjectContextLike>): ProjectContextLike;
  normalizeForDispatch(
    toolName: string,
    rawArgs: Record<string, unknown>,
  ): { normalized: Record<string, unknown>; warnings: string[] };
  validateToolArgs(
    toolName: string,
    args: unknown,
  ): import("./contract-validator.js").ContractValidation;
  // ─── Time / anchors ───────────────────────────────────────────────────────
  toEpochMillis(asOf?: string): number | null;
  resolveSinceAnchor(
    since: string,
    projectId: string,
  ): Promise<{ sinceTs: number; mode: string; anchorValue: string } | null>;
  lastGraphRebuildAt: string | undefined;
  lastGraphRebuildMode: "full" | "incremental" | undefined;
  // ─── Embeddings ───────────────────────────────────────────────────────────
  ensureEmbeddings(projectId?: string): Promise<void>;
  isProjectEmbeddingsReady(projectId: string): boolean;
  setProjectEmbeddingsReady(projectId: string, ready: boolean): void;
  // ─── Graph helpers ────────────────────────────────────────────────────────
  resolveElement(elementId: string): GraphNode | undefined;
  applyTemporalFilterToCypher(query: string): string;
  classifyIntent(query: string, candidates?: string[]): string;
  toSafeNumber(value: unknown): number | null;
  // ─── Workspace / runtime ─────────────────────────────────────────────────
  adaptWorkspaceForRuntime(context: ProjectContextLike): {
    context: ProjectContextLike;
    usedFallback: boolean;
    fallbackReason?: string;
  };
  runtimePathFallbackAllowed(): boolean;
  watcherEnabledForRuntime(): boolean;
  startActiveWatcher(context: ProjectContextLike): Promise<void>;
  getActiveWatcher(): { pendingChanges?: number; state?: string } | undefined;
  // ─── Build errors ─────────────────────────────────────────────────────────
  recordBuildError(projectId: string, error: unknown, context?: string): void;
  getRecentBuildErrors(
    projectId: string,
    limit?: number,
  ): Array<{ timestamp: number; error: string; context?: string }>;
  // ─── Optional implementation delegates ───────────────────────────────────
  core_context_pack_impl?: (args: ToolArgs) => Promise<string>;
  core_semantic_slice_impl?: (args: ToolArgs) => Promise<string>;
  // ─── Episode validation & episode hints ──────────────────────────────────
  validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null;
  inferEpisodeEntityHints(query: string, limit: number): Promise<string[]>;
  // ─── Response formatting ──────────────────────────────────────────────────
  errorEnvelope(code: string, reason: string, recoverable?: boolean, hint?: string): string;
  formatSuccess(data: unknown, profile?: string, summary?: string, toolName?: string): string;
}

/**
 * Registry contract for a single tool definition.
 */
export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  impl(args: ToolArgs, bridge: HandlerBridge): Promise<string>;
}
