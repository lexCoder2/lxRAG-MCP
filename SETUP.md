# Setup Guide — LexRAG MCP Server

This guide takes you from zero to a fully wired LexRAG instance: infrastructure deployed, server running, your VS Code project indexed, and GitHub Copilot or Claude ready to query the graph.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Deploy the server](#2-deploy-the-server)
   - [Option A — Full Docker Compose (recommended)](#option-a--full-docker-compose-recommended)
   - [Option B — DBs in Docker, server on host (dev / debug)](#option-b--dbs-in-docker-server-on-host)
3. [Point the server at your project](#3-point-the-server-at-your-project)
4. [Configure GitHub Copilot (VS Code)](#4-configure-github-copilot-vs-code)
5. [Configure Claude (VS Code extension or Desktop)](#5-configure-claude-vs-code-extension-or-desktop)
6. [Add the agent instructions file](#6-add-the-agent-instructions-file)
7. [First session — initialize, build, verify](#7-first-session--initialize-build-verify)
8. [Optional environment variables](#8-optional-environment-variables)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites

| Requirement        | Version / notes                                     |
| ------------------ | --------------------------------------------------- |
| Node.js            | 24 or later (`node --version`)                      |
| Docker             | 24+ with Docker Compose v2 (`docker compose version`) |
| Git                | Any recent version                                  |
| VS Code            | 1.99+ (for MCP agent mode in Copilot)               |

Clone the repository once and keep it running as a background service alongside any project you work on.

```bash
git clone https://github.com/lexCoder2/code-graph-server.git
cd code-graph-server
npm install
npm run build
```

---

## 2. Deploy the server

### Option A — Full Docker Compose (recommended)

All four services (Memgraph, Qdrant, Memgraph Lab UI, and the graph server itself) start as containers. The graph server indexes the project mounted at `CODE_GRAPH_TARGET_WORKSPACE`.

```bash
# Set this to the absolute path of the project you want to index
export CODE_GRAPH_TARGET_WORKSPACE=/absolute/path/to/your-project

# Start everything
docker compose up -d

# Confirm all services are healthy (~30 s)
docker compose ps
```

Expected output when healthy:

```
NAME                       STATUS
code-graph-memgraph        running (healthy)
code-graph-qdrant          running
code-graph-memgraph-lab    running
code-graph-server          running (healthy)
```

Endpoints:

| Service          | URL                         |
| ---------------- | --------------------------- |
| MCP HTTP server  | `http://localhost:9000/mcp` |
| Health check     | `http://localhost:9000/health` |
| Memgraph Lab UI  | `http://localhost:3000`     |
| Qdrant REST API  | `http://localhost:6333`     |

> **Path note (Docker mode):** inside the container your project is mounted at `/workspace`. Always use `/workspace` (not the host path) when calling `graph_set_workspace` in Docker mode.

---

### Option B — DBs in Docker, server on host

Better for development: edit TypeScript source and restart the server without rebuilding an image.

**Step 1 — Start only the database containers:**

```bash
docker compose up -d memgraph qdrant
docker compose ps   # wait for memgraph to be healthy
```

**Step 2 — Start the server on the host:**

```bash
export MEMGRAPH_HOST=localhost
export MEMGRAPH_PORT=7687
export QDRANT_HOST=localhost
export QDRANT_PORT=6333
export MCP_PORT=9000

npm run start:http
# Expected: [CodeGraphServer] MCP HTTP server started on port 9000
```

Health check:

```bash
curl http://localhost:9000/health
# {"status":"ok"}
```

> In host mode your native absolute paths work directly in `graph_set_workspace` (e.g. `/home/you/your-project`).

---

## 3. Point the server at your project

The server is project-agnostic. You tell it which project to index by calling `graph_set_workspace` at the start of each MCP session (your editor extension handles this automatically once configured — see sections 4 and 5).

For Docker mode the mounted path is `/workspace` (controlled by `CODE_GRAPH_TARGET_WORKSPACE`).  
For host mode use the native absolute path to your project.

To index a **different project** without restarting: call `graph_set_workspace` again with the new path. One server instance handles multiple projects across independent MCP sessions.

**Persistent workspace default (optional):** set these env vars so the server auto-initializes to a specific project on startup:

```bash
export CODE_GRAPH_WORKSPACE_ROOT=/path/to/your-project   # host mode
export GRAPH_SOURCE_DIR=/path/to/your-project/src        # optional sub-dir
export CODE_GRAPH_PROJECT_ID=my-project                  # scopes the graph
```

---

## 4. Configure GitHub Copilot (VS Code)

GitHub Copilot agent mode (VS Code 1.99+) supports MCP servers via a `.vscode/mcp.json` file in your project, or via VS Code user settings.

### 4a. Per-project configuration (recommended)

Create `.vscode/mcp.json` in the root of **your project** (not the code-graph-server repo):

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

Commit this file so every contributor gets the MCP integration automatically.

### 4b. Global user configuration

Open **VS Code Settings** (`Cmd/Ctrl+,`) → search for `mcp` → add to `settings.json`:

```json
"github.copilot.chat.mcp.servers": {
  "code-graph": {
    "type": "http",
    "url": "http://localhost:9000/mcp"
  }
}
```

### 4c. Verify in VS Code

1. Open the Copilot Chat panel (Copilot icon in the Activity Bar).
2. Switch to **Agent** mode (the `@` selector or the agent mode toggle).
3. Type: `use the code-graph MCP tool to run graph_health`
4. Copilot should call the tool and return graph statistics.

> **Workspace context reminder:** Copilot initializes a new MCP session when VS Code starts. The agent must call `graph_set_workspace` then `graph_rebuild` once per session before graph tools return results. The instructions file described in [section 6](#6-add-the-agent-instructions-file) prompts Copilot to do this automatically.

---

## 5. Configure Claude (VS Code extension or Desktop)

### 5a. Claude VS Code extension

The [Claude for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-for-vscode) extension reads MCP servers from the same `.vscode/mcp.json` described in section 4a. No additional configuration is required if that file is already present.

If you prefer user-level config: open the extension settings and add the server under **MCP Servers**.

### 5b. Claude Desktop (macOS / Windows / Linux)

Claude Desktop uses a JSON config file. Add the MCP server entry based on your transport preference:

**Option 1 — stdio transport** (simpler, no server process needed, Claude Desktop spawns it):

Edit the Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/index.js"],
      "env": {
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333",
        "CODE_GRAPH_WORKSPACE_ROOT": "/absolute/path/to/your-project",
        "CODE_GRAPH_PROJECT_ID": "my-project"
      }
    }
  }
}
```

> The `dist/index.js` stdio entry point exposes the core graph tools. Build first with `npm run build`.

**Option 2 — HTTP transport** (if the server is already running):

```json
{
  "mcpServers": {
    "code-graph": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:9000/mcp"]
    }
  }
}
```

> `mcp-remote` bridges stdio (what Claude Desktop expects) to the HTTP server. Install it: `npm install -g mcp-remote`.

Restart Claude Desktop after editing the config. The `code-graph` server should appear in the tools panel.

---

## 6. Add the agent instructions file

For best results, copy the provided instructions template into **your project** so the agent knows how to use the graph tools without being told explicitly every time.

```bash
# From inside your project directory
mkdir -p .github
cp /path/to/code-graph-server/.github/copilot-instructions.md .github/copilot-instructions.md
```

Then edit the first few lines to reflect your project name and workspace path. The key directives that make the agent behave correctly:

- Always call `graph_set_workspace` + `graph_rebuild` at the start of a new session.
- Use `graph_query` for discovery before reading files.
- Pass the correct workspace paths for the runtime in use (Docker `/workspace` vs host native path).

VS Code reads `.github/copilot-instructions.md` automatically for Copilot. Claude Desktop picks it up if you include a reference in your system prompt or conversation opener.

---

## 7. First session — initialize, build, verify

Whether you're using a VS Code extension or testing manually via curl, the MCP session lifecycle is always:

```
initialize → graph_set_workspace → graph_rebuild → (wait) → graph_health → query
```

### Manual curl walkthrough

```bash
# 1. Initialize — capture the session ID from the response header
SESSION_ID=$(curl -s -D - -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-03-26",
        "capabilities":{},
        "clientInfo":{"name":"setup-test","version":"1.0"}
      }}' \
  | grep -i "^mcp-session-id:" | awk '{print $2}' | tr -d '\r')

echo "Session: $SESSION_ID"

# 2. Set workspace
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
        "name":"graph_set_workspace",
        "arguments":{
          "workspaceRoot":"/workspace",
          "sourceDir":"src",
          "projectId":"my-project"
        }
      }}'

# 3. Trigger graph build (runs in background, returns immediately)
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
        "name":"graph_rebuild",
        "arguments":{"mode":"full"}
      }}'

# 4. Wait ~10–30 s, then check health
sleep 15
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{
        "name":"graph_health",
        "arguments":{"profile":"compact"}
      }}'
```

A healthy response looks like:

```json
{
  "indexedSymbols": 312,
  "memgraphConnected": true,
  "qdrantConnected": false,
  "lastRebuild": "full",
  ...
}
```

### First useful queries

```bash
# Natural language: find the main entry points
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{
        "name":"graph_query",
        "arguments":{"query":"show me the top-level entry files","language":"natural","limit":5}
      }}'

# Explain a symbol in context
curl -s -X POST http://localhost:9000/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{
        "name":"code_explain",
        "arguments":{"symbol":"GraphOrchestrator","depth":2}
      }}'
```

---

## 8. Optional environment variables

| Variable                              | Default   | Description                                                    |
| ------------------------------------- | --------- | -------------------------------------------------------------- |
| `CODE_GRAPH_USE_TREE_SITTER`          | `false`   | Enable AST-accurate parsers for TS/TSX/JS/JSX/Python/Go/Rust/Java |
| `CODE_GRAPH_WORKSPACE_ROOT`           | —         | Default workspace path loaded on server startup                |
| `CODE_GRAPH_PROJECT_ID`               | `default` | Default project namespace                                      |
| `CODE_GRAPH_TARGET_WORKSPACE`         | —         | Host path mounted as `/workspace` in Docker Compose            |
| `CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK` | `false` | Allow host paths when running inside Docker                    |
| `CODE_GRAPH_SUMMARIZER_URL`           | —         | OpenAI-compatible endpoint for indexing-time symbol summaries  |
| `MEMGRAPH_HOST` / `MEMGRAPH_PORT`     | `localhost` / `7687` | Memgraph connection                                |
| `QDRANT_HOST` / `QDRANT_PORT`         | `localhost` / `6333` | Qdrant connection (optional; used for vector search) |
| `MCP_PORT`                            | `9000`    | HTTP server port                                               |
| `LOG_LEVEL`                           | `info`    | `error` / `warn` / `info` / `debug`                            |

Enable tree-sitter for significantly better parse accuracy on large TypeScript/Python projects:

```bash
export CODE_GRAPH_USE_TREE_SITTER=true
npm run start:http
```

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| `400 Bad Request` on MCP call | Missing or expired `mcp-session-id` | Re-send `initialize`, capture the new session ID |
| `graph_health` shows `indexedSymbols: 0` | Graph not yet built | Call `graph_rebuild` and wait 15–30 s |
| `Connection refused` on port 9000 | Server not running | `npm run start:http` or `docker compose up -d` |
| `Connection refused` on port 7687 | Memgraph not started | `docker compose up -d memgraph` |
| Empty results on `graph_query` | Wrong `workspaceRoot` path | Verify path: Docker needs `/workspace`, host needs native path |
| Copilot shows no MCP tools | Extension not detecting config | Reload VS Code window; check `.vscode/mcp.json` is valid JSON |
| `graph_rebuild` times out | MCP client waiting on async op | Normal — rebuild is fire-and-forget; poll `graph_health` |
| Build error `tsc` fails | Dependency drift | `npm install && npm run build` |
| Tree-sitter inactive | Env var not set | `export CODE_GRAPH_USE_TREE_SITTER=true` before starting server |
| `docs_index` not found (upgrade) | Old instance missing docs index | Run `graph_rebuild mode:full` once to create it |

---

## Next steps

- [QUICK_REFERENCE.md](QUICK_REFERENCE.md) — all 35 tools with descriptions and parameters
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical internals
- [docs/GRAPH_EXPERT_AGENT.md](docs/GRAPH_EXPERT_AGENT.md) — full agent runbook (tool priority, path rules, response shaping)
- [README.md](README.md) — capability overview and product summary
