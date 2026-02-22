# Graph State Analysis: Executive Summary

## Quick Answers to Your Questions

### 1. Multiple Projects Setup
**Is lexRAG-MCP designed to handle multiple projects simultaneously, or one at a time?**

**Answer**: **One project at a time per session**, but multiple **isolated sessions** can work with different projects simultaneously.

- Session A can work on Project A
- Session B can work on Project B
- Each session maintains its own `ProjectContext` (workspace root, source dir, project ID)
- Sessions are identified via `mcp-session-id` header

**But**: Without sessions, all requests operate on a shared default context - so truly "multiple projects simultaneously" in a single client is not supported.

---

### 2. Project Context Switching

When `graph_set_workspace` is called with a new projectId, here's what happens:

| Component | What Changes | What Doesn't |
|-----------|-------------|--------------|
| **ProjectContext** | ✅ Updated | N/A |
| **FileWatcher** | ✅ Restarted for new directory | N/A |
| **Memgraph Connection** | ✅ Shared (works for any project) | N/A |
| **GraphIndexManager (in-memory)** | ❌ NOT CLEARED | Still has old project's data |
| **ProgressEngine** | ❌ NOT RESET | Still has old project's tasks/features |
| **ArchitectureEngine** | ❌ NOT RESET | Still references old index |
| **TestEngine** | ❌ NOT RESET | Still references old index |
| **EmbeddingEngine** | ❌ NOT RESET | Still references old index |
| **HybridRetriever** | ❌ NOT RESET | Still references old index |

**Critical Finding**: Engines hold references to a **shared, never-cleared index**. When you switch projects without rebuilding, engines still have data from the old project.

---

### 3. Graph Rebuild Behavior

When `graph_rebuild` is called:

```
Does it:
├─ Clear the in-memory index first?
│  └─ NO - The shared index is NOT cleared
│
├─ Append to existing index?
│  └─ NO - Only Orchestrator's internal index is populated
│
└─ Load the index from Memgraph?
   └─ NO - Creates a new index from scratch by parsing files
```

**What Actually Happens**:

1. **Orchestrator creates its own private GraphIndexManager** (separate from shared index)
2. **Parses source files** and populates its internal index
3. **Generates Cypher statements** from parsed data
4. **Sends Cypher to Memgraph** (database is updated)
5. **Returns build statistics**
6. **Discards its internal index** (never synced back)
7. **Shared ToolContext.index remains empty** (never populated)

**Result**:
- Database (Memgraph) is updated ✅
- Shared index stays empty ❌
- Orchestrator's index is wasted/discarded ❌

---

### 4. Index Initialization

When tools are initialized, the GraphIndexManager gets populated from:

```
WHERE does it get populated?

Startup:
├─ src/mcp-server.ts:618 → new GraphIndexManager()
└─ Result: EMPTY

After graph_rebuild:
├─ Orchestrator.build() populates ITS index
├─ But never syncs to ToolContext.index
└─ Result: Still EMPTY in ToolContext

When tools run:
├─ Tools query Memgraph directly (not index)
├─ Embedding engine queries shared index (EMPTY)
├─ Progress tracking reads shared index (EMPTY)
└─ Result: Queries work, but engines fail
```

**Answer**: **Started empty and usually stays empty.**

The shared index is:
- Not populated from Memgraph ✗
- Not populated from file system ✗
- Not populated from Orchestrator after builds ✗
- Only populated by manual `.addNode()` calls ✓

---

## The Core Problem

**Two separate, unsynced index systems exist:**

```
┌─────────────────────────────────────────────┐
│ ToolContext.index (Shared)                  │
│ - Initialized empty                         │
│ - Used by: All engines                      │
│ - Problem: Never updated                    │
│ - Status: Empty or stale                    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ GraphOrchestrator.index (Internal)          │
│ - Created during build                      │
│ - Populated with parsed data                │
│ - Problem: Never synced back                │
│ - Status: Temporary, then discarded         │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Memgraph Database (Source of Truth)         │
│ - Updated by Orchestrator's Cypher          │
│ - Queried directly by tools                 │
│ - Used for: Persistent storage              │
│ - Status: Current and accurate              │
└─────────────────────────────────────────────┘
```

**Why This Matters**:
- Tools querying Memgraph work ✅
- Embedding engine gets empty index ❌
- Progress tracking fails ❌
- Architecture validation fails ❌
- Multi-project support is risky ❌

---

## Design Issues Summary

### Issue #1: Index Accumulation on Project Switch
```
Sequential Scenario:
1. graph_set_workspace(projectId: "A") → ProjectContext = A
2. graph_rebuild() → Database updated with Project A data
3. [some queries with Project A data work]
4. graph_set_workspace(projectId: "B") → ProjectContext = B
5. [but shared index still has Project A nodes!]
6. Embedding engine generates vectors for Project A's code
7. Cross-project contamination ❌
```

**Fix**: Clear index in `graph_set_workspace()` when switching projects

### Issue #2: Orphaned Build Index
```
graph_rebuild execution:
1. Orchestrator builds and populates ITS index
2. Sends Cypher to Memgraph ✓
3. Orchestrator.index discarded
4. ToolContext.index never updated ✗

Result: Database accurate, cache empty
```

**Fix**: Sync orchestrator index back to shared index after build

### Issue #3: Index Never Loaded at Startup
```
Server startup:
1. new GraphIndexManager() → EMPTY
2. initializeEngines() → all engines reference EMPTY index
3. ProgressEngine.loadFromGraph() reads EMPTY index
4. Result: No data until first build, and only in Orchestrator
```

**Fix**: Load index from Memgraph when switching projects

### Issue #4: Engines Have Long-Lived References
```
Engine lifecycle:
- Initialized ONCE at server startup
- Never recreated on project switch
- Hold references to shared index
- If index isn't updated, engines get stale data

Example:
1. ProgressEngine initialized with empty index
2. graph_set_workspace(projectA)
3. graph_rebuild() updates Memgraph but not shared index
4. ProgressEngine.getProgress() reads empty index
5. Result: No progress data even though database is populated
```

**Fix**: Either update shared index after rebuild, or make engines query Memgraph directly

---

## Impact Analysis

### What Works
- ✅ Multi-project workflows with session IDs
- ✅ ProjectContext switching
- ✅ FileWatcher per project
- ✅ graph_query tool (uses Memgraph)
- ✅ code_explain tool (uses Memgraph)
- ✅ find_pattern tool (uses Memgraph)
- ✅ arch_validate tool (uses Memgraph)
- ✅ graph_rebuild (populates database)

### What Breaks
- ❌ Embedding generation (uses empty index)
- ❌ Vector search (depends on embeddings)
- ❌ Progress tracking (reads empty index)
- ❌ Architecture engine (uses empty index)
- ❌ Test engine (uses empty index)
- ❌ Community detection (might use index)
- ❌ Hybrid retrieval (uses empty index)

### Risk Level
- **Single project, single session**: LOW
- **Multiple projects, session IDs**: MEDIUM (cross-project data leakage)
- **Multiple projects, no session IDs**: HIGH (complete data mixing)

---

## Recommended Fixes (Priority Order)

### Priority 1: Prevent Data Corruption (30 min)
```typescript
// In graph_set_workspace()
if (oldContext.projectId !== nextContext.projectId) {
  this.context.index.clear();
}
```
**Why**: Prevents accumulation of data from multiple projects

### Priority 2: Enable Core Engines (2-3 hours)
```typescript
// After orchestrator.build() completes
this.context.index.clear();  // For full rebuild
const orchIndex = this.orchestrator.getIndex();
syncIndexes(orchIndex, this.context.index);
```
**Why**: Makes embedding, progress tracking, and validation work

### Priority 3: Add ProjectId Filters (1 hour)
```typescript
// In all Memgraph queries
WHERE n.projectId = $projectId
```
**Why**: Ensures queries respect project boundaries

### Priority 4: Refactor for Scalability (1-2 days)
```typescript
// Use project-scoped indices instead of single shared index
this.projectIndices: Map<projectId, GraphIndexManager>
```
**Why**: Future-proof architecture, complete isolation

---

## Files Changed by Each Fix

### Fix 1 (Index Clearing)
- `src/tools/tool-handlers.ts` (graph_set_workspace method)

### Fix 2 (Index Syncing)
- `src/graph/orchestrator.ts` (add getIndex() method)
- `src/tools/tool-handlers.ts` (graph_rebuild method)

### Fix 3 (Index Loading)
- `src/tools/tool-handlers.ts` (initializeEngines method)

### Fix 4 (Project-Scoped Indices)
- `src/tools/tool-handlers.ts` (entire index management)
- All engine constructors (to use dynamic index getter)

---

## Session Management Best Practices

### For Multi-Project Support
```
Always include mcp-session-id header:

Client A:
POST /initialize
Response: {"mcp-session-id": "sess-a", ...}

POST /tools/graph_set_workspace
Header: mcp-session-id: sess-a
Body: {projectId: "project-a"}

Client B:
POST /initialize
Response: {"mcp-session-id": "sess-b", ...}

POST /tools/graph_set_workspace
Header: mcp-session-id: sess-b
Body: {projectId: "project-b"}

Result: Each session has isolated ProjectContext
```

### Without Sessions (Not Recommended for Multi-Project)
```
Default behavior uses defaultActiveProjectContext
All requests share the same project
```

---

## Related Code Locations

| Component | File | Lines | Notes |
|-----------|------|-------|-------|
| **ToolContext** | `src/tools/tool-handlers.ts` | 41-46 | Shared index lives here |
| **ProjectContext** | `src/tools/tool-handlers.ts` | 48-52 | Per-session project metadata |
| **Session Management** | `src/tools/tool-handlers.ts` | 69-106 | Context getters/setters |
| **graph_set_workspace** | `src/tools/tool-handlers.ts` | 1543-1615 | Project switching logic |
| **graph_rebuild** | `src/tools/tool-handlers.ts` | 1617-1776 | Build and index population |
| **Orchestrator** | `src/graph/orchestrator.ts` | 70-176 | Has its own index |
| **Orchestrator.build** | `src/graph/orchestrator.ts` | 181-423 | Populates internal index |
| **addToIndex** | `src/graph/orchestrator.ts` | 763-828 | Populates orchestrator index |
| **GraphIndexManager** | `src/graph/index.ts` | 35-178 | Index implementation |
| **ProgressEngine** | `src/engines/progress-engine.ts` | 59-96 | Loads from shared index |
| **Server Initialization** | `src/mcp-server.ts` | 618-623 | Creates shared index |

---

## Testing Checklist

- [ ] Test single project workflow
- [ ] Test project switching with correct data isolation
- [ ] Test embedding generation after rebuild
- [ ] Test progress tracking after rebuild
- [ ] Test multi-project with different session IDs
- [ ] Test cross-project query filtering
- [ ] Test index clearing on context switch
- [ ] Test index sync after rebuild
- [ ] Verify no stale data in queries
- [ ] Performance test with large projects

---

## Conclusion

lexRAG-MCP is **designed for single-project workflows** but has **session-based infrastructure for multiple projects**. The main limitation is **graph state synchronization** between the in-memory index and the database.

**Recommended approach for multi-project support**:

1. **Short-term (this week)**: Apply Fix 1 + Fix 2 (1-2 hours) to stabilize
2. **Medium-term (this month)**: Apply Fix 3 (2-3 hours) to enable all engines
3. **Long-term (this quarter)**: Apply Fix 4 (1-2 days) for production-ready multi-project support

Current risk level: **MEDIUM** - Multi-project workflows work but have data isolation issues that could cause subtle bugs.
