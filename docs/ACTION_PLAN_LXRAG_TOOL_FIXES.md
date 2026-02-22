# Action Plan: Fix lxRAG Tool Issues (graph_health, feature_status, progress_query)

**Status:** Draft - Requires Implementation
**Date:** 2026-02-22
**Project:** lexRAG-MCP + code-visual (visualization client)
**Severity:** High (3 out of 4 primary operational tools broken)

---

## Executive Summary

Three critical lxRAG tools are returning incorrect data due to a **project-scoping divergence**. The in-memory graph index (`GraphIndexManager`) is global and non-scoped, while the Memgraph database supports per-project queries. When users switch projects via `graph_set_workspace`, the read-path breaks because:

1. Engines are initialized **once** at startup with a global, unfiltered index
2. Project context switches **do not reinitialize** engines
3. Query tools read from **stale in-memory state** instead of the live project-scoped graph

**Impact:**
- Health checks are misleading (report empty graphs when data exists)
- Feature and task queries fail on valid IDs
- Operational dashboards in code-visual cannot trust lxRAG data

---

## Issue Analysis

### Issue #1: `mcp_lxrag_graph_health` reports zero indexed graph entities

**Symptoms:**
- Tool returns `graphIndex.totalNodes = 0`, `graphIndex.totalRelationships = 0`
- Live Memgraph shows `809` nodes and `1359` relationships for same project

**Root Cause:**
- **Location:** [tool-handlers.ts:1782-1787](src/tools/tool-handlers.ts#L1782)
  ```typescript
  const stats = this.context.index.getStatistics();
  const functionCount = this.context.index.getNodesByType("FUNCTION").length;
  const classCount = this.context.index.getNodesByType("CLASS").length;
  const fileCount = this.context.index.getNodesByType("FILE").length;
  ```
- **Problem:** Reads from global `GraphIndexManager` without projectId filtering
- **Why it fails:** When `graph_set_workspace` is called, the index is never cleared or reloaded with new project data

**Diagnosis Path:**
1. `graph_set_workspace(projectId=code-visual)` → sets active context but doesn't reinitialize engines
2. `graph_health` → reads from stale global index still containing previous project's data
3. Memgraph queries in same tool (lines 1798-1804) DO use projectId filtering and return correct counts
4. **Inconsistency proves the divergence:** Index-based reads ≠ Cypher-based reads

---

### Issue #2: `mcp_lxrag_feature_status` fails on valid feature IDs

**Symptoms:**
- Tool returns "Feature not found: code-visual:feature:phase-1"
- Direct Cypher query finds the node: `MATCH (f:FEATURE {id: "code-visual:feature:phase-1"}) RETURN f`

**Root Cause:**
- **Location:** [progress-engine.ts:76-91](src/engines/progress-engine.ts#L76) (initialization)
- **Location:** [progress-engine.ts:183-185](src/engines/progress-engine.ts#L183) (lookup)
  ```typescript
  private loadFromGraph(): void {
    const featureNodes = this.index.getNodesByType("FEATURE");
    // ... populate this.features Map
  }

  getFeatureStatus(featureId: string): FeatureStatus | null {
    const feature = this.features.get(featureId); // ← Searches stale Map
    if (!feature) return null; // ← Returns null for valid IDs
  }
  ```
- **Problem:** ProgressEngine loads features once at initialization from global index
- **Why it fails:** Engines initialized at ToolHandlers constructor ([tool-handlers.ts:75](src/tools/tool-handlers.ts#L75)) before any project context exists. When project changes, the engine still holds old data.

**Diagnosis Path:**
1. ToolHandlers constructor → `initializeEngines()` → ProgressEngine initialized with empty/wrong index
2. `graph_set_workspace()` → sets active project context but does NOT call `progressEngine.reload()`
3. `feature_status()` → looks in stale `this.features` Map
4. Valid features exist in Memgraph but not in the in-memory Map

---

### Issue #3: `mcp_lxrag_progress_query` returns empty despite existing tasks

**Symptoms:**
- Tool returns `items: []`, `totalCount: 0`
- Live Memgraph shows `TASK` nodes with statuses: `completed:3`, `in-progress:2`, `pending:2`

**Root Cause:**
- **Location:** [progress-engine.ts:124-160](src/engines/progress-engine.ts#L124)
  ```typescript
  query(type: "feature" | "task", filter?: {...}): ProgressQueryResult {
    if (type === "task") {
      for (const task of this.tasks.values()) { // ← Empty Map for new project
        if (filter?.status && task.status !== filter.status) continue;
        items.push(task);
      }
    }
  }
  ```
- **Problem:** Same as Issue #2 — `this.tasks` Map never reloaded when project changes
- **Why it fails:** ProgressEngine.query() always returns empty for new project until graph_rebuild completes

---

## Cross-Issue Pattern: Read-Path Divergence

All three issues stem from the same architectural mismatch:

| Data Source | Scoping | Project-Aware? | Refresh on Switch? |
|---|---|---|---|
| **GraphIndexManager** (in-memory) | Global accumulator | ❌ No | ❌ No |
| **ProgressEngine state** (Maps) | In-memory snapshots | ❌ No | ❌ No |
| **Memgraph queries** (Cypher) | Per-project via WHERE clause | ✅ Yes | N/A (always current) |
| **graph_health Cypher paths** (lines 1798+) | Per-project via WHERE clause | ✅ Yes | N/A (always current) |

**The issue:** Tools mix Cypher-based reads (project-scoped, correct) with index-based reads (global, stale).

---

## Recommended Fix Order

### Fix #1: Add Project-Scoped Index Reloading (Medium effort, high impact)

**Goal:** Reinitialize ProgressEngine when project context changes

**Changes Required:**

**[1.1] ProgressEngine: Add reload() method**
- **File:** `src/engines/progress-engine.ts`
- **Change:** Add a method to reload features and tasks from the current graph index
  ```typescript
  reload(index: GraphIndexManager, projectId?: string): void {
    this.features.clear();
    this.tasks.clear();
    this.loadFromGraph(index, projectId);
  }
  ```
- **Details:** If `projectId` provided, filter nodes to those matching `node.properties.projectId === projectId`

**[1.2] ToolHandlers: Reinitialize ProgressEngine on project context change**
- **File:** `src/tools/tool-handlers.ts`
- **Change:** Modify `setActiveProjectContext()` to trigger engine reloads
  ```typescript
  private setActiveProjectContext(context: ProjectContext): void {
    // ... existing code ...
    const sessionId = this.getCurrentSessionId();
    if (sessionId) {
      this.sessionProjectContexts.set(sessionId, context);
    } else {
      this.defaultActiveProjectContext = context;
    }
    // NEW: Reload engines with new context
    this.reloadEnginesForContext(context);
  }

  private reloadEnginesForContext(context: ProjectContext): void {
    this.progressEngine?.reload(this.context.index, context.projectId);
    this.testEngine?.reload(this.context.index, context.projectId);
    this.archEngine?.reload(this.context.index, context.projectId);
  }
  ```

**[1.3] TestEngine: Add reload() method**
- **File:** `src/engines/test-engine.ts`
- **Change:** Similar to ProgressEngine — reload test-related nodes filtered by projectId

**[1.4] ArchitectureEngine: Add reload() method**
- **File:** `src/engines/architecture-engine.ts`
- **Change:** Reload architecture/violation nodes filtered by projectId

---

### Fix #2: Make graph_health Query-First (Low effort, medium impact)

**Goal:** Replace index-based statistics with Memgraph queries for authoritative counts

**Changes Required:**

**[2.1] graph_health: Query Memgraph for node counts**
- **File:** `src/tools/tool-handlers.ts`, lines 1778-1850
- **Change:** Replace lines 1782-1787 with Cypher queries:
  ```typescript
  const stats = this.context.index.getStatistics(); // REMOVE or deprecate

  // ADD: Query-based counts (project-scoped)
  const { projectId } = this.getActiveProjectContext();

  const nodeCountResult = await this.context.memgraph.executeCypher(
    `MATCH (n {projectId: $projectId}) RETURN count(n) AS totalNodes`,
    { projectId }
  );
  const relationshipCountResult = await this.context.memgraph.executeCypher(
    `MATCH (f {projectId: $projectId})-[r]->(t {projectId: $projectId}) RETURN count(r) AS totalRels`,
    { projectId }
  );

  const totalNodes = nodeCountResult.data?.[0]?.totalNodes || 0;
  const totalRelationships = relationshipCountResult.data?.[0]?.totalRels || 0;

  // Keep symbol counts from index (they're local only)
  const functionCount = this.context.index.getNodesByType("FUNCTION").length;
  // ...
  ```

**[2.2] Deprecate global index statistics**
- **File:** `src/graph/index.ts`
- **Change:** Add warning comment that `getStatistics()` is not project-scoped; prefer Cypher for operational queries

---

### Fix #3: Add Parity Tests (Medium effort, high value)

**Goal:** Detect read-path divergence automatically

**Changes Required:**

**[3.1] Create parity test suite**
- **File:** `src/tools/tool-handlers.parity.test.ts` (new file)
- **Tests:**
  1. After `graph_set_workspace(projectId=TEST_PROJECT)`, verify:
     - `graph_health` reports non-zero counts
     - These counts match `MATCH (n {projectId: TEST_PROJECT}) RETURN count(n)`
  2. After seeding test features, verify:
     - `feature_status(id)` resolves valid IDs
     - `progress_query(type="feature")` returns seeded features
  3. Task counts match between `progress_query` and Cypher `MATCH (t:TASK {projectId: ...})`

**[3.2] Add diagnostics to tool responses**
- **Location:** All three tools' responses
- **Addition:** Include a `_diagnostics` object in success responses:
  ```json
  {
    "success": true,
    "data": { ... },
    "_diagnostics": {
      "projectId": "code-visual",
      "source": "in-memory-index|cypher-query",
      "indexedAt": "2026-02-22T10:30:00Z",
      "warning": "Results from stale index; recommend graph_rebuild"
    }
  }
  ```

---

### Fix #4: Add Explicit Project-Scoping to GraphIndexManager (Long term, architectural)

**Goal:** Make the index project-aware from the ground up

**Rationale:** This is the "right" solution but requires more refactoring. Consider for v2.

**Changes Sketched:**
1. Split `GraphIndexManager` into `PerProjectIndexManager`
2. Store one index per projectId
3. Only load/query the active project's index
4. This would eliminate all three issues at the source

---

## Implementation Priority

**Phase 1 (Immediate - 2-3 hours):**
- ✅ Fix #2: Make graph_health query-first
- ✅ Fix #1.1 & #1.2: Add ProgressEngine reload on project context change
- Validates: Issue #1 (health), Issue #2 (feature_status), Issue #3 (progress_query)

**Phase 2 (Follow-up - 1-2 hours):**
- ✅ Fix #1.3 & #1.4: Add reload to TestEngine and ArchitectureEngine
- ✅ Fix #3: Add parity tests and diagnostics

**Phase 3 (Backlog - Design-level):**
- ✅ Fix #4: Architectural refactor to per-project indices

---

## Validation & Acceptance Criteria

After fixes are implemented, validate against the original reproduction case from code-visual:

```json
Prerequisite:
1. graph_set_workspace({ projectId: "code-visual", workspaceRoot: "/path/to/code-visual", sourceDir: "src" })
2. graph_rebuild({ mode: "full" })

Test Case 1 — graph_health parity:
  Before: { graphIndex: { totalNodes: 0, totalRelationships: 0 } }
  After: { graphIndex: { totalNodes: 809, totalRelationships: 1359 } } ✅
  Verify: Matches Memgraph query counts

Test Case 2 — feature_status resolution:
  Before: Feature not found: code-visual:feature:phase-1
  After: { success: true, feature: { ... }, tasks: [...] } ✅

Test Case 3 — progress_query item counts:
  Before: { items: [], totalCount: 0 }
  After: { items: [7 TASK nodes], totalCount: 7, completedCount: 3, inProgressCount: 2, blockedCount: 2 } ✅
  Verify: Status breakdown matches `MATCH (t:TASK) RETURN t.status, count(*)`
```

---

## Code-Visual Integration Notes

The visualization project (code-visual) will benefit from:

1. **Reliable health checks** — can use `graph_health` as a readiness signal
2. **Accurate progress dashboards** — `progress_query` + `feature_status` will show real data
3. **Consistent operational data** — Memgraph queries and tool responses will be in sync
4. **Diagnostics output** — can warn users if index is stale and recommend rebuild

---

## Summary of Findings

| Issue | Root Cause | Fix Category | Effort | Impact |
|---|---|---|---|---|
| `graph_health` returns zeros | Index not scoped by projectId | Replace with Cypher query | Low | High |
| `feature_status` "not found" | ProgressEngine state not reloaded on project switch | Reload on context change | Medium | High |
| `progress_query` empty | Same as feature_status | Reload on context change | Medium | High |

**The fix is NOT to add projectId filtering to every index operation.** The fix is to:
1. **Keep the index global** (performance benefit for local operations)
2. **Reinitialize engines** when project context changes
3. **Use Cypher for operational queries** (health, stats) that need to be authoritative

This preserves performance (index stays global) while fixing the read-path divergence (engines reload when context changes).

---

## Related Files

- Main issue tracking: `docs/lxrag-tool-issues.md`
- Tool implementations: `src/tools/tool-handlers.ts`
- Engines:
  - `src/engines/progress-engine.ts` (Issues #2, #3)
  - `src/graph/index.ts` (Issue #1 context)
- Graph client: `src/graph/client.ts`
- Orchestrator: `src/graph/orchestrator.ts`

---

## Next Steps

1. **Assign to developer** → Implement Phase 1 fixes
2. **Run validation tests** against code-visual test data
3. **Update QUICK_REFERENCE.md** with notes about tool reliability and parity guarantees
4. **Close issues** in code-visual once validated
5. **Add regression tests** to prevent future divergence

