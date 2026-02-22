# Graph State Management Analysis: lexRAG-MCP

## Executive Summary

lexRAG-MCP is **designed to work with ONE project at a time** within a session, though it supports **multiple isolated sessions** via session-based context management. The graph state architecture has a critical design pattern: **two separate index instances** that operate independently, creating potential synchronization challenges.

---

## 1. Multiple Projects Setup

### Design Philosophy
**One project per session**, but multiple sessions can run simultaneously with different projects.

### Session-Based Project Isolation

The `ToolHandlers` class implements session-aware project context management:

```typescript
private defaultActiveProjectContext: ProjectContext;
private sessionProjectContexts = new Map<string, ProjectContext>();
private sessionWatchers = new Map<string, FileWatcher>();
```

**ProjectContext Interface:**
```typescript
interface ProjectContext {
  workspaceRoot: string;
  sourceDir: string;
  projectId: string;
}
```

### Context Resolution Flow

1. **No Session ID**: Uses `defaultActiveProjectContext` (global fallback)
2. **With Session ID**: Uses session-specific context from `sessionProjectContexts` map
3. **Fallback**: If session context not found, reverts to `defaultActiveProjectContext`

```typescript
private getActiveProjectContext(): ProjectContext {
  const sessionId = this.getCurrentSessionId();
  if (!sessionId) {
    return this.defaultActiveProjectContext;
  }
  return (
    this.sessionProjectContexts.get(sessionId) ||
    this.defaultActiveProjectContext
  );
}
```

### Implications
- **Single-project workflows**: Safe to use without session IDs
- **Multi-project workflows**: Must maintain session IDs across all requests
- **Session isolation**: Each session can work with different projects independently
- **Global state risk**: Without session IDs, all tools operate on the same project context

---

## 2. Project Context Switching via `graph_set_workspace`

Located at: `/home/alex_rod/projects/lexRAG-MCP/src/tools/tool-handlers.ts:1543`

### What Happens on `graph_set_workspace` Call

#### 1. **Project Context Updates**
```typescript
async graph_set_workspace(args: any): Promise<string> {
  let nextContext = this.resolveProjectContext(args || {});
  // ... validation ...
  this.setActiveProjectContext(nextContext);  // Updates session/default context
  await this.startActiveWatcher(nextContext);  // Starts file watcher for new project
  // ...
  return this.formatSuccess({
    success: true,
    projectContext: this.getActiveProjectContext(),
    watcherState: /* ... */,
    message: "Workspace context updated. Subsequent graph tools will use this project."
  });
}
```

#### 2. **In-Memory GraphIndexManager: NO CLEARING**
⚠️ **CRITICAL FINDING**: The index is **NOT cleared** when switching projects.

- The shared `GraphIndexManager` instance in `ToolContext` is **never cleared**
- **Impact**: If Project A is indexed, then Project B context is set, the index still contains Project A's nodes
- **Risk**: Queries will return mixed results from both projects until a new rebuild

#### 3. **ProgressEngine State: INHERITED, NOT RESET**
```typescript
this.progressEngine = new ProgressEngine(
  this.context.index,
  this.context.memgraph
);
```

The `ProgressEngine` constructor loads from the shared index:
```typescript
constructor(index: GraphIndexManager, memgraph?: MemgraphClient) {
  this.index = index;
  this.memgraph = memgraph;
  this.features = new Map();
  this.tasks = new Map();
  this.loadFromGraph();  // Loads from whatever is in this.index
}
```

- ProgressEngine is initialized **once** at server startup
- When `graph_set_workspace` is called, the ProgressEngine is **not recreated**
- **Impact**: Features/tasks from old project remain until next rebuild

#### 4. **Other Engines: ALSO NOT RESET**

All engines are initialized once and reuse the shared `ToolContext.index`:

| Engine | Location | Index Handling |
|--------|----------|-----------------|
| **ArchitectureEngine** | Line 292 | Uses `this.context.index` - NOT reset |
| **TestEngine** | Line 299 | Uses `this.context.index` - NOT reset |
| **EpisodeEngine** | Line 304 | Uses `this.context.memgraph` only |
| **CoordinationEngine** | Line 305 | Uses `this.context.memgraph` only |
| **CommunityDetector** | Line 306 | Uses `this.context.memgraph` only |
| **HybridRetriever** | Line 321-323 | Uses `this.context.index` - NOT reset |

### Summary: What Changes vs. What Doesn't

| Component | Changes | Notes |
|-----------|---------|-------|
| **Active ProjectContext** | ✅ Updated | Via `setActiveProjectContext()` |
| **FileWatcher** | ✅ Restarted | Via `startActiveWatcher()` |
| **GraphIndexManager** | ❌ NOT Cleared | Same instance, accumulates data |
| **ProgressEngine** | ❌ NOT Reset | Keeps old project's features/tasks |
| **ArchitectureEngine** | ❌ NOT Reset | Still references old project's graph |
| **TestEngine** | ❌ NOT Reset | Still references old project's graph |
| **Memgraph Connection** | ✅ Shared | Same connection, works for all projects |

---

## 3. Graph Rebuild Behavior

Located at: `/home/alex_rod/projects/lexRAG-MCP/src/tools/tool-handlers.ts:1617` and `/home/alex_rod/projects/lexRAG-MCP/src/graph/orchestrator.ts:181`

### Rebuild Process

#### Step 1: Index Management in Orchestrator
```typescript
// In GraphOrchestrator.build()
async build(options: Partial<BuildOptions> = {}): Promise<BuildResult> {
  // Full rebuild: Clear cache but NOT the index
  if (opts.mode === "full") {
    this.cache.clear();  // Only cache cleared, not in-memory index
    filesChanged = files.length;
  }
```

#### Step 2: Index Population
During parsing, the orchestrator populates **its own private index**:
```typescript
private addToIndex(parsed: ParsedFile): void {
  this.index.addNode(`file:${parsed.relativePath}`, "FILE", {...});
  parsed.functions.forEach((fn) => {
    this.index.addNode(fn.id, "FUNCTION", {...});
    // Adds CONTAINS relationships
  });
  // Similarly for classes, imports, etc.
}
```

#### Step 3: Cypher Execution
Statements are sent to Memgraph:
```typescript
const results = await this.memgraph.executeBatch(statementsToExecute);
```

### Critical Discovery: TWO SEPARATE INDICES

```
┌─────────────────────────────────────┐
│         ToolContext (MCP Server)    │
│  ┌─────────────────────────────────┤
│  │ GraphIndexManager (shared)       │
│  │ - Initialized once at startup    │
│  │ - Shared by ALL engines          │
│  │ - NOT cleared on context switch  │
│  │ - NOT synchronized with Memgraph │
│  └─────────────────────────────────┤
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│      GraphOrchestrator (Builder)    │
│  ┌─────────────────────────────────┤
│  │ GraphIndexManager (internal)     │
│  │ - NEW instance per execution     │
│  │ - Populated during build()       │
│  │ - Results synced to Memgraph     │
│  │ - NEVER synced back to ToolContext
│  └─────────────────────────────────┤
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│         Memgraph Database           │
│  ┌─────────────────────────────────┤
│  │ NODES: FILE, FUNCTION, CLASS     │
│  │ RELS: CONTAINS, IMPORTS, etc.    │
│  │ - Source of truth for queries    │
│  │ - Queried directly by tools      │
│  └─────────────────────────────────┤
└─────────────────────────────────────┘
```

### Rebuild Behavior Summary

| Mode | In-Memory Index | Memgraph | Result |
|------|-----------------|----------|--------|
| **Full Rebuild** | ❌ NOT cleared (in Orchestrator's instance) | ✅ Replaced with new data | Orchestrator's index ≠ Memgraph |
| **Incremental** | ❌ Still not cleared | ✅ Updated with changes | Orchestrator's index ≠ Memgraph |
| **Context Switch** | ❌ ToolContext index accumulates | ❌ No automatic cleanup | Mixed project data in queries |

### Process Flow

1. **graph_rebuild** is called (fire-and-forget):
   ```typescript
   this.orchestrator
     .build({mode, workspaceRoot, projectId, ...})
     .then(async () => {
       const invalidated = await this.coordinationEngine!.invalidateStaleClaims(projectId);
     })
     .catch((error) => {
       // Background error handling
     });
   ```

2. **Build populates Orchestrator's internal index** and sends Cypher to Memgraph

3. **ToolContext.index remains unchanged** - it's never updated from the rebuild

4. **Queries run against Memgraph**, not the in-memory index

---

## 4. Index Initialization

Located at: `/home/alex_rod/projects/lexRAG-MCP/src/index.ts:77` and `/home/alex_rod/projects/lexRAG-MCP/src/mcp-server.ts:618`

### Initialization Flow

#### At Server Startup (mcp-server.ts)
```typescript
this.index = new GraphIndexManager();  // NEW empty index
this.config = this.loadConfig();
this.handlers = new ToolHandlers({
  index: this.index,
  memgraph: this.memgraph,
  config: this.config,
});
```

#### At Tool Handler Initialization
```typescript
// tool-handlers.ts:290-314
private initializeEngines(): void {
  this.testEngine = new TestEngine(this.context.index);
  this.progressEngine = new ProgressEngine(
    this.context.index,
    this.context.memgraph,
  );
  // ... other engines ...
  this.orchestrator =
    this.context.orchestrator ||
    new GraphOrchestrator(this.context.memgraph, false);
}
```

### Where Does Index Get Populated?

#### Source 1: ProgressEngine.loadFromGraph()
```typescript
private loadFromGraph(): void {
  const featureNodes = this.index.getNodesByType("FEATURE");
  for (const node of featureNodes) {
    this.features.set(node.id, {...});
  }
  // Reads from this.context.index
}
```

**Problem**: Only reads from in-memory index, which is empty at startup!

#### Source 2: During graph_rebuild
```typescript
// orchestrator.ts:763-828
private addToIndex(parsed: ParsedFile): void {
  this.index.addNode(`file:${parsed.relativePath}`, "FILE", {...});
  // ...
}
```

**Problem**: This adds to Orchestrator's **internal** index, not `ToolContext.index`!

#### Source 3: Never Populated from Memgraph
⚠️ **MAJOR FINDING**: The `ToolContext.index` is **NEVER populated from Memgraph**.

- It starts empty at startup
- It's never synchronized from the database
- Only the Orchestrator (during build) and direct manual additions populate indices

### Initialization Summary

| When | Index State | Source |
|------|-------------|--------|
| **Server startup** | Empty | `new GraphIndexManager()` |
| **After first `graph_rebuild`** | Still empty in ToolContext | Orchestrator's internal index ≠ shared index |
| **Queries during tools** | Read from Memgraph directly | Via Cypher queries, not index |
| **After project switch** | Contains old project data | Not reset on context change |

---

## 5. Design Implications and Issues

### Critical Issues

#### Issue #1: Index Accumulation on Project Switching
```
Session 1 (Project A):
  1. graph_set_workspace(projectId: "A")
  2. graph_rebuild → Orchestrator indexes Project A
  3. ToolContext.index remains empty
  4. graph_set_workspace(projectId: "B")
  5. ToolContext.index still empty, but ProjectContext changed

Result: Engines (ProgressEngine, ArchitectureEngine) have no data for either project
```

#### Issue #2: Orchestrator Index Never Synced
```
graph_rebuild processes files and populates Orchestrator.index
↓
Sends Cypher to Memgraph (persisted)
↓
Returns BuildResult with statistics
↓
Orchestrator.index is discarded / never shared back to ToolContext
↓
ToolContext.index stays empty
↓
Engines querying ToolContext.index get nothing
```

#### Issue #3: In-Memory Index Out of Sync with Database
```
Memgraph = source of truth (updated by graph_rebuild)
ToolContext.index = often empty or stale
Orchestrator.index = temporary, discarded after build
```

All tools query Memgraph directly via Cypher (not the in-memory index), so stale index doesn't break queries, but:
- Embedding engine uses in-memory index
- Hybrid retriever uses in-memory index
- Architecture validation uses in-memory index

---

## 6. Recommended Fixes

### Short-term (Minimal Changes)

#### 1. Clear Index on `graph_set_workspace`
```typescript
async graph_set_workspace(args: any): Promise<string> {
  let nextContext = this.resolveProjectContext(args || {});

  // NEW: Clear shared index when switching projects
  const oldContext = this.getActiveProjectContext();
  if (oldContext.projectId !== nextContext.projectId) {
    this.context.index.clear();
  }

  this.setActiveProjectContext(nextContext);
  // ...
}
```

#### 2. Sync Orchestrator Index Back to ToolContext
```typescript
// In graph_rebuild after orchestrator.build() completes
const buildResult = await this.orchestrator.build({...});

if (buildResult.success && this.orchestrator.getIndex) {
  // Copy Orchestrator's index to shared ToolContext.index
  const orchIndex = this.orchestrator.getIndex();
  // ... merge or sync mechanism ...
}
```

**Requires**: Adding `getIndex()` public method to GraphOrchestrator

#### 3. Load Index from Memgraph on Startup
```typescript
private async loadIndexFromMemgraph(projectId: string): Promise<void> {
  const nodes = await this.context.memgraph.executeCypher(
    `MATCH (n) WHERE n.projectId = $projectId RETURN n`,
    { projectId }
  );

  for (const nodeRow of nodes.data) {
    const node = nodeRow.n;
    this.context.index.addNode(node.id, node.type, node.properties);
  }
  // Also load relationships
}
```

### Medium-term (Better Architecture)

#### Use Project-Scoped Indices
```typescript
private projectIndices = new Map<string, GraphIndexManager>();

private getIndexForProject(projectId: string): GraphIndexManager {
  if (!this.projectIndices.has(projectId)) {
    this.projectIndices.set(projectId, new GraphIndexManager());
  }
  return this.projectIndices.get(projectId)!;
}
```

#### Pass Index to Engines at Tool Invocation Time
```typescript
async graph_query(args: any): Promise<string> {
  const context = this.getActiveProjectContext();
  const index = this.getIndexForProject(context.projectId);

  const result = await queryEngine.execute(query, {
    index,
    memgraph: this.context.memgraph,
    projectId: context.projectId,
  });
}
```

#### Sync Orchestrator to Project Index
```typescript
// In orchestrator callback
const buildResult = await this.orchestrator.build({...});
if (buildResult.success) {
  const projectIndex = this.getIndexForProject(projectId);
  projectIndex.clear();
  projectIndex.merge(this.orchestrator.getIndex());
}
```

---

## 7. Current Tool Behavior

### Tools That Query Memgraph (Safe)
- `graph_query`: Runs Cypher queries directly against Memgraph
- `code_explain`: Queries Memgraph for dependencies
- `find_pattern`: Queries Memgraph for patterns
- `arch_validate`: Queries Memgraph for architecture

### Tools That Use In-Memory Index (Risky)
- `graph_health`: Queries `this.context.index.getStatistics()`
- **EmbeddingEngine**: Iterates `this.context.index.getNodesByType("FUNCTION")`
- **HybridRetriever**: Uses `this.context.index` for retrieval
- **ProgressEngine**: Reads `this.context.index` for progress tracking

### Recommendation
For multi-project support, ensure all tools eventually query Memgraph with `projectId` filter, not the in-memory index.

---

## 8. Session Management Example

### Safe Multi-Project Workflow

```
Client A (Session A):
1. POST /initialize → get session-id: "sess-a"
2. graph_set_workspace({workspaceRoot: "/path/project-a", projectId: "a"})
3. graph_rebuild()
4. graph_query()
   └→ Uses "sess-a" context (Project A)

Client B (Session B):
1. POST /initialize → get session-id: "sess-b"
2. graph_set_workspace({workspaceRoot: "/path/project-b", projectId: "b"})
3. graph_rebuild()
4. graph_query()
   └→ Uses "sess-b" context (Project B)

Result: Two isolated sessions, each with their own ProjectContext
Problem: Both sessions share the same ToolContext.index (no isolation)
```

---

## 9. Summary Table

| Aspect | Current Behavior | Issue | Fix |
|--------|------------------|-------|-----|
| **Multiple Projects** | One per session via context map | Works at context level only | Clear index on context switch |
| **Context Switching** | Updates ProjectContext + Watcher | Doesn't clear shared index | Add `this.context.index.clear()` |
| **Full Rebuild** | Clears cache, not in-memory index | Orchestrator index ≠ Memgraph | Sync Orchestrator index back |
| **Incremental Rebuild** | Updates only changed files | Same sync issue | Same sync mechanism |
| **Index Init** | Empty at startup | Never populated from DB | Load from Memgraph on startup |
| **Embedding** | Uses in-memory index | May use old/wrong project data | Use project-scoped indices |
| **Progress Tracking** | Loads from shared index | Wrong project data | Use project-scoped indices |
| **Architecture Validation** | Uses shared index | Wrong project data | Use project-scoped indices |

---

## Files Referenced

- **Tool Handlers**: `/home/alex_rod/projects/lexRAG-MCP/src/tools/tool-handlers.ts`
  - Lines 41-46: ToolContext interface
  - Lines 48-52: ProjectContext interface
  - Lines 69-71: Session and context maps
  - Lines 87-106: Context getters/setters
  - Lines 1543-1615: `graph_set_workspace` implementation
  - Lines 1617-1776: `graph_rebuild` implementation
  - Lines 290-314: `initializeEngines()` method

- **Graph Orchestrator**: `/home/alex_rod/projects/lexRAG-MCP/src/graph/orchestrator.ts`
  - Lines 70-176: Constructor and index initialization
  - Lines 181-423: `build()` method with index handling
  - Lines 763-828: `addToIndex()` method

- **Graph Index**: `/home/alex_rod/projects/lexRAG-MCP/src/graph/index.ts`
  - Lines 35-160: GraphIndexManager class
  - Lines 148-160: `clear()` method

- **Progress Engine**: `/home/alex_rod/projects/lexRAG-MCP/src/engines/progress-engine.ts`
  - Lines 59-71: Constructor with `loadFromGraph()`
  - Lines 76-96: `loadFromGraph()` implementation

- **MCP Server**: `/home/alex_rod/projects/lexRAG-MCP/src/mcp-server.ts`
  - Lines 618-623: Index initialization and handler creation
