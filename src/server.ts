/**
 * MCP Server with stdio transport for Claude Code
 * Uses McpServer for simplified tool registration
 */

import * as dotenv from "dotenv";
import * as z from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import MemgraphClient from "./graph/client.js";
import GraphIndexManager from "./graph/index.js";
import { ToolHandlers } from "./tools/tool-handlers.js";
import { loadConfig } from "./config.js";
import GraphOrchestrator from "./graph/orchestrator.js";
import { runWithRequestContext } from "./request-context.js";

dotenv.config();

// Initialize components
const memgraph = new MemgraphClient({
  host: process.env.MEMGRAPH_HOST || "localhost",
  port: parseInt(process.env.MEMGRAPH_PORT || "7687"),
});

const index = new GraphIndexManager();
let toolHandlers: ToolHandlers;
let config: any = {};
let orchestrator: GraphOrchestrator;

// Load configuration
async function initialize() {
  try {
    await memgraph.connect();
    console.error("[MCP] Memgraph connected");

    // Load architecture config if exists
    try {
      config = await loadConfig();
      console.error("[MCP] Configuration loaded");
    } catch (err) {
      console.error("[MCP] No configuration file found, using defaults");
      config = { architecture: { layers: [], rules: [] } };
    }

    // Initialize GraphOrchestrator
    orchestrator = new GraphOrchestrator(memgraph, false);

    toolHandlers = new ToolHandlers({
      index,
      memgraph,
      config,
      orchestrator: orchestrator,
    });

    console.error("[MCP] Tool handlers initialized");
  } catch (error) {
    console.error("[MCP] Initialization error:", error);
  }
}

// Server implementation info
const serverInfo = {
  name: process.env.CODE_GRAPH_SERVER_NAME || "code-graph-server",
  version: "1.0.0",
};

function createMcpServerInstance(): McpServer {
  const mcpServer = new McpServer(serverInfo);

  // Register tools with Zod schemas
  mcpServer.registerTool(
    "graph_query",
    {
      description:
        "Execute Cypher or natural language query against the code graph",
      inputSchema: z.object({
        query: z.string().describe("Cypher or natural language query"),
        language: z
          .enum(["cypher", "natural"])
          .default("natural")
          .describe("Query language"),
        mode: z
          .enum(["local", "global", "hybrid"])
          .default("local")
          .describe("Query mode for natural language"),
        limit: z.number().default(100).describe("Result limit"),
        asOf: z
          .string()
          .optional()
          .describe(
            "Optional ISO timestamp or epoch ms for temporal query mode",
          ),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("graph_query", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "code_explain",
    {
      description: "Explain code element with dependency context",
      inputSchema: z.object({
        element: z.string().describe("File path, class or function name"),
        depth: z.number().min(1).max(3).default(2).describe("Analysis depth"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("code_explain", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "arch_validate",
    {
      description: "Validate code against layer rules",
      inputSchema: z.object({
        files: z.array(z.string()).optional().describe("Files to validate"),
        strict: z.boolean().default(false).describe("Strict validation mode"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("arch_validate", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "test_select",
    {
      description: "Select tests affected by changed files",
      inputSchema: z.object({
        changedFiles: z.array(z.string()).describe("Files that changed"),
        mode: z
          .enum(["direct", "transitive", "full"])
          .default("transitive")
          .describe("Selection mode"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("test_select", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "graph_rebuild",
    {
      description: "Rebuild code graph from source",
      inputSchema: z.object({
        mode: z
          .enum(["full", "incremental"])
          .default("incremental")
          .describe("Build mode"),
        verbose: z.boolean().default(false).describe("Verbose output"),
        workspaceRoot: z
          .string()
          .optional()
          .describe("Workspace root path (absolute preferred)"),
        workspacePath: z
          .string()
          .optional()
          .describe("Alias for workspaceRoot"),
        sourceDir: z
          .string()
          .optional()
          .describe(
            "Source directory path (absolute or relative to workspace root)",
          ),
        projectId: z
          .string()
          .optional()
          .describe("Project namespace for graph isolation"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
        indexDocs: z
          .boolean()
          .default(true)
          .describe(
            "Index markdown documentation files (READMEs, ADRs) during rebuild (default: true). Set false to skip docs indexing.",
          ),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("graph_rebuild", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "graph_set_workspace",
    {
      description:
        "Set active workspace/project context for subsequent graph tools",
      inputSchema: z.object({
        workspaceRoot: z
          .string()
          .optional()
          .describe("Workspace root path (absolute preferred)"),
        workspacePath: z
          .string()
          .optional()
          .describe("Alias for workspaceRoot"),
        sourceDir: z
          .string()
          .optional()
          .describe(
            "Source directory path (absolute or relative to workspace root)",
          ),
        projectId: z
          .string()
          .optional()
          .describe("Project namespace for graph isolation"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("graph_set_workspace", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "graph_health",
    {
      description: "Report graph/index/vector health and freshness status",
      inputSchema: z.object({
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("graph_health", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "diff_since",
    {
      description:
        "Summarize temporal graph changes since txId, timestamp, git commit, or agentId",
      inputSchema: z.object({
        since: z
          .string()
          .describe(
            "Anchor value: txId, ISO timestamp, git commit SHA, or agentId",
          ),
        projectId: z
          .string()
          .optional()
          .describe("Optional project override (defaults to active context)"),
        types: z
          .array(z.enum(["FILE", "FUNCTION", "CLASS"]))
          .optional()
          .describe("Optional node types to include"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("diff_since", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  mcpServer.registerTool(
    "contract_validate",
    {
      description:
        "Normalize and validate tool argument contracts before execution",
      inputSchema: z.object({
        tool: z.string().describe("Target tool name"),
        arguments: z
          .record(z.any())
          .optional()
          .describe("Raw arguments to normalize"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("contract_validate", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Phase 4: Wire remaining 9 tools with proper Zod schemas

  // find_pattern
  mcpServer.registerTool(
    "find_pattern",
    {
      description: "Find architectural patterns or violations in code",
      inputSchema: z.object({
        pattern: z.string().describe("Pattern to search for"),
        type: z
          .enum(["pattern", "violation", "unused", "circular"])
          .describe("Pattern type"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("find_pattern", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // arch_suggest
  mcpServer.registerTool(
    "arch_suggest",
    {
      description: "Suggest best location for new code",
      inputSchema: z.object({
        name: z.string().describe("Code name/identifier"),
        type: z
          .enum([
            "component",
            "hook",
            "service",
            "context",
            "utility",
            "engine",
            "class",
            "module",
          ])
          .describe("Code type"),
        dependencies: z
          .array(z.string())
          .optional()
          .describe("Required dependencies"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("arch_suggest", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // test_categorize
  mcpServer.registerTool(
    "test_categorize",
    {
      description: "Categorize tests by type",
      inputSchema: z.object({
        testFiles: z
          .array(z.string())
          .optional()
          .describe("Test files to categorize"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("test_categorize", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // impact_analyze
  mcpServer.registerTool(
    "impact_analyze",
    {
      description: "Analyze impact of changes",
      inputSchema: z.object({
        files: z.array(z.string()).optional().describe("Changed files"),
        changedFiles: z
          .array(z.string())
          .optional()
          .describe("Changed files (alternate contract)"),
        depth: z.number().default(3).describe("Analysis depth"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("impact_analyze", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // test_run
  mcpServer.registerTool(
    "test_run",
    {
      description: "Execute test suite",
      inputSchema: z.object({
        testFiles: z.array(z.string()).describe("Test files to run"),
        parallel: z.boolean().default(true).describe("Run tests in parallel"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("test_run", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // progress_query
  mcpServer.registerTool(
    "progress_query",
    {
      description: "Query progress tracking data",
      inputSchema: z.object({
        query: z.string().describe("Progress query"),
        status: z
          .enum(["all", "active", "blocked", "completed"])
          .optional()
          .describe("Filter by status"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("progress_query", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // task_update
  mcpServer.registerTool(
    "task_update",
    {
      description: "Update task status",
      inputSchema: z.object({
        taskId: z.string().describe("Task ID"),
        status: z.string().describe("New status"),
        notes: z.string().optional().describe("Optional notes"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("task_update", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // feature_status
  mcpServer.registerTool(
    "feature_status",
    {
      description: "Get feature implementation status",
      inputSchema: z.object({
        featureId: z.string().describe("Feature ID"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("feature_status", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // blocking_issues
  mcpServer.registerTool(
    "blocking_issues",
    {
      description: "Find blocking issues",
      inputSchema: z.object({
        context: z.string().optional().describe("Issue context"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("blocking_issues", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // Phase 6: Vector Search Tools (5 tools)

  // semantic_search
  mcpServer.registerTool(
    "semantic_search",
    {
      description: "Search code semantically using vector similarity",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        type: z
          .enum(["function", "class", "file"])
          .optional()
          .describe("Code type to search"),
        limit: z.number().default(5).describe("Result limit"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("semantic_search", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // find_similar_code
  mcpServer.registerTool(
    "find_similar_code",
    {
      description: "Find code similar to a given function or class",
      inputSchema: z.object({
        elementId: z.string().describe("Code element ID"),
        threshold: z
          .number()
          .default(0.7)
          .describe("Similarity threshold (0-1)"),
        limit: z.number().default(10).describe("Result limit"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("find_similar_code", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // code_clusters
  mcpServer.registerTool(
    "code_clusters",
    {
      description: "Find clusters of related code",
      inputSchema: z.object({
        type: z
          .enum(["function", "class", "file"])
          .describe("Code type to cluster"),
        count: z.number().default(5).describe("Number of clusters"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("code_clusters", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // semantic_diff
  mcpServer.registerTool(
    "semantic_diff",
    {
      description: "Find semantic differences between code elements",
      inputSchema: z.object({
        elementId1: z.string().describe("First code element ID"),
        elementId2: z.string().describe("Second code element ID"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("semantic_diff", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // suggest_tests
  mcpServer.registerTool(
    "suggest_tests",
    {
      description: "Suggest tests for a code element based on semantics",
      inputSchema: z.object({
        elementId: z.string().describe("Code element ID"),
        limit: z.number().default(5).describe("Number of suggestions"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("suggest_tests", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // episode_add
  mcpServer.registerTool(
    "episode_add",
    {
      description: "Persist a structured episode in long-term agent memory",
      inputSchema: z.object({
        type: z
          .enum([
            "OBSERVATION",
            "DECISION",
            "EDIT",
            "TEST_RESULT",
            "ERROR",
            "REFLECTION",
            "LEARNING",
          ])
          .describe("Episode type"),
        content: z.string().describe("Episode content"),
        entities: z
          .array(z.string())
          .optional()
          .describe("Related graph entity IDs"),
        taskId: z.string().optional().describe("Related task ID"),
        outcome: z
          .enum(["success", "failure", "partial"])
          .optional()
          .describe("Outcome classification"),
        metadata: z.record(z.any()).optional().describe("Extra metadata"),
        sensitive: z
          .boolean()
          .optional()
          .describe("Exclude from default recalls"),
        agentId: z.string().optional().describe("Agent identifier"),
        sessionId: z.string().optional().describe("Session identifier"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("episode_add", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // episode_recall
  mcpServer.registerTool(
    "episode_recall",
    {
      description:
        "Recall episodes by semantic, temporal, and entity relevance",
      inputSchema: z.object({
        query: z.string().describe("Recall query"),
        agentId: z.string().optional().describe("Agent filter"),
        taskId: z.string().optional().describe("Task filter"),
        types: z.array(z.string()).optional().describe("Episode type filters"),
        entities: z.array(z.string()).optional().describe("Entity filters"),
        limit: z.number().default(5).describe("Result limit"),
        since: z.string().optional().describe("ISO timestamp or epoch ms"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("episode_recall", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // decision_query
  mcpServer.registerTool(
    "decision_query",
    {
      description: "Query decision episodes for a target topic",
      inputSchema: z.object({
        query: z.string().describe("Decision query text"),
        affectedFiles: z
          .array(z.string())
          .optional()
          .describe("Related files/entities"),
        taskId: z.string().optional().describe("Task filter"),
        agentId: z.string().optional().describe("Agent filter"),
        limit: z.number().default(5).describe("Result limit"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("decision_query", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // reflect
  mcpServer.registerTool(
    "reflect",
    {
      description:
        "Synthesize reflections and learning nodes from recent episodes",
      inputSchema: z.object({
        taskId: z.string().optional().describe("Task filter"),
        agentId: z.string().optional().describe("Agent filter"),
        limit: z.number().default(20).describe("Episodes to analyze"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("reflect", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // agent_claim
  mcpServer.registerTool(
    "agent_claim",
    {
      description:
        "Create a coordination claim for a task or code target with conflict detection",
      inputSchema: z.object({
        targetId: z.string().describe("Target task/code node id"),
        claimType: z
          .enum(["task", "file", "function", "feature"])
          .default("task")
          .describe("Claim target type"),
        intent: z.string().describe("Natural language intent"),
        taskId: z.string().optional().describe("Related task id"),
        agentId: z.string().optional().describe("Agent identifier"),
        sessionId: z.string().optional().describe("Session identifier"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("agent_claim", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // agent_release
  mcpServer.registerTool(
    "agent_release",
    {
      description: "Release an active claim",
      inputSchema: z.object({
        claimId: z.string().describe("Claim id"),
        outcome: z.string().optional().describe("Optional outcome summary"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("agent_release", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // agent_status
  mcpServer.registerTool(
    "agent_status",
    {
      description: "Get active claims and recent episodes for an agent",
      inputSchema: z.object({
        agentId: z.string().describe("Agent identifier"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("agent_status", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // coordination_overview
  mcpServer.registerTool(
    "coordination_overview",
    {
      description:
        "Fleet-wide claim view including active claims, stale claims, and conflicts",
      inputSchema: z.object({
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool(
          "coordination_overview",
          args,
        );
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // context_pack
  mcpServer.registerTool(
    "context_pack",
    {
      description:
        "Build a single-call task briefing using PPR-ranked retrieval across code, decisions, learnings, and blockers",
      inputSchema: z.object({
        task: z.string().describe("Task description"),
        taskId: z.string().optional().describe("Optional task id"),
        agentId: z.string().optional().describe("Agent identifier"),
        includeDecisions: z
          .boolean()
          .default(true)
          .describe("Include decision episodes"),
        includeEpisodes: z
          .boolean()
          .default(true)
          .describe("Include recent episodes"),
        includeLearnings: z
          .boolean()
          .default(true)
          .describe("Include learnings"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("context_pack", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // semantic_slice
  mcpServer.registerTool(
    "semantic_slice",
    {
      description:
        "Return relevant exact source lines with optional dependency and memory context",
      inputSchema: z.object({
        file: z
          .string()
          .optional()
          .describe("Relative or absolute source file path"),
        symbol: z
          .string()
          .optional()
          .describe("Symbol id/name (e.g. ToolHandlers.callTool)"),
        query: z
          .string()
          .optional()
          .describe("Natural-language fallback query"),
        context: z
          .enum(["signature", "body", "with-deps", "full"])
          .default("body")
          .describe("Slice detail mode"),
        pprScore: z
          .number()
          .optional()
          .describe("Optional PPR score from context_pack pipeline"),
        profile: z
          .enum(["compact", "balanced", "debug"])
          .default("compact")
          .describe("Response profile"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("semantic_slice", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // index_docs — discover and index markdown documentation files
  mcpServer.registerTool(
    "index_docs",
    {
      description:
        "Discover and index all markdown documentation files (README, ADRs, guides, CHANGELOG, ARCHITECTURE) under the workspace root into DOCUMENT and SECTION graph nodes. Supports incremental mode (skips unchanged files). Emits DOC_DESCRIBES edges linking sections to the code symbols they mention.",
      inputSchema: z.object({
        workspaceRoot: z
          .string()
          .optional()
          .describe("Workspace root path (defaults to active session context)"),
        projectId: z
          .string()
          .optional()
          .describe("Project ID (defaults to active session context)"),
        incremental: z
          .boolean()
          .default(true)
          .describe("Skip files whose hash has not changed (default: true)"),
        withEmbeddings: z
          .boolean()
          .default(false)
          .describe("Also embed section content into Qdrant vector store"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("index_docs", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  // search_docs — search indexed documentation sections
  mcpServer.registerTool(
    "search_docs",
    {
      description:
        "Search indexed documentation sections by full-text query or by code symbol name. Returns matching SECTION nodes with heading, source document, kind (readme/adr/guide/…), line number, relevance score, and a short content excerpt. Run index_docs first to populate the index.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Full-text search query (cannot be combined with symbol)"),
        symbol: z
          .string()
          .optional()
          .describe(
            "Symbol name to look up (finds Sections that document this function/class/file via DOC_DESCRIBES edges)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Maximum number of results to return"),
        projectId: z
          .string()
          .optional()
          .describe("Project ID (defaults to active session context)"),
      }),
    },
    async (args: any) => {
      if (!toolHandlers) {
        return {
          content: [{ type: "text", text: "Server not initialized" }],
          isError: true,
        };
      }
      try {
        const result = await toolHandlers.callTool("search_docs", args);
        return { content: [{ type: "text", text: result }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  return mcpServer;
}

// Start server with stdio transport
async function main() {
  await initialize();

  const transportMode = process.env.MCP_TRANSPORT || "stdio";

  if (transportMode === "http") {
    const port = parseInt(process.env.MCP_PORT || "9000", 10);
    const app = createMcpExpressApp();
    const sessions = new Map<
      string,
      { server: McpServer; transport: StreamableHTTPServerTransport }
    >();

    const handleMcpRequest = async (req: any, res: any) => {
      try {
        const headerSessionId = req.headers?.["mcp-session-id"];
        const sessionId =
          typeof headerSessionId === "string"
            ? headerSessionId
            : Array.isArray(headerSessionId)
              ? headerSessionId[0]
              : undefined;
        const isInitialize = req.body?.method === "initialize";

        if (isInitialize) {
          const sessionServer = createMcpServerInstance();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId: string) => {
              sessions.set(newSessionId, {
                server: sessionServer,
                transport,
              });
            },
          });

          transport.onclose = () => {
            const closedSessionId = transport.sessionId;
            if (!closedSessionId) {
              return;
            }

            const existing = sessions.get(closedSessionId);
            if (existing?.transport === transport) {
              sessions.delete(closedSessionId);
              void existing.server.close().catch((closeError) => {
                console.warn(
                  "[MCP] Failed to close session server after transport close:",
                  closeError,
                );
              });
            }
          };

          await sessionServer.connect(transport);

          await runWithRequestContext(
            { sessionId: transport.sessionId },
            async () => {
              await transport!.handleRequest(req, res, req.body);
            },
          );
          return;
        }

        if (!sessionId || !sessions.has(sessionId)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: Invalid or missing MCP session",
            },
            id: null,
          });
          return;
        }

        const sessionState = sessions.get(sessionId)!;
        await runWithRequestContext({ sessionId }, async () => {
          await sessionState.transport.handleRequest(req, res, req.body);
        });
      } catch (error: any) {
        console.error("[MCP] HTTP transport error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: error?.message || "Internal server error",
            },
            id: null,
          });
        }
      }
    };

    app.post("/", handleMcpRequest);
    app.post("/mcp", handleMcpRequest);

    app.get("/health", (_req: any, res: any) => {
      res.status(200).json({ status: "ok", transport: "http" });
    });

    // A2A Agent Card — Phase 4 / Section 0.4 of AGENT_CONTEXT_ENGINE_PLAN.md
    // Allows A2A-aware orchestrators (LangGraph, AutoGen, etc.) to discover
    // this server as a memory + coordination specialist agent.
    app.get("/.well-known/agent.json", (_req: any, res: any) => {
      const serverName =
        process.env.CODE_GRAPH_SERVER_NAME || "code-graph-server";
      res.status(200).json({
        "@context": "https://schema.a2aprotocol.dev/v1",
        "@type": "Agent",
        name: serverName,
        description:
          "External long-term memory and coordination layer for LLM agent fleets working on software codebases. Provides code graph queries, agent episode memory, multi-agent coordination, and PPR-ranked context packing.",
        capabilities: [
          "code-graph",
          "agent-memory",
          "agent-coordination",
          "multi-agent-coordination",
          "context-packing",
          "architecture-validation",
          "test-impact-analysis",
        ],
        mcpEndpoint: "/mcp",
        transport: "StreamableHTTP",
        version: "1.0.0",
      });
    });

    app.listen(port, () => {
      console.error(`[MCP] Server started on HTTP transport (port ${port})`);
      console.error("[MCP] Endpoints: POST / and POST /mcp");
      console.error("[MCP] A2A Agent Card: GET /.well-known/agent.json");
      console.error(
        `[MCP] Available tools: 26 (5 GraphRAG + 2 Architecture + 4 Test + 4 Progress + 4 Utility + 5 Vector Search + 2 Docs)`,
      );
    });

    return;
  }

  const mcpServer = createMcpServerInstance();
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);

  console.error("[MCP] Server started on stdio transport");
  console.error(
    `[MCP] Available tools: 26 (5 GraphRAG + 2 Architecture + 4 Test + 4 Progress + 4 Utility + 5 Vector Search + 2 Docs)`,
  );
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
