# Graph Server Architecture

## Overview

Code Graph Server is a production MCP server that turns any repository into a queryable graph + retrieval system. It exposes **33 MCP tools** across code intelligence, architecture validation, test selection, agent memory, and multi-agent coordination.

## Server Implementation

Two server entry points exist — both production-ready:

| File | Transport | Use case |
|------|-----------|---------|
| `src/server.ts` | MCP HTTP (Streamable HTTP) | Production — multi-client, multi-session |
| `src/mcp-server.ts` | stdio | Editor integrations (single client) |
| `src/index.ts` | stdio (legacy) | Backward compat only |

**Recommended**: `src/server.ts` via `npm run start:http` for agent fleets; stdio entry (`src/mcp-server.ts`) for local editor use.

## Key Architectural Properties

- **Session-scoped workspace context**: each MCP session has its own project context (set via `graph_set_workspace`); no shared global state
- **Async graph rebuild**: `graph_rebuild` returns `status: QUEUED`; poll via `graph_health` / `graph_query` until ready
- **Hybrid retrieval**: natural `graph_query` uses vector + BM25/lexical + graph expansion with Reciprocal Rank Fusion (RRF)
- **Response shaping**: three profiles (`compact`, `balanced`, `debug`) with token budget enforcement

## Data Planes

```
┌──────────────────────────────────────────────────────────────┐
│  MCP Client (VS Code / agent / curl)                         │
└──────────────────┬───────────────────────────────────────────┘
                   │ MCP HTTP (Streamable HTTP)
┌──────────────────▼───────────────────────────────────────────┐
│  src/server.ts  — McpServer (MCP SDK)                        │
│  33 registered tools → ToolHandlers                          │
└────────┬──────────────────────────────────────────┬──────────┘
         │                                          │
┌────────▼──────────┐                  ┌────────────▼──────────┐
│  Memgraph (MAGE)  │                  │  Qdrant               │
│  graph plane      │                  │  vector plane         │
│  FILE/FUNCTION/   │                  │  embeddings per       │
│  CLASS/IMPORT     │                  │  function/class/file  │
│  + episodic nodes │                  │                       │
│  SCIP IDs on all  │                  │                       │
│  code nodes       │                  │                       │
└───────────────────┘                  └───────────────────────┘
```

## Graph Schema

Node labels and key properties:

| Label | Key properties |
|-------|---------------|
| `FILE` | `path`, `language`, `projectId`, `scipId`, `checksum` |
| `FUNCTION` | `name`, `startLine`, `endLine`, `language`, `projectId`, `scipId`, `scopePath` |
| `CLASS` | `name`, `startLine`, `endLine`, `language`, `projectId`, `scipId` |
| `IMPORT` | `source`, `symbols[]` |
| `EPISODE` | `type`, `content`, `agentId`, `taskId`, `timestamp`, `projectId` |
| `CLAIM` | `agentId`, `taskName`, `claimedAt`, `projectId` |

**SCIP IDs** (`scipId` field added to all code nodes):
- File: `src/tools/tool-handlers.ts`
- Function: `src/tools/tool-handlers.ts::callTool()`
- Method: `src/tools/tool-handlers.ts::ToolHandlers#arch_suggest()`
- Class: `src/tools/tool-handlers.ts::ToolHandlers#`

Relationships: `CONTAINS`, `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS`

## Parser Architecture

Parsing is handled in `src/graph/orchestrator.ts` which dispatches to the appropriate parser per file extension.

### Parser registry

| Language | Extensions | Parser (default) | Parser (tree-sitter, `CODE_GRAPH_USE_TREE_SITTER=true`) |
|----------|-----------|-----------------|--------------------------------------------------------|
| TypeScript | `.ts` | regex (typescript-parser.ts) | `TreeSitterTypeScriptParser` |
| TSX | `.tsx` | regex fallback | `TreeSitterTSXParser` |
| JavaScript | `.js`, `.mjs`, `.cjs` | FILE node only | `TreeSitterJavaScriptParser` |
| JSX | `.jsx` | FILE node only | `TreeSitterJSXParser` |
| Python | `.py` | regex | `TreeSitterPythonParser` |
| Go | `.go` | regex | `TreeSitterGoParser` |
| Rust | `.rs` | regex | `TreeSitterRustParser` |
| Java | `.java` | regex | `TreeSitterJavaParser` |

Tree-sitter grammars are `optionalDependencies`. Missing grammars fall back silently per language.

Parsers extract: functions, arrow-function consts, methods (with `scopePath`), classes, interfaces, type aliases, enums, imports.

### Parser source files

- `src/parsers/tree-sitter-typescript-parser.ts` — TS/TSX/JS/JSX parsers
- `src/parsers/tree-sitter-parser.ts` — Python/Go/Rust/Java parsers
- `src/parsers/typescript-parser.ts` — regex fallback for TypeScript

## MAGE Algorithms

The server uses **Memgraph MAGE** (`memgraph/memgraph-mage:latest`) for native graph algorithms:

| Algorithm | MAGE call | Fallback |
|-----------|----------|---------|
| Community detection (Leiden) | `CALL community_detection.get()` | directory heuristic |
| PageRank PPR | `CALL pagerank.get()` + 3-hop Cypher | JS power iteration |
| BM25 text search | `CALL text_search.search()` | lexical scorer |

Result objects include a `mode` field (`"mage_leiden"`, `"directory_heuristic"`, `"mage_pagerank"`, `"js_ppr"`) indicating which path ran.

## Engines

| Engine | File | Responsibility |
|--------|------|---------------|
| `GraphOrchestrator` | `src/graph/orchestrator.ts` | File discovery, parse dispatch, Memgraph writes, incremental/full rebuild |
| `ArchitectureEngine` | `src/engines/architecture-engine.ts` | Layer rules, violation detection, layer suggestion |
| `TestEngine` | `src/engines/test-engine.ts` | Test file detection, affected test selection, categorization |
| `ProgressEngine` | `src/engines/progress-engine.ts` | Task/feature CRUD, blocking issue detection |
| `EpisodeEngine` | `src/engines/episode-engine.ts` | Episodic memory, decision query, reflect synthesis |
| `CoordinationEngine` | `src/engines/coordination-engine.ts` | Agent claims, release, staleness detection |
| `CommunityDetector` | `src/engines/community-detector.ts` | Leiden / directory-heuristic communities |
| `EmbeddingEngine` | `src/vector/embedding-engine.ts` | Symbol embedding generation and lookup |
| `HybridRetriever` | `src/graph/hybrid-retriever.ts` | RRF fusion of vector + BM25 + graph expansion |
| `PPR` | `src/graph/ppr.ts` | Personalized PageRank for relevance ranking |

## Tool Surface (33 tools)

**Graph/querying** (4): `graph_set_workspace`, `graph_rebuild`, `graph_health`, `graph_query`

**Code intelligence** (5): `code_explain`, `find_pattern`, `semantic_slice`, `context_pack`, `diff_since`

**Architecture** (2): `arch_validate`, `arch_suggest`

**Semantic/similarity** (4): `semantic_search`, `find_similar_code`, `code_clusters`, `semantic_diff`

**Test intelligence** (5): `test_select`, `test_categorize`, `impact_analyze`, `test_run`, `suggest_tests`

**Progress tracking** (4): `progress_query`, `task_update`, `feature_status`, `blocking_issues`

**Episode memory** (4): `episode_add`, `episode_recall`, `decision_query`, `reflect`

**Agent coordination** (4): `agent_claim`, `agent_release`, `agent_status`, `coordination_overview`

**Utility** (1): `contract_validate`

## API Endpoints

```bash
# MCP Streamable HTTP
POST http://localhost:9000/
POST http://localhost:9000/mcp

# Health
GET  http://localhost:9000/health
GET  http://localhost:9000/info
```

## Environment Variables

```bash
MEMGRAPH_HOST=localhost          # default: localhost
MEMGRAPH_PORT=7687               # default: 7687
MCP_PORT=9000                    # default: 9000
CODE_GRAPH_PROJECT_ID=my-repo    # optional default project namespace
CODE_GRAPH_USE_TREE_SITTER=true  # enable tree-sitter AST parsers
```

## Build & Run

```bash
# Install (optionalDependencies include tree-sitter grammars)
npm install

# Build TypeScript
npm run build

# Start HTTP server (port 9000)
npm run start:http

# Development watch mode
npm run dev

# Run tests
npm test
```

## Docker Stack

```yaml
# docker-compose.yml uses:
memgraph/memgraph-mage:latest   # Memgraph with MAGE algorithms
qdrant/qdrant:latest            # Vector database
```

## Response Profiles

All tools accept `profile` parameter:

| Profile | Description |
|---------|-------------|
| `compact` (default) | Low-token, answer-first; omits verbose metadata |
| `balanced` | Moderate context with key supporting data |
| `debug` | Full unshaped payload for investigation |

## Repository Map

```
src/
  server.ts                    MCP HTTP surface (33 tools)
  mcp-server.ts                stdio MCP surface
  index.ts                     legacy stdio entry
  config.ts                    environment config
  tools/
    tool-handlers.ts           all 33 tool implementations
  graph/
    orchestrator.ts            file discovery + parse dispatch + Memgraph writes
    client.ts                  Memgraph Bolt client
    builder.ts                 Cypher node/edge builders (SCIP IDs)
    hybrid-retriever.ts        RRF fusion retrieval
    ppr.ts                     Personalized PageRank
    watcher.ts                 file watcher for incremental rebuilds
    cache.ts                   query result cache
  parsers/
    tree-sitter-typescript-parser.ts   TS/TSX/JS/JSX tree-sitter parsers
    tree-sitter-parser.ts              Python/Go/Rust/Java tree-sitter parsers
    typescript-parser.ts               regex fallback for TypeScript
  engines/
    architecture-engine.ts
    test-engine.ts
    progress-engine.ts
    episode-engine.ts
    coordination-engine.ts
    community-detector.ts
    migration-engine.ts
  vector/
    embedding-engine.ts
    qdrant-client.ts
  response/
    budget.ts                  token budget enforcement
  cli/                         CLI utilities
docs/
  GRAPH_EXPERT_AGENT.md        agent runbook
  AGENT_CONTEXT_ENGINE_PLAN.md implementation plan + phase status
```
