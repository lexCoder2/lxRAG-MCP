# Quick Start — LexRAG MCP Server

Get the server running and your first query answered in ~5 minutes.

The server supports two transports. Pick the one that matches your client:

| Transport | Best for | Entry point |
| --------- | -------- | ----------- |
| **HTTP** | VS Code Copilot, Claude, remote agents, curl | `npm run start:http` |
| **stdio** | Claude Desktop, Claude Code, any stdio MCP client | `npm run start` |

Both transports expose all 35 tools and require the same infrastructure (Memgraph + Qdrant).

---

## Step 1 — Install and build

```bash
git clone https://github.com/lexCoder2/code-graph-server.git
cd code-graph-server
npm install && npm run build
```

Optional — enable AST-accurate tree-sitter parsers (recommended for TypeScript/Python projects):

```bash
export CODE_GRAPH_USE_TREE_SITTER=true
```

---

## Step 2 — Start infrastructure

```bash
docker compose up -d memgraph qdrant
docker compose ps   # wait until memgraph shows "healthy"
```

---

## Route A — HTTP transport

Use this when connecting from **VS Code Copilot**, **Claude extension**, or any HTTP-capable MCP client.

### Start the server

```bash
npm run start:http
# [CodeGraphServer] MCP HTTP server started on port 9000
```

Health check:

```bash
curl http://localhost:9000/health
# {"status":"ok"}
```

### Session flow

HTTP workspace context is **session-scoped** — every client connection must run this sequence once before tools return results.

```bash
# 1. Initialize — capture mcp-session-id from the response header
SESSION_ID=$(curl -s -D - -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-03-26","capabilities":{},
        "clientInfo":{"name":"my-client","version":"1.0"}}}' \
  | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

echo "Session: $SESSION_ID"

# 2. Set workspace
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"graph_set_workspace",
        "arguments":{"workspaceRoot":"/path/to/your-project","projectId":"my-repo"}}}'

# 3. Build the graph (async — returns immediately, indexes in background)
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"graph_rebuild","arguments":{"mode":"full"}}}'

# Wait 5–30 s, then verify
sleep 15
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
        "name":"graph_health","arguments":{"profile":"compact"}}}'
```

### Wire it to VS Code Copilot

Create `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "code-graph": {
      "type": "http",
      "url": "http://localhost:9000/mcp"
    }
  }
}
```

Open Copilot Chat → switch to **Agent** mode → the 35 tools are available immediately.

### First query over HTTP

```bash
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
        "name":"graph_query",
        "arguments":{"query":"find all classes in the engines layer","language":"natural"}}}'
```

---

## Route B — stdio transport

Use this when connecting from **Claude Desktop**, **Claude Code**, or any client that spawns the server process directly over stdin/stdout. No HTTP port, no session header — the client manages the connection.

### Start the server (manual test)

```bash
npm run start
# [MCP] Server started on stdio transport
```

The process reads JSON-RPC from stdin and writes responses to stdout. You won't interact with it manually — your MCP client does.

### Configure Claude Desktop

Edit the Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333",
        "CODE_GRAPH_WORKSPACE_ROOT": "/absolute/path/to/your-project",
        "CODE_GRAPH_PROJECT_ID": "my-repo"
      }
    }
  }
}
```

Restart Claude Desktop. The `code-graph` tools appear in the tool panel automatically.

### Configure VS Code Copilot (stdio process mode)

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "code-graph": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333",
        "CODE_GRAPH_WORKSPACE_ROOT": "${workspaceFolder}",
        "CODE_GRAPH_PROJECT_ID": "my-repo"
      }
    }
  }
}
```

> With stdio, the client sends `initialize` internally and manages the session. You still need to call `graph_set_workspace` and `graph_rebuild` once per session with the correct project path.

---

## Step 3 — Point to a different project

Call `graph_set_workspace` again with a new `workspaceRoot` at any time. One server instance handles multiple projects across independent sessions.

---

## Optional: inspect the graph directly

```bash
docker compose exec memgraph memgraph-cli --exec "MATCH (f:FILE) RETURN count(f)"
# Returns the number of indexed files
```

Memgraph Lab UI is also available at `http://localhost:3000` when running the full Docker Compose stack.

---

## Troubleshooting

| Problem | Solution |
| ------- | -------- |
| `400` on MCP call | Missing or expired `mcp-session-id` (HTTP only); re-send `initialize` |
| `graph_health` shows 0 symbols | `graph_rebuild` hasn't finished yet; wait 15 s and retry |
| `Connection refused` on port 9000 | Server not running; `npm run start:http` |
| `Connection refused` on port 7687 | Memgraph not started; `docker compose up -d memgraph` |
| Empty results on `graph_query` | Wrong `workspaceRoot`; verify the path matches the runtime (Docker: `/workspace`, host: native path) |
| Claude Desktop shows no tools | Config file path wrong or JSON invalid; restart Claude Desktop after fixing |
| stdio server exits immediately | Check `MEMGRAPH_HOST`/`QDRANT_HOST` env vars; the server logs errors to stderr |
| Build fails | `npm install && npm run build`; check TypeScript errors |
| Tree-sitter inactive | `export CODE_GRAPH_USE_TREE_SITTER=true` before starting the server |

---

## Next steps

1. [SETUP.md](SETUP.md) — full VS Code / Copilot / Claude extension wiring
2. [QUICK_REFERENCE.md](QUICK_REFERENCE.md) — all 35 tools with parameters
3. [README.md](README.md) — capability overview
4. [docs/GRAPH_EXPERT_AGENT.md](docs/GRAPH_EXPERT_AGENT.md) — agent runbook (tool priority, path rules, session patterns)

## Total setup time

| Step | Time |
| ---- | ---- |
| Docker startup | ~30 s |
| `npm install && npm run build` | ~1 min |
| Graph index (medium repo) | 5–30 s |
| First query | immediate |
