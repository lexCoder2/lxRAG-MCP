/**
 * stratSolver Code Graph MCP Server
 *
 * Provides 14 tools for code analysis:
 * - GraphRAG (3): graph_query, code_explain, find_pattern
 * - Architecture (2): arch_validate, arch_suggest
 * - Test Intelligence (4): test_select, test_categorize, impact_analyze, test_run
 * - Progress Tracking (4): progress_query, task_update, feature_status, blocking_issues
 * - Utility (1): graph_rebuild
 */

import * as fs from 'fs';
import * as path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  TextContent,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import MemgraphClient from './graph/client.js';
import GraphIndexManager from './graph/index.js';
import GraphOrchestrator from './graph/orchestrator.js';
import ToolHandlers from './tools/tool-handlers.js';
import { loadConfig } from './config.js';

// Tool definitions for MCP
const TOOLS: Tool[] = [
  // GraphRAG Tools
  {
    name: 'graph_query',
    description:
      'Execute Cypher or natural language query against the code graph. Supports queries about file structure, dependencies, imports, etc.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Either a Cypher query or natural language query (e.g., "show all files in components layer")',
        },
        language: {
          type: 'string',
          enum: ['cypher', 'natural'],
          description: 'Query language: cypher for Cypher syntax, natural for plain English',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 100)',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'code_explain',
    description:
      'Explain a code element (function, class, file) with graph context. Shows dependencies, callers, and related code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        element: {
          type: 'string',
          description: 'Code element identifier: filepath, class name, or function name',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth for dependency context (1-3, default: 2)',
        },
      },
      required: ['element'],
    },
  },

  {
    name: 'find_pattern',
    description:
      'Find architectural patterns or violations in the codebase. E.g., "find all components using BuildingContext" or "circular dependencies".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Pattern to search for or violation to detect',
        },
        type: {
          type: 'string',
          enum: ['pattern', 'violation', 'unused', 'circular'],
          description: 'Type of search',
        },
      },
      required: ['pattern'],
    },
  },

  // Architecture Tools
  {
    name: 'arch_validate',
    description: 'Validate code against architectural layer rules and constraints.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to validate (empty = all files)',
        },
        strict: {
          type: 'boolean',
          description: 'Treat warnings as errors (default: false)',
        },
      },
    },
  },

  {
    name: 'arch_suggest',
    description:
      'Suggest best location for new code based on dependencies and layer architecture.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Name of code to add (e.g., "NewCalculationService")',
        },
        type: {
          type: 'string',
          enum: ['component', 'hook', 'service', 'context', 'utility'],
          description: 'Type of code',
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modules this code will depend on',
        },
      },
      required: ['name', 'type'],
    },
  },

  // Test Intelligence Tools
  {
    name: 'test_select',
    description:
      'Select tests affected by changed files. Returns list of test files to run.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of changed file paths',
        },
        includeIntegration: {
          type: 'boolean',
          description: 'Include integration tests (default: true)',
        },
      },
      required: ['changedFiles'],
    },
  },

  {
    name: 'test_categorize',
    description:
      'Categorize tests as unit, integration, performance, or e2e based on patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        testFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test files to categorize (empty = all)',
        },
      },
    },
  },

  {
    name: 'impact_analyze',
    description:
      'Analyze change blast radius. Shows all affected tests and downstream code.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed file paths',
        },
        depth: {
          type: 'number',
          description: 'How deep to traverse dependencies (1-5)',
        },
      },
      required: ['changedFiles'],
    },
  },

  {
    name: 'test_run',
    description: 'Execute selected tests via Vitest.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        testFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Test files to run',
        },
        watch: {
          type: 'boolean',
          description: 'Run in watch mode',
        },
        coverage: {
          type: 'boolean',
          description: 'Generate coverage report',
        },
      },
      required: ['testFiles'],
    },
  },

  // Progress Tracking Tools
  {
    name: 'progress_query',
    description: 'Query features and tasks by status, assignee, or deadline.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['feature', 'task', 'milestone'],
          description: 'What to query',
        },
        filter: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'in-progress', 'completed', 'blocked'],
            },
            assignee: { type: 'string' },
            dueDate: { type: 'string' },
          },
          description: 'Filter criteria',
        },
      },
      required: ['type'],
    },
  },

  {
    name: 'task_update',
    description: 'Update task status, assignee, or due date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID to update',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in-progress', 'completed', 'blocked'],
          description: 'New status',
        },
        assignee: { type: 'string' },
        dueDate: { type: 'string', description: 'ISO 8601 date string' },
      },
      required: ['taskId'],
    },
  },

  {
    name: 'feature_status',
    description:
      'Show detailed status of a feature including implementing code, tests, and tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        featureId: {
          type: 'string',
          description: 'Feature ID or name',
        },
      },
      required: ['featureId'],
    },
  },

  {
    name: 'blocking_issues',
    description: 'Find tasks or features that are blocking progress.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['all', 'critical', 'features', 'tests'],
          description: 'What to search for',
        },
      },
    },
  },

  // Utility Tools
  {
    name: 'graph_rebuild',
    description:
      'Rebuild the code graph from scratch or incrementally update it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: {
          type: 'string',
          enum: ['full', 'incremental'],
          description: 'Rebuild mode (default: incremental)',
        },
        verbose: {
          type: 'boolean',
          description: 'Enable verbose logging',
        },
      },
    },
  },
];

class CodeGraphServer {
  private server: Server;
  private memgraph: MemgraphClient;
  private index: GraphIndexManager;
  private config: any;
  private toolHandlers: ToolHandlers | null = null;

  constructor() {
    this.server = new Server({
      name: 'stratSolver Code Graph',
      version: '0.0.1',
    });

    this.memgraph = new MemgraphClient({
      host: process.env.MEMGRAPH_HOST || 'localhost',
      port: parseInt(process.env.MEMGRAPH_PORT || '7687'),
    });

    this.index = new GraphIndexManager();
  }

  async start(): Promise<void> {
    try {
      // Load configuration
      try {
        this.config = await loadConfig();
        console.log('[CodeGraphServer] Configuration loaded');
      } catch (err) {
        console.warn('[CodeGraphServer] Using default configuration');
        this.config = { architecture: { layers: [], rules: [] } };
      }

      // Connect to Memgraph
      await this.memgraph.connect();
      console.log('[CodeGraphServer] Memgraph connected');

      // Initialize graph orchestrator and tool handlers
      const orchestrator = new GraphOrchestrator(this.memgraph, false);
      this.toolHandlers = new ToolHandlers({
        index: this.index,
        memgraph: this.memgraph,
        config: this.config,
        orchestrator,
      });

      console.log('[CodeGraphServer] Tool handlers initialized');

      // Setup MCP request handlers
      this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOLS,
      }));

      this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        return this.handleToolCall(request.params.name, request.params.arguments || {});
      });

      // Start MCP server (stdio transport)
      this.server.connect(process.stdin, process.stdout);
      console.log('[CodeGraphServer] Started successfully (stdio transport)');
    } catch (error) {
      console.error('[CodeGraphServer] Startup error:', error);
      process.exit(1);
    }
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; content: TextContent[] }> {
    try {
      if (!this.toolHandlers) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Tool handlers not initialized' }],
        };
      }

      // Call the appropriate tool handler
      const handler = (this.toolHandlers as any)[toolName];
      if (!handler) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        };
      }

      const result = await handler.call(this.toolHandlers, args);
      return {
        isError: false,
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error executing tool ${toolName}: ${error}` }],
      };
    }
  }
}

// Start server
const server = new CodeGraphServer();
server.start().catch(console.error);
