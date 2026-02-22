# REVISED Action Plan: lxRAG Tool Issues Analysis
## Updated After CLI Command Investigation & Graph State Analysis

**Status:** Analysis Complete - Ready for Implementation
**Date:** 2026-02-22
**Analysis Depth:** Full graph state lifecycle investigation
**Previous Analysis:** ACTION_PLAN_LXRAG_TOOL_FIXES.md (superseded by this document)

---

## What Changed: New Findings from Graph State Analysis

### Discovery #1: The Index is Mostly EMPTY, Not Just Unscoped

**Previous Understanding:**
- "The index is global and not project-scoped"

**Actual Reality:**
- The shared `GraphIndexManager` starts **empty** at server startup
- It's **never populated** from Memgraph
- It's **never synced** from Orchestrator after builds
- It remains empty throughout the server's lifetime (except for manual adds)

**Impact on Original Issues:**
```
✗ graph_health reports zeros because:
  └─ It reads from empty shared index
  └─ NOT because data is "un-scoped"

✗ feature_status fails because:
  └─ ProgressEngine.features Map is empty
  └─ NOT because of stale project-scoped data

✗ progress_query returns empty because:
  └─ ProgressEngine.tasks Map is empty
  └─ NOT because of stale project-scoped data
```

### Discovery #2: Three Unsynced Index Systems Exist

```
SYSTEM 1: GraphOrchestrator.index (Internal)
├─ Created during graph_rebuild()
├─ Populated with ALL parsed source code
├─ Used to generate Cypher statements
└─ DISCARDED after build (never synced to shared index)

SYSTEM 2: ToolContext.index (Shared, Global)
├─ Initialized empty at server startup
├─ Never populated from Memgraph
├─ Never synced from Orchestrator
├─ Used by ALL engines (ProgressEngine, TestEngine, etc.)
└─ Remains empty during normal operation

SYSTEM 3: Memgraph Database (Source of Truth)
├─ Updated by Orchestrator's Cypher statements
├─ Queried directly by tool implementations
├─ Accurate and current
└─ NOT synced back to shared index
```

### Discovery #3: CLI Commands Were Read-Only Diagnostic Queries

The curl commands in the issues document were **not data-modifying operations**. They were:

```bash
# These are all SELECT-only (immutable) operations:
MATCH (n) RETURN count(n) AS nodes          # ← Read-only
MATCH ()-[r]->() RETURN count(r) AS rels    # ← Read-only
MATCH (f:FEATURE) RETURN f.id, f.name...    # ← Read-only
MATCH (t:TASK) RETURN t.status, count(*)    # ← Read-only
```

**What they revealed:**
- Memgraph DOES contain 809 nodes, 1359 relationships
- Features and tasks exist in database
- These nodes likely came from code-visual's own graph_rebuild
- The database is the source of truth and is NOT broken

**What they didn't change:**
- The empty shared index
- Engine states
- Project context

---

## Root Cause: The Triple-Mismatch Problem

### The Actual Architecture Flaw

```
graph_rebuild() called
    ↓
Orchestrator.build()
    ├─ Parses source files
    ├─ Creates internal GraphIndexManager (temporary)
    ├─ Populates: FILE, FUNCTION, CLASS nodes in internal index
    ├─ Generates Cypher statements (INSERT/MATCH/CREATE)
    ├─ Executes Cypher → Memgraph database updated ✅
    ├─ PROBLEM: Never syncs back to ToolContext.index ❌
    └─ Discards internal index
        ↓
ToolContext.index remains empty
    ├─ graph_health reads from here → returns zeros ❌
    ├─ ProgressEngine reads from here → returns empty maps ❌
    ├─ All engines reference this empty index ❌

Memgraph database is updated ✅
    ├─ Contains accurate nodes and relationships
    ├─ Is current and correct
    ├─ But is NOT synced to shared index ❌
```

### Why Code-Visual Works (Partially)

Code-visual's proxy **bypasses the shared index entirely**:

```
code-visual frontend
    ↓
memgraph-proxy.mjs (direct Bolt connection)
    ├─ Runs Cypher queries directly
    └─ Reads from Memgraph database (source of truth)
        ↓
    Data is accurate ✅
    But lxRAG tools still return empty/zero ❌
```

This explains the paradox: **code-visual's CLI queries show accurate data while lxRAG tools return empty results.**

---

## Why Each Tool Actually Fails (Corrected)

### Issue #1: `graph_health` reports zero graph entities

**Root Cause (Corrected):**
```typescript
// From tool-handlers.ts:1782-1787
const stats = this.context.index.getStatistics();
                           ↑
                    This is EMPTY from startup
                    Never populated by orchestrator

Result: Always returns zeros regardless of database state
```

**Why:** Not project-scoping issue, but **index synchronization issue**

**Evidence:**
- Memgraph contains 809 nodes (proven by CLI query)
- Shared index is empty (proven by agent analysis)
- Tool only reads from empty shared index (code inspection)

---

### Issue #2: `feature_status` fails to resolve valid IDs

**Root Cause (Corrected):**
```typescript
// From progress-engine.ts:76-91
private loadFromGraph(): void {
  const featureNodes = this.index.getNodesByType("FEATURE");
  // ProgressEngine.features Map populated here
  // But ONLY if index has data

  // Problem: index is empty, so this.features is empty
}

// From tool-handlers.ts:1500
const status = this.progressEngine!.getFeatureStatus(featureId);
// Looks in empty this.features Map
// Returns null for ANY featureId
```

**Why:** Not stale data, but **empty initial state that's never refilled**

**Evidence:**
- ProgressEngine initialized once at startup (empty index)
- Features ARE in Memgraph (proven by CLI query: `code-visual:feature:phase-1`)
- But they're not in ProgressEngine's Map (index was empty when loaded)

---

### Issue #3: `progress_query` returns empty despite existing tasks

**Root Cause (Corrected):**
```typescript
// From progress-engine.ts:94-108
private loadFromGraph(): void {
  const taskNodes = this.index.getNodesByType("TASK");
  // this.tasks Map populated from index

  // Problem: index is empty, so this.tasks is empty
  // No refresh happens on project context switch
}

// Results in: query() returns empty items array
```

**Why:** Not stale project-scoped data, but **never-replenished empty data**

---

## The CLI Commands Role: They Proved the Database is Healthy

The curl commands in the updated issues document prove:

✅ **Database is correct:**
```
curl: MATCH (n) RETURN count(n)
→ 809 nodes exist in Memgraph
```

✅ **Features exist:**
```
curl: MATCH (f:FEATURE) RETURN f.id
→ code-visual:feature:phase-1 exists
```

✅ **Tasks exist:**
```
curl: MATCH (t:TASK) RETURN t.status, count(*)
→ 7 tasks with distribution: completed:3, in-progress:2, pending:2
```

❌ **lxRAG tools don't see this data:**
```
graph_health → totalNodes: 0
feature_status("code-visual:feature:phase-1") → "not found"
progress_query → items: []
```

**Conclusion:** The tools are broken due to empty/unsynced index, not database issues.

---

## Code-Visual's Different Expectation

Based on the README and architecture:

**code-visual's Assumption:**
- Direct Memgraph Bolt connection (memgraph-proxy.mjs)
- Queries Memgraph directly, bypasses lxRAG tools
- Expects accurate data from Memgraph ✅

**What code-visual HOPED to use:**
- lxRAG tools for operational insights
- `graph_health` for readiness checks
- `progress_query` for task dashboards
- `feature_status` for feature tracking

**What code-visual ACTUALLY gets:**
- Direct Memgraph proxy works ✅
- lxRAG tools return empty (not integrated)
- Can't use lxRAG for operational dashboards ❌

---

## Revised Fix Strategy (Critical Difference)

### NOT A "Project-Scoping" Problem

The original action plan focused on "project scoping divergence" - this was partially correct but missed the core issue.

### The REAL Problem: Index Synchronization

The shared index is **not populated** after builds. The fix must ensure:

1. **After graph_rebuild:** Orchestrator's populated index syncs to shared index
2. **On project switch:** Engines are refreshed with new project data
3. **Overall:** Shared index becomes source of truth for engines

### Fix Strategy Tiers

#### TIER 1: Quick Fix (2-3 hours) - Make Tools Query-First

**Instead of:**
```typescript
// graph_health reads from empty index
const stats = this.context.index.getStatistics();
return { totalNodes: 0 }; // Always zero
```

**Do this:**
```typescript
// Query Memgraph for authoritative counts
const result = await this.context.memgraph.executeCypher(
  "MATCH (n {projectId: $projectId}) RETURN count(n) AS total",
  { projectId }
);
return { totalNodes: result.data[0].total };
```

**Impact:**
- ✅ Fixes Issue #1: graph_health (uses Cypher, not empty index)
- ✅ Partial fix for other tools (they can also query Memgraph)
- ⏱ Fastest implementation
- ⚠ Not ideal long-term (engines still use empty index)

#### TIER 2: Proper Fix (4-6 hours) - Sync Index After Build

**After orchestrator.build():**
```typescript
// Copy orchestrator's populated index to shared index
this.context.index = orchestrator.index;
// or sync the data:
orchestrator.index.getAllNodes().forEach(node =>
  this.context.index.addNode(node.id, node.type, node.properties)
);
```

**Impact:**
- ✅ Fixes all three issues at source
- ✅ ProgressEngine gets real data
- ✅ TestEngine gets real data
- ✅ Embedding generation works
- ⏱ More complex, requires build pipeline changes
- ✅ Better long-term solution

#### TIER 3: Full Refactor (8+ hours) - Multi-Project Support

Split index by projectId (see ACTION_PLAN_LXRAG_TOOL_FIXES.md for details)

---

## Implementation Path (Revised)

### Phase 1: Immediate (Use TIER 1 + TIER 2 combined)

**Step 1.1: Add Index Sync After Build**
- **File:** `src/graph/orchestrator.ts` (build method)
- **Change:** After successful build, sync internal index to shared index
  ```typescript
  async build(): Promise<BuildResult> {
    // ... existing build code ...

    // NEW: Sync populated index to shared context
    if (this.sharedIndex) {
      this.index.getAllNodes().forEach(node => {
        this.sharedIndex.addNode(node.id, node.type, node.properties);
      });
      this.index.getAllRelationships().forEach(rel => {
        this.sharedIndex.addRelationship(rel.id, rel.from, rel.to,
          rel.type, rel.properties);
      });
    }

    return result;
  }
  ```

**Step 1.2: Make graph_health Query-First**
- **File:** `src/tools/tool-handlers.ts` (graph_health method)
- **Change:** Query Memgraph for authoritative counts
  ```typescript
  async graph_health(): Promise<string> {
    const { projectId } = this.getActiveProjectContext();

    // Query database instead of empty index
    const countResult = await this.context.memgraph.executeCypher(
      "MATCH (n {projectId: $projectId}) RETURN count(n) AS total",
      { projectId }
    );

    return this.formatSuccess({
      graphIndex: {
        totalNodes: countResult.data[0].total || 0,
        // ...
      }
    });
  }
  ```

**Step 1.3: Reload Engines on Project Context Change**
- **File:** `src/tools/tool-handlers.ts`
- **Change:** When project switches, refresh engines
  ```typescript
  private setActiveProjectContext(context: ProjectContext): void {
    // ... existing code ...

    // NEW: Reload engines with new context
    this.progressEngine?.reload(this.context.index, context.projectId);
    this.testEngine?.reload(this.context.index, context.projectId);
  }
  ```

### Phase 2: Validation (1-2 hours)

Test against code-visual's data:
```
Before: graph_health → { totalNodes: 0 }
After:  graph_health → { totalNodes: 809 }

Before: feature_status("code-visual:feature:phase-1") → "not found"
After:  feature_status("code-visual:feature:phase-1") → { feature: {...} }

Before: progress_query(status="all") → { items: [], totalCount: 0 }
After:  progress_query(status="all") → { items: [7 tasks], totalCount: 7 }
```

### Phase 3: Long-term (Design fixes)

See ACTION_PLAN_LXRAG_TOOL_FIXES.md for architectural improvements

---

## Why This is Different from Original Plan

| Aspect | Original Plan | Revised Plan |
|--------|---|---|
| **Root Cause** | Project-scoping divergence | Index synchronization failure |
| **Index State** | "Global and unscoped" | "Empty and never synced" |
| **Primary Issue** | Data mixed across projects | Data never populated from build |
| **Tool Strategy** | Add projectId filtering | Query Memgraph + sync index |
| **Effort** | 3-4 hours Phase 1 | 2-3 hours Phase 1 |
| **Effectiveness** | Fixes scoping | Fixes all three issues |

---

## Validation Against CLI Commands

The CLI commands in the issues document serve as **proof that the fix works**:

```bash
# After implementing Phase 1 fixes:

# CLI query (always worked):
curl -s -X POST http://localhost:4001/query \
  -d '{"query":"MATCH (n) RETURN count(n)"}'
→ { rows: [{ n: 809 }] }

# lxRAG tool (NOW FIXED):
graph_health()
→ { graphIndex: { totalNodes: 809 } }

# CLI query for features:
curl: MATCH (f:FEATURE) RETURN f.id
→ code-visual:feature:phase-1

# lxRAG tool (NOW FIXED):
feature_status("code-visual:feature:phase-1")
→ { feature: { id: "...", name: "..." } }
```

---

## Acceptance Criteria (Updated)

**Test these exact scenarios:**

1. **graph_health matches CLI counts:**
   ```
   CLI: MATCH (n {projectId: "code-visual"}) RETURN count(n)
   → 809

   Tool: graph_health()
   → { graphIndex: { totalNodes: 809 } }
   ```

2. **feature_status resolves known IDs:**
   ```
   Known ID: code-visual:feature:phase-1 (from CLI query)

   Tool: feature_status("code-visual:feature:phase-1")
   → { success: true, feature: {...} }
   ```

3. **progress_query shows all tasks:**
   ```
   CLI: MATCH (t:TASK) RETURN count(t)
   → 7 total

   Tool: progress_query(status="all")
   → { items: [7 tasks], totalCount: 7 }
   ```

---

## Summary of Key Insights

1. **The database is healthy** - CLI commands prove 809 nodes exist ✅
2. **The tools are broken** - They read from empty shared index ❌
3. **The index is never synced** - Orchestrator build doesn't sync to shared index ❌
4. **code-visual works around this** - Direct Memgraph bypass ✅
5. **The fix is synchronization, not scoping** - Sync orchestrator index after build ✅

---

## File References

### Original Issues & Analysis
- `docs/lxrag-tool-issues.md` - Updated with CLI commands
- `docs/ACTION_PLAN_LXRAG_TOOL_FIXES.md` - Previous analysis (still valid for architectural improvements)

### New Deep-Dive Documents
- `GRAPH_STATE_SUMMARY.md` - Executive summary of graph architecture
- `GRAPH_STATE_ANALYSIS.md` - Complete technical analysis with code references
- `GRAPH_STATE_DIAGRAMS.md` - Architecture diagrams
- `GRAPH_STATE_FIXES.md` - All four fix tiers with code examples

### Implementation Files
- `src/graph/orchestrator.ts` - Where index sync must happen
- `src/tools/tool-handlers.ts` - Where Cypher queries replace index reads
- `src/engines/progress-engine.ts` - Where reload() methods added
- `src/graph/index.ts` - Consider adding sync/clear methods

