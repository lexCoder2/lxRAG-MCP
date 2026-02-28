/**
 * Configuration type definitions
 * Phase 4.6: Type safety improvements
 */

/**
 * Architecture layer configuration
 */
export interface ArchitectureLayer {
  id: string;
  name: string;
  description?: string;
  contains?: string[];
  canDependOn?: string[];
}

/**
 * Architecture rule configuration
 */
export interface ArchitectureRule {
  id: string;
  type: "dependency" | "file-pattern" | "custom";
  severity: "error" | "warning" | "info";
  description: string;
  pattern?: string;
  from?: string;
  to?: string;
}

/**
 * Architecture configuration
 */
export interface ArchitectureConfig {
  layers: ArchitectureLayer[];
  rules: ArchitectureRule[];
  projectStructure?: {
    src?: string;
    tests?: string;
    docs?: string;
  };
}

/**
 * Full configuration object
 */
export interface ApplicationConfig {
  architecture: ArchitectureConfig;
  version?: string;
  name?: string;
}

/**
 * Memgraph connection config
 */
export interface MemgraphConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/**
 * Qdrant connection config
 */
export interface QdrantConfig {
  host: string;
  port: number;
  apiKey?: string;
}

/**
 * MCP server config
 */
export interface MCPServerConfig {
  transport: "stdio" | "http";
  port?: number;
  name?: string;
  version?: string;
}

/**
 * System configuration combining all sub-configs
 */
export interface SystemConfig {
  application: ApplicationConfig;
  memgraph: MemgraphConfig;
  qdrant: QdrantConfig;
  mcp: MCPServerConfig;
}

/**
 * Type guard to check if value is valid architecture config
 */
export function isValidArchitectureConfig(obj: unknown): obj is ArchitectureConfig {
  if (!obj || typeof obj !== "object") return false;
  const config = obj as Record<string, unknown>;
  return Array.isArray(config.layers) && Array.isArray(config.rules);
}

/**
 * Type guard for application config
 */
export function isValidApplicationConfig(obj: unknown): obj is ApplicationConfig {
  if (!obj || typeof obj !== "object") return false;
  const config = obj as Record<string, unknown>;
  return isValidArchitectureConfig(config.architecture);
}
