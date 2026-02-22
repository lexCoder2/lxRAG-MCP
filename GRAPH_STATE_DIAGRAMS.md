# Graph State Architecture Diagrams

## Diagram 1: Current Index Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        MCP Server Process                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │            ToolContext (Shared, Long-lived)            │   │
│  │  ┌─────────────────────────────────────────────────────┤   │
│  │  │ GraphIndexManager                                   │   │
│  │  │ ├─ nodesByType: Map<string, GraphNode[]>           │   │
│  │  │ ├─ nodeById: Map<string, GraphNode>                │   │
│  │  │ ├─ relationshipsByFrom: Map<...>                   │   │
│  │  │ └─ statistics: {...}                               │   │
│  │  │                                                     │   │
│  │  │ State at startup: EMPTY                            │   │
│  │  │ State after rebuild: EMPTY (not synced)            │   │
│  │  │ Used by: ProgressEngine, ArchitectureEngine,       │   │
│  │  │          TestEngine, EmbeddingEngine,              │   │
│  │  │          HybridRetriever                           │   │
│  │  └─────────────────────────────────────────────────────┤   │
│  │                                                         │   │
│  │  MemgraphClient (Shared connection)                    │   │
│  │  ├─ Connected to: Memgraph database                   │   │
│  │  └─ Used by: All query tools                          │   │
│  │                                                         │   │
│  │  config: {...}                                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         ToolHandlers (Session-aware)                   │   │
│  │  ┌─────────────────────────────────────────────────────┤   │
│  │  │ ProjectContext Management                           │   │
│  │  │ ├─ defaultActiveProjectContext                      │   │
│  │  │ ├─ sessionProjectContexts: Map<sessionId, ctx>      │   │
│  │  │ └─ sessionWatchers: Map<sessionId, watcher>         │   │
│  │  │                                                     │   │
│  │  │ Engines (Instance Variables)                        │   │
│  │  │ ├─ progressEngine: ProgressEngine                   │   │
│  │  │ ├─ orchestrator: GraphOrchestrator                  │   │
│  │  │ ├─ archEngine: ArchitectureEngine                   │   │
│  │  │ ├─ testEngine: TestEngine                           │   │
│  │  │ ├─ episodeEngine: EpisodeEngine                     │   │
│  │  │ ├─ coordinationEngine: CoordinationEngine           │   │
│  │  │ ├─ communityDetector: CommunityDetector             │   │
│  │  │ └─ hybridRetriever: HybridRetriever                 │   │
│  │  │                                                     │   │
│  │  │ NOTE: All engines initialized ONCE at startup       │   │
│  │  │       Not recreated on project context switch       │   │
│  │  └─────────────────────────────────────────────────────┤   │
│  │                                                         │   │
│  │  ┌─────────────────────────────────────────────────────┤   │
│  │  │ GraphOrchestrator (Instance in ToolHandlers)        │   │
│  │  │ ├─ index: GraphIndexManager (NEW on construction)   │   │
│  │  │ ├─ builder: GraphBuilder                            │   │
│  │  │ ├─ cache: CacheManager                              │   │
│  │  │ ├─ memgraph: MemgraphClient (same as ToolContext)  │   │
│  │  │ └─ parser: TypeScriptParser + others                │   │
│  │  │                                                     │   │
│  │  │ NOTE: Has its own private index                     │   │
│  │  │       Separate from ToolContext.index              │   │
│  │  │       Populated during build() but not synced back  │   │
│  │  └─────────────────────────────────────────────────────┤   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    (Cypher Queries)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                    Memgraph Database                             │
│  ├─ Nodes: FILE, FUNCTION, CLASS, IMPORT, FEATURE, TASK, ...   │
│  ├─ Relations: CONTAINS, IMPORTS, CALLS, IMPLEMENTS, ...        │
│  ├─ Transactions: GRAPH_TX tracking rebuild history             │
│  └─ Source of Truth for all persistent data                     │
└──────────────────────────────────────────────────────────────────┘
```

## Diagram 2: Data Flow During graph_rebuild

```
User calls graph_rebuild()
        ↓
┌─────────────────────────────────────────────┐
│ ToolHandlers.graph_rebuild()                │
│ 1. Validate workspace                       │
│ 2. Create GRAPH_TX record in Memgraph       │
│ 3. Call this.orchestrator.build({...})      │
│    (FIRE AND FORGET - async, no wait)       │
│ 4. Return status immediately                │
└─────────────────────────────────────────────┘
        ↓
        └──────────────────────────────┐
                                       ↓
        ┌──────────────────────────────────────────┐
        │ GraphOrchestrator.build()  (async)       │
        │ 1. Create NEW GraphIndexManager()        │
        │ 2. Parse all source files                │
        │ 3. For each file:                        │
        │    ├─ Parse → ParsedFile                 │
        │    ├─ Call addToIndex(parsed)            │
        │    │  └→ Adds to THIS.INDEX (internal)   │
        │    └─ Generate Cypher statements         │
        │ 4. Build test relationships              │
        │ 5. Execute Cypher batch → Memgraph      │
        │ 6. Index docs (optional)                 │
        │ 7. Return BuildResult                    │
        └──────────────────────────────────────────┘
                       ↓
        ┌──────────────────────────────────────────┐
        │ Orchestrator's Internal Index            │
        │ (GraphIndexManager instance)             │
        │                                          │
        │ Contains: All FILE, FUNCTION, CLASS,     │
        │           IMPORT nodes from build        │
        │                                          │
        │ Problem: NEVER synced to ToolContext.    │
        │          index OR persisted anywhere     │
        │          Only used for build statistics  │
        └──────────────────────────────────────────┘
                       ↓
        ┌──────────────────────────────────────────┐
        │ Memgraph Database  (UPDATED)             │
        │                                          │
        │ Receives: All Cypher statements          │
        │ Result: Database now contains new graph  │
        │         (this is the source of truth)    │
        └──────────────────────────────────────────┘
                       ↓
        ┌──────────────────────────────────────────┐
        │ ToolContext.index                        │
        │                                          │
        │ State: UNCHANGED (remains empty)         │
        │ Problem: Never receives data from build  │
        │          Engines using this index get    │
        │          nothing (or stale data)         │
        └──────────────────────────────────────────┘
```

## Diagram 3: Data Flow During graph_set_workspace

```
User calls graph_set_workspace({
  workspaceRoot: "/path/to/project-b",
  projectId: "project-b"
})
        ↓
┌──────────────────────────────────────────┐
│ ToolHandlers.graph_set_workspace()        │
│ 1. Resolve new ProjectContext             │
│ 2. Call setActiveProjectContext(newCtx)   │
│    ├─ Get sessionId                       │
│    └─ If session exists:                  │
│       ├─ Update sessionProjectContexts    │
│       └─ Else update default context      │
│ 3. Start FileWatcher for new project      │
│ 4. Return success                         │
└──────────────────────────────────────────┘
        ↓
        ├─→ Affected: ProjectContext in ToolHandlers
        │   (Now points to new workspace)
        │
        ├─→ Affected: FileWatcher
        │   (Now monitoring new directory)
        │
        └─→ NOT Affected: ToolContext.index
            (Still contains old project's data)

RESULT: ProjectContext switched, but:
  • In-memory index still has old project's nodes
  • Engines (ProgressEngine, etc.) still have old data
  • Next queries will see mixed data from both projects
  • (Unless graph_rebuild clears it, which it doesn't)
```

## Diagram 4: Tool Context Switching Flow

```
Server Start
    ↓
┌─────────────────────────────────────────┐
│ MCP Server initialization               │
│ 1. Create MemgraphClient                │
│ 2. Create GraphIndexManager() → EMPTY   │
│ 3. Create ToolHandlers with context     │
│    └─ initializeEngines()               │
│       ├─ ProgressEngine(index) loads    │
│       │  from index (which is empty)    │
│       └─ Other engines initialized      │
└─────────────────────────────────────────┘
    ↓
Session A (Client with mcp-session-id: "sess-a")
    ├─ graph_set_workspace(proj: "A")
    │  └─ Update sessionProjectContexts["sess-a"]
    ├─ graph_rebuild()
    │  └─ Orchestrator builds, Memgraph updated
    │     ToolContext.index still empty
    └─ graph_query()
       └─ Query runs against Memgraph (works)
       └─ Embedding uses ToolContext.index (empty)

Session B (Client with mcp-session-id: "sess-b")
    ├─ graph_set_workspace(proj: "B")
    │  └─ Update sessionProjectContexts["sess-b"]
    ├─ graph_rebuild()
    │  └─ Orchestrator builds Project B, Memgraph updated
    │     ToolContext.index still empty
    └─ graph_query()
       └─ Query runs against Memgraph (works)
       └─ Embedding uses ToolContext.index (empty)

No Session (Backwards compatibility)
    ├─ graph_set_workspace(proj: "C")
    │  └─ Update defaultActiveProjectContext
    └─ ...rest of flow...

RESULT: Multiple sessions work if they only use Memgraph queries
        But engines using in-memory index fail for all projects
```

## Diagram 5: Index Population Sources and Sinks

```
SOURCES of Index Data:
├─ manual.addNode() calls
├─ orchestrator.addToIndex() → Orchestrator's internal index
└─ ProgressEngine.loadFromGraph() → reads from in-memory (empty at start)

┌────────────────────────────────────────┐
│ GraphIndexManager (ToolContext.index)   │
├────────────────────────────────────────┤
│ Populated from:                        │
│ ├─ (empty at startup)                 │
│ ├─ (never populated from Memgraph)     │
│ ├─ (not synced from orchestrator)      │
│ └─ (only manual additions)             │
│                                        │
│ Used by:                               │
│ ├─ ProgressEngine.loadFromGraph()     │
│ ├─ ArchitectureEngine queries          │
│ ├─ TestEngine queries                  │
│ ├─ EmbeddingEngine iteration           │
│ └─ HybridRetriever lookup              │
│                                        │
│ Cleared when:                          │
│ ├─ (NEVER - this is the problem)       │
│ └─ (manual .clear() call)              │
└────────────────────────────────────────┘

┌────────────────────────────────────────┐
│ GraphIndexManager (Orchestrator.index)  │
├────────────────────────────────────────┤
│ Populated from:                        │
│ ├─ orchestrator.addToIndex()           │
│ │  └─ Called during build()            │
│ └─ (ONE instance per orchestrator)     │
│                                        │
│ Used by:                               │
│ ├─ orchestrator.getStatistics()        │
│ └─ (internal to orchestrator)          │
│                                        │
│ Synced to:                             │
│ └─ (NEVER - this is the problem)       │
└────────────────────────────────────────┘
        ↓ (Cypher statements)
┌────────────────────────────────────────┐
│ Memgraph Database                      │
├────────────────────────────────────────┤
│ Populated from:                        │
│ ├─ orchestrator.build() → Cypher batch │
│ ├─ Direct Cypher execution             │
│ └─ (Source of truth)                   │
│                                        │
│ Queried by:                            │
│ ├─ graph_query tool                    │
│ ├─ code_explain tool                   │
│ ├─ find_pattern tool                   │
│ ├─ arch_validate tool                  │
│ └─ All other query-based tools         │
└────────────────────────────────────────┘
```

## Diagram 6: Engine Initialization and Data Flow

```
Server Startup
    ↓
initializeEngines() called ONCE
    ├─→ ArchitectureEngine(this.context.index)
    │   └─ Holds reference to shared index
    │      (empty at startup, not updated after rebuild)
    │
    ├─→ TestEngine(this.context.index)
    │   └─ Holds reference to shared index
    │      (empty at startup, not updated after rebuild)
    │
    ├─→ ProgressEngine(this.context.index, memgraph)
    │   └─ Constructor calls loadFromGraph()
    │      ├─ Reads: this.index.getNodesByType("FEATURE")
    │      ├─ Reads: this.index.getNodesByType("TASK")
    │      └─ Result: features and tasks maps remain empty
    │
    ├─→ EpisodeEngine(memgraph)
    │   └─ Uses memgraph only (no index) ✓
    │
    ├─→ CoordinationEngine(memgraph)
    │   └─ Uses memgraph only (no index) ✓
    │
    ├─→ CommunityDetector(memgraph)
    │   └─ Uses memgraph only (no index) ✓
    │
    └─→ GraphOrchestrator(memgraph)
        └─ Creates its OWN GraphIndexManager()
           (separate from ToolContext.index)

Problem Flow:
graph_rebuild() executes
    ↓
Orchestrator builds and populates ITS index
    ↓
Memgraph updated with Cypher statements ✓
    ↓
Orchestrator.index discarded/unused
    ↓
ToolContext.index STILL empty ✗
    ↓
When tools call engines:
    ├─ ProgressEngine.getProgress() → queries empty index ✗
    ├─ ArchitectureEngine.validate() → queries empty index ✗
    └─ EmbeddingEngine.generate() → queries empty index ✗

Solution would require:
    1. Sync orchestrator.index → ToolContext.index after build
    2. OR recreate engines after rebuild
    3. OR make all engines query Memgraph instead of index
```

## Diagram 7: Session Isolation (Current vs Ideal)

```
CURRENT STATE (Shared ToolContext.index):
═════════════════════════════════════════

Session A (ProjectId: "project-a")     Session B (ProjectId: "project-b")
        │                                      │
        ├─ ProjectContext = A                  ├─ ProjectContext = B
        │                                      │
        ├─ query("find all files")             ├─ query("find all files")
        │  └─ Queries Memgraph with A context  │  └─ Queries Memgraph with B context
        │                                      │
        ├─ EmbeddingEngine.generate()          ├─ EmbeddingEngine.generate()
        │  └─ Reads from shared index          │  └─ Reads from shared index
        │     (empty or mixed data)            │     (empty or mixed data)
        │                                      │
        └─ PROBLEM: Shared index has no        └─ PROBLEM: Same shared index
           project isolation                        affects this session too


IDEAL STATE (Project-scoped indices):
═════════════════════════════════════════

Session A (ProjectId: "project-a")     Session B (ProjectId: "project-b")
        │                                      │
        ├─ ProjectContext = A                  ├─ ProjectContext = B
        ├─ Index = indexForProject("a")        ├─ Index = indexForProject("b")
        │                                      │
        ├─ query("find all files")             ├─ query("find all files")
        │  └─ Queries Memgraph with A         │  └─ Queries Memgraph with B
        │                                      │
        ├─ EmbeddingEngine.generate()          ├─ EmbeddingEngine.generate()
        │  └─ Reads from project-a index       │  └─ Reads from project-b index
        │     (A's data only)                  │     (B's data only)
        │                                      │
        └─ WORKING: Complete isolation         └─ WORKING: Complete isolation
```

## Diagram 8: Critical Path Analysis

```
Three Critical Paths for Multi-Project Support:

PATH 1: Context Switching (PARTIALLY WORKING)
──────────────────────────────────────────────
graph_set_workspace()
    ├─ ✓ Updates ProjectContext
    ├─ ✓ Starts new FileWatcher
    ├─ ✗ Does NOT clear shared index
    └─ Result: Project context changed, but index corrupted

PATH 2: Graph Rebuild (PARTIALLY WORKING)
──────────────────────────────────────────
graph_rebuild()
    ├─ ✓ Clears cache
    ├─ ✓ Sends Cypher to Memgraph
    ├─ ✗ Doesn't sync internal index back
    ├─ ✗ Doesn't update ToolContext.index
    └─ Result: Database updated, but in-memory index unused

PATH 3: Tool Queries (WORKING FOR MEMGRAPH, BROKEN FOR INDEX)
─────────────────────────────────────────────────────────────
Tool execution (e.g., graph_query)
    ├─ If Cypher query: ✓ Uses Memgraph (works)
    ├─ If uses in-memory index: ✗ Gets empty/stale data
    └─ Result: Some tools work, embedding/validation fail


RECOMMENDATION: Fix in order:
    1. Fix PATH 1: Clear index on context switch
    2. Fix PATH 2: Sync orchestrator index after rebuild
    3. Fix PATH 3: Make all tools projectId-aware for Memgraph queries
```

---

## Summary of Key Insights

1. **Two separate index systems** exist and are never synchronized
   - ToolContext.index (shared, used by engines, but empty)
   - Orchestrator.index (internal, populated during build, then discarded)

2. **Memgraph is the source of truth** but ToolContext.index should be the query cache

3. **Session isolation works at ProjectContext level** but not at index level

4. **Engines are initialized once** and hold stale references to an empty index

5. **Context switching doesn't clean up** the accumulated state in shared index
