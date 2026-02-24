# lxRAG Tool Audit — lexRAG-visual (2026-02-23, run B)

**Workspace:** `/home/alex_rod/projects/code-visual`  
**Project ID:** `lexRAG-visual`  
**Rebuilt from:** empty Memgraph instance  
**Transaction:** `tx-5d021ec9`  
**Method:** lxRAG MCP tools only — no file reads, grep, or workspace list operations used for analysis  
**Prior audits:** [2026-02-22](lxrag-tool-audit-2026-02-22.md), [2026-02-23 run A](lxrag-tool-audit-2026-02-23.md)

---

## 1. Methodology

Tools were exercised in the following sequence after a clean full rebuild:

1. `init_project_setup` — one-shot workspace init
2. `graph_rebuild(full)` — explicit full rebuild with docs
3. `graph_health(debug)` — immediate post-build state
4. `graph_query(cypher)` — node/relationship census, path audit, REFERENCES edges
5. `arch_validate(strict)` — layer rule checking
6. `arch_suggest` — placement guidance (×2 types)
7. `graph_query(natural/hybrid/global)` — NL retrieval surface
8. `index_docs(withEmbeddings=true)` — doc indexing with embedding request
9. `graph_health(debug)` — post-docs state check
10. `semantic_search`, `code_explain`, `find_similar_code`, `semantic_slice`, `semantic_diff` — vector tool surface
11. `find_pattern` (×4 types) — structural pattern detection
12. `code_clusters` — function clustering
13. `blocking_issues` — issue detection
14. `reflect` — memory synthesis
15. `feature_status` — feature registry

---

## 2. Tool Availability Matrix

Compared against sessions 1 and 2 to track tool availability drift.

| Tool                    | Session 2 (2026-02-23a) | Session 3 (this run) | Notes                                                     |
| ----------------------- | ----------------------- | -------------------- | --------------------------------------------------------- |
| `init_project_setup`    | ✅                      | ✅                   |                                                           |
| `graph_rebuild`         | ✅                      | ✅                   |                                                           |
| `graph_health`          | ✅                      | ✅                   |                                                           |
| `graph_query (cypher)`  | ✅                      | ✅                   |                                                           |
| `graph_query (natural)` | ⚠️ broken               | ⚠️ broken            | Still returns 0 results                                   |
| `index_docs`            | ✅                      | ✅                   | `withEmbeddings=true` silently ignored                    |
| `arch_validate`         | ⚠️ degraded             | ⚠️ degraded          | No layer config                                           |
| `arch_suggest`          | ⚠️ wrong layer          | ⚠️ wrong layer       | Always returns `src/types/`                               |
| `reflect`               | ✅                      | ✅                   | 0 learnings (no episode history)                          |
| `feature_status`        | ⚠️ no registry          | ⚠️ no registry       |                                                           |
| `ref_query`             | ✅                      | ✅                   | Depth-limited, works on current repo                      |
| `find_pattern`          | ❌ disabled             | ⚠️ partial           | Now enabled; `circular` = not-implemented; others = empty |
| `semantic_search`       | ❌ disabled             | ⚠️ fails             | Now enabled; "No indexed symbols"                         |
| `find_similar_code`     | ❌ disabled             | ⚠️ fails             | Now enabled; "No indexed symbols"                         |
| `code_explain`          | ❌ disabled             | ⚠️ fails             | Now enabled; always ELEMENT_NOT_FOUND                     |
| `semantic_slice`        | ❌ disabled             | ⚠️ fails             | Now enabled; always SEMANTIC_SLICE_NOT_FOUND              |
| `semantic_diff`         | ❌ disabled             | ⚠️ fails             | Now enabled; always ELEMENT_NOT_FOUND                     |
| `code_clusters`         | ❌ disabled             | ⚠️ fails             | Now enabled; "No indexed symbols"                         |
| `blocking_issues`       | ❌ disabled             | ✅                   | Now enabled; returns empty results                        |
| `impact_analyze`        | ✅                      | ❌ not available     | Was working (broken) — now absent                         |
| `contract_validate`     | ✅                      | ❌ not available     | Was working — now absent                                  |
| `search_docs`           | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `diff_since`            | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `context_pack`          | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `progress_query`        | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `task_update`           | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `test_select`           | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `test_categorize`       | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `suggest_tests`         | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `episode_add/recall`    | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `agent_claim/release`   | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `coordination_overview` | ❌ disabled             | ❌ not available     | Still not accessible                                      |
| `decision_query`        | ❌ disabled             | ❌ not available     | Still not accessible                                      |

**Summary: 5 fully working, 9 enabled-but-broken, 15+ not available in this session.**

---

## 3. Post-rebuild Graph State

### Node census

| Node type | Count    | Delta vs run A |
| --------- | -------- | -------------- |
| VARIABLE  | 273      | —              |
| SECTION   | 265      | +18            |
| FUNCTION  | 90       | —              |
| EXPORT    | 69       | —              |
| CLASS     | 65       | —              |
| IMPORT    | 51       | —              |
| FILE      | 28       | —              |
| FOLDER    | 14       | —              |
| DOCUMENT  | 11       | +1             |
| COMMUNITY | 7        | +1             |
| **Total** | **873+** | **+80**        |

Health check reports 875 nodes / 1438 relationships (run A: 793 / 1079). The delta is explained by the new `docs/lxrag-tool-audit-2026-02-23.md` file being indexed.

### Relationship census

| Relationship   | Count  | Delta   |
| -------------- | ------ | ------- |
| CONTAINS       | 469    | —       |
| SECTION_OF     | 265    | +18     |
| NEXT_SECTION   | 254    | +17     |
| BELONGS_TO     | 186    | +3      |
| DOC_DESCRIBES  | 109    | +2      |
| EXPORTS        | 69     | —       |
| IMPORTS        | 51     | —       |
| **REFERENCES** | **36** | **new** |

**Key new relationship: `REFERENCES`** — 36 `(IMPORT)-[:REFERENCES]->(FILE)` edges that link each `IMPORT` node to its resolved target `FILE` node. This is a structural improvement over run A.

---

## 4. Findings

### F1 — File path normalization split (critical — persists from run A)

**Status:** Unresolved. Confirmed by Cypher query on this run.

- 22 `FILE` nodes: absolute paths (`/home/alex_rod/projects/code-visual/src/...`)
- 6 `FILE` nodes: relative paths (`src/components/...`, `src/lib/...`, `src/config/...`)

Relative-path files:

```
src/lib/graphVisuals.ts
src/lib/layoutEngine.ts
src/components/EdgeCanvas.tsx
src/components/controls/ArchitectureControls.tsx
src/components/controls/RefreshToggleControl.tsx
src/config/constants.ts
```

**New evidence this run:** `src/config/constants.ts` has 6 importers and `src/lib/layoutEngine.ts` has 3 importer REFERENCES edges — these are the most-imported files in the project. Their relative-path identifiers mean any tool that normalizes input paths to absolute will silently miss them.

---

### F2 — SECTION.relativePath always null (high — persists from run A)

**Status:** Unresolved. Confirmed 265/265 SECTION nodes have `relativePath=NULL` after a fresh full rebuild including `index_docs`.

`DOCUMENT` nodes correctly have `relativePath` (e.g., `docs/architecture.md`). The propagation to SECTION children is still broken in `DocsBuilder`.

---

### F3 — NL/hybrid retrieval returns 0 results (high — persists from run A)

**Status:** Unresolved. New test confirmed:

- `natural + local` → 0 results
- `natural + global` → 0 results
- `natural + hybrid` → 2 rows but both are empty sections (`communities=[], results=[]`)

`graph_health` still shows: `bm25IndexExists: false`, `retrieval.mode: lexical_fallback`, `embeddings.generated: 0`.

---

### F4 — `index_docs(withEmbeddings=true)` silently ignored (new — high)

**Evidence:** Called `index_docs(withEmbeddings=true, incremental=false)` → `ok=true, indexed=11, errors=0`. Subsequent `graph_health(debug)` shows:

```
embeddings.ready: false
embeddings.generated: 0
embeddings.coverage: 0
embeddings.recommendation: "Embeddings complete"   ← CONTRADICTION
```

**Impact:**

- The `withEmbeddings` parameter accepts `true` without error but has no effect — Qdrant is connected but receives no writes
- The health report contradicts itself: "Embeddings complete" with 0 generated, 0% coverage is actively misleading
- All 7 semantic tools that require embeddings (semantic_search, find_similar_code, code_clusters, semantic_diff, code_explain, semantic_slice, context_pack) will fail as long as this bug exists

**Fix direction:**

- Ensure `withEmbeddings=true` triggers the embedding pipeline against Qdrant rather than being a no-op
- Fix the health status: `"Embeddings complete"` must only appear when `generated > 0`; otherwise report `"Embeddings not generated — run index_docs with withEmbeddings=true"`

---

### F5 — All 7 semantic tools fail with "No indexed symbols" (new block — high)

**Evidence — each tested independently:**

| Tool                | Input tried                                     | Error                                                |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------- |
| `semantic_search`   | `query='graph node rendering', type='function'` | `SEMANTIC_SEARCH_FAILED: No indexed symbols found`   |
| `find_similar_code` | `elementId='lexRAG-visual:App.tsx:App:69'`      | `FIND_SIMILAR_CODE_FAILED: No indexed symbols found` |
| `code_clusters`     | `type='function', count=5`                      | `CODE_CLUSTERS_FAILED: No indexed symbols found`     |
| `code_explain`      | file path, full ID, simple name, all tried      | `ELEMENT_NOT_FOUND`                                  |
| `semantic_slice`    | symbol+file, relative path, absolute path       | `SEMANTIC_SLICE_NOT_FOUND`                           |
| `semantic_diff`     | exact IDs from Cypher query                     | `SEMANTIC_DIFF_ELEMENT_NOT_FOUND`                    |

**Root cause:** All these tools depend on a symbol index that is never populated because embeddings are never generated (F4). The tools were re-enabled in this session but are all in a permanently broken state until embeddings work.

**Additional note on `code_explain`:** It returns `ELEMENT_NOT_FOUND` even with the exact `id` value returned by Cypher (`lexRAG-visual:App.tsx:App:69`). It appears to use a different lookup key than the graph — likely a Qdrant vector store lookup by embedding, not a Memgraph lookup by ID.

---

### F6 — `find_pattern` partially non-functional (new)

**Evidence — tested all 4 types:**

| `type`      | Input              | Result                                          |
| ----------- | ------------------ | ----------------------------------------------- |
| `circular`  | "circular imports" | `status: "not-implemented"`                     |
| `unused`    | "unused exports"   | `matches: []` (empty, no actual scan)           |
| `violation` | "layer violation"  | `matches: []` (empty, no actual scan)           |
| `pattern`   | "React component"  | `status: "search-implemented"` but no `matches` |

**Impact:** `find_pattern` is now enabled and responds without errors, but delivers no actionable output. The `circular` type explicitly reports `not-implemented`. The `unused` and `violation` types appear to short-circuit without scanning the graph.

---

### F7 — COMMUNITY detection is path-segment based, not graph-based (new)

**Evidence from Cypher:**

```
community "home"        → [App.tsx, CanvasControls.tsx, ProjectControl.tsx, ...]
community "memgraphClient.ts" → [memgraphClient.ts] (single file)
community "graphVisuals.ts"   → [graphVisuals.ts] (single file)
community "layoutEngine.ts"   → [layoutEngine.ts, graphStore.ts]  ← unrelated files
community "config"       → [src/config/constants.ts]
community "components"   → [EdgeCanvas.tsx, ArchitectureControls.tsx, ...]
```

**Issues:**

1. **Community label "home"**: derived from the first segment of `/home/alex_rod/...` absolute paths — the algorithm is splitting on `/` and using path tokens as community names, not graph-clustering algorithms like Louvain or label propagation
2. **Single-file communities**: `memgraphClient.ts` and `graphVisuals.ts` are isolated into their own communities despite having multiple importers
3. **Mis-grouping**: `graphStore.ts` (absolute path) is in the same community as `layoutEngine.ts` (relative path) despite having no direct dependency relationship — likely a side effect of the path normalization bug
4. **`COMMUNITY.size` always null**: 7/7 community nodes have `size=null` — no member count is ever written

---

### F8 — Cache drift false-positive after rebuild (medium — persists from run A)

**Status:** Unresolved.

`graph_health` immediately after `graph_rebuild(full)`:

```
indexHealth.driftDetected: true
cachedNodes: 0
memgraphNodes: 875
```

The in-memory cache is never synchronized. Every agent session that calls `health → rebuild → health` will always see "out of sync" even when the data is fresh.

---

### F9 — arch_validate and arch_suggest require .lxrag/config.json (medium — persists from run A)

**Status:** Unresolved.

- `arch_validate(strict)`: all 6 tested files return `layer: unknown`, `severity: warn`
  - Only 4 absolute-path files produced violations; the 2 relative-path files (EdgeCanvas.tsx, graphVisuals.ts) did not appear in violations at all — another consequence of the path normalization split
- `arch_suggest`: tested `type=service`, `type=component` — both return `src/types/` with empty `reasoning` string

---

### F10 — Tool availability rotates between sessions (new — meta)

**Evidence:** Comparing tool sets across the three audit sessions:

- Session 1 (Feb 22): included `context_pack`, `diff_since`, `test_*`, `episode_*`, `agent_*`, `coordination_overview`
- Session 2 (Feb 23a): most of the above were disabled; `impact_analyze` and `contract_validate` were working
- Session 3 (this run): semantic tools now enabled; `impact_analyze`, `contract_validate`, and memory tools are absent

**Impact:**

- An agent cannot plan a reliable workflow because its tool surface changes between sessions
- A feature that appeared working in one session (e.g., `impact_analyze`) may be unavailable in the next
- There is no introspection tool to discover which tools are active in the current session before attempting to call them

**Fix direction:**

- Add a `tools_status` or `tools_list` endpoint returning the currently active tool manifest
- Tools that require configuration (embeddings, BM25, layer config) should be listed as conditionally available with a reason

---

### F11 — `REFERENCES` edges present but not surfaced by impact tools (medium)

**New structural finding:** This run discovered 36 `(IMPORT)-[:REFERENCES]->(FILE)` edges connecting import statements to resolved file targets. These enable dependency traversal:

```cypher
MATCH (fSrc:FILE)-[:IMPORTS]->(imp:IMPORT)-[:REFERENCES]->(fDst:FILE)
WHERE fDst.path CONTAINS 'constants.ts'
```

Returns 6 importers correctly. The data exists to power impact analysis via this path.

**Gap:** `impact_analyze` (unavailable this session) previously returned empty `directImpact=[]`. These REFERENCES edges should be the input for that traversal but the tool was not consuming them. See cross-check via raw Cypher: `src/config/constants.ts` has 6 importers through REFERENCES; `graphStore.ts` has 2. Impact analysis could be correct if it used `FILE -[:IMPORTS]-> IMPORT -[:REFERENCES]-> FILE` traversal.

---

## 5. Positive Observations

- `init_project_setup` + `graph_rebuild(full)` reliably bootstraps the workspace in one pass
- All 11 markdown documents are correctly indexed with populated `DOCUMENT.relativePath` — the docs pipeline is structurally sound except for SECTION child propagation
- `DOC_DESCRIBES` link quality: 109 edges across 3 target types (FILE=68, FUNCTION=27, CLASS=14) — doc-to-code cross-linking is working
- 7 COMMUNITY nodes produced; community membership via `BELONGS_TO` is correctly written (even if the grouping logic needs improvement)
- `graph_query(cypher)` remains fully reliable and expressive; complex queries with `WITH` clauses, aggregations, and multi-hop traversals all work
- `REFERENCES` edges are a structural improvement over the previous audit runs — the dependency graph now has richer connectivity
- Qdrant service is connected (`qdrantConnected: true`) — the embedding pipeline infrastructure is ready, only the write path is broken

---

## 6. Comparison with Previous Audits

| Finding                                      | Run A (Feb 22) | Run B (Feb 23a) | Run C (this)              |
| -------------------------------------------- | -------------- | --------------- | ------------------------- |
| Path normalization split (6 files)           | Found          | Confirmed       | Still present             |
| SECTION.relativePath null                    | Found          | Confirmed       | Still present             |
| NL retrieval broken                          | Found          | Confirmed       | Still present             |
| Cache drift false-positive                   | Found          | Confirmed       | Still present             |
| arch_suggest wrong layer                     | Found          | Confirmed       | Still present             |
| arch_validate no layer config                | Found          | Confirmed       | Still present             |
| `withEmbeddings=true` silently ignored       | —              | —               | **New**                   |
| Embeddings health contradicts itself         | —              | —               | **New**                   |
| Semantic tools all fail (enabled but broken) | disabled       | disabled        | **New (enabled, broken)** |
| `find_pattern` partial (not-implemented)     | disabled       | disabled        | **New (partial)**         |
| COMMUNITY path-segment grouping bug          | —              | —               | **New**                   |
| COMMUNITY.size always null                   | —              | —               | **New**                   |
| Tool availability rotates per session        | —              | Noted           | **Confirmed**             |
| REFERENCES edges now present                 | —              | absent          | **New structure**         |

---

## 7. Prioritized Fix Plan

| Priority | Finding                             | Fix                                                                                                      |
| -------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| P0       | F4 — `withEmbeddings=true` ignored  | Wire `index_docs` embedding param to Qdrant write pipeline                                               |
| P0       | F1 — Path normalization split       | Normalize all `FILE.path` to absolute at parse time                                                      |
| P1       | F5 — All semantic tools broken      | Once F4 fixed: semantic tools should work; also fix `code_explain` to use Memgraph ID lookup as fallback |
| P1       | F3 — NL retrieval returns 0         | Build BM25 index synchronously during `graph_rebuild`                                                    |
| P1       | F2 — SECTION.relativePath null      | Propagate `document.relativePath` to each child SECTION node                                             |
| P1       | F7 — COMMUNITY grouping wrong       | Replace path-segment tokenizing with graph-based community detection; populate `size`                    |
| P1       | F8 — Cache drift false-positive     | Sync in-memory cache after rebuild completes                                                             |
| P2       | F6 — find_pattern not-implemented   | Implement circular-dependency traversal using `IMPORTS+REFERENCES` path                                  |
| P2       | F9 — arch_suggest wrong layer       | Fix layer inference from `type` param; populate `reasoning` string                                       |
| P2       | F10 — Tool availability rotates     | Add `tools_list` introspection endpoint                                                                  |
| P2       | F11 — REFERENCES not used by impact | Use `FILE-[:IMPORTS]->IMPORT-[:REFERENCES]->FILE` path in `impact_analyze`                               |
| P3       | Embeddings health contradiction     | Fix health status string when `generated=0`                                                              |

---

## 8. Re-run Checklist

After fixes are applied, run these assertions:

- [ ] `MATCH (f:FILE) WHERE NOT f.path STARTS WITH '/' RETURN count(f)` → 0
- [ ] `MATCH (s:SECTION) WHERE s.relativePath IS NULL RETURN count(s)` → 0
- [ ] `graph_health` after full rebuild → `driftDetected: false`, `cachedNodes > 0`
- [ ] `index_docs(withEmbeddings=true)` → `graph_health` shows `embeddings.generated > 0`
- [ ] `semantic_search(query='React component')` → returns ≥1 result
- [ ] `code_explain(element='useGraphController')` → returns a description
- [ ] `graph_query(natural, 'graph node rendering')` → returns ≥1 result
- [ ] `arch_suggest(type='service')` → returns path under `src/lib/` or `src/services/`
- [ ] `find_pattern(type='circular')` → does not return `not-implemented`
- [ ] `MATCH (c:COMMUNITY) WHERE c.size IS NULL RETURN count(c)` → 0
- [ ] `MATCH (c:COMMUNITY) WHERE c.label = 'home' RETURN count(c)` → 0
- [ ] Tools list is stable across two consecutive sessions
