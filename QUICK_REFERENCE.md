# Code Graph Server — Quick Reference

## Session Flow (MCP HTTP)

Every client session follows this sequence — workspace context is session-scoped:

```
1. POST /mcp  { method: "initialize" }          → capture mcp-session-id header
2. graph_set_workspace  workspaceRoot + projectId
3. graph_rebuild  (incremental by default)
4. graph_health   (confirm Memgraph + Qdrant ready)
5. query with any tool
```

Include `mcp-session-id` on every subsequent request for that session.

## Startup

```bash
# Start infrastructure (Memgraph MAGE + Qdrant)
docker-compose up -d

# Build and start HTTP server (port 9000)
npm install && npm run build
npm run start:http

# Health check
curl http://localhost:9000/health
```

## 33 MCP Tools

### Graph / Querying
| Tool | Purpose |
|------|---------|
| `graph_set_workspace` | Set project context for this session |
| `graph_rebuild` | Index/re-index the repository |
| `graph_health` | Check Memgraph, Qdrant, and index status |
| `graph_query` | Cypher or natural-language graph query |

### Code Intelligence
| Tool | Purpose |
|------|---------|
| `code_explain` | Explain symbol with dependency context |
| `find_pattern` | Detect patterns, violations, circular deps |
| `semantic_slice` | Extract semantically relevant code ranges |
| `context_pack` | Assemble cross-file context under token budget |
| `diff_since` | Show graph changes since a timestamp |

### Architecture
| Tool | Purpose |
|------|---------|
| `arch_validate` | Check layer rule violations |
| `arch_suggest` | Suggest correct layer for new code |

### Semantic / Similarity
| Tool | Purpose |
|------|---------|
| `semantic_search` | Vector + BM25 hybrid search |
| `find_similar_code` | Find code similar to a given symbol |
| `code_clusters` | Cluster related code by type |
| `semantic_diff` | Semantic difference between two symbols |

### Test Intelligence
| Tool | Purpose |
|------|---------|
| `test_select` | Select tests affected by changed files |
| `test_categorize` | Categorize test files by type |
| `impact_analyze` | Blast radius of a change |
| `test_run` | Execute selected test files |
| `suggest_tests` | Suggest tests for a symbol |

### Progress Tracking
| Tool | Purpose |
|------|---------|
| `progress_query` | Query task/feature progress |
| `task_update` | Update task status |
| `feature_status` | Status of features |
| `blocking_issues` | Find blocked items |

### Episode Memory
| Tool | Purpose |
|------|---------|
| `episode_add` | Record an observation, decision, or edit |
| `episode_recall` | Recall episodes by query or entity |
| `decision_query` | Query past agent decisions |
| `reflect` | Synthesize recent episodes |

### Agent Coordination
| Tool | Purpose |
|------|---------|
| `agent_claim` | Claim ownership of a task/file |
| `agent_release` | Release a claim |
| `agent_status` | Show active claims |
| `coordination_overview` | Full coordination state |

### Utility
| Tool | Purpose |
|------|---------|
| `contract_validate` | Normalize and validate tool inputs |

## Common Workflows

### Boot a new project context
```json
{ "name": "graph_set_workspace", "arguments": { "workspaceRoot": "/workspace", "projectId": "my-repo" } }
{ "name": "graph_rebuild", "arguments": {} }
{ "name": "graph_health", "arguments": {} }
```

### Find architecture violations
```json
{ "name": "arch_validate", "arguments": { "profile": "balanced" } }
```

### Test impact for changed files
```json
{ "name": "impact_analyze", "arguments": { "changedFiles": ["src/graph/orchestrator.ts"] } }
{ "name": "test_select", "arguments": { "changedFiles": ["src/graph/orchestrator.ts"] } }
```

### Natural language code query
```json
{ "name": "graph_query", "arguments": { "query": "find all classes that import from engines", "language": "natural" } }
```

## Environment Variables

```bash
MEMGRAPH_HOST=localhost       # default: localhost
MEMGRAPH_PORT=7687            # default: 7687
MCP_PORT=9000                 # default: 9000
CODE_GRAPH_PROJECT_ID=my-repo # optional: default project namespace
CODE_GRAPH_USE_TREE_SITTER=true  # enable AST-accurate parsers (requires optional deps)
```

## Tree-sitter Parsers

When `CODE_GRAPH_USE_TREE_SITTER=true`, AST-accurate parsers activate for:

| Language | Extensions | Fallback |
|----------|-----------|---------|
| TypeScript | `.ts` | regex parser |
| TSX | `.tsx` | regex parser |
| JavaScript | `.js`, `.mjs`, `.cjs` | FILE-node only |
| JSX | `.jsx` | FILE-node only |
| Python | `.py` | regex parser |
| Go | `.go` | regex parser |
| Rust | `.rs` | regex parser |
| Java | `.java` | regex parser |

Grammars are `optionalDependencies` — missing grammars fall back silently.

## File Locations

| What | Path |
|------|------|
| Server entry | `src/server.ts` |
| Tool handlers | `src/tools/tool-handlers.ts` |
| Graph orchestrator | `src/graph/orchestrator.ts` |
| TS/JS tree-sitter parsers | `src/parsers/tree-sitter-typescript-parser.ts` |
| Other language parsers | `src/parsers/tree-sitter-parser.ts` |
| Engines | `src/engines/` |
| Docker stack | `docker-compose.yml` |
| Runbook | `docs/GRAPH_EXPERT_AGENT.md` |

## Troubleshooting

| Problem | Solution |
|---------|---------|
| `400` from MCP | Missing or wrong `mcp-session-id`; re-initialize session |
| Empty graph results | Call `graph_rebuild` then wait 5–15 s before querying |
| Wrong project context | Call `graph_set_workspace` again with correct `workspaceRoot` |
| `Connection refused` | Run `docker-compose ps`; check Memgraph port 7687 |
| Tree-sitter not loading | Install optional deps: `npm install` (they are `optionalDependencies`) |

---

**Updated**: June 2025
