# lxRAG Tool Audit — lexRAG-visual (2026-02-23)

**Workspace:** `/home/alex_rod/projects/code-visual`  
**Project ID:** `lexRAG-visual`  
**Rebuilt from:** empty Memgraph instance  
**Method:** lxRAG tools only — no file reads, grep, or list operations used for analysis

---

## 1. Methodology

This audit ran against a clean database to measure the full tool surface from scratch. Tools were exercised in this order:

1. `init_project_setup` — one-shot workspace init, rebuild, and copilot instructions
2. `graph_health` (debug profile) — post-build state
3. `graph_query` (cypher) — graph structure and node counts
4. `arch_validate` (strict) — layer validation
5. `arch_suggest` — placement recommendations
6. `find_pattern` — circular, unused, and violation checks
7. `index_docs` (full, no embeddings) — documentation indexing
8. `search_docs` — doc section search
9. `impact_analyze` — change blast radius
10. `contract_validate` — tool schema validation
11. `suggest_tests`, `test_select`, `test_categorize`, `test_run`, `code_clusters` — test intelligence
12. `find_similar_code`, `code_explain`, `semantic_slice`, `semantic_diff`, `semantic_search` — semantic tools
13. `context_pack`, `diff_since` — agent utility tools
14. `episode_add`, `episode_recall`, `decision_query`, `reflect` — memory tools
15. `agent_claim`, `agent_release`, `agent_status`, `coordination_overview` — coordination tools
16. `progress_query`, `task_update`, `feature_status`, `blocking_issues` — progress tools

---

## 2. Tool Availability Matrix

| Tool | Status | Behavior |
|---|---|---|
| `init_project_setup` | ✅ Working | Rebuilt from empty; copilot instructions skipped (already exist) |
| `graph_rebuild` | ✅ Working | Full rebuild queued, tx `tx-4dfcc963`, no errors |
| `graph_health` | ✅ Working | Connected; drift flag fires correctly |
| `graph_query` (cypher) | ✅ Working | Returns correct rows |
| `graph_query` (natural/hybrid/global) | ⚠️ Broken | Always returns 0 results despite graph having 793 nodes |
| `index_docs` | ✅ Working | Indexed 10 markdown files, 0 errors, 3.5 s |
| `arch_validate` | ⚠️ Degraded | Works but returns all files as `layer: unknown` — no config present |
| `arch_suggest` | ⚠️ Bug | Always returns `src/types/` layer regardless of `type` parameter |
| `impact_analyze` | ⚠️ Broken | Returns empty `directImpact` for core files with clear dependents |
| `contract_validate` | ✅ Working | Validates and normalizes args correctly |
| `reflect` | ✅ Working | Runs; returns 0 learnings (no episode history) |
| `feature_status` | ⚠️ Limited | Works but never finds any feature IDs; no discoverable ID list |
| `find_pattern` | ❌ Disabled | |
| `search_docs` | ❌ Disabled | |
| `diff_since` | ❌ Disabled | |
| `semantic_search` | ❌ Disabled | |
| `find_similar_code` | ❌ Disabled | |
| `code_explain` | ❌ Disabled | |
| `semantic_slice` | ❌ Disabled | |
| `semantic_diff` | ❌ Disabled | |
| `context_pack` | ❌ Disabled | |
| `code_clusters` | ❌ Disabled | |
| `test_select` | ❌ Disabled | |
| `test_categorize` | ❌ Disabled | |
| `suggest_tests` | ❌ Disabled | |
| `blocking_issues` | ❌ Disabled | |
| `progress_query` | ❌ Disabled | |
| `task_update` | ❌ Disabled | |
| `decision_query` | ❌ Disabled | |
| `episode_add` | ❌ Disabled | |
| `episode_recall` | ❌ Disabled | |
| `agent_claim` | ❌ Disabled | |
| `agent_release` | ❌ Disabled | |
| `coordination_overview` | ❌ Disabled | |
| `agent_status` | ⚠️ Schema error | Requires `agentId` (should be optional for list-all case) |

**Summary: 5 tools fully working, 5 degraded/broken, 24+ disabled.**

---

## 3. Post-rebuild Graph State

Data from Cypher queries immediately after fresh full rebuild:

| Node type | Count |
|---|---|
| VARIABLE | 273 |
| SECTION | 247 |
| FUNCTION | 90 |
| EXPORT | 69 |
| CLASS | 65 |
| IMPORT | 51 |
| FILE | 28 |
| FOLDER | 14 |
| DOCUMENT | 10 |
| COMMUNITY | 6 |

**Relationships:**

| Relationship | Count |
|---|---|
| CONTAINS | 469 |
| SECTION_OF | 247 |
| NEXT_SECTION | 237 |
| BELONGS_TO | 183 |
| DOC_DESCRIBES | 107 |
| EXPORTS | ~69 |
| IMPORTS | ~51 |

**Total graph nodes:** 793 — **Relationships:** 1,079

---

## 4. Findings — Bugs and Missing Features

### F1 — File path normalization split (critical)

**Evidence:**
- 22 `FILE` nodes have absolute paths: `/home/alex_rod/projects/code-visual/src/...`
- 6 `FILE` nodes have relative paths: `src/components/...` or `src/lib/...`

Affected relative-path files:
```
src/components/EdgeCanvas.tsx
src/components/controls/ArchitectureControls.tsx
src/components/controls/RefreshToggleControl.tsx
src/config/constants.ts
src/lib/graphVisuals.ts
src/lib/layoutEngine.ts
```

**Impact:**
- Path-based queries (`WHERE f.path STARTS WITH '/home/...'`) silently exclude these 6 files from every result
- `impact_analyze`, `suggest_tests`, and dependency traversals miss all references through these files
- Mixed `FILE.id` format: absolute-path files get `lexRAG-visual:file:src/...` while relative-path files get the same but with folder prefix missing from FUNCTION IDs (e.g., `lexRAG-visual:ArchitectureControls.tsx:fn:line` instead of `lexRAG-visual:components/controls/ArchitectureControls.tsx:fn:line`)

**Fix direction:**
- Normalize all `FILE.path` to absolute at parse/index time using `workspaceRoot` join
- Add an indexing regression test asserting no relative paths in `FILE.path` when `workspaceRoot` is provided

---

### F2 — SECTION.relativePath is always null (high)

**Evidence:**
- `index_docs` succeeded: `indexed=10`, `errors=0`
- `MATCH (s:SECTION) RETURN sum(CASE WHEN s.relativePath IS NULL THEN 1 ELSE 0 END) AS nullPath` → 247 of 247 sections have `null` relativePath
- `DOCUMENT.relativePath` is populated correctly (e.g., `README.md`, `docs/architecture.md`)

**Impact:**
- `search_docs` (when enabled) cannot trace results back to source documents
- `DOC_DESCRIBES` edges exist (107 found) but cannot surface section location without `relativePath`
- Any UI or tool that shows "found in `docs/architecture.md` line 42" will show `null`

**Fix direction:**
- Propagate `document.relativePath` to each SECTION node at write time in `DocsBuilder`
- Add assertion: `MATCH (s:SECTION) WHERE s.relativePath IS NULL RETURN count(s)` should return 0

---

### F3 — Natural/hybrid retrieval completely non-functional (high)

**Evidence:**
- `graph_query(language='natural', mode='local')` → 0 results
- `graph_query(language='natural', mode='global')` → 0 results
- `graph_query(language='natural', mode='hybrid')` → 0 results
- All of the above run on a graph with 793 nodes, 28 indexed files, 90 functions
- `graph_health` confirms: `bm25IndexExists: false`, `retrieval.mode: lexical_fallback`, `embeddings.ready: false`, `embeddings.generated: 0`

**Impact:**
- The most important user-facing query capability (natural language → code) does not work at all
- Every agent/Copilot workflow that relies on `graph_query` for discovery is silently non-functional
- Tools that build on semantic retrieval (semantic_search, find_similar_code etc.) are also not viable

**Fix direction:**
- BM25 index must be built as part of `graph_rebuild`, not deferred
- Ensure BM25/TF-IDF index is built synchronously or at least flagged as pending with retry
- Add `graph_health` warning when `bm25IndexExists=false` after a completed rebuild
- Optional but high value: emit a `hint` in `graph_query` results when mode=natural returns empty but cypher returns data

---

### F4 — Index drift always reported after rebuild (medium-high)

**Evidence:**
- `graph_health(debug)` after a fresh full rebuild shows:
  - `indexHealth.driftDetected: true`
  - `cachedNodes: 0` vs `memgraphNodes: 793`
  - Recommendation: "Index is out of sync - run graph_rebuild to refresh"

**Impact:**
- Confusing signal: the rebuild just ran but health always says "out of sync"
- Masks real drift when it would actually occur
- Agents following the session script (`rebuild → health → query`) will see a misleading warning

**Fix direction:**
- After a completed rebuild transaction, the in-memory cache should be synchronized automatically
- If the background async rebuild is not yet complete, the health check should show "rebuild in progress" with the txId, not "drift"

---

### F5 — `arch_suggest` always returns `src/types/` layer (medium-high)

**Evidence:**
- `arch_suggest(name='GraphDataService', type='service')` → `suggestedPath: src/types/GraphDataServiceService.ts`
- `arch_suggest(name='LayoutWorkerBridge', type='service', dependencies=['react','zustand','d3-force'])` → same `src/types/` with wrong suffix (`LayoutWorkerBridgeService.ts`)
- Both suggestions used layer `Types` with reasoning `"Layer 'Types' can import from "` (empty reasoning string)

**Impact:**
- The `arch_suggest` tool gives actively wrong placement guidance: services belong in `src/services/` or `src/lib/`, not `src/types/`
- Reasoning is always an empty string — the explanation generation is broken
- Appends the `type` suffix to the name (e.g., `LayoutWorkerBridgeService.ts`) even though it was already called `LayoutWorkerBridge`

**Fix direction:**
- Layer selection must inspect both the `type` param and import dependencies to pick the right layer
- Empty reasoning string indicates the config interpolation loop is not completing — fix layer config resolution
- Name deduplication: if user provides `GraphDataService` and type is `service`, do not append `Service` suffix again

---

### F6 — `impact_analyze` returns empty for core files (medium-high)

**Evidence:**
- `impact_analyze(files=[memgraphClient.ts, graphStore.ts, useGraphController.ts, layoutEngine.ts])`:
  - `directImpact: []`
  - `testsSelected: 0`
  - `coverage: 0%`
- These files are central to the entire application; the graph clearly shows `CONTAINS` and `IMPORTS` relationships

**Impact:**
- Developers cannot use `impact_analyze` to scope changes or understand blast radius
- The zero-test result is technically accurate (no test files exist), but `directImpact: []` for files like `memgraphClient.ts` (which has 28 VARIABLE and 9 FUNCTION children) is incorrect

**Fix direction:**
- `directImpact` should return the list of files that import or depend on the changed files using graph traversal (`IMPORTS`/`CONTAINS` edges)
- Separate no-test-files state from no-impact state in the response; include a note if the repo has no test files

---

### F7 — 24+ tools disabled with no fallback or explanation (medium)

**Evidence:**
- The following responded with "currently disabled by the user":
  `find_pattern`, `search_docs`, `diff_since`, `semantic_search`, `find_similar_code`, `code_explain`, `semantic_slice`, `semantic_diff`, `context_pack`, `code_clusters`, `test_select`, `test_categorize`, `suggest_tests`, `blocking_issues`, `progress_query`, `task_update`, `decision_query`, `episode_add`, `episode_recall`, `agent_claim`, `agent_release`, `coordination_overview`

**Impact:**
- More than half the lxRAG tool surface is completely inaccessible in this VS Code session
- Any workflow relying on semantic search, test intelligence, memory, or coordination is fully blocked
- No error message distinguishes "disabled in this session" from "feature not available in plan"

**Fix direction:**
- Expose active tool list via `graph_health` or a dedicated `tools_status` call so agents can adapt without trial-and-error
- Provide a clearer disabled message: "This tool requires [feature/plan] — see [link]" rather than the generic "disabled by the user"

---

### F8 — `progress_query` rejects valid `profile` parameter (low-medium)

**Evidence:**
- `progress_query(query='all tasks', status='all', profile='balanced')` → `ERROR: must NOT have additional properties`
- Other tools (`graph_health`, `impact_analyze`, `arch_validate`) accept `profile` as standard

**Impact:**
- Minor inconsistency but breaks any automation that applies `profile` uniformly

**Fix direction:**
- Add `profile` to `progress_query` input schema, consistent with all other tool schemas

---

### F9 — Cypher `ORDER BY aggregate(...)` rejected by query engine (low)

**Evidence:**
- `ORDER BY size(collect(DISTINCT i.source)) DESC` in a `RETURN collect(...)` query fails:
  `"Aggregation functions are only allowed in WITH and RETURN"`

**Impact:**
- Standard Cypher idioms (common in docs and examples) fail silently; callers see an error response
- Affects any downstream tool or user that tries to order results by aggregation in the same clause

**Fix direction:**
- If lxRAG proxies Cypher before forwarding to Memgraph, rewrite or document the dialect restriction
- Add a user-friendly error message or a query rewrite hint in the error payload

---

### F10 — Missing `.lxrag/config.json` layer definitions (configuration gap)

**Evidence:**
- `arch_validate(strict=true)` flags all 6 checked files as `layer: unknown`
- No `.lxrag/config.json` exists in this repo

**Impact:**
- Architecture validation cannot enforce any rules and only generates low-signal "unknown layer" warnings
- `arch_suggest` falls back to incorrect default layer (`types`)

**Fix direction:**
- For a React + TypeScript project with this structure, a minimal `.lxrag/config.json` should define:
  ```json
  {
    "layers": [
      { "id": "components", "paths": ["src/components/**", "src/assets/**"], "canImport": ["hooks", "state", "lib", "types", "config"] },
      { "id": "hooks",      "paths": ["src/hooks/**"],                        "canImport": ["state", "lib", "types", "config"] },
      { "id": "state",      "paths": ["src/state/**"],                        "canImport": ["lib", "types", "config"] },
      { "id": "lib",        "paths": ["src/lib/**"],                          "canImport": ["types", "config"] },
      { "id": "types",      "paths": ["src/types/**"],                        "canImport": [] },
      { "id": "config",     "paths": ["src/config/**"],                       "canImport": [] }
    ]
  }
  ```

---

## 5. Positive Observations

- `init_project_setup` successfully bootstrapped the workspace, queued a rebuild, and detected the existing copilot instructions in one call — the one-shot initialization flow works end to end
- `index_docs` correctly classified 10 markdown files including READMEs, guides, and the architecture doc with zero errors
- `DOCUMENT` node metadata is well populated: `relativePath`, `kind`, and `title` are all present and correct
- `DOC_DESCRIBES` edges were created (107 found) linking documentation sections to code symbols
- `contract_validate` correctly normalizes arguments (e.g., maps `changedFiles` → `files`)
- Cypher-mode `graph_query` is reliable and expressive; complex queries work correctly
- The COMMUNITY detection ran successfully and produced 6 communities from 22 in-scope files

---

## 6. Prioritized Fix Plan

| Priority | Finding | Fix |
|---|---|---|
| P0 | F3 — NL retrieval broken | Build BM25 index synchronously during `graph_rebuild`; add health hint when BM25 missing |
| P0 | F1 — Path normalization split | Normalize all FILE.path to absolute at index time using workspaceRoot |
| P0 | F7 — 24+ tools disabled | Expose enabled tool list in health check; improve disabled message |
| P1 | F2 — SECTION.relativePath null | Propagate `document.relativePath` to each SECTION in DocsBuilder |
| P1 | F4 — Drift false-positive after rebuild | Sync in-memory cache after rebuild completes |
| P1 | F6 — impact_analyze returns empty | Implement graph-traversal directImpact using IMPORTS/CONTAINS edges |
| P1 | F5 — arch_suggest wrong layer | Fix layer selection logic and populate reasoning string |
| P2 | F10 — No .lxrag/config.json | Add minimal layer config for this repo |
| P2 | F8 — progress_query schema | Add `profile` to progress_query input schema |
| P3 | F9 — Cypher aggregate dialect | Document or fix Memgraph dialect restriction |

---

## 7. Re-run Checklist

After fixes are applied:

- [ ] `graph_query(language='natural', mode='local', query='React components')` returns > 0 results
- [ ] `MATCH (f:FILE) WHERE f.path STARTS WITH 'src/' RETURN count(f)` returns 0
- [ ] `MATCH (s:SECTION) WHERE s.relativePath IS NULL RETURN count(s)` returns 0
- [ ] `graph_health` after full rebuild shows `driftDetected: false`
- [ ] `arch_suggest(type='service')` returns a path under `src/services/` or `src/lib/`
- [ ] `impact_analyze` returns non-empty `directImpact` for `memgraphClient.ts`
- [ ] `progress_query(query='all', profile='compact')` does not return schema error
- [ ] At least 10 additional tools respond without "disabled" error
