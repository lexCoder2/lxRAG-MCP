# Code Graph Server

Code Graph Server is an MCP-native memory and code intelligence layer for software agents.

It turns your repository into a queryable graph + retrieval system so agents can answer architecture, impact, and planning questions without re-reading the entire codebase on every turn.

## Why this exists

LLM agents often fail on real repositories for three reasons:

- They lose context between sessions.
- They spend tokens repeatedly scanning the same files.
- They lack structured, cross-file dependency memory.

Code Graph Server addresses this by combining:

- Graph structure (files, symbols, relationships)
- Temporal memory (episodes, decisions, claims)
- Hybrid retrieval (vector + lexical + graph expansion)
- MCP tools for deterministic, automatable workflows

## What you get

### 1) Code intelligence for agents

- Natural-language and Cypher graph querying
- Symbol-level explanation with dependency context
- Pattern and architecture rule validation
- Semantic code slicing for targeted line ranges

### 2) Agent memory and coordination

- Persistent episode memory (`observation`, `decision`, `edit`, `test_result`, `error`)
- Claim/release workflow to reduce multi-agent collisions
- Coordination views for active ownership and blockers

### 3) Delivery acceleration

- Test impact analysis and selective test execution
- Graph-backed progress/task tracking
- Context packs that assemble high-value context under token budgets

## Product architecture

Code Graph Server runs as an MCP server over stdio or HTTP and coordinates three data planes:

- **Graph plane (Memgraph)**: structural and temporal truth (FILE/FUNCTION/CLASS/IMPORT + relationships + tx history)
- **Vector plane (Qdrant-compatible flow)**: semantic retrieval for natural questions
- **Response plane**: answer-first shaping with profile budgets (`compact`, `balanced`, `debug`)

Retrieval for natural queries uses hybrid fusion:

1. Vector retrieval
2. BM25/lexical retrieval (optional Memgraph `text_search`, fallback lexical scorer)
3. Graph expansion
4. Reciprocal Rank Fusion (RRF)

## Tooling surface

The server exposes 20+ MCP tools across:

- Graph/querying: `graph_query`, `code_explain`, `find_pattern`, `semantic_slice`, `context_pack`
- Architecture: `arch_validate`, `arch_suggest`
- Test intelligence: `test_select`, `test_categorize`, `impact_analyze`, `test_run`, `suggest_tests`
- Progress/operations: `progress_query`, `task_update`, `feature_status`, `blocking_issues`
- Memory/coordination: `episode_add`, `episode_recall`, `decision_query`, `reflect`, `agent_claim`, `agent_release`, `agent_status`, `coordination_overview`
- Runtime controls: `graph_set_workspace`, `graph_rebuild`, `graph_health`, `contract_validate`

## Quick start

### Prerequisites

- Node.js 18+
- Docker + Docker Compose
- Python 3 (for benchmark utilities)

### 1) Install and build

```bash
npm install
npm run build
```

### 2) Start infrastructure and server

```bash
docker-compose up -d
npm run start:http
```

Health endpoint:

```bash
curl http://localhost:9000/health
```

### 3) Required MCP HTTP session flow

Workspace context is session-scoped.

1. `initialize`
2. capture `mcp-session-id` response header
3. include `mcp-session-id` in all following calls for that client session
4. call `graph_set_workspace`
5. call `graph_rebuild`
6. query with `graph_query` / other tools

Example:

```bash
# initialize
curl -s -D /tmp/mcp_headers.txt -o /tmp/mcp_init.txt \
  -X POST http://localhost:9000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"client","version":"1.0.0"}}}'

SESSION_ID=$(grep -i '^mcp-session-id:' /tmp/mcp_headers.txt | awk '{print $2}' | tr -d '\r')

# set workspace
curl -s -X POST http://localhost:9000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_set_workspace","arguments":{"workspaceRoot":"/workspace","sourceDir":"src","projectId":"my-repo"}}}'

# queue rebuild
curl -s -X POST http://localhost:9000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"graph_rebuild","arguments":{"mode":"incremental"}}}'

# query
curl -s -X POST http://localhost:9000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"graph_query","arguments":{"query":"find key graph files","language":"natural","mode":"local","limit":5}}}'
```

## Runtime modes

- **stdio**: best for local editor integrations and short-lived sessions
- **http**: best for multi-client agent fleets and remote orchestration

Scripts:

- `npm run start` (server entry)
- `npm run start:http` (HTTP supervisor)
- `npm run build`
- `npm test`

## Repository map

- `src/server.ts`, `src/mcp-server.ts`: MCP/HTTP surfaces
- `src/tools/tool-handlers.ts`: tool orchestration layer
- `src/graph/*`: graph client, orchestrator, retrieval, watcher
- `src/engines/*`: architecture/test/progress/community/episode logic
- `src/response/*`: response shaping, schemas, summarization
- `docs/AGENT_CONTEXT_ENGINE_PLAN.md`: implementation plan and phase status
- `docs/GRAPH_EXPERT_AGENT.md`: runbook and operator guidance

## Product status

Current branch includes delivered slices for:

- Hybrid retrieval for natural `graph_query`
- Multi-language parser scaffolding and registry
- Watcher-driven incremental rebuild processing
- Temporal query/diff support (`asOf`, `diff_since`)
- Indexing-time symbol summarization
- Optional Memgraph `text_search` BM25 path with safe fallback

## Benchmarks and quality gates

Benchmark and regression scripts are included under `scripts/` and `benchmarks/` to track:

- latency
- token efficiency
- accuracy trends
- compact-profile response budget compliance

Run regression checks:

```bash
npm run benchmark:check-regression
```

## Integration guidance

For best results with GitHub Copilot and other MCP clients:

- Set workspace each session with `graph_set_workspace`
- Rebuild incrementally after file changes (`graph_rebuild` or watcher)
- Use `profile: compact` for low-token autonomous loops
- Use `balanced/debug` when deeper payloads are needed

See:

- `.github/copilot-instructions.md`
- `docs/GRAPH_EXPERT_AGENT.md`

## License

MIT
