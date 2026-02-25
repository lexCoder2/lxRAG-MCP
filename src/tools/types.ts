/**
 * @file tools/types
 * @description Shared type contracts for tool registration and runtime dispatch.
 * @remarks These types define the bridge between registry definitions and handlers.
 */

import type * as z from "zod";

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
}

/**
 * Collection of lazily-initialized engines available to tool implementations.
 */
export interface EngineSet {
  arch?: unknown;
  test?: unknown;
  progress?: unknown;
  orchestrator?: unknown;
  qdrant?: unknown;
  embedding?: unknown;
  episode?: unknown;
  coordination?: unknown;
  community?: unknown;
  hybrid?: unknown;
  docs?: unknown;
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
    memgraph: any;
    index: any;
    config: any;
    orchestrator?: any;
  };
  engines: EngineSet;
  getCurrentSessionId(): string | undefined;
  callTool(toolName: string, rawArgs: any): Promise<string>;
  getActiveProjectContext(): ProjectContextLike;
  resolveProjectContext(overrides?: any): ProjectContextLike;
  normalizeForDispatch(
    toolName: string,
    rawArgs: any,
  ): { normalized: any; warnings: string[] };
  toEpochMillis(asOf?: string): number | null;
  ensureEmbeddings(projectId?: string): Promise<void>;
  resolveElement(elementId: string): any | undefined;
  validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null;
  inferEpisodeEntityHints(query: string, limit: number): Promise<string[]>;
  errorEnvelope(
    code: string,
    reason: string,
    recoverable?: boolean,
    hint?: string,
  ): string;
  formatSuccess(
    data: unknown,
    profile?: string,
    summary?: string,
    toolName?: string,
  ): string;
}

/**
 * Registry contract for a single tool definition.
 */
export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  description: string;
  inputShape: z.ZodRawShape;
  impl(args: any, bridge: HandlerBridge): Promise<string>;
}
