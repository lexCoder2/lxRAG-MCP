# Graph Server Architecture

## Overview

The graph server provides MCP (Model Context Protocol) tools for code analysis, test intelligence, and progress tracking.

## Server Implementation Status

**Current State**: Two server implementations exist with different approaches:

### 1. **index.ts** (MCP SDK-based) ⚠️
- Uses `@modelcontextprotocol/sdk` for native MCP protocol
- Implements 14 tools directly
- Class: `CodeGraphServer`
- Connection: stdio transport
- **Status**: MVP implementation - tool handlers are stubs

### 2. **server.ts** (Express + JSON-RPC 2.0) ✅ RECOMMENDED
- Uses Express.js with JSON-RPC 2.0 protocol
- Implements all 14 tools via `ToolHandlers` class
- RESTful health checks: `GET /health`, `GET /info`
- Proper HTTP server for production use
- Tool execution: `POST /` with JSON-RPC 2.0 payload
- **Status**: More complete with engine initialization

## Recommendation

**Use `server.ts`** for the following reasons:
1. More flexible architecture (Express handles routing, CORS, etc.)
2. Better error handling and logging
3. Easier integration with VS Code and other clients
4. Health check endpoints for monitoring
5. Full tool context initialization (ArchitectureEngine, TestEngine, etc.)

The `index.ts` implementation can be deprecated or refactored when full MCP SDK support is needed.

## Key Files

- `src/server.ts` - Main Express server (JSON-RPC 2.0)
- `src/graph/orchestrator.ts` - Graph build orchestration
- `src/tools/tool-handlers.ts` - Tool implementations
- `src/engines/` - Specialized engines (architecture, test, progress)
- `src/graph/` - Graph data structures and client

## Environment Variables

```bash
MEMGRAPH_HOST=localhost    # Default: localhost
MEMGRAPH_PORT=7687         # Default: 7687
MCP_PORT=9000              # Default: 9000
MCP_TRANSPORT=stdio         # Not used with Express server
```

## API Endpoints (server.ts)

```bash
# Health check
GET http://localhost:9000/health

# Server info
GET http://localhost:9000/info

# Root info
GET http://localhost:9000/

# Tool execution (JSON-RPC 2.0)
POST http://localhost:9000/
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

## Build & Run

```bash
# Build
npm run build

# Development (watch mode)
npm run dev

# Start server
node dist/server.js
```

## Next Steps

1. **Consolidate**: Decide between MCP SDK vs JSON-RPC 2.0 approach
2. **Testing**: Add comprehensive tests for tool handlers
3. **Integration**: Connect with Memgraph for actual graph queries
4. **Documentation**: Add examples for each tool
5. **Monitoring**: Add metrics/observability
