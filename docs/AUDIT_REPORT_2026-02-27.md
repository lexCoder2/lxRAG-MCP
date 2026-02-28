# lxDIG MCP Tool Audit Report — 2026-02-27 (Second Run)

**Scope:** All 36 registered MCP tools
**Date:** 2026-02-27
**Branch:** `test/refactor`
**Graph state:** 69 FILE nodes · 141 FUNCTION · 172 CLASS · 78 DEPENDS_ON · projectId `lexdig-mcp`
**Prior session fixes applied:** ERR-01 (duplicate nodes), ERR-02 (testSuites passthrough), ERR-03 (DEPENDS_ON edges), ERR-04 (call_expression extraction), DEPENDS_ON combined-query fix, 1,831 stale `lxdig-mcp` node cleanup

---

## Summary

| Status | Count |
|--------|-------|
| ✅ Working | 21 |
| ⚠️ Partial | 5 |
| ❌ Broken | 10 |
| — Not tested | 5 |

---

## Errors Found

### ERR-A — Qdrant embeddings keyed to old `lexDIG-MCP` projectId *(CRITICAL)*

**Affects:** `semantic_search`, `find_similar_code`, `code_clusters`, `find_pattern` (type=pattern), `context_pack` (coreSymbols)

**Symptom:** All vector-similarity queries return 0 results regardless of query type (function / class / file) or topic.

**Root cause:** The 385 Qdrant points were indexed when `projectId = "lexDIG-MCP"`. After ERR-01 normalization, Memgraph uses `lexdig-mcp` but Qdrant payload still carries `projectId: "lexDIG-MCP"`. The embedding engine filters points by projectId at query time → no matches.

Confirmed by `graph_health`: `coverage: 1.008` (>1.0 means duplicate points from both variants coexist in Qdrant).

**Fix:**
```
Option A: Delete the lexDIG-MCP Qdrant collection and run graph_rebuild (embeddings will be re-generated under lexdig-mcp).
Option B: Bulk-update Qdrant payload: SET projectId = 'lexdig-mcp' WHERE projectId = 'lexDIG-MCP'.
```

---

### ERR-B — Test files excluded from build (server restart needed) *(HIGH)*

**Affects:** `test_select`, `test_categorize`, `suggest_tests`, `impact_analyze` (blastRadius=0)

**Symptom:** All test-intelligence tools return empty. `test_select` finds 0 tests for any changed source file. `test_categorize` reports 0 for explicitly passed `.test.ts` paths. Only 1 TEST_SUITE node (`"probe"`) in graph from 28 real test files.

**Root cause:** `"__tests__"` was hardcoded in the exclude list in both:
- `src/tools/handlers/core-graph-tools.ts:445`
- `src/tools/tool-handler-base.ts:1181`

28 test files are never parsed → no TEST_SUITE / TEST_CASE / test FILE nodes created.

**Fix status:** Code patched (`__tests__` removed, compiled). **Requires MCP server restart** (PIDs 13437, 53332, 54295), then `graph_rebuild mode=full`.

---

### ERR-C — `search_docs` uses un-normalized projectId *(MEDIUM)*

**Affects:** `search_docs`

**Symptom:** All queries return 0 results. Response metadata shows `projectId: "lexDIG-MCP"` (uppercase) while the 29 DOCUMENT nodes in Memgraph are stored under `lexdig-mcp` (lowercase).

**Root cause:** The docs engine resolves projectId via `path.basename(workspaceRoot)` = `"lexDIG-MCP"` without `.toLowerCase()`. The search Cypher query filters `WHERE n.projectId = "lexDIG-MCP"` and finds nothing.

**Fix:** Apply `.toLowerCase()` to projectId inside the docs-engine's search query path.
- File: `src/engines/docs-engine.ts` — normalize projectId before passing to Cypher queries.

---

### ERR-D — No PROGRESS_FEATURE nodes seeded *(MEDIUM)*

**Affects:** `progress_query`, `feature_status`, `task_update`

**Symptom:** `progress_query` returns 0 items for any status filter. `feature_status("phase-3")` returns `"Feature not found", availableFeatureIds: []`. No `PROGRESS_FEATURE` nodes exist in Memgraph.

**Root cause:** `orchestrator.build()` calls `seedProgressNodes()` which generates Cypher statements for PROGRESS nodes. These are included in the `statementsToExecute` batch. The rebuild consistently reports 5 Cypher statement failures — these are likely the progress seed statements failing due to a schema or label mismatch.

**Fix:**
1. Run `graph_rebuild verbose=true` to identify which 5 statements fail.
2. Check the `seedProgressNodes()` method in `orchestrator.ts` for label/property mismatches.

---

## Partial Issues

### WARN-1 — `code_explain` returns stale `projectId: "lexDIG-MCP"` in node properties

The in-memory `GraphIndexManager` still holds nodes indexed under the old uppercase projectId. Properties show `"projectId": "lexDIG-MCP"` even though Memgraph has `lexdig-mcp`. Dependencies are empty (`dependencies: []`) for all classes because the index was built before DEPENDS_ON edges were fully populated.

**Fix:** Server restart clears the in-memory index; first `graph_rebuild` after restart rebuilds it correctly.

---

### WARN-2 — `impact_analyze` blastRadius always 0

Correctly finds direct file dependencies via DEPENDS_ON (e.g., `builder.ts → orchestrator.ts`). However `blastRadius.testsAffected = 0` always because no TEST_SUITE nodes link to source files via TESTS relationships. Consequence of ERR-B.

**Fix:** Resolved automatically when ERR-B is fixed (server restart → rebuild).

---

### WARN-3 — `context_pack` coreSymbols always empty

Successfully returns recent episodes and learnings. `coreSymbols: []` and `entryPoint: "No entry point found"` for all tasks because the PPR-ranked symbol retrieval depends on Qdrant vector search (broken by ERR-A).

**Fix:** Resolved when ERR-A is fixed (Qdrant re-index).

---

### WARN-4 — `semantic_diff` is metadata-only, not semantic

`semantic_diff` compares property keys between two elements (`changedKeys: ["name","filePath","startLine","endLine","LOC","summary"]`) but performs no actual semantic/embedding similarity comparison.

**Observation:** This may be by design or may be incomplete implementation. No vector similarity score is returned.

---

### WARN-5 — `find_pattern(violation)` reports false positives from `.lxdig/config.json`

Finds real violations (e.g. `graph/orchestrator.ts` importing from `parsers`), but these are false positives: the `.lxdig/config.json` defines `graph canImport: ["types","utils","config"]` which is stricter than the default config (which allows `parsers`). `orchestrator.ts` importing parsers is architecturally intentional.

**Fix:** Update `.lxdig/config.json` — add `"parsers"`, `"response"`, and `"vector"` to the `graph` layer's `canImport` list to match actual architecture.

---

## Tool Status Table

| Tool | Status | Issue |
|------|--------|-------|
| `graph_health` | ✅ | Index drift noted |
| `tools_list` | ✅ | — |
| `graph_query` | ✅ | — |
| `graph_rebuild` | ✅ | 5 silent Cypher failures (ERR-D) |
| `graph_set_workspace` | ✅ | — |
| `diff_since` | ✅ | — |
| `contract_validate` | ✅ | — |
| `arch_suggest` | ✅ | — |
| `arch_validate` | ✅ | — |
| `find_pattern` (circular) | ✅ | — |
| `find_pattern` (unused) | ✅ | — |
| `find_pattern` (violation) | ✅ | WARN-5 (config mismatch) |
| `episode_add` | ✅ | — |
| `episode_recall` | ✅ | — |
| `decision_query` | ✅ | — |
| `reflect` | ✅ | — |
| `agent_claim` | ✅ | — |
| `agent_release` | ✅ | — |
| `agent_status` | ✅ | — |
| `coordination_overview` | ✅ | — |
| `blocking_issues` | ✅ | — |
| `code_explain` | ⚠️ | WARN-1 (stale projectId, empty deps) |
| `semantic_diff` | ⚠️ | WARN-4 (metadata-only) |
| `semantic_slice` | ⚠️ | `incomingCallers`/`outgoingCalls` empty (no CALLS_TO edges yet) |
| `impact_analyze` | ⚠️ | WARN-2 (blastRadius=0) |
| `context_pack` | ⚠️ | WARN-3 (coreSymbols empty) |
| `semantic_search` | ❌ | ERR-A |
| `find_similar_code` | ❌ | ERR-A |
| `code_clusters` | ❌ | ERR-A |
| `find_pattern` (pattern) | ❌ | ERR-A |
| `test_select` | ❌ | ERR-B |
| `test_categorize` | ❌ | ERR-B |
| `suggest_tests` | ❌ | ERR-B |
| `search_docs` | ❌ | ERR-C |
| `progress_query` | ❌ | ERR-D |
| `feature_status` | ❌ | ERR-D |
| `test_run` | — | Not tested (would execute tests) |
| `task_update` | — | Not tested (no progress nodes to update) |
| `index_docs` | — | Runs inside `graph_rebuild` |
| `init_project_setup` | — | Not tested |
| `ref_query` | — | Not tested (no sibling repo) |

---

## Graph Health Snapshot

| Metric | Value | Status |
|--------|-------|--------|
| Memgraph nodes total | 2,061 | |
| FILE nodes (`lexdig-mcp`) | 69 | ✅ |
| FUNCTION nodes | 141 | ✅ |
| CLASS nodes | 172 | ✅ |
| DEPENDS_ON edges | 78 | ✅ Fixed |
| TEST_SUITE nodes | 1 | ❌ ERR-B |
| PROGRESS_FEATURE nodes | 0 | ❌ ERR-D |
| Qdrant embeddings | 385 | ❌ Wrong projectId (ERR-A) |
| DOCUMENT nodes | 29 | ❌ Unsearchable (ERR-C) |
| Duplicate FILE nodes | 0 | ✅ Fixed |
| Stale `lxdig-mcp` nodes | 0 | ✅ Cleaned |

---

## Priority Fix Order

| Priority | ID | Action | Files | Effort |
|----------|----|--------|-------|--------|
| **P1** | ERR-B | Restart MCP server (code already patched) | — | ~1 min |
| **P1** | ERR-A | Delete `lexDIG-MCP` Qdrant collection, then `graph_rebuild` | — | ~5 min |
| **P2** | ERR-C | Add `.toLowerCase()` to projectId in docs-engine search | `src/engines/docs-engine.ts` | Small |
| **P2** | ERR-D | Debug `seedProgressNodes` — run verbose rebuild, fix 5 failing statements | `src/graph/orchestrator.ts` | Medium |
| **P3** | WARN-5 | Update `.lxdig/config.json` layer rules to match actual architecture | `.lxdig/config.json` | Small |
