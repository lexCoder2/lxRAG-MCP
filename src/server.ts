/**
 * @file server
 * @description MCP server bootstrap supporting stdio and Streamable HTTP transports.
 * @remarks Tool registration is sourced from the centralized tool registry.
 */

import * as env from "./env.js";
import * as z from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import MemgraphClient from "./graph/client.js";
import GraphIndexManager from "./graph/index.js";
import { ToolHandlers } from "./tools/tool-handlers.js";
import { toolRegistry } from "./tools/registry.js";
import { loadConfig, type Config } from "./config.js";
import GraphOrchestrator from "./graph/orchestrator.js";
import { runWithRequestContext } from "./request-context.js";
import { logger } from "./utils/logger.js";

// Initialize components
const memgraph = new MemgraphClient({
  host: env.MEMGRAPH_HOST,
  port: env.MEMGRAPH_PORT,
});

const index = new GraphIndexManager();
let toolHandlers: ToolHandlers;
let config: Config = { architecture: { layers: [], rules: [] } };
let orchestrator: GraphOrchestrator;

/**
 * Initializes shared infrastructure required before serving requests.
 *
 * @remarks
 * This connects Memgraph, loads architecture config, and wires `ToolHandlers`
 * with the shared index/orchestrator instances.
 */
async function initialize() {
  try {
    await memgraph.connect();
    logger.error("[MCP] Memgraph connected");

    // Load architecture config if exists
    try {
      config = await loadConfig();
      logger.error("[MCP] Configuration loaded");
    } catch (_err) {
      logger.error("[MCP] No configuration file found, using defaults");
      config = { architecture: { layers: [], rules: [] } };
    }

    // Initialize GraphOrchestrator — pass shared index so post-build sync populates it
    orchestrator = new GraphOrchestrator(memgraph, false, index);

    toolHandlers = new ToolHandlers({
      index,
      memgraph,
      config,
      orchestrator: orchestrator,
    });

    logger.error("[MCP] Tool handlers initialized");
  } catch (error) {
    logger.error("[MCP] Initialization error:", error);
  }
}

// Server implementation info
const serverInfo = {
  name: env.LXRAG_SERVER_NAME,
  version: "1.0.0",
};

/**
 * Creates a configured MCP server instance and binds all registered tools.
 *
 * @returns A ready-to-connect `McpServer` instance.
 */
function createMcpServerInstance(): McpServer {
  const mcpServer = new McpServer(serverInfo);

  /**
   * Wraps registry-based tool execution into MCP response envelopes.
   */
  const invokeRegisteredTool = (toolName: string) => async (args: unknown) => {
    if (!toolHandlers) {
      return {
        content: [{ type: "text" as const, text: "Server not initialized" }],
        isError: true,
      };
    }
    try {
      const result = await toolHandlers.callTool(toolName, args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (error: unknown) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(error as Error).message}` }],
        isError: true,
      };
    }
  };

  /**
   * Registers one tool definition with zod input validation.
   */
  const registerTool = (name: string, description: string, inputSchema: z.ZodTypeAny) => {
    mcpServer.registerTool(
      name,
      {
        description,
        inputSchema,
      },
      invokeRegisteredTool(name),
    );
  };

  // Register all tools from centralized registry.
  for (const definition of toolRegistry) {
    registerTool(definition.name, definition.description, z.object(definition.inputShape));
  }

  return mcpServer;
}

/**
 * Process entrypoint.
 *
 * @remarks
 * Chooses transport mode (`stdio` or `http`), initializes per-session state,
 * and starts serving requests.
 */
async function main() {
  await initialize();

  const transportMode = env.MCP_TRANSPORT;

  if (transportMode === "http") {
    const port = env.MCP_PORT;
    const app = createMcpExpressApp();
    const sessions = new Map<
      string,
      { server: McpServer; transport: StreamableHTTPServerTransport }
    >();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                logger.warn(
                  "[MCP] Failed to close session server after transport close:",
                  closeError,
                );
              });
            }
          };

          await sessionServer.connect(transport);

          await runWithRequestContext({ sessionId: transport.sessionId }, async () => {
            await transport!.handleRequest(req, res, req.body);
          });
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
      } catch (error: unknown) {
        logger.error("[MCP] HTTP transport error:", error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: (error as Error)?.message || "Internal server error",
            },
            id: null,
          });
        }
      }
    };

    app.post("/", (req, res) => { void handleMcpRequest(req, res); });
    app.post("/mcp", (req, res) => { void handleMcpRequest(req, res); });

    app.get("/health", (_req, res) => {
      res.status(200).json({ status: "ok", transport: "http" });
    });

    // A2A Agent Card — Phase 4 / Section 0.4 of AGENT_CONTEXT_ENGINE_PLAN.md
    // Allows A2A-aware orchestrators (LangGraph, AutoGen, etc.) to discover
    // this server as a memory + coordination specialist agent.
    app.get("/.well-known/agent.json", (_req, res) => {
      const serverName = env.LXRAG_SERVER_NAME;
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
      logger.error(`[MCP] Server started on HTTP transport (port ${port})`);
      logger.error("[MCP] Endpoints: POST / and POST /mcp");
      logger.error("[MCP] A2A Agent Card: GET /.well-known/agent.json");
      logger.error(
        `[MCP] Available tools: 38 (5 GraphRAG + 2 Architecture + 4 Test + 4 Progress + 4 Utility + 5 Vector Search + 2 Docs + 1 Reference + 2 Setup)`,
      );
    });

    return;
  }

  const mcpServer = createMcpServerInstance();
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);

  logger.error("[MCP] Server started on stdio transport");
  logger.error(
    `[MCP] Available tools: 38 (5 GraphRAG + 2 Architecture + 4 Test + 4 Progress + 4 Utility + 5 Vector Search + 2 Docs + 1 Reference + 2 Setup)`,
  );
}

main().catch((error) => {
  logger.error("[MCP] Fatal error:", error);
  process.exit(1);
});
