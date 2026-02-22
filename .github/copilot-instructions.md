# Copilot Instructions for Code Graph Server

You are working in the Code Graph MCP Server repository.

## Primary Goal

Use graph-backed tools first for code intelligence, then fall back to file reads only when needed.

## Runtime Truths

- MCP HTTP endpoints: `POST /` and `POST /mcp`
- Health endpoint: `GET /health`
- Workspace context is session-scoped (per MCP session)
- Graph rebuild is asynchronous (`status: QUEUED`)
- Docker image: `memgraph/memgraph-mage:latest` (provides Leiden, PageRank PPR, text_search)
- Set `CODE_GRAPH_USE_TREE_SITTER=true` to enable AST-accurate parsers for TS/TSX/JS/JSX/Python/Go/Rust/Java

## Required Session Flow (HTTP)

1. Send `initialize`
2. Capture `mcp-session-id` from response header
3. Include `mcp-session-id` on all subsequent requests in that VS Code window/session
4. Call `graph_set_workspace`
5. Call `graph_rebuild`

6. Validate via `graph_health` and `graph_query`

## Path Rules

- Docker runtime: use mounted container paths (commonly `/workspace`)
- Host runtime (Windows/Linux/macOS): use native absolute paths
- If requested path is inaccessible in Docker, report mount/path fix clearly

## Tool Priority

- Discovery/counts/listing: `graph_query`
- Dependency context: `code_explain`
- Architecture checks: `arch_validate`, `find_pattern`, `arch_suggest`
- Test impact: `impact_analyze`, `test_select`, `test_run`
- Similarity/search: `semantic_search`, `find_similar_code`, `code_clusters`
- Progress: `progress_query`, `feature_status`, `task_update`, `blocking_issues`
- Memory: `episode_add`, `episode_recall`, `decision_query`, `reflect`
- Coordination: `agent_claim`, `agent_release`, `agent_status`, `coordination_overview`
- Validation/normalization: `contract_validate`

## Output Requirements

Always include:

1. Active context (`projectId`, `workspaceRoot`)
2. Whether results are final or pending async rebuild
3. The single best next action
   MATCH (n)
   WHERE n.projectId = $projectId
   OPTIONAL MATCH (n)-[r]-(m)
   WHERE m.projectId = $projectId
   RETURN n, r, m
   LIMIT 2000;

## Source of Truth

For full runbook details, use `docs/GRAPH_EXPERT_AGENT.md`.
