# Quick Start - Code Graph Tool

Get the graph server running in ~5 minutes.

## Prerequisites

- Docker & Docker Compose
- Node.js 18+
- Claude CLI: `npm install -g @anthropic-ai/claude`

## 1. Start Infrastructure (1 min)

```bash
cd /home/alex_rod/code-graph-server
# Optional but recommended for shared Memgraph:
export CODE_GRAPH_PROJECT_ID=my-repo
docker-compose up -d
docker-compose ps  # Wait for "healthy" status
```

## 2. Build Graph Server (1 min)

```bash
cd /home/alex_rod/code-graph-server
npm install
npm run build
```

## 3. Build Code Graph (2-3 min)

Parses all 696 TypeScript files and creates the graph:

```bash
npm run graph:build
```

Or manually:

```bash
node dist/index.js graph:build --verbose
```

## 4. Start MCP Server (immediate)

```bash
node dist/index.js
# Expected: [CodeGraphServer] Started successfully (stdio transport)
```

## 5. Use Claude CLI

In another terminal:

```bash
# Ask a question
claude --message "What architecture violations exist?"

# Or interactive mode
claude --interactive
> Which tests are affected by src/engine/calculations/columns.ts?
> Find circular dependencies
```

**That's it!** The MCP is configured globally at `~/.claude/mcp.json`.

## 6. Point to Current Project via MCP Tool

Before querying/rebuilding, set workspace dynamically from your MCP client:

- Call `graph_set_workspace` with `workspaceRoot` (or `workspacePath`), optional `sourceDir`, optional `projectId`
- Then call `graph_rebuild`

This makes one server instance work across different repositories without editing config paths.

## Verify Graph Has Data

```bash
docker-compose exec memgraph memgraph-cli --exec "MATCH (f:FILE) RETURN count(f)"
# Should return a non-zero number after indexing
```

## Troubleshooting

| Problem              | Solution                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| "Connection refused" | Ensure `docker-compose ps` shows all services healthy                                            |
| "No results"         | Run `npm run graph:build` to populate the graph                                                  |
| "Node not found"     | Set `MEMGRAPH_HOST=localhost` when running on host (`memgraph` only works inside Docker network) |
| "Build fails"        | Check `npm run build` compiles without errors                                                    |

## Next Steps

1. Read [README.md](README.md) for full documentation
2. Check [QUICK_REFERENCE.md](QUICK_REFERENCE.md) for common queries
3. Review [ARCHITECTURE.md](ARCHITECTURE.md) for technical details

## Total Setup Time: ~5 minutes

- Docker: 30 sec
- Build: 1 min
- Graph build: 2-3 min
- Server start: 5 sec
- Testing: 1 min
