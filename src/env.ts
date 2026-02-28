/**
 * Centralized environment configuration.
 *
 * This is the ONLY place in the codebase that reads `process.env`.
 * Every other module imports the constants it needs from here.
 *
 * Copy `.env.example` to `.env` and adjust the values for your setup.
 */

import * as dotenv from "dotenv";
import * as path from "path";

// Load .env file as early as possible so all subsequent reads see the values.
dotenv.config();

// ── Workspace / Project ───────────────────────────────────────────────────────

/**
 * Absolute path to the workspace being indexed.
 * Env: LXDIG_WORKSPACE_ROOT
 * Default: process.cwd()
 */
export const LXDIG_WORKSPACE_ROOT: string = path.resolve(
  process.env.LXDIG_WORKSPACE_ROOT || process.cwd(),
);

// Alias for backward compatibility
export const CODE_GRAPH_WORKSPACE_ROOT = LXDIG_WORKSPACE_ROOT;

/**
 * Source sub-directory to index. Can be absolute or relative to WORKSPACE_ROOT.
 * Env: GRAPH_SOURCE_DIR
 * Default: <WORKSPACE_ROOT>/src
 */
export const GRAPH_SOURCE_DIR: string = (() => {
  const raw = process.env.GRAPH_SOURCE_DIR || path.join(LXDIG_WORKSPACE_ROOT, "src");
  return path.isAbsolute(raw) ? raw : path.resolve(LXDIG_WORKSPACE_ROOT, raw);
})();

/**
 * Logical project identifier used as a namespace in the graph.
 * Env: LXDIG_PROJECT_ID
 * Default: basename of LXDIG_WORKSPACE_ROOT
 */
export const LXDIG_PROJECT_ID: string =
  process.env.LXDIG_PROJECT_ID || path.basename(LXDIG_WORKSPACE_ROOT);

// Alias for backward compatibility
export const CODE_GRAPH_PROJECT_ID = LXDIG_PROJECT_ID;

/**
 * Transaction ID for graph write operations.
 * Env: LXDIG_TX_ID
 * Default: undefined (callers generate a fresh `tx-<timestamp>` per invocation)
 */
export const LXDIG_TX_ID: string | undefined = process.env.LXDIG_TX_ID || undefined;

// ── MCP Transport ─────────────────────────────────────────────────────────────

/**
 * Transport mode for the MCP server.
 * Env: MCP_TRANSPORT
 * Default: "stdio"
 */
export const MCP_TRANSPORT: "stdio" | "http" =
  (process.env.MCP_TRANSPORT as "stdio" | "http") || "stdio";

/**
 * HTTP port when MCP_TRANSPORT=http.
 * Env: MCP_PORT
 * Default: 9000
 */
export const MCP_PORT: number = parseInt(process.env.MCP_PORT || "9000", 10);

/**
 * Display name reported by the MCP server.
 * Env: LXDIG_SERVER_NAME
 * Default: "lxDIG MCP"
 */
export const LXDIG_SERVER_NAME: string = process.env.LXDIG_SERVER_NAME || "lxDIG MCP";

// Alias for backward compatibility
export const CODE_GRAPH_SERVER_NAME = LXDIG_SERVER_NAME;

// ── Memgraph (graph database) ─────────────────────────────────────────────────

/**
 * Hostname of the Memgraph instance.
 * Env: MEMGRAPH_HOST
 * Default: "localhost"
 */
export const MEMGRAPH_HOST: string = process.env.MEMGRAPH_HOST || "localhost";

/**
 * Bolt port of the Memgraph instance.
 * Env: MEMGRAPH_PORT
 * Default: 7687
 */
export const MEMGRAPH_PORT: number = parseInt(process.env.MEMGRAPH_PORT || "7687", 10);

// ── Qdrant (vector store) ─────────────────────────────────────────────────────

/**
 * Hostname of the Qdrant instance.
 * Env: QDRANT_HOST
 * Default: "localhost"
 */
export const QDRANT_HOST: string = process.env.QDRANT_HOST || "localhost";

/**
 * REST port of the Qdrant instance.
 * Env: QDRANT_PORT
 * Default: 6333
 */
export const QDRANT_PORT: number = parseInt(process.env.QDRANT_PORT || "6333", 10);

// ── Code Summarizer ───────────────────────────────────────────────────────────

/**
 * URL of the optional LLM summarizer service (e.g. http://localhost:8080).
 * When undefined, summarization is disabled and heuristic summaries are used.
 * Env: LXDIG_SUMMARIZER_URL
 */
export const LXDIG_SUMMARIZER_URL: string | undefined =
  process.env.LXDIG_SUMMARIZER_URL || undefined;

// Alias for backward compatibility
export const CODE_GRAPH_SUMMARIZER_URL = LXDIG_SUMMARIZER_URL;

// ── Agent / Coordination ──────────────────────────────────────────────────────

/**
 * Identifier for the current agent instance used in coordination claims.
 * Env: LXDIG_AGENT_ID
 * Default: "agent-local"
 */
export const LXDIG_AGENT_ID: string = process.env.LXDIG_AGENT_ID || "agent-local";

// Alias for backward compatibility
export const CODE_GRAPH_AGENT_ID = LXDIG_AGENT_ID;

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Set to true to use the Tree-sitter parser instead of the regex parser.
 * Env: LXDIG_USE_TREE_SITTER
 * Default: false
 */
export const LXDIG_USE_TREE_SITTER: boolean = process.env.LXDIG_USE_TREE_SITTER === "true";

// Alias for backward compatibility
export const CODE_GRAPH_USE_TREE_SITTER = LXDIG_USE_TREE_SITTER;

// ── File Watcher ──────────────────────────────────────────────────────────────

/**
 * Enables incremental file-change watching.
 * Automatically considered true when MCP_TRANSPORT=http.
 * Env: LXDIG_ENABLE_WATCHER
 * Default: false
 */
export const LXDIG_ENABLE_WATCHER: boolean = process.env.LXDIG_ENABLE_WATCHER === "true";

// Alias for backward compatibility
export const CODE_GRAPH_ENABLE_WATCHER = LXDIG_ENABLE_WATCHER;

/**
 * Comma-separated glob patterns to exclude from indexing/watching.
 * Env: LXDIG_IGNORE_PATTERNS
 * Example: "node_modules/**,dist/**,.git/**"
 */
export const LXDIG_IGNORE_PATTERNS: string[] = (process.env.LXDIG_IGNORE_PATTERNS || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// Alias for backward compatibility
export const CODE_GRAPH_IGNORE_PATTERNS = LXDIG_IGNORE_PATTERNS;

// ── Path Fallback ─────────────────────────────────────────────────────────────

/**
 * Allow the server to fall back to the mounted workspace path when the
 * requested path is not accessible (useful inside Docker containers).
 * Env: LXDIG_ALLOW_RUNTIME_PATH_FALLBACK
 * Default: false
 */
export const LXDIG_ALLOW_RUNTIME_PATH_FALLBACK: boolean =
  process.env.LXDIG_ALLOW_RUNTIME_PATH_FALLBACK === "true";

// Alias for backward compatibility
export const CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK = LXDIG_ALLOW_RUNTIME_PATH_FALLBACK;

// ── Command Execution ──────────────────────────────────────────────────────

/**
 * Maximum execution time for command execution in milliseconds.
 * Env: LXDIG_COMMAND_EXECUTION_TIMEOUT_MS
 * Default: 30000 (30 seconds)
 */
export const LXDIG_COMMAND_EXECUTION_TIMEOUT_MS: number = parseInt(
  process.env.LXDIG_COMMAND_EXECUTION_TIMEOUT_MS || "30000",
  10,
);

/**
 * Maximum time to wait synchronously for graph_rebuild before falling back
 * to queued/background execution.
 * Env: LXDIG_SYNC_REBUILD_THRESHOLD_MS
 * Default: 12000 (12 seconds)
 */
export const LXDIG_SYNC_REBUILD_THRESHOLD_MS: number = parseInt(
  process.env.LXDIG_SYNC_REBUILD_THRESHOLD_MS || "12000",
  10,
);

/**
 * Maximum output size for command results in bytes.
 * Prevents DoS from commands producing massive output.
 * Env: LXDIG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES
 * Default: 10485760 (10 MB)
 */
export const LXDIG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES: number = parseInt(
  process.env.LXDIG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES || "10485760",
  10,
);

// ── File Watcher ───────────────────────────────────────────────────────────

/**
 * Debounce time for file watcher in milliseconds.
 * Env: LXDIG_WATCHER_DEBOUNCE_MS
 * Default: 500 (500ms)
 */
export const LXDIG_WATCHER_DEBOUNCE_MS: number = parseInt(
  process.env.LXDIG_WATCHER_DEBOUNCE_MS || "500",
  10,
);

// ── Connection Pools ────────────────────────────────────────────────────────

/**
 * Maximum Memgraph connection pool size.
 * Env: LXDIG_MEMGRAPH_MAX_POOL_SIZE
 * Default: 50
 */
export const LXDIG_MEMGRAPH_MAX_POOL_SIZE: number = parseInt(
  process.env.LXDIG_MEMGRAPH_MAX_POOL_SIZE || "50",
  10,
);

/**
 * Memgraph connection acquisition timeout in milliseconds.
 * Env: LXDIG_MEMGRAPH_CONNECTION_TIMEOUT_MS
 * Default: 10000 (10 seconds)
 */
export const LXDIG_MEMGRAPH_CONNECTION_TIMEOUT_MS: number = parseInt(
  process.env.LXDIG_MEMGRAPH_CONNECTION_TIMEOUT_MS || "10000",
  10,
);

/**
 * Memgraph connection liveness check timeout in milliseconds.
 * Env: LXDIG_MEMGRAPH_LIVENESS_TIMEOUT_MS
 * Default: 5000 (5 seconds)
 */
export const LXDIG_MEMGRAPH_LIVENESS_TIMEOUT_MS: number = parseInt(
  process.env.LXDIG_MEMGRAPH_LIVENESS_TIMEOUT_MS || "5000",
  10,
);

// ── State Management ────────────────────────────────────────────────────────

/**
 * Maximum state history size (bounded for memory efficiency).
 * Env: LXDIG_STATE_HISTORY_MAX_SIZE
 * Default: 200 entries
 */
export const LXDIG_STATE_HISTORY_MAX_SIZE: number = parseInt(
  process.env.LXDIG_STATE_HISTORY_MAX_SIZE || "200",
  10,
);

// ── Logging ───────────────────────────────────────────────────────────────────

/**
 * Minimum log level emitted by the structured logger.
 * Env: LXDIG_LOG_LEVEL
 * Accepted values: "debug" | "info" | "warn" | "error"
 * Default: "info"
 */
export const LXDIG_LOG_LEVEL: string = process.env.LXDIG_LOG_LEVEL ?? "info";
