# Setup & Quick Start — lxDIG MCP Server

Everything you need to go from zero to a fully wired lxDIG instance: infrastructure up, server running, your project indexed, and your editor connected.

The server supports two transports — pick the one that matches your client:

| Transport                | Best for                                                           | Command              |
| ------------------------ | ------------------------------------------------------------------ | -------------------- |
| **stdio** ✅ recommended | Claude Desktop, VS Code Copilot, Claude Code, any stdio MCP client | `npm run start`      |
| **HTTP**                 | Remote agents, curl, multi-client fleets                           | `npm run start:http` |

Both transports expose all 38 tools and require the same infrastructure (Memgraph + Qdrant).

> **Recommended setup:** run the databases in Docker, run the MCP server directly on your host via stdio. No port management, no session ID headers — your editor spawns and owns the process.

---

## 1. Prerequisites

| Requirement | Version / notes                                       |
| ----------- | ----------------------------------------------------- |
| Node.js     | 24 or later (`node --version`)                        |
| Docker      | 24+ with Docker Compose v2 (`docker compose version`) |
| Git         | Any recent version                                    |
| VS Code     | 1.99+ (for MCP agent mode in Copilot)                 |

```bash
git clone https://github.com/lexCoder2/lxDIG-MCP.git
cd lxDIG-MCP
npm install && npm run build
```

Optional — enable AST-accurate tree-sitter parsers (recommended for TypeScript/Python projects):

```bash
export CODE_GRAPH_USE_TREE_SITTER=true
```

---

## 2. Start infrastructure

### Option A — DBs in Docker, server on host ✅ recommended

Run only Memgraph and Qdrant in Docker. The MCP server runs on your host and is managed by your editor via stdio — no image rebuilds, native paths, easy restarts.

```bash
# Start only the databases
docker compose up -d memgraph qdrant
docker compose ps   # wait for memgraph to show "healthy" (~30 s)
```

| Service         | URL                                                                       |
| --------------- | ------------------------------------------------------------------------- |
| Memgraph        | `bolt://localhost:7687`                                                   |
| Qdrant REST API | `http://localhost:6333`                                                   |
| Memgraph Lab UI | `http://localhost:3000` (optional — add `memgraph-lab` to the up command) |

Then configure your editor to spawn the server process (see Routes below). Use native absolute host paths in `graph_set_workspace`.

### Option B — Full Docker Compose

All services start as containers including the MCP HTTP server. Good for remote access or team deployments.

```bash
export CODE_GRAPH_TARGET_WORKSPACE=/absolute/path/to/your-project
docker compose up -d
docker compose ps   # wait for "healthy" on all services (~30 s)
```

| Service         | URL                            |
| --------------- | ------------------------------ |
| MCP HTTP server | `http://localhost:9000/mcp`    |
| Health check    | `http://localhost:9000/health` |
| Memgraph Lab UI | `http://localhost:3000`        |
| Qdrant REST API | `http://localhost:6333`        |

> **Docker path note:** your project is mounted at `/workspace` inside the container. Use `/workspace` (not the host path) when calling `graph_set_workspace` in Docker mode.

---

## 3. Route A — HTTP transport

Use this with **VS Code Copilot**, the **Claude VS Code extension**, or any HTTP MCP client.

### First session (curl)

HTTP workspace context is **session-scoped** — run this sequence once per client connection before tools return results.

```bash
# 1. Initialize — capture mcp-session-id from the response header
SESSION_ID=$(curl -s -D - -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-03-26","capabilities":{},
        "clientInfo":{"name":"my-client","version":"1.0"}}}' \
  | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

echo "Session: $SESSION_ID"

# 2. Set workspace (Docker mode: use /workspace; host mode: use native path)
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"graph_set_workspace",
        "arguments":{"workspaceRoot":"/path/to/your-project","sourceDir":"src","projectId":"my-repo"}}}'

# 3. Build the graph (async — indexes in background, returns immediately)
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"graph_rebuild","arguments":{"mode":"full"}}}'

# 4. Wait ~15 s, then verify
sleep 15
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
        "name":"graph_health","arguments":{"profile":"compact"}}}'
```

A healthy response looks like:

```json
{ "indexedSymbols": 312, "memgraphConnected": true, "lastRebuild": "full" }
```

### First queries

```bash
# Natural language
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
        "name":"graph_query",
        "arguments":{"query":"find all classes in the engines layer","language":"natural"}}}'

# Explain a symbol with its dependencies
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{
        "name":"code_explain",
        "arguments":{"symbol":"GraphOrchestrator","depth":2}}}'
```

### Connect VS Code Copilot ✅ recommended — stdio

Create `.vscode/mcp.json` in the root of **your project** and commit it. VS Code spawns the server process automatically — no HTTP port needed.

```json
{
  "servers": {
    "lxdig": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/lxDIG-MCP/dist/server.js"],
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

Open Copilot Chat → switch to **Agent** mode → the 38 tools are available immediately.

> With stdio, VS Code owns the server lifecycle. You still need to call `graph_set_workspace` + `graph_rebuild` once per session (or use `init_project_setup` to do both in one step).

#### Alternative — HTTP (if you prefer a persistent server process)

```json
{
  "servers": {
    "lxdig": {
      "type": "http",
      "url": "http://localhost:9000/mcp"
    }
  }
}
```

Or add it globally via **VS Code Settings** (`Cmd/Ctrl+,`) → search `mcp`:

```json
"github.copilot.chat.mcp.servers": {
  "lxdig": {
    "type": "http",
    "url": "http://localhost:9000/mcp"
  }
}
```

### Connect the Claude VS Code extension

The Claude extension reads the same `.vscode/mcp.json`. The stdio config above works as-is — no extra configuration needed.

---

## 4. Route B — stdio transport

Use this with **Claude Desktop**, **Claude Code**, or any client that spawns the server process directly. No HTTP port, no session header — the client manages the lifecycle.

The server process reads JSON-RPC from stdin and writes responses to stdout. Set `MCP_TRANSPORT=stdio` (the default when using `npm run start`).

### Configure Claude Desktop

Edit the config file for your OS:

| OS      | Path                                                              |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["/absolute/path/to/lxDIG-MCP/dist/server.js"],
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

### Connect VS Code Copilot (stdio)

Use the `.vscode/mcp.json` config shown in **Route A** above — it already uses stdio by default.

---

## 5. Add the agent instructions file

Copy the provided instructions template into **your project** so your agent auto-initializes sessions and uses the right tool order without being told each time:

```bash
mkdir -p /path/to/your-project/.github
cp /path/to/lxDIG-MCP/.github/copilot-instructions.md \
   /path/to/your-project/.github/copilot-instructions.md
```

Edit the first few lines to reflect your project name and workspace path. The key behaviors it enforces:

- Call `graph_set_workspace` + `graph_rebuild` at session start.
- Use `graph_query` for discovery before reading files.
- Use the correct path format for the runtime (`/workspace` for Docker, native path for host).

VS Code reads `.github/copilot-instructions.md` automatically. Claude Desktop picks it up if you reference it in a system prompt.

---

## 6. Persistent workspace defaults (optional)

Set these env vars to skip the `graph_set_workspace` call — the server auto-initializes to this project on startup:

```bash
export CODE_GRAPH_WORKSPACE_ROOT=/path/to/your-project
export GRAPH_SOURCE_DIR=/path/to/your-project/src   # optional sub-dir
export CODE_GRAPH_PROJECT_ID=my-project
```

To index a **different project** at any time: call `graph_set_workspace` again with the new path. One server instance handles multiple projects across independent sessions.

---

## 7. Optional environment variables

| Variable                                 | Default              | Description                                                   |
| ---------------------------------------- | -------------------- | ------------------------------------------------------------- |
| `CODE_GRAPH_USE_TREE_SITTER`             | `false`              | AST-accurate parsers for TS/TSX/JS/JSX/Python/Go/Rust/Java    |
| `CODE_GRAPH_WORKSPACE_ROOT`              | —                    | Default workspace path on startup                             |
| `CODE_GRAPH_PROJECT_ID`                  | `default`            | Default project namespace                                     |
| `CODE_GRAPH_TARGET_WORKSPACE`            | —                    | Host path mounted as `/workspace` in Docker Compose           |
| `CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK` | `false`              | Allow host paths when running inside Docker                   |
| `CODE_GRAPH_SUMMARIZER_URL`              | —                    | OpenAI-compatible endpoint for indexing-time symbol summaries |
| `MEMGRAPH_HOST` / `MEMGRAPH_PORT`        | `localhost` / `7687` | Memgraph connection                                           |
| `QDRANT_HOST` / `QDRANT_PORT`            | `localhost` / `6333` | Qdrant connection                                             |
| `MCP_PORT`                               | `9000`               | HTTP server port                                              |
| `MCP_TRANSPORT`                          | `stdio`              | `stdio` or `http`                                             |
| `LOG_LEVEL`                              | `info`               | `error` / `warn` / `info` / `debug`                           |

---

## 8. Troubleshooting

| Problem                             | Solution                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `400` on MCP call                   | Missing or expired `mcp-session-id` (HTTP only); re-send `initialize`       |
| `graph_health` shows 0 symbols      | `graph_rebuild` hasn't finished; wait 15 s and retry                        |
| `Connection refused` on port 9000   | Server not running; `npm run start:http` or `docker compose up -d`          |
| `Connection refused` on port 7687   | Memgraph not started; `docker compose up -d memgraph`                       |
| Empty results on `graph_query`      | Wrong `workspaceRoot` — Docker needs `/workspace`, host needs native path   |
| Copilot shows no MCP tools          | `.vscode/mcp.json` missing or invalid JSON; reload VS Code window           |
| Claude Desktop shows no tools       | Config file path wrong or JSON invalid; restart Claude Desktop after fixing |
| stdio server exits immediately      | Check `MEMGRAPH_HOST`/`QDRANT_HOST` env vars; errors go to stderr           |
| `graph_rebuild` returns immediately | Normal — it's async; poll `graph_health` until `indexedSymbols > 0`         |
| Build fails                         | `npm install && npm run build`; check TypeScript errors                     |
| Tree-sitter inactive                | `export CODE_GRAPH_USE_TREE_SITTER=true` before starting the server         |
| `docs_index` not found (upgrade)    | Run `graph_rebuild mode:full` once to create the missing index              |

---

## Inspect the graph directly

```bash
docker compose exec memgraph memgraph-cli --exec "MATCH (f:FILE) RETURN count(f)"
```

Memgraph Lab UI: `http://localhost:3000` (full Docker Compose stack only).

---

## Total setup time

| Step                           | Time      |
| ------------------------------ | --------- |
| Docker startup                 | ~30 s     |
| `npm install && npm run build` | ~1 min    |
| Graph index (medium repo)      | 5–30 s    |
| First query                    | immediate |

---

## Next steps

- [QUICK_REFERENCE.md](QUICK_REFERENCE.md) — all 35 tools with parameters
- [README.md](README.md) — capability overview
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical internals
- [docs/GRAPH_EXPERT_AGENT.md](docs/GRAPH_EXPERT_AGENT.md) — agent runbook (tool priority, path rules, response shaping)
