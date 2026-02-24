# lxRAG Tool Audit — code-visual

Date: 2026-02-22  
Scope: `/home/alex_rod/projects/code-visual`  
Method: **lxRAG tools only** (no file reads/grep/list/search tools used for analysis)

---

## 1) Goal and execution mode

Audit this repository using lxRAG tools to:

1. Build/index graph data
2. Review architecture/tool functionality
3. Index/query documentation graph data
4. Detect missing features or errors to fix

---

## 2) Tools exercised

The following lxRAG tools were exercised in this audit:

- `graph_rebuild` (full)
- `graph_health` (balanced/debug)
- `graph_query` (natural + cypher)
- `arch_validate` (strict)
- `find_pattern` (`circular`, `unused`, `violation`)
- `index_docs` (full re-index)
- `impact_analyze`
- `contract_validate`
- `feature_status`
- `reflect`
- `suggest_tests`
- `semantic_diff`
- `ref_query`

---

## 3) High-level results

### 3.1 Graph build/status

- `graph_rebuild(mode=full)` succeeded and produced tx `tx-a4c46341`.
- `graph_health(debug)` showed:
  - `memgraphConnected: true`
  - `qdrantConnected: true`
  - graphIndex summary (for active context):
    - `totalNodes: 829`
    - `totalRelationships: 1348`
    - `indexedFiles: 28`
    - `indexedFunctions: 90`
    - `indexedClasses: 65`
  - `indexHealth.driftDetected: true`
  - retrieval mode: `lexical_fallback`
  - `bm25IndexExists: false`

### 3.2 Architecture/pattern tools

- `arch_validate(strict=true)` returned warnings for all checked files due to **unknown layer assignment**:
  - `src/App.tsx`
  - `src/hooks/useGraphController.ts`
  - `src/state/graphStore.ts`
  - `src/lib/memgraphClient.ts`
- `find_pattern(type=circular)` returned:
  - `Circular dependency detection requires full graph traversal`
  - `status: not-implemented`
- `find_pattern(type=unused)` returned no matches.
- `find_pattern(type=violation)` returned no matches.

### 3.3 Documentation graph tools

- `index_docs(incremental=false)` succeeded: `indexed=9`, `errors=0`.
- Cypher checks after indexing:
  - `DOCUMENT` count = `42`
  - `SECTION` count = `1085`
  - `SECTION.relativePath IS NULL` count = `1085` (100% null in this run)

### 3.4 Impact/test intelligence

- `impact_analyze` (both relative + absolute file paths) returned:
  - `directImpact: []`
  - `testsSelected: 0`
  - `totalTests: 0`
  - `coverage: 0%`
- `suggest_tests(elementId=lexRAG-visual:file:src/lib/memgraphClient.ts)` failed:
  - `SUGGEST_TESTS_ELEMENT_NOT_FOUND`

### 3.5 Semantic/feature/memory tools

- `semantic_diff` failed for IDs returned by `graph_query`:
  - `SEMANTIC_DIFF_ELEMENT_NOT_FOUND`
- `feature_status` with plausible IDs failed:
  - `Feature not found: docs-indexing`
  - `Feature not found: architecture-validation`
- `reflect(limit=20)` succeeded but returned 0 learnings (no episode history in active context).

### 3.6 Reference query

- `ref_query` to `/home/alex_rod/projects/lxRAG-MCP` failed with `REF_REPO_NOT_FOUND` (path inaccessible in this runtime).
- `ref_query` to current repo path succeeded and returned ranked code findings (App/controller/store/client/viewer files).

---

## 4) Critical findings (bugs / missing functionality)

## F1 — Project data isolation leakage (critical)

Evidence:

- Querying `FILE.path` returned entries from another repo path (`/home/alex_rod/projects/lexRAG-MCP/...`) while active project context is `lexRAG-visual`.
- Aggregate check:
  - `codeVisualFiles = 22`
  - `lexRagMcpFiles = 60`
  - `totalFiles = 88`

Impact:

- Cross-project contamination degrades trust in analysis, architecture checks, and impact outputs.
- Natural/hybrid answers can be empty or irrelevant because data scope is mixed.

Likely fix direction:

1. Enforce strict `projectId` scoping in every query path (including fallback and summary queries).
2. Add hard filter guards to tool handlers when workspace/project context is set.
3. Add regression tests for multi-project isolation (`graph_query`, `index_docs`, `impact_analyze`, `suggest_tests`).

## F2 — Natural/hybrid retrieval not useful in this context (high)

Evidence:

- Multiple `graph_query(language=natural, mode=hybrid)` calls returned only empty `global/local` sections.
- Cypher queries returned data immediately.

Impact:

- Core natural language workflow is non-functional for practical analysis.

Likely fix direction:

1. Diagnose hybrid retrieval pipeline under project-scoped context.
2. Validate BM25/vector initialization and index selection per project.
3. Add fallback-to-cypher strategy with explicit warning payload when hybrid returns empty but graph has nodes.

## F3 — Architecture validation rules not configured for this repo (high)

Evidence:

- `arch_validate` marks all checked files as unassigned layer (`layer: unknown`).

Impact:

- Architecture validation yields low-value warnings; no actionable layering policy enforced.

Likely fix direction:

1. Add/update `.lxrag/config.json` layer path patterns for this repository.
2. Define import constraints between UI, state, hooks, and data/client modules.

## F4 — Circular dependency detection reported as not implemented (high)

Evidence:

- `find_pattern(type=circular)` returned `status: not-implemented`.

Impact:

- Important architecture risk class is currently undetectable via this tool path.

Likely fix direction:

1. Implement full graph traversal cycle detection in `find_pattern` circular mode.
2. Return cycle path traces for remediation.

## F5 — Documentation section metadata quality issue (medium-high)

Evidence:

- After successful docs indexing, `SECTION.relativePath` is null for all sampled/aggregated section nodes (`1085/1085`).

Impact:

- Documentation query results cannot reliably map findings back to source docs.

Likely fix direction:

1. Ensure `relativePath` is populated at SECTION creation time.
2. Add index-time validation assertion for required fields (`relativePath`, `heading`, `startLine`).

## F6 — Impact/test suggestion toolchain ineffective in this repo context (medium)

Evidence:

- `impact_analyze` returned zero direct impact and zero tests for important core files.
- `suggest_tests` could not resolve a valid FILE element ID.

Impact:

- Change-risk and test-scoping automation is not currently actionable.

Likely fix direction:

1. Align ID resolution between graph nodes and `suggest_tests`/`semantic_diff` handlers.
2. Validate path normalization (absolute vs relative) and project namespace matching.
3. Add fixtures for repos with sparse/no test files and ensure graceful but informative output.

## F7 — Feature registry discoverability gap (medium)

Evidence:

- `feature_status` failed for plausible feature IDs.

Impact:

- Hard to use feature monitoring without discoverable feature keys.

Likely fix direction:

1. Add `feature_list` or expose accepted feature IDs in `feature_status` error payload.

---

## 5) Prioritized fix plan

### P0 (do first)

1. Fix strict project isolation across tool handlers and retrieval paths.
2. Fix natural/hybrid empty-result behavior when data exists.

### P1

3. Add proper layer config for architecture validation in this repo.
4. Implement circular dependency detection in `find_pattern`.
5. Fix docs SECTION metadata (`relativePath`) population.

### P2

6. Repair `suggest_tests` and `semantic_diff` element resolution.
7. Improve `feature_status` discoverability with list/introspection support.

---

## 6) Re-run checklist after fixes

1. `graph_rebuild(full)` and `graph_health(debug)` show synchronized index.
2. `graph_query(natural/hybrid)` returns meaningful results for architecture and hotspots.
3. `arch_validate(strict)` returns policy-based violations (not unknown-layer warnings).
4. `find_pattern(circular)` returns explicit cycles or an explicit "none found" result.
5. `index_docs` produces SECTION nodes with non-null source path metadata.
6. `impact_analyze` + `suggest_tests` return non-empty or explicitly justified outputs.

---

## 7) Conclusion

The lxRAG toolchain is connected and partially functional in this workspace, but several core capabilities are currently unreliable for production-grade analysis: project isolation, natural/hybrid retrieval quality, architecture rule assignment, circular detection, and downstream impact/test tooling. Fixing those areas should significantly improve trust and practical utility.
