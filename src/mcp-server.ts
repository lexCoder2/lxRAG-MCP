/**
 * MCP Server Implementation
 * Full Model Context Protocol server with all 14 tools
 */

import * as fs from "fs";
import * as path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  TextContent,
  Tool,
  Resource,
} from "@modelcontextprotocol/sdk/types.js";
import MemgraphClient from "./graph/client.js";
import GraphIndexManager from "./graph/index.js";
import ToolHandlers from "./tools/tool-handlers.js";

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "graph_query",
    description:
      "Execute Cypher or natural language query against the code graph. Supports queries about file structure, dependencies, imports, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Either a Cypher query or natural language query (e.g., "show all files in components layer")',
        },
        language: {
          type: "string",
          enum: ["cypher", "natural"],
          description:
            "Query language: cypher for Cypher syntax, natural for plain English",
        },
        mode: {
          type: "string",
          enum: ["local", "global", "hybrid"],
          description: "Query mode for natural language requests",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 100)",
        },
        asOf: {
          type: "string",
          description:
            "Optional ISO timestamp or epoch ms for temporal query mode",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "code_explain",
    description:
      "Explain a code element (function, class, file) with graph context. Shows dependencies, callers, and related code.",
    inputSchema: {
      type: "object",
      properties: {
        element: {
          type: "string",
          description:
            "Code element identifier: filepath, class name, or function name",
        },
        depth: {
          type: "number",
          description:
            "Traversal depth for dependency context (1-3, default: 2)",
        },
      },
      required: ["element"],
    },
  },

  {
    name: "find_pattern",
    description:
      'Find architectural patterns or violations in the codebase. E.g., "find all components using BuildingContext" or "circular dependencies".',
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Pattern to search for or violation to detect",
        },
        type: {
          type: "string",
          enum: ["pattern", "violation", "unused", "circular"],
          description: "Type of search",
        },
      },
      required: ["pattern"],
    },
  },

  {
    name: "arch_validate",
    description:
      "Validate code against architectural layer rules and constraints.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "File paths to validate (empty = all files)",
        },
        strict: {
          type: "boolean",
          description: "Treat warnings as errors (default: false)",
        },
      },
    },
  },

  {
    name: "arch_suggest",
    description:
      "Suggest best location for new code based on dependencies and layer architecture.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Name of code to add (e.g., "NewCalculationService")',
        },
        type: {
          type: "string",
          enum: [
            "component",
            "hook",
            "service",
            "context",
            "utility",
            "engine",
            "class",
            "module",
          ],
          description: "Type of code",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Modules this code will depend on",
        },
      },
      required: ["name", "type"],
    },
  },

  {
    name: "test_select",
    description:
      "Select tests affected by changed files. Returns list of test files to run.",
    inputSchema: {
      type: "object",
      properties: {
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "List of changed file paths",
        },
        includeIntegration: {
          type: "boolean",
          description: "Include integration tests (default: true)",
        },
      },
      required: ["changedFiles"],
    },
  },

  {
    name: "test_categorize",
    description:
      "Categorize tests as unit, integration, performance, or e2e based on patterns.",
    inputSchema: {
      type: "object",
      properties: {
        testFiles: {
          type: "array",
          items: { type: "string" },
          description: "Test files to categorize (empty = all)",
        },
      },
    },
  },

  {
    name: "impact_analyze",
    description:
      "Analyze change blast radius. Shows all affected tests and downstream code.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Changed file paths (primary parameter)",
        },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Alias for files — accepted for compatibility",
        },
        depth: {
          type: "number",
          description: "How deep to traverse dependencies (1-5)",
        },
      },
    },
  },

  {
    name: "test_run",
    description: "Execute selected tests via Vitest.",
    inputSchema: {
      type: "object",
      properties: {
        testFiles: {
          type: "array",
          items: { type: "string" },
          description: "Test files to run",
        },
        parallel: {
          type: "boolean",
          description: "Run tests in parallel (default: true)",
        },
      },
      required: ["testFiles"],
    },
  },

  {
    name: "progress_query",
    description: "Query features and tasks by status, assignee, or deadline.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["feature", "task", "milestone"],
          description: "What to query",
        },
        filter: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["pending", "in-progress", "completed", "blocked"],
            },
            assignee: { type: "string" },
            dueDate: { type: "string" },
          },
          description: "Filter criteria",
        },
      },
      required: ["type"],
    },
  },

  {
    name: "task_update",
    description: "Update task status, assignee, or due date.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task ID to update",
        },
        status: {
          type: "string",
          enum: ["pending", "in-progress", "completed", "blocked"],
          description: "New status",
        },
        assignee: { type: "string" },
        dueDate: { type: "string", description: "ISO 8601 date string" },
      },
      required: ["taskId"],
    },
  },

  {
    name: "feature_status",
    description:
      "Show detailed status of a feature including implementing code, tests, and tasks.",
    inputSchema: {
      type: "object",
      properties: {
        featureId: {
          type: "string",
          description: "Feature ID or name",
        },
      },
      required: ["featureId"],
    },
  },

  {
    name: "blocking_issues",
    description: "Find tasks or features that are blocking progress.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["all", "critical", "features", "tests"],
          description: "What to search for",
        },
      },
    },
  },

  {
    name: "graph_rebuild",
    description:
      "Rebuild the code graph from source files. Full mode reprocesses all files; incremental updates only changed files since the last build.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["full", "incremental"],
          description: "Rebuild mode (default: incremental)",
        },
        verbose: {
          type: "boolean",
          description: "Enable verbose logging",
        },
        workspaceRoot: {
          type: "string",
          description:
            "Absolute path to workspace root (overrides session context)",
        },
        sourceDir: {
          type: "string",
          description:
            "Source directory to scan (default: <workspaceRoot>/src)",
        },
        projectId: {
          type: "string",
          description: "Project identifier for graph node scoping",
        },
      },
    },
  },

  {
    name: "diff_since",
    description:
      "Summarize temporal graph changes since txId, timestamp, git commit, or agentId.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description:
            "Anchor value: txId, ISO timestamp, git commit SHA, or agentId",
        },
        projectId: {
          type: "string",
          description: "Optional project override",
        },
        types: {
          type: "array",
          items: {
            type: "string",
            enum: ["FILE", "FUNCTION", "CLASS"],
          },
          description: "Optional node types to include",
        },
        profile: {
          type: "string",
          enum: ["compact", "balanced", "debug"],
        },
      },
      required: ["since"],
    },
  },

  {
    name: "episode_add",
    description:
      "Persist an episode (observation, decision, edit, test result, or error) for agent memory.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: [
            "OBSERVATION",
            "DECISION",
            "EDIT",
            "TEST_RESULT",
            "ERROR",
            "REFLECTION",
            "LEARNING",
          ],
        },
        content: { type: "string" },
        entities: { type: "array", items: { type: "string" } },
        taskId: { type: "string" },
        outcome: {
          type: "string",
          enum: ["success", "failure", "partial"],
        },
        metadata: { type: "object" },
        sensitive: { type: "boolean" },
        agentId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["type", "content"],
    },
  },

  {
    name: "episode_recall",
    description:
      "Recall episodes using lexical, temporal, and graph-entity scoring.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        agentId: { type: "string" },
        taskId: { type: "string" },
        types: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
        since: { type: "string" },
      },
      required: ["query"],
    },
  },

  {
    name: "decision_query",
    description:
      "Recall decision episodes relevant to a query and affected files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        affectedFiles: { type: "array", items: { type: "string" } },
        taskId: { type: "string" },
        agentId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },

  {
    name: "reflect",
    description:
      "Synthesize reflections and learning nodes from recent episodes.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        agentId: { type: "string" },
        limit: { type: "number" },
      },
    },
  },

  {
    name: "agent_claim",
    description:
      "Create a coordination claim for a task or code target with conflict detection.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string" },
        claimType: {
          type: "string",
          enum: ["task", "file", "function", "feature"],
        },
        intent: { type: "string" },
        taskId: { type: "string" },
        agentId: { type: "string" },
        sessionId: { type: "string" },
      },
      required: ["targetId", "intent"],
    },
  },

  {
    name: "agent_release",
    description: "Release an active claim.",
    inputSchema: {
      type: "object",
      properties: {
        claimId: { type: "string" },
        outcome: { type: "string" },
      },
      required: ["claimId"],
    },
  },

  {
    name: "agent_status",
    description: "Get active claims and recent episodes for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
      },
      required: ["agentId"],
    },
  },

  {
    name: "coordination_overview",
    description:
      "Fleet-wide claim view including active claims, stale claims, and conflicts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "context_pack",
    description:
      "Build a single-call task briefing using PPR-ranked retrieval across code, decisions, learnings, and blockers.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        taskId: { type: "string" },
        agentId: { type: "string" },
        includeDecisions: { type: "boolean" },
        includeEpisodes: { type: "boolean" },
        includeLearnings: { type: "boolean" },
        profile: {
          type: "string",
          enum: ["compact", "balanced", "debug"],
        },
      },
      required: ["task"],
    },
  },

  {
    name: "semantic_slice",
    description:
      "Return relevant exact source lines with optional dependency and memory context.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        symbol: { type: "string" },
        query: { type: "string" },
        context: {
          type: "string",
          enum: ["signature", "body", "with-deps", "full"],
        },
        pprScore: { type: "number" },
        profile: {
          type: "string",
          enum: ["compact", "balanced", "debug"],
        },
      },
    },
  },
];

// Resource definitions
const RESOURCES: Resource[] = [
  {
    uri: "graph://schema",
    name: "Graph Schema",
    description: "Memgraph schema with 18 node types and 20 relationships",
    mimeType: "text/plain",
  },
  {
    uri: "graph://statistics",
    name: "Graph Statistics",
    description: "Current graph statistics (node counts, relationships, etc.)",
    mimeType: "application/json",
  },
  {
    uri: "graph://config",
    name: "Configuration",
    description: "Architecture layers, rules, and test categories",
    mimeType: "application/json",
  },
];

export class MCPServer {
  private server: Server;
  private memgraph: MemgraphClient;
  private index: GraphIndexManager;
  private handlers: ToolHandlers;
  private config: any;

  constructor() {
    this.server = new Server({
      name: process.env.CODE_GRAPH_SERVER_NAME || "Code Graph MCP Server",
      version: "1.0.0",
    });

    this.memgraph = new MemgraphClient({
      host: process.env.MEMGRAPH_HOST || "localhost",
      port: parseInt(process.env.MEMGRAPH_PORT || "7687"),
    });

    this.index = new GraphIndexManager();
    this.config = this.loadConfig();
    this.handlers = new ToolHandlers({
      index: this.index,
      memgraph: this.memgraph,
      config: this.config,
    });

    this.setupHandlers();
  }

  private loadConfig(): any {
    const configPath = path.resolve(process.cwd(), ".code-graph/config.json");
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
    return {};
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: RESOURCES,
    }));

    // Read resources
    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const uri = request.params.uri;

        if (uri === "graph://schema") {
          const schemaPath = path.resolve(
            process.cwd(),
            "tools/docker/init/schema.cypher",
          );
          if (fs.existsSync(schemaPath)) {
            const content = fs.readFileSync(schemaPath, "utf-8");
            return {
              contents: [
                {
                  uri,
                  mimeType: "text/plain",
                  text: content,
                },
              ],
            };
          }
        }

        if (uri === "graph://statistics") {
          const stats = this.index.getStatistics();
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(stats, null, 2),
              },
            ],
          };
        }

        if (uri === "graph://config") {
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(this.config, null, 2),
              },
            ],
          };
        }

        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text: `Resource not found: ${uri}`,
            },
          ],
        };
      },
    );

    // Call tools
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleToolCall(
        request.params.name,
        request.params.arguments || {},
      );
    });
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; content: TextContent[] }> {
    try {
      let result = "";

      // Type assertion to any to access dynamic method
      const handler = this.handlers as any;

      if (typeof handler[toolName] === "function") {
        result = await handler[toolName](args);
      } else {
        return {
          isError: true,
          content: [{ type: "text", text: `Tool not found: ${toolName}` }],
        };
      }

      return {
        isError: false,
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool execution failed: ${error}` }],
      };
    }
  }

  async start(): Promise<void> {
    // Connect to Memgraph
    await this.memgraph.connect();

    // Determine transport
    const transport = process.env.MCP_TRANSPORT || "stdio";

    if (transport === "stdio") {
      this.server.connect(process.stdin, process.stdout);
    } else if (transport === "http") {
      // HTTP transport could be added in future
      console.log("[MCPServer] HTTP transport not yet implemented");
    }

    console.log("[MCPServer] Started successfully");
    console.log(`[MCPServer] Available tools: ${TOOLS.length}`);
    console.log(`[MCPServer] Available resources: ${RESOURCES.length}`);
  }
}

// Export for testing
export default MCPServer;
