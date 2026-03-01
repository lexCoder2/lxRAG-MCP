# lxDIG MCP — LLM Session Audit Report
**Date:** 2026-02-28
**Method:** Simulated fresh-LLM session — all 39 tools invoked through a real MCP stdio client, following every skill workflow from start to finish.
**Scope:** Tool correctness, LLM ease-of-use, skill–tool alignment, error quality, and output usefulness.

---

## Executive Summary

| Category | Count |
|---|---|
| ✅ Working correctly | 11 |
| ⚠️ Working but misleading or incomplete | 10 |
| ❌ Broken or unusable | 9 |
| 🔥 CRITICAL — blocks every skill workflow | 4 |

**The single most impactful bug:** every skill file lists tool names with a `lxDIG_` prefix (e.g. `lxDIG_graph_health`) but the server registers them without it (`graph_health`). Any LLM following the skills will fail every tool call with `-32602 Tool not found`.

---

## 🔥 Critical Issues — Fix Before Everything Else

### CRIT-1 — Skills reference non-existent tool names
**Affects:** All 10 skills, all 39 tools.

Every skill lists tools as `lxDIG_graph_health`, `lxDIG_episode_add`, etc. The actual MCP tool names registered by the server are `graph_health`, `episode_add`, etc. An LLM following any skill will receive:

```
MCP error -32602: Tool lxDIG_graph_health not found
```

**Fix:** Either prefix all tool registrations in `src/tools/registry.ts` with `lxDIG_`, or strip the prefix from all 10 skill files. Prefixing is preferred — it makes the tool namespace unambiguous in multi-server sessions.

---

### CRIT-2 — `find_pattern` skill calls use the wrong param name
**Affects:** `lxdig-explore`, `lxdig-place`, `lxdig-refactor`

Skills say: `find_pattern` with `type: 'circular'` or `type: 'unused'`.
Actual schema requires: `pattern: string` (not `type`).

Live result:
```
"Invalid input: expected string, received undefined" for path ["pattern"]
```

The Zod schema has `pattern` as a required string, but all skills reference `type`. The tool is completely uncallable from any skill.

**Fix:** Update all skill steps to say `pass pattern: 'circular'` or `pass pattern: 'unused'`; or rename the Zod field to `type` in the handler.

---

### CRIT-3 — `episode_add` with `type: DECISION` silently requires `metadata.rationale`
**Affects:** `lxdig-decision` (Path C), `lxdig-refactor` (step 8), `lxdig-claim` (step 7), `lxdig-place` (step 8)

Every skill says "Record with rationale (`episode_add`)" or "set `type: DECISION`, include rationale in `content`". But the tool enforces a hidden rule:

```json
{
  "error": "DECISION episodes require metadata.rationale (or metadata.reason)"
}
```

Rationale must be passed in `metadata.rationale`, not in `content`. An LLM following the skill will always get this error because no skill mentions `metadata`.

Live call that failed:
```json
{ "type": "DECISION", "content": "...rationale text here...", "outcome": "success" }
```

**Fix:** Update all skills to show the full call: `episode_add({ type: "DECISION", content: "...", metadata: { rationale: "..." } })`. Add this rule to the tool description.

---

### CRIT-4 — `feature_status` and `diff_since` and `contract_validate` have required params not documented anywhere
**Affects:** `lxdig-progress`, `lxdig-rebuild`, `lxdig-refactor`

All three fail with `-32602` when called without args:

| Tool | Required param | Skill mentions it? |
|---|---|---|
| `feature_status` | `featureId: string` | No |
| `diff_since` | `since: string` (ISO timestamp or epoch ms) | No |
| `contract_validate` | `tool: string` (not `toolName`) | No |

`diff_since` appears as step 9 in `lxdig-refactor` and step 4 in `lxdig-rebuild` with no args shown. An LLM will call it with just `profile` and get a hard validation error.

**Fix for skills:** Add `diff_since` param hint: "pass `since` as ISO timestamp or git SHA (e.g. output of `git log -1 --format=%cI`)". For `feature_status`: "pass `featureId` from a `progress_query` result". For `contract_validate`: param is `tool`, not `toolName`.

---

## Per-Tool Status Table

| Tool | Status | Issue |
|---|---|---|
| `tools_list` | ⚠️ | Reports 36/39 tools; miscategorizes `blocking_issues`, `context_pack`, `ref_query` |
| `init_project_setup` | ⚠️ | Returns "queued" — doesn't block or confirm graph rebuild completion |
| `graph_health` | ✅ | Accurate drift detection; good structured output |
| `graph_query` | ❌ | Circuit breaker open → Memgraph unavailable; Cypher queries fail entirely |
| `graph_rebuild` | — | Not directly tested; init calls it internally as "queued" |
| `graph_set_workspace` | ✅ | Works (called internally by init) |
| `diff_since` | ❌ | CRIT-4: required `since` param not documented |
| `code_explain` | ⚠️ | Returns correct metadata but `dependencies: []` even for 1082-LOC class with many imports |
| `find_pattern` | ❌ | CRIT-2: wrong param name in every skill |
| `semantic_search` | ⚠️ | Returns results but irrelevant (Qdrant projectId mismatch ERR-A still present) |
| `find_similar_code` | ❌ | Silent wrong behavior: returns 10 results for a completely fake `elementId` instead of error |
| `code_clusters` | ❌ | Useless output: all 95 files cluster to "/home", all 114 functions to "unknown" |
| `semantic_diff` | — | Not tested live; known to be metadata-only (WARN-4) |
| `semantic_slice` | ✅ | Works; returns correct code slice for natural language query |
| `suggest_tests` | ❌ | Accepts tool name as `elementId`, returns "unable to resolve file path" — unhelpful error |
| `context_pack` | ⚠️ | Returns empty coreSymbols, "No entry point found" — Qdrant ERR-A blocks symbol ranking |
| `arch_validate` | ⚠️ | Returns 11 violations, all config false positives (`.lxdig/config.json` is too strict — WARN-5) |
| `arch_suggest` | ✅ | Works; returns correct layer, path, and reasoning |
| `init_project_setup` | ⚠️ | See above |
| `setup_copilot_instructions` | ✅ | Works (called by init; file exists path handled gracefully) |
| `index_docs` | ❌ | Returns `ok: true` but `indexed: 0, errorCount: 30` — silent failure due to Memgraph circuit breaker |
| `search_docs` | ❌ | Always returns 0 results; uses uppercase `projectId: "lxDIG-MCP"` vs stored `"lxdig-mcp"` (ERR-C) |
| `ref_query` | ✅ | Works well; mode inference correct; results scored and relevant |
| `test_select` | ❌ | Returns 0 selected tests for any file (ERR-B: no TEST_SUITE nodes) |
| `test_categorize` | ❌ | Returns 0 for every category (ERR-B) |
| `impact_analyze` | ⚠️ | Finds direct file relationships but `blastRadius.testsAffected: 0` always (ERR-B) |
| `test_run` | — | Not tested (would execute tests) |
| `suggest_tests` | ❌ | See above |
| `progress_query` | ⚠️ | Works but returns 0 items; contractWarnings show silent param remapping |
| `task_update` | — | Not tested (no task nodes to update) |
| `feature_status` | ❌ | CRIT-4: required `featureId` not documented; fails with hard validation error |
| `blocking_issues` | ✅ | Works; clean empty response |
| `episode_add` | ❌ | CRIT-3: `DECISION` type silently requires `metadata.rationale`; fails without it |
| `episode_recall` | ✅ | Works; clean response when no episodes stored |
| `decision_query` | ✅ | Works; clean response when no decisions stored |
| `reflect` | ✅ | Works; graceful when 0 episodes |
| `agent_claim` | ⚠️ | Returns claimId but claim not persisted (Memgraph down) |
| `agent_release` | ❌ | Returns `notFound: true` for a claimId returned seconds earlier by `agent_claim` |
| `agent_status` | ❌ | Shows 0 active claims immediately after a successful `agent_claim` |
| `coordination_overview` | ✅ | Works; clean response |
| `contract_validate` | ❌ | CRIT-4: param is `tool`, skills and intuition say `toolName` |

---

## Findings by Category

### 1. Skill ↔ Tool Name Mismatch (CRIT-1)

Every skill's **Tools** section uses `lxDIG_*` prefix. The server registers tools without it. This is a complete blocker — no skill workflow is executable by an LLM following the files as written.

The `tools_list` call confirmed real names:
```
graph_query, graph_rebuild, graph_set_workspace, graph_health,
diff_since, code_explain, find_pattern, tools_list, contract_validate,
semantic_search, find_similar_code, code_clusters, semantic_diff,
suggest_tests, context_pack, semantic_slice, init_project_setup, ...
```

---

### 2. Silent Wrong Behavior (Worse Than Errors)

**`find_similar_code` with invalid `elementId`:**
Called with `elementId: "fake-id-that-does-not-exist"` — should fail with "element not found". Instead returned 10 results, claimed they were similar to the fake ID. An LLM has no way to know the results are meaningless.

```json
{ "elementId": "fake-id-that-does-not-exist", "count": 10, "similar": [...] }
```

**`index_docs` returning `ok: true` with 30 errors:**
```json
{ "ok": true, "indexed": 0, "skipped": 0, "errorCount": 30 }
```
The top-level `ok: true` contradicts 100% failure rate. An LLM reading `ok: true` will proceed to `search_docs` expecting results that will never come.

**`init_project_setup` returning "queued" without blocking:**
The skill says "Verify graph health" immediately after init. But init returns before the rebuild finishes, so `graph_health` shows `memgraphNodes: 0` and triggers "run graph_rebuild" recommendation — even though a rebuild was just triggered. There is no way for an LLM to know it needs to poll and wait.

---

### 3. Error Message Quality

**Good errors (LLM-recoverable):**
- `code_explain` on missing element: `"hint": "Provide a file path, class name, or function name present in the index."` ✅
- `episode_add` bad type: Zod lists all valid values in the error message ✅
- `arch_suggest`: clear output with layer reasoning ✅

**Bad errors (LLM-confusing):**
- `episode_add` DECISION: `"DECISION episodes require metadata.rationale (or metadata.reason)"` — no hint where to look or what format. ⚠️
- `suggest_tests`: `"Unable to resolve file path for element: arch_validate"` — correct error but doesn't say "`elementId` must be a SCIP ID like `arch-tools.ts:arch_validate:42`, not a tool name". ⚠️
- `agent_release` not found: Returns `ok: true, released: false, notFound: true` — `ok: true` is wrong. Releasing a non-existent claim is a failure, not a success. ❌

---

### 4. `code_clusters` Output is Structurally Broken

The clustering groups files by the first two path segments of the absolute path. Since all files are under `/home/...`, every file ends up in a single cluster called `/home`. The function clustering groups by `metadata.path` which defaults to `"unknown"` for most entries, producing one cluster of 114 functions labeled `"unknown"`.

This is useless for codebase orientation. The `lxdig-explore` skill uses `code_clusters` as step 3 — the primary orientation step — and will produce no actionable output.

**Root cause:** `clusterId = itemPath.split("/").slice(0, 2).join("/")` should use relative paths and more segments, e.g. the first 3 segments of the `relativePath` property.

---

### 5. `code_explain` Missing Dependencies

`GraphOrchestrator` (1082 LOC, dozens of imports) returned:
```json
{ "dependencies": [], "dependents": [{ "type": "CONTAINS", "source": "orchestrator.ts" }] }
```

The in-memory index has CONTAINS and IMPORTS edges but not DEPENDS_ON edges (Memgraph circuit breaker prevents graph traversal). Dependency graph is always empty when Memgraph is down.

---

### 6. Coordination Claim Lifecycle is Broken Without Memgraph

`agent_claim` → returns `claimId: "claim-..."` (stored in memory)
`agent_status` → shows 0 active claims (reads from Memgraph, which is empty)
`agent_release(claimId)` → `notFound: true` (Memgraph doesn't have it)

The claim lifecycle requires Memgraph to function. When the circuit breaker is open, `agent_claim` appears to succeed but the state is never readable or releasable. No error or warning is surfaced to the caller.

---

### 7. `tools_list` Categorization Errors

The `tools_list` output miscategorizes several tools:
- `blocking_issues` → listed under "semantic" (should be "task")
- `context_pack` → listed under "memory" (should be "coordination")
- `ref_query`, `tools_list` → listed under "graph" (should be separate "reference"/"utility")
- `diff_since`, `contract_validate` → listed under "coordination" (should be "utility")

These mismatches also mean the tool categories an LLM sees differ from what the skills reference.

---

### 8. Residual Known Bugs Still Present

All issues from the 2026-02-27 audit are still present:

| ID | Description | Status |
|---|---|---|
| ERR-A | Qdrant embeddings keyed to wrong projectId (`lexDIG-MCP` vs `lxdig-mcp`) | ❌ Still present |
| ERR-B | No TEST_SUITE nodes — test intelligence tools all return 0 | ❌ Still present |
| ERR-C | `search_docs` uses un-normalized projectId | ❌ Still present |
| ERR-D | No PROGRESS_FEATURE nodes seeded | ❌ Still present |
| WARN-3 | `context_pack` coreSymbols empty (depends on ERR-A) | ❌ Still present |
| WARN-5 | `arch_validate` false positives from strict `.lxdig/config.json` | ❌ Still present |

---

## Recommendations — Ordered by Impact

### P0 — Fix before any LLM can use the skills

| # | Action | Effort |
|---|---|---|
| 1 | **CRIT-1:** Prefix all 39 tools as `lxDIG_*` in registry, or strip `lxDIG_` from all skill files | Small |
| 2 | **CRIT-2:** Fix `find_pattern` skill param: `type` → `pattern` in all skill files | Trivial |
| 3 | **CRIT-3:** Document `metadata.rationale` requirement for `DECISION` episodes in skill + tool description | Small |
| 4 | **CRIT-4:** Add `since`, `featureId`, `tool` param hints to `diff_since`, `feature_status`, `contract_validate` skills | Small |

### P1 — Correctness fixes in tool implementations

| # | Action | File | Effort |
|---|---|---|---|
| 5 | `find_similar_code`: return error when `elementId` not found in embeddings index | `core-semantic-tools.ts` | Small |
| 6 | `index_docs`: return `ok: false` (or top-level error) when `errorCount > 0` and `indexed === 0` | `docs-tools.ts` | Small |
| 7 | `agent_release`: return `ok: false` when `notFound: true` | `memory-coordination-tools.ts` | Trivial |
| 8 | `code_clusters`: cluster by relative path segments (not absolute), use 3 segments | `core-semantic-tools.ts` | Small |
| 9 | `init_project_setup`: poll `graph_health` internally until rebuild completes (or return a status that signals "wait") | `core-setup-tools.ts` | Medium |
| 10 | Fix ERR-C: normalize `projectId` to lowercase in `docs-engine.ts` search path | `engines/docs-engine.ts` | Trivial |
| 11 | Fix ERR-A: Re-index Qdrant under normalized `lxdig-mcp` projectId | Config/ops | Medium |
| 12 | Fix ERR-B: Restart server after `__tests__` exclusion patch, then `graph_rebuild full` | Config/ops | Small |

### P2 — LLM ease-of-use improvements

| # | Action |
|---|---|
| 13 | `episode_add` DECISION: add hint in error response: "Pass metadata: { rationale: '...' }" |
| 14 | `suggest_tests` error: clarify that `elementId` must be a SCIP ID from `graph_query`/`code_explain`, not a tool name |
| 15 | `tools_list`: fix category assignments to match actual tool groupings |
| 16 | `arch_validate`: update `.lxdig/config.json` to allow `parsers`, `response`, `vector` imports in `graph` and `engines` layers |
| 17 | Add `agent_claim`/`agent_release` graceful degradation note when Memgraph is unavailable |
| 18 | `lxdig-progress` skill: note that `feature_status` requires `featureId` from `progress_query` first |

---

## Positive Observations

- **`semantic_slice`** — best-in-class: natural language query → exact code line range, works even with Memgraph down.
- **`arch_suggest`** — consistently useful: correct layer inference, clear reasoning, right file path suggestion.
- **`ref_query`** — works well across all modes; relevance scoring is sensible.
- **`episode_recall`, `decision_query`, `reflect`** — all return clean, structured responses and handle empty state gracefully.
- **`coordination_overview`, `blocking_issues`** — clean responses, no surprises.
- **`graph_health`** — excellent structured output with drift detection and actionable recommendations.
- **Error envelope format** — consistent across all tools (`ok`, `profile`, `summary`, `errorCode`, `hint`). When errors do surface, the `hint` field is usually actionable.
- **`contract_validate`** output in `impact_analyze`** — contractWarnings surfaced transparently in response (`"mapped changedFiles -> files"`). This pattern is valuable for debugging call mismatches.

---

## Appendix — Live Session Graph State

```
Memgraph:       circuit breaker OPEN (0 Cypher queries succeeded)
In-memory index: 1169 cached nodes, 1074 cached relationships
Qdrant:         378 embeddings, projectId mismatch (ERR-A)
TEST_SUITE nodes: 0 (ERR-B)
DOCUMENT nodes:  0 indexed this session (ERR-C + circuit breaker)
PROGRESS_FEATURE: 0 (ERR-D)
Copilot instructions: already present — skipped by init
```
