# Test Audit — lxRAG-MCP

Date: 2026-02-23  
Scope: repository-wide automated tests and critical capability coverage

## 1) Execution result

- Full test suite run: **PASS**
  - Test files: **18 passed**
  - Tests: **208 passed**
- Command: `npm test`

## 2) Coverage snapshot

- Command: `npm run test:coverage`
- Global coverage:
  - Statements: **55.79%**
  - Branches: **44.19%**
  - Functions: **57.88%**
  - Lines: **56.94%**

Interpretation: coverage is now materially improved and over half the codebase by lines is covered. Remaining risk is concentrated in integration-heavy paths and low-level utilities.

## 3) What is well covered

### A. Documentation pipeline (strong)

- `src/parsers/docs-parser.ts` (~99% lines)
- `src/graph/docs-builder.ts` (~100% lines)
- `src/engines/docs-engine.ts` (~97% lines)
- `src/tools/handlers/docs-tools.ts` (~91% lines)

Validated capabilities:

- Markdown parse/split/metadata extraction
- DOCUMENT/SECTION graph generation
- Incremental indexing and search behavior

### B. Tool-handler contracts + regressions + lifecycle/query paths

Covered in `src/tools/tool-handlers.contract.test.ts` (**46 tests**):

- Input normalization and contract warnings
- Session workspace isolation and BigInt-safe health paths
- Core lifecycle/query behavior (`graph_set_workspace`, `graph_rebuild`, `graph_query`)
- Broad contract coverage across architecture/test/memory/coordination/setup/reference tools
- Watcher callback integration behavior (`runWatcherIncrementalRebuild`) for tx write, incremental payload forwarding, and embedding readiness reset

### C. Engine/graph/vector runtime paths (expanded)

- `src/engines/architecture-engine.test.ts`
- `src/engines/progress-engine.test.ts`
- `src/graph/hybrid-retriever.test.ts`
- `src/graph/orchestrator.test.ts`
- `src/graph/client.test.ts`
- `src/graph/watcher.test.ts`
- `src/vector/embedding-engine.test.ts`
- `src/vector/qdrant-client.test.ts`

Memgraph client resiliency now explicitly tested:

- host fallback (`memgraph` → `localhost`)
- transient query retry path
- non-transient no-retry path
- connection-failure envelope path

Orchestrator freshness normalization now explicitly tested:

- dedupe of repeated incremental changed-file entries
- filtering of out-of-workspace changed-file paths

## 4) Critical functionality still under-covered

### A. Graph lifecycle integration depth

Still lower-confidence end-to-end areas:

- `src/graph/orchestrator.ts` (~49% lines)
- `src/graph/builder.ts` (~55% lines)
- watcher + rebuild freshness behavior under concurrent changes

### B. Remaining high-value tool scenarios

Even with broad contract coverage, these need deeper scenario matrices:

- coordination/episode persistence conflict permutations
- setup/reference behavior on larger repos and failure branches
- natural/hybrid `graph_query` behavior under live Memgraph variability

### C. Utility layer (now strong)

- `src/utils/exec-utils.ts` now covered at **100% lines**
- `src/utils/validation.ts` now covered at **91.52% lines**
- Remaining utility risk is limited to a small set of uncovered error/branch paths

### D. Parser registry routing (now covered)

- `src/parsers/parser-registry.ts` now covered at **100% lines**
- Registration normalization and parser selection/dispatch paths are now validated

### E. Response budget logic (now covered)

- `src/response/budget.ts` now covered at **100% lines**
- Budget defaults/overrides, token estimation, and slot-fill overflow behavior are now validated

### F. Response schema prioritization (now strong)

- `src/response/schemas.ts` now covered at **89.47% lines**
- Field-priority trimming behavior (required preservation + low→medium→high drop order) is now validated

## 5) Recommended next test priorities

1. Add live-driver integration matrix for Memgraph error classes (beyond mocked-driver behavior).
2. Extend watcher/orchestrator integration tests for end-to-end incremental freshness guarantees (including tool-handler watcher callback paths).
3. Expand persistence/failure scenarios for coordination + episode engines.
4. Extend low-coverage parser/engine modules where high-severity regressions are most likely.

## 6) Verification log (latest wave)

- Targeted watcher/orchestrator suites:
  - `npm test -- src/graph/orchestrator.test.ts src/graph/watcher.test.ts`
  - **4 passed (4)**

- Targeted contract suite:
  - `npm test -- src/tools/tool-handlers.contract.test.ts`
  - **46 passed (46)**
- Targeted Memgraph client suite:
  - `npm test -- src/graph/client.test.ts`
  - **7 passed (7)**
- Targeted utility suites:
  - `npm test -- src/utils/validation.test.ts src/utils/exec-utils.test.ts`
  - **16 passed (16)**
- Targeted parser registry suite:
  - `npm test -- src/parsers/parser-registry.test.ts`
  - **4 passed (4)**
- Targeted response budget suite:
  - `npm test -- src/response/budget.test.ts`
  - **6 passed (6)**
- Targeted response schemas suite:
  - `npm test -- src/response/schemas.test.ts`
  - **5 passed (5)**
- Full suite:
  - `npm test`
  - **18 files passed, 208 tests passed**
- Coverage:
  - `npm run test:coverage`
  - **56.94% lines**, **55.79% statements**, **44.19% branches**, **57.88% functions**

## 7) Notes

- Coverage uses `@vitest/coverage-v8`.
- Expected mocked-environment warnings remain present in logs and are currently non-failing by design.
