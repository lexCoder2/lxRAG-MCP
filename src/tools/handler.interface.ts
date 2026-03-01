import { type Config } from "../config";
import { GraphOrchestrator } from "../graph/orchestrator";
import type { GraphIndexManager } from "../graph/index.js";
import type MemgraphClient from "../graph/client.js";

export interface ToolContext {
  index: GraphIndexManager;
  memgraph: MemgraphClient;
  config: Config;
  orchestrator?: GraphOrchestrator;
}

export interface runtimeContextResult {
  context: ProjectContext;
  usedFallback: boolean;
  fallbackReason?: string;
}

export interface ProjectContext {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
  /** 4-char alphanumeric hash of workspaceRoot — stable workspace identity fingerprint */
  projectFingerprint?: string;
}
export interface NormalizedToolArgs {
  normalized: Record<string, unknown>;
  warnings: string[];
}
