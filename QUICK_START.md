# Quick Start — Code Graph Server

Get the server running and connected in ~5 minutes.

## Prerequisites

- Docker & Docker Compose
- Node.js 24+

## 1. Start Infrastructure (1 min)

```bash
cd /home/alex_rod/code-graph-server
docker-compose up -d
docker-compose ps  # Wait for "healthy" status on Memgraph + Qdrant
```

## 2. Build the Server (1 min)

```bash
npm install
npm run build
```

To enable AST-accurate tree-sitter parsers (optional):

```bash
# Already included as optionalDependencies — npm install handles it
# Activate at runtime:
export CODE_GRAPH_USE_TREE_SITTER=true
```

## 3. Start the MCP HTTP Server

```bash
npm run start:http
# Expected: [CodeGraphServer] MCP HTTP server started on port 9000
```

Health check:

```bash
curl http://localhost:9000/health
```

## 4. Initialize an MCP Session and Build the Graph

Workspace context is **session-scoped**. Every client session must follow this sequence:

```bash
# Step 1: Initialize — capture mcp-session-id from the response header
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D - | grep -i mcp-session-id

# Step 2: Set workspace (replace SESSION_ID and /path/to/repo)
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_set_workspace","arguments":{"workspaceRoot":"/path/to/repo","projectId":"my-repo"}}}'

# Step 3: Trigger graph build
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graph_rebuild","arguments":{}}}'
```

Wait 5–30 s depending on repository size, then verify:

```bash
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"graph_health","arguments":{}}}'
```

## 5. Query

```bash
# Natural language graph query
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"graph_query","arguments":{"query":"find all classes in the engines layer","language":"natural"}}}'
```

**That's it!** See [QUICK_REFERENCE.md](QUICK_REFERENCE.md) for all 35 tools.

## 6. Point to a Different Project

Call `graph_set_workspace` again with the new `workspaceRoot`. One server instance handles multiple projects across sessions.

## Optional: Point Memgraph CLI at the Graph

```bash
docker-compose exec memgraph memgraph-cli --exec "MATCH (f:FILE) RETURN count(f)"
# Returns the number of indexed files
```

## Troubleshooting

| Problem                | Solution                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `400` from MCP         | Missing or stale `mcp-session-id`; re-send `initialize`      |
| Empty query results    | Call `graph_rebuild`, wait 10–15 s, then retry               |
| `Connection refused`   | Check `docker-compose ps`; ensure Memgraph on port 7687      |
| Build fails            | Run `npm run build` and check TypeScript errors              |
| Tree-sitter not active | Set `CODE_GRAPH_USE_TREE_SITTER=true` before starting server |

## Next Steps

1. Read [SETUP.md](SETUP.md) for VS Code / Copilot / Claude extension setup
2. Read [README.md](README.md) for full capability overview
3. Read [QUICK_REFERENCE.md](QUICK_REFERENCE.md) for all tools and common workflows
4. Read [ARCHITECTURE.md](ARCHITECTURE.md) for technical details
5. Read [docs/GRAPH_EXPERT_AGENT.md](docs/GRAPH_EXPERT_AGENT.md) for the agent runbook

## Total Setup Time: ~5 minutes

| Step                           | Time      |
| ------------------------------ | --------- |
| Docker startup                 | ~30 s     |
| `npm install && npm run build` | ~1 min    |
| Graph index (medium repo)      | 5–30 s    |
| First query                    | immediate |
