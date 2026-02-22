# Code Graph Server

A graph-powered code intelligence server.

## Installation

Install via npm:

```bash
npm install -g @stratsolver/graph-server
```

Set `CODE_GRAPH_USE_TREE_SITTER=true` for AST-accurate parsing.

## Quick Start

Start the HTTP server:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "code-graph-server", version: "1.0.0" });
```

Use the `graph_rebuild` tool to index your project. The `GraphOrchestrator` handles
all parsing phases.

## Architecture

The server uses `MemgraphClient` for graph storage and `QdrantClient` for vector search.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for full details.

### Parser Registry

The `ParserRegistry` supports `TypeScriptParser`, `PythonParser`, `GoParser`, `RustParser`,
and `JavaParser`.

## Configuration

Edit `code-graph.json` to configure layers and rules.

## License

MIT
