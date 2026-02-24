/**
 * lxRAG MCP — stdio entry point (legacy)
 *
 * Thin stdio wrapper around ToolHandlers. For the full HTTP server (all 33
 * tools, multi-session, Streamable HTTP transport) use `src/server.ts` via
 * `npm run start:http`.
 */

import * as z from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import MemgraphClient from "./graph/client.js";
import GraphIndexManager from "./graph/index.js";
import GraphOrchestrator from "./graph/orchestrator.js";
import ToolHandlers from "./tools/tool-handlers.js";
import { loadConfig } from "./config.js";
import * as env from "./env.js";

// All tool names exposed by this entry point
const TOOL_NAMES = [
  "graph_query",
  "graph_set_workspace",
  "graph_rebuild",
  "graph_health",
  "tools_list",
  "code_explain",
  "find_pattern",
  "semantic_slice",
  "context_pack",
  "diff_since",
  "arch_validate",
  "arch_suggest",
  "semantic_search",
  "find_similar_code",
  "code_clusters",
  "semantic_diff",
  "test_select",
  "test_categorize",
  "impact_analyze",
  "test_run",
  "suggest_tests",
  "progress_query",
  "task_update",
  "feature_status",
  "blocking_issues",
  "episode_add",
  "episode_recall",
  "decision_query",
  "reflect",
  "agent_claim",
  "agent_release",
  "agent_status",
  "coordination_overview",
  "contract_validate",
  // Documentation tools (previously absent from stdio transport)
  "index_docs",
  "search_docs",
  // Reference and setup tools (previously absent from stdio transport)
  "ref_query",
  "init_project_setup",
  "setup_copilot_instructions",
] as const;

// Passthrough schema — full validation handled inside ToolHandlers
const passthroughSchema = z.object({}).passthrough();

class CodeGraphServer {
  private mcpServer: McpServer;
  private memgraph: MemgraphClient;
  private index: GraphIndexManager;
  private config: any;
  private toolHandlers: ToolHandlers | null = null;

  constructor() {
    this.mcpServer = new McpServer({
      name: env.LXRAG_SERVER_NAME,
      version: "1.0.0",
    });

    this.memgraph = new MemgraphClient({
      host: env.MEMGRAPH_HOST,
      port: env.MEMGRAPH_PORT,
    });

    this.index = new GraphIndexManager();
  }

  async start(): Promise<void> {
    try {
      // Load configuration
      try {
        this.config = await loadConfig();
        console.error("[CodeGraphServer] Configuration loaded");
      } catch {
        console.error("[CodeGraphServer] Using default configuration");
        this.config = { architecture: { layers: [], rules: [] } };
      }

      // Connect to Memgraph
      await this.memgraph.connect();
      console.error("[CodeGraphServer] Memgraph connected");

      // Initialize tool handlers
      // Pass sharedIndex so graph_rebuild syncs the in-memory index after each
      // build; without this, graph_health always reports driftDetected: true
      // because context.index stays at 0 nodes (A2 regression fix).
      const orchestrator = new GraphOrchestrator(this.memgraph, false, this.index);
      this.toolHandlers = new ToolHandlers({
        index: this.index,
        memgraph: this.memgraph,
        config: this.config,
        orchestrator,
      });

      console.error("[CodeGraphServer] Tool handlers initialized");

      // Register all tools — dispatch through callTool()
      for (const name of TOOL_NAMES) {
        this.mcpServer.registerTool(
          name,
          { inputSchema: passthroughSchema },
          async (args: any) => {
            if (!this.toolHandlers) {
              return {
                content: [
                  { type: "text" as const, text: "Server not initialized" },
                ],
                isError: true,
              };
            }
            try {
              const result = await this.toolHandlers.callTool(name, args);
              return { content: [{ type: "text" as const, text: result }] };
            } catch (error: any) {
              return {
                content: [
                  { type: "text" as const, text: `Error: ${error.message}` },
                ],
                isError: true,
              };
            }
          },
        );
      }

      // Start stdio transport
      const transport = new StdioServerTransport();
      await this.mcpServer.connect(transport);
      console.error("[CodeGraphServer] Started successfully (stdio transport)");
    } catch (error) {
      console.error("[CodeGraphServer] Startup error:", error);
      process.exit(1);
    }
  }
}

// Start server
const server = new CodeGraphServer();
server.start().catch(console.error);
