# Graph Tools Benchmark Matrix

Generated: 2026-02-21T23:42:24.987677+00:00

## Storage

- Canonical results database: benchmarks/graph_tools_benchmark.sqlite
- Result rows are stored in `benchmark_results` with per-run keys in `benchmark_runs`.

## Method

- At least 4 scenarios per MCP tool (19 tools => 76 scenarios total).
- Compared each MCP graph-server tool against a standard non-graph workflow (CLI/manual equivalent).
- Metrics: latency, accuracy (expectation-match score), estimated token usage, success rate, and winner.
- Token estimate uses `ceil(characters / 4)` for both request and output.
- `mcp_only` indicates no practical automated non-graph equivalent.

## Matrix

| ID   | Tool              | Scenario                                         | MCP ms | Baseline ms | MCP Acc | Base Acc | MCP Tok | Base Tok | Winner   | Notes                                                                                 |
| ---- | ----------------- | ------------------------------------------------ | -----: | ----------: | ------: | -------: | ------: | -------: | -------- | ------------------------------------------------------------------------------------- |
| T001 | graph_query       | Cypher: list all FILES in the graph              |  31.11 |      210.09 |   0.000 |    1.000 |      78 |      265 | mcp      | Low MCP accuracy on this scenario                                                     |
| T002 | graph_query       | Cypher: functions exported from tool-handlers    |  15.22 |      207.85 |   0.000 |    1.000 |      97 |      488 | mcp      | Low MCP accuracy on this scenario                                                     |
| T003 | graph_query       | Natural: files that import GraphOrchestrator     |  14.66 |      218.28 |   0.000 |    1.000 |      73 |      117 | mcp      | Natural-language query quality is low; Low MCP accuracy on this scenario              |
| T004 | graph_query       | Cypher: class nodes with their file paths        |  16.29 |      207.48 |   0.000 |    1.000 |      86 |      471 | mcp      | Low MCP accuracy on this scenario                                                     |
| T005 | code_explain      | Explain tool-handlers.ts                         |  15.28 |      209.45 |   0.000 |    1.000 |      64 |      303 | mcp      | Low MCP accuracy on this scenario                                                     |
| T006 | code_explain      | Explain ToolHandlers class                       |  14.97 |      205.38 |   0.000 |    1.000 |      63 |      408 | mcp      | Low MCP accuracy on this scenario                                                     |
| T007 | code_explain      | Explain ProgressEngine                           |  15.15 |      204.99 |   0.000 |    1.000 |      63 |       24 | baseline | Low MCP accuracy on this scenario                                                     |
| T008 | code_explain      | Explain GraphOrchestrator                        |  14.73 |      203.41 |   0.000 |    1.000 |      64 |       24 | baseline | Low MCP accuracy on this scenario                                                     |
| T009 | arch_validate     | Validate architecture defaults                   |  14.69 |      204.03 |   0.000 |    1.000 |      57 |      154 | mcp      | Low MCP accuracy on this scenario                                                     |
| T010 | arch_validate     | Validate architecture strict mode                |  15.15 |      216.76 |   0.000 |    1.000 |      57 |      213 | mcp      | Low MCP accuracy on this scenario                                                     |
| T011 | arch_validate     | Validate specific engine files                   |  15.00 |      218.49 |   0.000 |    1.000 |      78 |      215 | mcp      | Low MCP accuracy on this scenario                                                     |
| T012 | arch_validate     | Validate graph layer files                       |  15.73 |      228.16 |   0.000 |    1.000 |      74 |      253 | mcp      | Low MCP accuracy on this scenario                                                     |
| T013 | test_select       | Test select for tool-handlers change             |  15.69 |      211.72 |   0.000 |    1.000 |      65 |       30 | baseline | Low MCP accuracy on this scenario                                                     |
| T014 | test_select       | Test select for progress-engine change           |  15.14 |      224.28 |   0.000 |    1.000 |      66 |       31 | baseline | Low MCP accuracy on this scenario                                                     |
| T015 | test_select       | Test select for orchestrator change              |  14.56 |      206.63 |   0.000 |    0.000 |      65 |       22 | tie      | Low MCP accuracy on this scenario                                                     |
| T016 | test_select       | Test select for contract test file               |  14.79 |      226.22 |   0.000 |    1.000 |      68 |       22 | baseline | Low MCP accuracy on this scenario                                                     |
| T017 | graph_rebuild     | Rebuild incremental (lxDIG-MCP src)             |  15.84 |      205.97 |   0.000 |    1.000 |      64 |       11 | baseline | Low MCP accuracy on this scenario                                                     |
| T018 | graph_rebuild     | Rebuild incremental verbose                      |  14.31 |      203.85 |   0.000 |    1.000 |      63 |       13 | baseline | Low MCP accuracy on this scenario                                                     |
| T019 | graph_rebuild     | Rebuild full mode                                |  15.11 |      218.72 |   0.000 |    1.000 |      62 |       12 | baseline | Low MCP accuracy on this scenario                                                     |
| T020 | graph_rebuild     | Rebuild full verbose                             |  14.50 |      204.09 |   0.000 |    1.000 |      62 |        7 | baseline | Low MCP accuracy on this scenario                                                     |
| T021 | find_pattern      | Pattern: architecture violations                 |  14.71 |      206.10 |   0.000 |    1.000 |      69 |      155 | mcp      | Low MCP accuracy on this scenario                                                     |
| T022 | find_pattern      | Pattern: unused nodes                            |  15.48 |      216.87 |   0.000 |    1.000 |      64 |      191 | mcp      | Low MCP accuracy on this scenario                                                     |
| T023 | find_pattern      | Pattern: circular deps (returns NOT_IMPLEMENTED) |  14.74 |      204.03 |   1.000 |    1.000 |      67 |      170 | mcp      | -                                                                                     |
| T024 | find_pattern      | Pattern: generic symbol search                   |  14.54 |      212.45 |   0.000 |    1.000 |      65 |      408 | mcp      | Low MCP accuracy on this scenario                                                     |
| T025 | arch_suggest      | Suggest placement: EpisodeEngine (new service)   |  15.52 |      222.94 |   0.000 |    1.000 |      78 |       23 | baseline | Low MCP accuracy on this scenario                                                     |
| T026 | arch_suggest      | Suggest placement: CoordinationEngine            |  18.15 |      211.14 |   0.000 |    1.000 |      75 |       72 | baseline | Low MCP accuracy on this scenario                                                     |
| T027 | arch_suggest      | Suggest placement: HybridRetriever utility       |  15.28 |      209.94 |   0.000 |    1.000 |      78 |       23 | baseline | Low MCP accuracy on this scenario                                                     |
| T028 | arch_suggest      | Suggest placement: ContextBudget helper          |  14.96 |      206.49 |   0.000 |    1.000 |      69 |       25 | baseline | Low MCP accuracy on this scenario                                                     |
| T029 | test_categorize   | Categorize all tests (empty list = statistics)   |  14.52 |      226.54 |   0.000 |    1.000 |      58 |       36 | baseline | Low MCP accuracy on this scenario                                                     |
| T030 | test_categorize   | Categorize contract test file                    |  15.53 |      207.17 |   0.000 |    1.000 |      69 |       22 | baseline | Low MCP accuracy on this scenario                                                     |
| T031 | test_categorize   | Categorize integration test sample               |  14.37 |      215.33 |   0.000 |    1.000 |      63 |       12 | baseline | Low MCP accuracy on this scenario                                                     |
| T032 | test_categorize   | Categorize vitest setup file                     |  14.79 |      203.57 |   0.000 |    1.000 |      62 |       10 | baseline | Low MCP accuracy on this scenario                                                     |
| T033 | impact_analyze    | Impact: change to tool-handlers.ts               |  14.45 |      204.51 |   0.000 |    1.000 |      67 |       30 | baseline | Low MCP accuracy on this scenario                                                     |
| T034 | impact_analyze    | Impact: change to graph client                   |  13.95 |      219.34 |   0.000 |    0.000 |      65 |       21 | tie      | Low MCP accuracy on this scenario                                                     |
| T035 | impact_analyze    | Impact: change to embedding engine               |  14.05 |      205.82 |   0.000 |    0.000 |      68 |       22 | tie      | Low MCP accuracy on this scenario                                                     |
| T036 | impact_analyze    | Impact: change to progress engine                |  14.95 |      203.45 |   0.000 |    1.000 |      68 |       31 | baseline | Low MCP accuracy on this scenario                                                     |
| T037 | test_run          | Run contract tests                               |  14.25 |     1895.98 |   1.000 |    1.000 |      71 |      737 | mcp      | -                                                                                     |
| T038 | test_run          | Run non-existent test file (error path)          |  14.41 |      784.56 |   1.000 |    1.000 |      70 |      105 | mcp      | -                                                                                     |
| T039 | progress_query    | Progress query: in-progress tasks                |  14.82 |         N/A |   0.000 |    1.000 |      66 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T040 | progress_query    | Progress query: blocked                          |  14.02 |         N/A |   0.000 |    1.000 |      65 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T041 | progress_query    | Progress query: completed                        |  14.15 |         N/A |   0.000 |    1.000 |      66 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T042 | progress_query    | Progress query: all features                     |  13.95 |         N/A |   0.000 |    1.000 |      65 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T043 | task_update       | Update task PHASE1-001 → in-progress             |  13.82 |         N/A |   0.000 |    1.000 |      74 |       19 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T044 | task_update       | Update task PHASE2-001 → in-progress             |  13.87 |         N/A |   0.000 |    1.000 |      75 |       19 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T045 | task_update       | Update task PHASE3-001 → blocked                 |  14.01 |         N/A |   0.000 |    1.000 |      72 |       19 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T046 | task_update       | Update task PHASE5-001 → completed               |  13.61 |         N/A |   0.000 |    1.000 |      73 |       19 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T047 | feature_status    | Feature: FEAT-CONTEXT-BUDGET                     |  14.10 |         N/A |   0.000 |    1.000 |      63 |       21 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T048 | feature_status    | Feature: FEAT-EPISODE-MEMORY                     |  14.04 |         N/A |   0.000 |    1.000 |      63 |       21 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T049 | feature_status    | Feature: FEAT-CONTEXT-PACK                       |  14.07 |         N/A |   0.000 |    1.000 |      62 |       21 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T050 | feature_status    | Feature: FEAT-HYBRID-RETRIEVAL                   |  14.27 |         N/A |   0.000 |    1.000 |      63 |       21 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T051 | blocking_issues   | Blockers: all                                    |  14.08 |         N/A |   0.000 |    1.000 |      58 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T052 | blocking_issues   | Blockers: critical                               |  13.86 |         N/A |   0.000 |    1.000 |      59 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T053 | blocking_issues   | Blockers: features                               |  14.23 |         N/A |   0.000 |    1.000 |      59 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T054 | blocking_issues   | Blockers: tests                                  |  13.68 |         N/A |   0.000 |    1.000 |      58 |       20 | mcp_only | No direct non-graph automation; Low MCP accuracy on this scenario                     |
| T055 | semantic_search   | Semantic search: episode memory design           |  14.06 |      215.91 |   0.000 |    1.000 |      73 |      368 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T056 | semantic_search   | Semantic search: PPR graph retrieval             |  15.54 |      214.19 |   0.000 |    1.000 |      77 |      189 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T057 | semantic_search   | Semantic search: context budget allocation       |  14.28 |      205.88 |   0.000 |    1.000 |      77 |      395 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T058 | semantic_search   | Semantic search: temporal graph model            |  14.28 |      212.33 |   0.000 |    0.000 |      75 |      165 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T059 | find_similar_code | Similar to ToolHandlers                          |  14.83 |      205.73 |   0.000 |    1.000 |      69 |      408 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T060 | find_similar_code | Similar to ProgressEngine                        |  14.69 |      207.83 |   0.000 |    1.000 |      70 |      235 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T061 | find_similar_code | Similar to EmbeddingEngine                       |  14.84 |      205.03 |   0.000 |    1.000 |      70 |      310 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T062 | find_similar_code | Similar to ArchitectureEngine                    |  14.24 |      207.38 |   0.000 |    1.000 |      71 |      155 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T063 | code_clusters     | Cluster files by directory                       |  15.18 |      202.61 |   0.000 |    1.000 |      60 |       31 | baseline | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T064 | code_clusters     | Cluster functions                                |  15.95 |      213.17 |   0.000 |    1.000 |      61 |      438 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T065 | code_clusters     | Cluster classes                                  |  14.73 |      204.54 |   0.000 |    1.000 |      61 |      362 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T066 | code_clusters     | Cluster files top 3                              |  14.30 |      204.53 |   0.000 |    1.000 |      60 |       31 | baseline | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T067 | semantic_diff     | Semantic diff: two engine files                  |  14.63 |      203.97 |   0.000 |    1.000 |      78 |      308 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T068 | semantic_diff     | Semantic diff: two graph files                   |  14.76 |      207.71 |   0.000 |    1.000 |      74 |      323 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T069 | semantic_diff     | Semantic diff: two vector files                  |  14.37 |      210.30 |   0.000 |    1.000 |      77 |      269 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T070 | semantic_diff     | Semantic diff: server vs mcp-server              |  14.12 |      203.51 |   0.000 |    1.000 |      70 |      393 | mcp      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T071 | suggest_tests     | Suggest tests for tool-handlers.ts               |  14.82 |      209.88 |   0.000 |    1.000 |      67 |       26 | baseline | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T072 | suggest_tests     | Suggest tests for progress-engine.ts             |  15.06 |      207.61 |   0.000 |    1.000 |      68 |       27 | baseline | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T073 | suggest_tests     | Suggest tests for graph/client.ts                |  15.05 |      206.45 |   0.000 |    0.000 |      65 |       18 | tie      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |
| T074 | suggest_tests     | Suggest tests for embedding-engine.ts            |  15.11 |      206.14 |   0.000 |    0.000 |      68 |       18 | tie      | Vector tool: requires Qdrant index to be populated; Low MCP accuracy on this scenario |

## Summary

- Total scenarios: 74
- Tools covered: 19
- Minimum scenarios per tool: 2
- MCP faster: 58 | Baseline faster: 0 | Ties: 0
- MCP better accuracy: 0 | Baseline better accuracy: 65 | Equal: 9
- MCP lower token usage: 30 | Baseline lower token usage: 44 | Equal: 0
- MCP-only scenarios: 16
- Token budget compliance (compact ≤300 tok): 74 / 74
- Answer-first summary field present: 0 / 74

## Improvement Targets

- Phase 1: Ensure compact profile consistently meets \_tokenEstimate ≤ 300 target (response shaper in tool-handlers.ts).
- Phase 2: Add bi-temporal (validFrom/validTo) to all FILE/FUNCTION/CLASS nodes in graph/builder.ts.
- Phase 3: Replace in-memory CHECKPOINT with persistent EPISODE nodes (new episode-engine.ts).
- Phase 5: Implement context_pack tool with PPR-based retrieval (ppr.ts + context-pack handler).
- Phase 8: Replace routeNaturalToCypher regex stubs with hybrid retriever (vector+BM25+PPR via RRF in hybrid-retriever.ts).

## Re-run

```bash
PYENV_VERSION=system python3 tools/graph-server/scripts/benchmark_graph_tools.py
```

## SQLite Quick Queries

```bash
sqlite3 tools/graph-server/benchmarks/graph_tools_benchmark.sqlite "SELECT tool, COUNT(*) FROM benchmark_results WHERE run_id=(SELECT run_id FROM benchmark_runs ORDER BY generated_at DESC LIMIT 1) GROUP BY tool ORDER BY tool;"
sqlite3 tools/graph-server/benchmarks/graph_tools_benchmark.sqlite "SELECT winner, COUNT(*) FROM benchmark_results WHERE run_id=(SELECT run_id FROM benchmark_runs ORDER BY generated_at DESC LIMIT 1) GROUP BY winner;"
```
