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
 * Env: LXRAG_WORKSPACE_ROOT
 * Default: process.cwd()
 */
export const LXRAG_WORKSPACE_ROOT: string = path.resolve(
  process.env.LXRAG_WORKSPACE_ROOT || process.cwd(),
);

// Alias for backward compatibility
export const CODE_GRAPH_WORKSPACE_ROOT = LXRAG_WORKSPACE_ROOT;

/**
 * Source sub-directory to index. Can be absolute or relative to WORKSPACE_ROOT.
 * Env: GRAPH_SOURCE_DIR
 * Default: <WORKSPACE_ROOT>/src
 */
export const GRAPH_SOURCE_DIR: string = (() => {
  const raw =
    process.env.GRAPH_SOURCE_DIR || path.join(LXRAG_WORKSPACE_ROOT, "src");
  return path.isAbsolute(raw) ? raw : path.resolve(LXRAG_WORKSPACE_ROOT, raw);
})();

/**
 * Logical project identifier used as a namespace in the graph.
 * Env: LXRAG_PROJECT_ID
 * Default: basename of LXRAG_WORKSPACE_ROOT
 */
export const LXRAG_PROJECT_ID: string =
  process.env.LXRAG_PROJECT_ID || path.basename(LXRAG_WORKSPACE_ROOT);

// Alias for backward compatibility
export const CODE_GRAPH_PROJECT_ID = LXRAG_PROJECT_ID;

/**
 * Transaction ID for graph write operations.
 * Env: LXRAG_TX_ID
 * Default: undefined (callers generate a fresh `tx-<timestamp>` per invocation)
 */
export const LXRAG_TX_ID: string | undefined =
  process.env.LXRAG_TX_ID || undefined;

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
 * Env: LXRAG_SERVER_NAME
 * Default: "lxRAG MCP"
 */
export const LXRAG_SERVER_NAME: string =
  process.env.LXRAG_SERVER_NAME || "lxRAG MCP";

// Alias for backward compatibility
export const CODE_GRAPH_SERVER_NAME = LXRAG_SERVER_NAME;

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
export const MEMGRAPH_PORT: number = parseInt(
  process.env.MEMGRAPH_PORT || "7687",
  10,
);

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
export const QDRANT_PORT: number = parseInt(
  process.env.QDRANT_PORT || "6333",
  10,
);

// ── Code Summarizer ───────────────────────────────────────────────────────────

/**
 * URL of the optional LLM summarizer service (e.g. http://localhost:8080).
 * When undefined, summarization is disabled and heuristic summaries are used.
 * Env: LXRAG_SUMMARIZER_URL
 */
export const LXRAG_SUMMARIZER_URL: string | undefined =
  process.env.LXRAG_SUMMARIZER_URL || undefined;

// Alias for backward compatibility
export const CODE_GRAPH_SUMMARIZER_URL = LXRAG_SUMMARIZER_URL;

// ── Agent / Coordination ──────────────────────────────────────────────────────

/**
 * Identifier for the current agent instance used in coordination claims.
 * Env: LXRAG_AGENT_ID
 * Default: "agent-local"
 */
export const LXRAG_AGENT_ID: string =
  process.env.LXRAG_AGENT_ID || "agent-local";

// Alias for backward compatibility
export const CODE_GRAPH_AGENT_ID = LXRAG_AGENT_ID;

// ── Parser ────────────────────────────────────────────────────────────────────

/**
 * Set to true to use the Tree-sitter parser instead of the regex parser.
 * Env: LXRAG_USE_TREE_SITTER
 * Default: false
 */
export const LXRAG_USE_TREE_SITTER: boolean =
  process.env.LXRAG_USE_TREE_SITTER === "true";

// Alias for backward compatibility
export const CODE_GRAPH_USE_TREE_SITTER = LXRAG_USE_TREE_SITTER;

// ── File Watcher ──────────────────────────────────────────────────────────────

/**
 * Enables incremental file-change watching.
 * Automatically considered true when MCP_TRANSPORT=http.
 * Env: LXRAG_ENABLE_WATCHER
 * Default: false
 */
export const LXRAG_ENABLE_WATCHER: boolean =
  process.env.LXRAG_ENABLE_WATCHER === "true";

// Alias for backward compatibility
export const CODE_GRAPH_ENABLE_WATCHER = LXRAG_ENABLE_WATCHER;

/**
 * Comma-separated glob patterns to exclude from indexing/watching.
 * Env: LXRAG_IGNORE_PATTERNS
 * Example: "node_modules/**,dist/**,.git/**"
 */
export const LXRAG_IGNORE_PATTERNS: string[] = (
  process.env.LXRAG_IGNORE_PATTERNS || ""
)
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// Alias for backward compatibility
export const CODE_GRAPH_IGNORE_PATTERNS = LXRAG_IGNORE_PATTERNS;

// ── Path Fallback ─────────────────────────────────────────────────────────────

/**
 * Allow the server to fall back to the mounted workspace path when the
 * requested path is not accessible (useful inside Docker containers).
 * Env: LXRAG_ALLOW_RUNTIME_PATH_FALLBACK
 * Default: false
 */
export const LXRAG_ALLOW_RUNTIME_PATH_FALLBACK: boolean =
  process.env.LXRAG_ALLOW_RUNTIME_PATH_FALLBACK === "true";

// Alias for backward compatibility
export const CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK =
  LXRAG_ALLOW_RUNTIME_PATH_FALLBACK;

// ── Command Execution ──────────────────────────────────────────────────────

/**
 * Maximum execution time for command execution in milliseconds.
 * Env: LXRAG_COMMAND_EXECUTION_TIMEOUT_MS
 * Default: 30000 (30 seconds)
 */
export const LXRAG_COMMAND_EXECUTION_TIMEOUT_MS: number = parseInt(
  process.env.LXRAG_COMMAND_EXECUTION_TIMEOUT_MS || "30000",
  10,
);

/**
 * Maximum output size for command results in bytes.
 * Prevents DoS from commands producing massive output.
 * Env: LXRAG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES
 * Default: 10485760 (10 MB)
 */
export const LXRAG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES: number = parseInt(
  process.env.LXRAG_COMMAND_OUTPUT_SIZE_LIMIT_BYTES || "10485760",
  10,
);

// ── File Watcher ───────────────────────────────────────────────────────────

/**
 * Debounce time for file watcher in milliseconds.
 * Env: LXRAG_WATCHER_DEBOUNCE_MS
 * Default: 500 (500ms)
 */
export const LXRAG_WATCHER_DEBOUNCE_MS: number = parseInt(
  process.env.LXRAG_WATCHER_DEBOUNCE_MS || "500",
  10,
);

// ── Connection Pools ────────────────────────────────────────────────────────

/**
 * Maximum Memgraph connection pool size.
 * Env: LXRAG_MEMGRAPH_MAX_POOL_SIZE
 * Default: 50
 */
export const LXRAG_MEMGRAPH_MAX_POOL_SIZE: number = parseInt(
  process.env.LXRAG_MEMGRAPH_MAX_POOL_SIZE || "50",
  10,
);

/**
 * Memgraph connection acquisition timeout in milliseconds.
 * Env: LXRAG_MEMGRAPH_CONNECTION_TIMEOUT_MS
 * Default: 10000 (10 seconds)
 */
export const LXRAG_MEMGRAPH_CONNECTION_TIMEOUT_MS: number = parseInt(
  process.env.LXRAG_MEMGRAPH_CONNECTION_TIMEOUT_MS || "10000",
  10,
);

/**
 * Memgraph connection liveness check timeout in milliseconds.
 * Env: LXRAG_MEMGRAPH_LIVENESS_TIMEOUT_MS
 * Default: 5000 (5 seconds)
 */
export const LXRAG_MEMGRAPH_LIVENESS_TIMEOUT_MS: number = parseInt(
  process.env.LXRAG_MEMGRAPH_LIVENESS_TIMEOUT_MS || "5000",
  10,
);

// ── State Management ────────────────────────────────────────────────────────

/**
 * Maximum state history size (bounded for memory efficiency).
 * Env: LXRAG_STATE_HISTORY_MAX_SIZE
 * Default: 200 entries
 */
export const LXRAG_STATE_HISTORY_MAX_SIZE: number = parseInt(
  process.env.LXRAG_STATE_HISTORY_MAX_SIZE || "200",
  10,
);
