# Copilot Instructions for lexRAG MCP (code-graph-server)

## Primary Goal

Use graph-backed tools first for code intelligence, then fall back to file reads only when needed.
This server powers the StratsOlver graphExpert agent used by all sibling projects.

## Runtime Truths

- **Transport**: stdio (Node.js `dist/server.js`) — WSL users: use absolute nvm path
- **Entry**: `wsl -- /home/alex_rod/.nvm/versions/node/v22.17.0/bin/node /home/alex_rod/code-graph-server/dist/server.js`
- **Session**: workspace context is per MCP session — always call `graph_set_workspace` first
- **Graph rebuild**: asynchronous (`status: QUEUED`) — wait before intensive queries
- **Docker image**: `memgraph/memgraph-mage:latest` (Leiden, PageRank PPR, text_search)
- **Tree-sitter**: set `CODE_GRAPH_USE_TREE_SITTER=true` for AST-accurate TS/TSX/JS/Python/Go/Rust/Java

## Required Session Flow

1. `init_project_setup(workspaceRoot)` — sets context + triggers rebuild + generates instructions
2. `graph_health` — verify rebuild completed
3. `graph_query` — start exploration

## Active Projects Using This Server

| Project | Path | projectId |
|---------|------|-----------|
| cad-engine | `/home/alex_rod/projects/cad-engine` | `cad-engine` |
| cad-web | `/home/alex_rod/projects/cad-web` | `cad-web` |

## Tool Priority

| Task | Primary tool |
|------|-------------|
| Discovery / counts / listing | `graph_query` |
| Understand a symbol | `code_explain` |
| What breaks if I change X | `impact_analyze` |
| Where should new code go | `arch_suggest` |
| Layer rule violations | `arch_validate` |
| Tests affected by a change | `test_select` |
| Search by concept | `semantic_search` |
| Borrow from reference repo | `ref_query` |
| Track progress | `progress_query`, `feature_status`, `task_update` |
| Persist decisions | `episode_add`, `decision_query` |
| Coordination | `agent_claim`, `agent_release` |

## Path Rules

- Host runtime (WSL/Linux): use native absolute Linux paths
- Docker runtime: use mounted container paths (`/workspace`)
- Never guess paths — verify with `graph_query` or `list_dir`

## Output Requirements

Every response must include:

1. Active context (`projectId`, `workspaceRoot`)
2. Whether graph results are final or pending async rebuild
3. The single best next action

## Source of Truth

Full runbook: `docs/GRAPH_EXPERT_AGENT.md`
