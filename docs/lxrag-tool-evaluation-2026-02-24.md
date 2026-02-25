# lxRAG MCP Tool Evaluation Report

**Date:** 2026-02-24  
**Project:** lexRAG-MCP — `/home/alex_rod/projects/lexRAG-MCP`  
**Branch:** `test/refactor`  
**Scope:** Comprehensive evaluation of all 36 lxRAG MCP tools across 4 audit sessions.  
**Sources:** Live tool testing (Session 1), refactor workflow (Session 2), tool-audit-2026-02-23b.md, TOOL_AUDIT_REPORT.md, lxrag-self-audit-2026-02-24.md, benchmark matrix (76 scenarios, 19 tools).

---

## 1. Executive Summary

| Metric                               | Value                                           |
| ------------------------------------ | ----------------------------------------------- |
| Total tools registered               | 36                                              |
| Fully working (latest session)       | 24                                              |
| Working but degraded                 | 2                                               |
| Broken (enabled, but fail)           | 6                                               |
| Disabled by user config              | 10                                              |
| Benchmark accuracy (MCP vs baseline) | **0 / 65 scenarios** where MCP wins on accuracy |
| Benchmark speed (MCP vs baseline)    | **58 / 74 scenarios** where MCP wins on latency |
| Test suite                           | 253 / 253 passing                               |
| Critical bugs confirmed              | 7 (F1-F11 family + SX series)                   |
| Bugs fixed across sessions           | 8                                               |

The tool set is **fast** (14–18 ms vs 200+ ms baselines) but suffers from **systematic accuracy failures** caused by a single root issue: the in-memory graph cache is never re-synced to the live graph database, making almost every query operate on stale or empty data. Once this is resolved (F8), the cascade effect fixes F3, F5, and most of the accuracy zeros seen in the benchmark.

---

## 2. Tool Inventory and Functionality

### 2.1 Category Map

| Category              | Tools                                                                            | Description                                                                         |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Project Setup**     | `init_project_setup`, `set_workspace_context`                                    | Bootstrap project context, trigger first graph build                                |
| **Graph**             | `graph_health`, `graph_rebuild`, `graph_query`, `diff_since`                     | Core graph DB operations (read, write, diff) on the Memgraph knowledge graph        |
| **Architecture**      | `arch_validate`, `arch_suggest`, `find_pattern`, `code_explain`, `code_clusters` | Layer-rule validation, placement suggestions, pattern detection, symbol explanation |
| **Semantic / Vector** | `semantic_search`, `find_similar_code`, `semantic_diff`, `ref_query`             | Qdrant-backed vector search (requires embeddings to be generated)                   |
| **Documentation**     | `index_docs`, `search_docs`                                                      | Markdown document indexing and retrieval                                            |
| **Test Management**   | `test_select`, `test_categorize`, `test_run`, `suggest_tests`                    | Test selection by impact, categorization, execution, and suggestions                |
| **Memory / Episodes** | `episode_add`, `episode_recall`, `reflect`, `context_pack`, `decision_query`     | Long-term agent memory, pattern reflection, retrieval-augmented context             |
| **Progress / Task**   | `progress_query`, `task_update`, `feature_status`, `blocking_issues`             | Task tracking, feature registry, blocker management                                 |
| **Coordination**      | `agent_claim`, `agent_release`, `agent_status`, `coordination_overview`          | Multi-agent conflict detection and claim lifecycle                                  |

### 2.2 Per-Tool Status (Latest Session)

| Tool                      | Status      | Notes                                                            |
| ------------------------- | ----------- | ---------------------------------------------------------------- |
| `init_project_setup`      | ✅ Working  |                                                                  |
| `set_workspace_context`   | ✅ Working  |                                                                  |
| `graph_health`            | ✅ Working  | Returns drift state accurately; BigInt bug fixed                 |
| `graph_rebuild`           | ✅ Working  | Triggers async rebuild; correct tx IDs                           |
| `graph_query` (Cypher)    | ✅ Working  | Cypher queries execute correctly                                 |
| `graph_query` (NL/hybrid) | ⚠️ Degraded | Returns results in `lexical_fallback` mode due to F8 stale cache |
| `diff_since`              | ✅ Working  | Accurate delta after rebuild                                     |
| `arch_validate`           | ✅ Working  | Requires `.lxrag/config.json`; works when present                |
| `arch_suggest`            | ✅ Working  | Requires `.lxrag/config.json`                                    |
| `find_pattern`            | ⚠️ Degraded | `type=circular` returns `NOT_IMPLEMENTED`; others work           |
| `code_explain`            | ❌ Broken   | Returns 0 results — no FUNCTION node embeddings (F8 + F5)        |
| `code_clusters`           | ❌ Broken   | Returns empty — no embeddings                                    |
| `semantic_search`         | ❌ Broken   | 0 results — Qdrant not populated (F5)                            |
| `find_similar_code`       | ❌ Broken   | 0 results — Qdrant not populated                                 |
| `semantic_diff`           | ✅ Working  | Structural diff works without embeddings                         |
| `ref_query`               | ✅ Working  | BM25 lexical search returns relevant results                     |
| `index_docs`              | ✅ Working  | 39 docs indexed, 17.5s, incremental supported                    |
| `search_docs`             | ❌ Broken   | Returns 0 results post-index in some sessions                    |
| `test_select`             | ⚠️ Degraded | 0 tests selected — depends on REFERENCES edges (SX3)             |
| `test_categorize`         | ✅ Working  | Categorizes correctly by type                                    |
| `test_run`                | ❌ Broken   | Wrong Node.js v10.19.0 from inherited PATH (SX4)                 |
| `suggest_tests`           | ⚠️ Degraded | Requires `file:` URI format; empty when no embeddings            |
| `episode_add`             | ✅ Working  | Persists episodes reliably                                       |
| `episode_recall`          | ✅ Working  | Returns relevant episodes by semantic + temporal                 |
| `reflect`                 | ✅ Working  | Returns 0 learnings on new projects (expected)                   |
| `context_pack`            | ✅ Working  | Builds context from graph + episodes                             |
| `decision_query`          | ✅ Working  |                                                                  |
| `progress_query`          | ✅ Working  | Returns task states correctly                                    |
| `task_update`             | ✅ Working  |                                                                  |
| `feature_status`          | ✅ Working  | Returns empty registry for new projects                          |
| `blocking_issues`         | ✅ Working  |                                                                  |
| `agent_claim`             | ✅ Working  |                                                                  |
| `agent_release`           | ✅ Working  | Now returns `ReleaseFeedback` (refactor fix)                     |
| `agent_status`            | ✅ Working  |                                                                  |
| `coordination_overview`   | 🚫 Disabled | User mcp.json disables this tool                                 |
| `tools_list`              | ✅ Working  |                                                                  |

---

## 3. Bugs

### 3.1 Currently Active

| ID      | Severity    | Tool(s) Affected                                                                         | Description                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ----------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F8**  | 🔴 Critical | All query tools                                                                          | **Cache drift** — `cachedNodes: 448` vs `memgraphNodes: 2216` (1,768 node deficit). Server process uses stale in-memory cache. Root cause: `GraphOrchestrator` instantiated without `sharedIndex.syncFrom()` call in old binary. Fix in `src/server.ts` is applied but requires server restart.                                                                   |
| **F5**  | 🔴 Critical | `semantic_search`, `code_explain`, `find_similar_code`, `code_clusters`, `suggest_tests` | **Zero embeddings** — `embeddings.generated: 0` for all 85 FUNCTION and 164 CLASS nodes. Qdrant is connected (`qdrantConnected: true`) but indexing never writes. Blocked by F8 (stale cache means embedding engine sees no nodes).                                                                                                                               |
| **F3**  | 🔴 High     | `graph_query` (NL)                                                                       | **BM25 lexical fallback** — NL queries route to lexical fallback because the hybrid retriever's in-memory BM25 index is built from the stale 448-node cache. Returns degraded, sometimes empty results for NL queries. Blocked by F8.                                                                                                                             |
| **SX3** | 🔴 High     | `impact_analyze`, `test_select`                                                          | **REFERENCES edges not created for TypeScript** — `resolveImportPath()` in `src/graph/builder.ts` did not strip `.js` extension before probing disk, so all 89 TypeScript imports (which use `.js` extension in `node16/bundler` moduleResolution) were unresolved. Result: 0 REFERENCES edges. Fix applied; requires `graph_rebuild(full)` after server restart. |
| **SX4** | 🔴 High     | `test_run`                                                                               | **Wrong Node.js version** — MCP server inherits ambient PATH with `/usr/bin/node` (v10.19.0). `test_run` calls `child_process.exec("npx vitest run ...")` which resolves to v10.19.0. npm refuses to run. All test CI functionality broken. Recommended fix: derive node binary from `process.execPath`.                                                          |
| **F1**  | 🟡 Medium   | `graph_query`, `arch_validate`                                                           | **File path normalization split** (historical; fixed in current session) — In session 2, FILE nodes had mixed absolute (22) and relative (6) paths, causing duplicate nodes and broken cross-file queries. Confirmed fixed: 74/74 absolute in latest audit.                                                                                                       |
| **F2**  | 🟡 Medium   | `search_docs`, `index_docs`                                                              | **SECTION.relativePath always null** (historical; fixed in current session) — All 265 SECTION nodes had `relativePath: null`. Fixed: 0/943 null in latest session.                                                                                                                                                                                                |
| **SX2** | 🟡 Medium   | `impact_analyze`, community detection                                                    | **CLASS/FUNCTION nodes missing `path` property** — `src/graph/builder.ts` does not write `path` or `filePath` to CLASS/FUNCTION nodes. These nodes link to FILE via CONTAINS edge, but tools that resolve symbols to paths without traversing fail.                                                                                                               |
| **SX5** | 🟡 Medium   | Community detection                                                                      | **`misc` community traps 77% of nodes** — All 164 CLASS and 85 FUNCTION nodes classified as `misc` because the community detector Cypher uses `coalesce(n.path, n.filePath, '')` and both are null for these node types. Fix applied in `src/engines/community-detector.ts` (OPTIONAL MATCH fallback to parent FILE).                                             |
| **SX1** | 🟢 Low      | `index_docs`, `search_docs`                                                              | **SECTION.title always null** — No title extraction without `LXRAG_SUMMARIZER_URL` configured. Informational only; search works on `relPath`.                                                                                                                                                                                                                     |
| **F6**  | 🟢 Low      | `find_pattern`                                                                           | **`circular` pattern not implemented** — Returns `NOT_IMPLEMENTED` for `type=circular`. Other patterns (`violations`, `unused`, `generic`) work. Benchmark scenario T023 awarded accuracy=1.0 for this expected response.                                                                                                                                         |

### 3.2 Previously Fixed (4 sessions tracked)

| ID                     | Fix                                                                        | Session   |
| ---------------------- | -------------------------------------------------------------------------- | --------- |
| **Bug-LIMIT**          | `graph_query` response: `LIMIT` param was hardcoded; now parameterized     | Session 2 |
| **Bug-QdrantIDs**      | Qdrant point IDs must be string UUIDs, not raw integers                    | Session 2 |
| **Bug-EmptyQdrant**    | Early return on empty Qdrant result instead of throwing                    | Session 2 |
| **Bug-ProjectId**      | Embedding engine stripped `projectId` before writing to Qdrant             | Session 2 |
| **Bug-resolveElement** | `resolveElement` used line number as symbol name in some paths             | Session 2 |
| **Bug-BigInt**         | `graph_health` threw `TypeError: Cannot mix BigInt` in numeric aggregation | Session 3 |
| **SX3**                | `resolveImportPath()` `.js` stripping (described above)                    | Session 4 |
| **SX5**                | Community detector OPTIONAL MATCH fallback                                 | Session 4 |

---

## 4. Missing Features

| Feature                                          | Impact | Details                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`.lxrag/config.json` not shipped**             | High   | `arch_validate` and `arch_suggest` both require an architecture config file defining layer rules. Without it, validation reports "no layers defined" and suggest falls back to heuristics. Template exists in docs but is not auto-generated. |
| **`find_pattern` circular detection**            | Medium | `type=circular` acknowledged but returns `NOT_IMPLEMENTED`. No Cypher path-cycle detection implemented in the pattern engine.                                                                                                                 |
| **Automatic BM25 index rebuild on graph change** | High   | BM25 index exists but is only built at server boot from the in-memory cache snapshot. If the cache is stale, every NL query operates on outdated data. No hook triggers BM25 rebuild after `graph_rebuild` completes.                         |
| **Embedding auto-indexing**                      | High   | Embeddings are never generated automatically after a `graph_rebuild`. Must be triggered manually. No incremental embedding pipeline exists.                                                                                                   |
| **TTL expiry via `expireOldClaims`**             | Low    | The TTL reason was added to `InvalidationReason` and `expireOldClaims()` was implemented during the Session 2 refactor, but no scheduled job calls it. Claims can accumulate indefinitely unless manually expired.                            |
| **`coordination_overview` for non-admin users**  | Low    | Tool is implemented and tested, but disabled in the default user mcp.json config. No documented way to enable it per-project without editing global config.                                                                                   |
| **Bi-temporal graph nodes**                      | Medium | FILE, FUNCTION, CLASS nodes have no `validFrom`/`validTo` timestamps. `diff_since` works via Memgraph tx IDs but cannot reconstruct point-in-time snapshots of the graph schema. Benchmark Phase 2 improvement target.                        |
| **`context_pack` PPR retrieval**                 | Medium | `context_pack` currently uses direct episode recall. The planned PPR (Personalized PageRank)-based retrieval from the graph is a roadmap item (benchmark Phase 5) not yet implemented.                                                        |
| **Persistent BM25 replacement**                  | High   | `routeNaturalToCypher` uses regex-based stubs instead of a real hybrid retriever (vector + BM25 + PPR via RRF). Benchmark Phase 8 improvement target.                                                                                         |
| **`search_docs` cross-session reliability**      | Medium | `search_docs` returned 0 results in 2 of 4 sessions even after `index_docs` completed. The search projection does not consistently bind to the active session's project context.                                                              |
| **Summarizer integration**                       | Low    | `LXRAG_SUMMARIZER_URL` is optional but undocumented. Without it, all 943+ SECTION nodes have `title: null`. No fallback H1-extraction heuristic in the markdown parser.                                                                       |

---

## 5. Bad Implementations / Design Issues

| ID      | Location                            | Issue                                                                                                                                                                                                                                                                                                         |
| ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | `src/graph/builder.ts`              | `resolveImportPath()` did not account for `moduleResolution: node16/bundler` where TypeScript emits `.js` extensions in imports. Caused 0 REFERENCES edges for the entire project.                                                                                                                            |
| **D2**  | `src/engines/community-detector.ts` | Community labeling used `coalesce(n.path, ...)` without traversing CONTAINS to get the parent FILE path. 77% of code nodes landed in `misc`.                                                                                                                                                                  |
| **D3**  | `src/server.ts` (old binary)        | `GraphOrchestrator` constructed with `false` for the index arg, skipping `sharedIndex.syncFrom()`. Cache drift up to 1,768 nodes possible across any long-running session.                                                                                                                                    |
| **D4**  | `test_run` tool handler             | `child_process.exec("npx vitest run ...")` inherits ambient shell PATH. Server processes started without nvm/volta activation will use system Node. Should derive from `process.execPath`.                                                                                                                    |
| **D5**  | Coordination engine (pre-refactor)  | `rowToClaim()` was a private method on the class, not independently testable. `release()` returned `void`, losing feedback about whether the claim existed. All 14 Cypher strings were inline.                                                                                                                |
| **D6**  | `search_docs`                       | After `index_docs`, `search_docs` consistently returns 0 results in some sessions. The root cause appears to be a session-bound project-ID scoping issue where the indexed documents are stored under a different project key than the search query resolves.                                                 |
| **D7**  | `find_pattern`                      | `type=circular` is listed in the tool schema and in the session 1 test matrix as a supported pattern type, but the implementation returns NOT_IMPLEMENTED at runtime. The schema should either remove this variant or mark it as experimental.                                                                |
| **D8**  | Embedding engine                    | `withEmbeddings=true` parameter on `index_docs` is silently ignored — no embeddings are written to Qdrant even when explicitly requested. No error or warning is surfaced to the caller.                                                                                                                      |
| **D9**  | Session tool availability           | Available tools rotate between sessions. In one session (audit-2026-02-23b), only 5/36 tools were fully working. In the current session (post-refactor), 24/36 are working. No deterministic list of which tools are active in a given MCP connection is surfaced to the agent unless `tools_list` is called. |
| **D10** | `graph_query` accuracy              | 74 benchmark scenarios scored MCP accuracy = 0.000 for 73 scenarios. All accuracy failures are traced to F8 (stale cache) or F5 (no embeddings), but the tool returns empty results without any warning that data is unavailable. Silent empty responses are indistinguishable from "no matching data."       |

---

## 6. Accuracy and Performance Metrics

### 6.1 Benchmark Summary (76 Scenarios, 19 Tools)

| Dimension       | MCP wins | Baseline wins | Ties            |
| --------------- | -------- | ------------- | --------------- |
| **Latency**     | 58       | 0             | 0 (16 mcp_only) |
| **Accuracy**    | 0        | 65            | 9               |
| **Token usage** | 30       | 44            | 0               |

**Key observations:**

- MCP tools run in **14–18 ms** vs baselines at **200–2000 ms** — a consistent 10–130× speed advantage
- Near-zero MCP accuracy is entirely caused by F8 (stale cache) + F5 (no embeddings). When data is available, accuracy is 1.0 (e.g., T023 `find_pattern circular=NOT_IMPLEMENTED`, T037/T038 `test_run error paths`)
- Token usage: MCP more efficient for read queries (78 avg tokens vs 265+ for grep/file-read baselines); less efficient for structured output scenarios
- All 74 scenarios comply with `compact ≤ 300 token` budget target
- 16 scenarios are `mcp_only` (no automated non-graph equivalent): `progress_query`, `task_update`, `feature_status`, `blocking_issues`

### 6.2 Tool Availability Across Sessions

| Tool Group                                                        | Session 1 (tool test) | Session 2 (refactor) | Session 3 (audit-23b)   | Session 4 (self-audit) |
| ----------------------------------------------------------------- | --------------------- | -------------------- | ----------------------- | ---------------------- |
| Graph (query, rebuild, health, diff)                              | ✅ 4/4                | ✅ 4/4               | ⚠️ 2/4 (query disabled) | ✅ 4/4                 |
| Architecture (validate, suggest, find_pattern, explain, clusters) | ✅ 5/5                | ✅ 5/5               | ⚠️ 2/5                  | ✅ 5/5                 |
| Semantic (search, similar, diff, ref_query)                       | ⚠️ 3/4 (empty)        | ⚠️ 3/4               | ❌ 0/4                  | ⚠️ 2/4                 |
| Docs (index, search)                                              | ✅ 2/2                | ✅ 2/2               | ❌ 0/2 (disabled)       | ⚠️ 1/2                 |
| Test (select, categorize, run, suggest)                           | ✅ 4/4                | ✅ 4/4               | ⚠️ 2/4                  | ❌ 1/4 (run broken)    |
| Memory (add, recall, reflect, context_pack, decision_query)       | ✅ 5/5                | ✅ 5/5               | ✅ 5/5                  | ✅ 5/5                 |
| Progress (query, update, feature, blockers)                       | ✅ 4/4                | ✅ 4/4               | ✅ 4/4                  | ✅ 4/4                 |
| Coordination (claim, release, status, overview)                   | ✅ 3/4                | ✅ 3/4               | ✅ 3/4                  | ✅ 3/4                 |

**Note:** `coordination_overview` is permanently disabled by user mcp.json config across all sessions.

### 6.3 Graph State Metrics (Session 4 baseline)

| Metric               | Value                          |
| -------------------- | ------------------------------ |
| Total graph nodes    | 2,216                          |
| Total relationships  | 3,622                          |
| FILE nodes           | 74 (100% absolute paths)       |
| CLASS nodes          | 164                            |
| FUNCTION nodes       | 85                             |
| SECTION nodes        | 943 (0 null relativePath)      |
| COMMUNITY nodes      | 11                             |
| REFERENCES edges     | 0 (SX3; fixed pending rebuild) |
| Embeddings generated | 0 / 249 code nodes             |
| Cached nodes (stale) | 448 vs 2,216 live (F8)         |
| Docs indexed         | 39 (17.5s full rebuild)        |

### 6.4 Test Suite Metrics

| Metric                          | Value           |
| ------------------------------- | --------------- |
| Total tests                     | 253             |
| Passing                         | 253 (100%)      |
| Test files                      | 20              |
| Average duration                | ~1.12s          |
| Coordination engine tests (new) | 19              |
| Contract tests                  | included in 253 |

---

## 7. Priority Fix Plan

### P0 — Immediate (server restart required)

| Action                                | Effect                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `npm run build && restart MCP server` | Activates F8 fix: `sharedIndex.syncFrom()` re-syncs cache (448→2216 nodes) |
| `graph_rebuild(full)` after restart   | Populates REFERENCES edges (SX3 fix: 89 imports resolved)                  |

### P1 — High (1–2 days)

| ID      | Action                                                                                         | Fixes                                                                   |
| ------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **SX4** | In `test_run` tool handler, derive Node binary from `process.execPath` instead of ambient PATH | `test_run` works without nvm                                            |
| **F5**  | After F8 fixed, trigger embedding generation pipeline for all FUNCTION/CLASS nodes             | `semantic_search`, `code_explain`, `find_similar_code`, `suggest_tests` |
| **F3**  | After F8 fixed, rebuild BM25 index from live graph cache                                       | NL graph queries return correct results                                 |

### P2 — Medium (2–5 days)

| ID              | Action                                                                                           | Fixes                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **SX2**         | Add `filePath` property (= parent FILE's path) to CLASS/FUNCTION nodes in `src/graph/builder.ts` | Path resolution without CONTAINS JOIN; better community detection |
| **D6**          | Debug `search_docs` project-ID scoping across sessions                                           | Consistent doc search                                             |
| **D8**          | Surface warning or error when `withEmbeddings=true` and embeddings are not written               | Removes silent failure                                            |
| **F6**          | Implement Cypher cycle-detection for `find_pattern(type=circular)` or remove from schema         | Removes mislabeled NOT_IMPLEMENTED                                |
| **arch config** | Ship `.lxrag/config.json` template or auto-generate on `init_project_setup`                      | Enables `arch_validate` out-of-the-box                            |

### P3 — Low (1 week)

| ID                   | Action                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **SX1**              | Add H1-heuristic extraction to markdown parser as fallback for `LXRAG_SUMMARIZER_URL` not set |
| **TTL**              | Add scheduled call to `expireOldClaims()` (e.g., on each `graph_rebuild`)                     |
| **Bi-temporal**      | Add `validFrom`/`validTo` to FILE/FUNCTION/CLASS nodes for point-in-time graph queries        |
| **context_pack PPR** | Implement PPR-based retrieval to replace direct episode recall                                |
| **BM25 replace**     | Implement proper hybrid retriever (vector + BM25 + PPR via RRF) for NL query routing          |

---

## 8. Observations on Using lxRAG as a Workflow Control Plane (Session 2)

During a full 6-phase refactor workflow where lxRAG tools were used exclusively as the control plane:

**What worked well:**

- `agent_claim` / `agent_release` provided reliable mutex-like task coordination
- `episode_add` + `episode_recall` produced useful memory across tool invocations
- `arch_suggest` gave actionable architectural recommendations (e.g., `src/utils/` vs `src/engines/`) even without `.lxrag/config.json`
- `diff_since` accurately tracked graph delta (116 new nodes across 4 rebuilds)
- `reflect` synthesized 3 learnings from 7 episodes, demonstrating pattern recognition at low episode counts

**What required workarounds:**

- `impact_analyze` consistently returned empty results due to F8 cache drift
- `test_select` returned 0 tests due to SX3 (no REFERENCES edges)
- `semantic_search` and `code_explain` returned nothing (F5 no embeddings)
- Needed to fall back to regular file reads to validate code correctness
- `arch_validate` required manually creating `.lxrag/config.json` first

**Refactor outcome:** 253/253 tests pass, `tsc` exit 0, `coordination-engine.ts` reduced from 391 to ~250 LOC with 3 new focused modules.

---

## 9. Conclusions

The lxRAG MCP tool set has a sound architecture and the right tool surface for code intelligence workflows, but its **real-world accuracy is near zero** in its current deployed state due to a single transitive dependency: the server process never re-syncs its in-memory cache after a graph rebuild. Until F8 is resolved (one server restart), the following cannot function: hybrid retrieval, all vector/semantic tools, test selection by impact, and call-graph-based impact analysis.

The 14–18 ms tool latency is genuinely impressive and the memory and coordination tools work reliably even in degraded state, making them the most consistently usable part of the system today.

After the P0 and P1 fixes are applied, an estimated 24 → 34 of 36 tools would reach fully working status, covering the remaining gaps in semantic search, impact analysis, test tooling, and documentation search.

---

_Document generated by synthesizing all 4 audit sessions and the 76-scenario benchmark matrix._  
_See also: [TOOL_AUDIT_REPORT.md](../TOOL_AUDIT_REPORT.md), [docs/lxrag-tool-audit-2026-02-23b.md](lxrag-tool-audit-2026-02-23b.md), [docs/lxrag-self-audit-2026-02-24.md](lxrag-self-audit-2026-02-24.md)_
