# lxRAG Tool Issues (Session Findings)

## Scope
This document lists issues directly related to lxRAG tools observed during the current validation session in `code-visual`.

- Date: 2026-02-22
- Workspace: `/home/alex_rod/projects/code-visual`
- Project ID: `code-visual`
- Data source used for comparison: live Memgraph queries through `http://localhost:4001/query`

## Summary
Three lxRAG tool-level inconsistencies were reproduced against live graph data:

1. `mcp_lxrag_graph_health` reports an empty graph index while graph data exists.
2. `mcp_lxrag_feature_status` cannot resolve valid feature IDs present in the graph.
3. `mcp_lxrag_progress_query` returns no items while `TASK` nodes exist with valid statuses.

## CLI Cypher Commands Used in This Session
The graph checks and node/state validation in this session were executed from the command line via the proxy endpoint (`curl -> http://localhost:4001/query`).

Important: these graph observations came from CLI-applied Cypher queries; they were not created/validated exclusively by lxRAG tool responses.

### Commands run from terminal

#### Feature/task-target check
```bash
curl -s -X POST http://localhost:4001/query -H "Content-Type: application/json" -d '{"query":"MATCH (f:FEATURE {id:\"code-visual:feature:split-canvas-viewer\"}) OPTIONAL MATCH (t:TASK)-[:APPLIES_TO]->(f) OPTIONAL MATCH (f)-[:TARGETS]->(x) RETURN f.name as feature, f.status as status, count(DISTINCT t) as taskCount, count(DISTINCT x) as targetCount"}'
```

#### Global graph counts
```bash
curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (n) RETURN count(n) AS nodes"}'

curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH ()-[r]->() RETURN count(r) AS rels"}'
```

#### Top label distribution
```bash
curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (n) RETURN labels(n) AS labels, count(*) AS c ORDER BY c DESC LIMIT 15"}'
```

#### Feature inventory and project scoping
```bash
curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (f:FEATURE) RETURN f.id AS id, f.name AS name, f.status AS status, f.projectId AS projectId ORDER BY id"}'

curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (n) RETURN count(n.projectId) AS withProjectId, count(*) AS total"}'
```

#### Task totals and status breakdown
```bash
curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (t:TASK) RETURN count(t) AS taskCount"}'

curl -s -X POST http://localhost:4001/query -H 'Content-Type: application/json' -d '{"query":"MATCH (t:TASK) RETURN t.status AS status, count(*) AS c ORDER BY c DESC"}'
```

## Issues

### 1) `mcp_lxrag_graph_health` reports zero indexed graph entities

**Observed (tool):**
- `graphIndex.totalNodes = 0`
- `graphIndex.totalRelationships = 0`
- `indexedFiles = 0`

**Observed (live graph):**
- `MATCH (n) RETURN count(n)` → `809`
- `MATCH ()-[r]->() RETURN count(r)` → `1359`

**Impact:**
- Health checks are misleading and cannot be used as a readiness signal.
- Any feature depending on index stats may be incorrectly gated or disabled.

**Repro:**
1. Run `mcp_lxrag_graph_set_workspace` with `projectId=code-visual`.
2. Run `mcp_lxrag_graph_health`.
3. Compare with direct counts from Memgraph via proxy endpoint.

**Likely root cause (hypothesis):**
- Tool reads from a different index/state than the active Memgraph project context, or project-scoped filtering is not applied consistently.

---

### 2) `mcp_lxrag_feature_status` fails on valid feature IDs

**Observed (tool):**
- `Feature not found: code-visual:feature:phase-1`
- `Feature not found: code-visual:feature:simplification-phase-4`

**Observed (live graph):**
- `MATCH (f:FEATURE) RETURN f.id, f.name, f.status` returns those IDs and metadata.

**Impact:**
- Feature dashboards and status widgets based on this tool show false negatives.
- Automation relying on feature existence cannot progress reliably.

**Repro:**
1. Confirm feature IDs with direct query:
   - `MATCH (f:FEATURE) RETURN f.id, f.name, f.status ORDER BY f.id`
2. Run `mcp_lxrag_feature_status` for one returned ID.
3. Tool still reports "not found".

**Likely root cause (hypothesis):**
- Feature lookup path uses a mismatched namespace/index source or incorrect project scoping.

---

### 3) `mcp_lxrag_progress_query` returns empty despite existing tasks

**Observed (tool):**
- `items: []`
- `totalCount: 0`

**Observed (live graph):**
- `MATCH (t:TASK) RETURN count(t)` → `7`
- `MATCH (t:TASK) RETURN t.status, count(*)` → `completed:3`, `in-progress:2`, `pending:2`

**Impact:**
- Progress/reporting views may display no work in flight even when tasks exist.
- Status summaries become unreliable for planning workflows.

**Repro:**
1. Run `mcp_lxrag_progress_query` with a broad query (status `all`).
2. Compare with direct `TASK` counts in Memgraph.

**Likely root cause (hypothesis):**
- Query adapter maps request contract correctly but reads from a stale or differently scoped source.

## Cross-Issue Pattern
All three issues indicate a probable **read-path divergence** between lxRAG tools and the live Memgraph graph used by the app.

## Temporary Workarounds
- Use direct Memgraph queries via proxy for operational checks:
  - Node/relationship counts
  - Feature existence/status
  - Task totals and status breakdown
- Treat `graph_health`, `feature_status`, and `progress_query` as non-authoritative until parity is restored.

## Recommended Fix Order
1. Validate tool data source and project scoping (`projectId=code-visual`) for all three tools.
2. Add parity tests that compare tool responses vs direct graph queries for canonical fixtures.
3. Add diagnostics to each tool response (effective projectId, source, index generation timestamp).
4. Re-run parity checks and mark these issues closed only after exact-match thresholds are met.

## Acceptance Criteria for Resolution
- `mcp_lxrag_graph_health` reports non-zero graph index values that match direct graph counts within expected tolerance.
- `mcp_lxrag_feature_status` resolves known IDs from `FEATURE` nodes in current project scope.
- `mcp_lxrag_progress_query` returns item counts and status distribution consistent with `TASK` nodes in graph.
