/**
 * Type definitions for MCP tool arguments
 * Phase 4.6: Type safety improvements
 */

/**
 * Generic tool arguments with required and optional fields
 */
export interface ToolArgs {
  [key: string]: unknown;
}

/**
 * Graph query tool arguments
 */
export interface GraphQueryArgs extends ToolArgs {
  query: string;
  language?: "cypher" | "natural";
  mode?: "local" | "global" | "hybrid";
  limit?: number;
  asOf?: string;
}

/**
 * Graph set workspace arguments
 */
export interface GraphSetWorkspaceArgs extends ToolArgs {
  workspaceRoot: string;
  sourceDir?: string;
  projectId?: string;
}

/**
 * Graph rebuild arguments
 */
export interface GraphRebuildArgs extends ToolArgs {
  mode?: "full" | "incremental";
  verbose?: boolean;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Graph health arguments
 */
export interface GraphHealthArgs extends ToolArgs {
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Semantic search arguments
 */
export interface SemanticSearchArgs extends ToolArgs {
  query: string;
  type?: "function" | "class" | "file";
  limit?: number;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Find similar arguments
 */
export interface FindSimilarArgs extends ToolArgs {
  elementId: string;
  limit?: number;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Code clusters arguments
 */
export interface CodeClustersArgs extends ToolArgs {
  type?: "function" | "class" | "file";
  count?: number;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Create feature arguments
 */
export interface CreateFeatureArgs extends ToolArgs {
  name: string;
  description?: string;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Create task arguments
 */
export interface CreateTaskArgs extends ToolArgs {
  name: string;
  featureId?: string;
  description?: string;
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Update task arguments
 */
export interface UpdateTaskArgs extends ToolArgs {
  taskId: string;
  status?: "pending" | "in-progress" | "completed" | "blocked";
  profile?: "compact" | "balanced" | "debug";
}

/**
 * Union type for all tool arguments
 */
export type AnyToolArgs =
  | GraphQueryArgs
  | GraphSetWorkspaceArgs
  | GraphRebuildArgs
  | GraphHealthArgs
  | SemanticSearchArgs
  | FindSimilarArgs
  | CodeClustersArgs
  | CreateFeatureArgs
  | CreateTaskArgs
  | UpdateTaskArgs
  | ToolArgs;

/**
 * Type guard to safely extract typed arguments
 */
export function extractToolArgs<T extends ToolArgs>(
  args: unknown,
  requiredFields: string[] = [],
): T {
  if (!args || typeof args !== "object") {
    throw new Error(`Invalid tool arguments: expected object, got ${typeof args}`);
  }

  const obj = args as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in obj)) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  return obj as T;
}

/**
 * Get profile from tool arguments (safely)
 */
export function getProfileFromArgs(args: ToolArgs): "compact" | "balanced" | "debug" {
  const profile = args.profile;
  if (typeof profile === "string" && ["compact", "balanced", "debug"].includes(profile)) {
    return profile as "compact" | "balanced" | "debug";
  }
  return "compact";
}

/**
 * Get limit from tool arguments with validation
 */
export function getLimitFromArgs(args: ToolArgs, defaultLimit: number = 100, maxLimit: number = 10000): number {
  const limit = args.limit;
  if (typeof limit === "number") {
    return Math.max(1, Math.min(limit, maxLimit));
  }
  return defaultLimit;
}
