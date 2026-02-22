# Graph State Synchronization: Implementation Guide

## Overview

This guide provides concrete implementation paths to fix the graph state synchronization issues identified in the codebase analysis.

---

## Issue Summary

### Current Problems

1. **Index Accumulation**: `ToolContext.index` is never cleared on project context switches
2. **Orphaned Build State**: `GraphOrchestrator.index` is populated but never synced back to `ToolContext.index`
3. **Startup Desync**: `ToolContext.index` is never populated from Memgraph database
4. **Engine Stale State**: Engines hold references to empty index for entire server lifetime

### Impact

- Multi-project workflows see mixed data from multiple projects
- Embedding engine generates embeddings for nonexistent nodes
- Progress tracking shows data from wrong project
- Architecture validation runs against empty index

---

## Fix Level 1: Immediate Quick Wins (1-2 hours)

### Fix 1.1: Clear Index on Project Context Switch

**File**: `src/tools/tool-handlers.ts`

**Location**: `graph_set_workspace()` method (line ~1586)

**Current Code**:
```typescript
async graph_set_workspace(args: any): Promise<string> {
  // ...validation...
  this.setActiveProjectContext(nextContext);
  await this.startActiveWatcher(nextContext);
  // ...
}
```

**Fixed Code**:
```typescript
async graph_set_workspace(args: any): Promise<string> {
  const oldContext = this.getActiveProjectContext();
  let nextContext = this.resolveProjectContext(args || {});

  // ... validation code ...

  // NEW: Clear index if switching to different project
  if (oldContext.projectId !== nextContext.projectId) {
    console.log(`[graph_set_workspace] Clearing index for project switch: ${oldContext.projectId} → ${nextContext.projectId}`);
    this.context.index.clear();
  }

  this.setActiveProjectContext(nextContext);
  await this.startActiveWatcher(nextContext);

  return this.formatSuccess({
    // ... existing response ...
    note: oldContext.projectId !== nextContext.projectId
      ? "Index cleared for new project. Run graph_rebuild to populate."
      : undefined
  });
}
```

**Testing**:
```typescript
// Test: Switch between two projects
graph_set_workspace({projectId: "project-a"})
graph_rebuild() // Fills database with project-a
graph_health() // Should show project-a stats

graph_set_workspace({projectId: "project-b"})
// At this point, in-memory index should be cleared
graph_health() // Should show 0 indexed items until rebuild
graph_rebuild() // Fills database with project-b
graph_health() // Should show project-b stats
```

### Fix 1.2: Add ProjectId Filter to Existing Queries

Many tools query Memgraph but should filter by `projectId` to prevent cross-project data leakage.

**File**: `src/tools/tool-handlers.ts`

**Affected Methods**:
- `graph_query()` (line ~700)
- `code_explain()` (line ~800)
- `find_pattern()` (line ~900)

**Example - graph_query**:

**Current Code**:
```typescript
const result = await this.context.memgraph.executeCypher(
  `MATCH (n) RETURN n LIMIT ${limit}`,
  {}
);
```

**Fixed Code**:
```typescript
const context = this.getActiveProjectContext();
const result = await this.context.memgraph.executeCypher(
  `MATCH (n) WHERE n.projectId = $projectId RETURN n LIMIT ${limit}`,
  { projectId: context.projectId, limit }
);
```

**Why**: Ensures queries only return data for current project, even if database has multiple projects

---

## Fix Level 2: Index Synchronization (3-4 hours)

### Fix 2.1: Export Index from GraphOrchestrator

**File**: `src/graph/orchestrator.ts`

**Current Code** (line ~70-176):
```typescript
export class GraphOrchestrator {
  private parser: TypeScriptParser;
  // ... other fields ...
  private index: GraphIndexManager;

  constructor(memgraph?: MemgraphClient, verbose = false) {
    // ... initialization ...
    this.index = new GraphIndexManager();
  }
```

**Fixed Code**:
```typescript
export class GraphOrchestrator {
  private parser: TypeScriptParser;
  // ... other fields ...
  private index: GraphIndexManager;

  constructor(memgraph?: MemgraphClient, verbose = false) {
    // ... initialization ...
    this.index = new GraphIndexManager();
  }

  /**
   * Get reference to the in-memory index
   * Useful for syncing after build completion
   */
  getIndex(): GraphIndexManager {
    return this.index;
  }

  /**
   * Export statistics from the in-memory index
   */
  getStatistics(): GraphIndex['statistics'] {
    return this.index.getStatistics();
  }
}
```

### Fix 2.2: Sync Orchestrator Index After Build

**File**: `src/tools/tool-handlers.ts`

**Location**: `graph_rebuild()` method (line ~1617-1776)

**Current Code**:
```typescript
async graph_rebuild(args: any): Promise<string> {
  // ... validation ...

  this.orchestrator
    .build({mode, verbose, workspaceRoot, projectId, sourceDir, ...})
    .then(async () => {
      const invalidated = await this.coordinationEngine!.invalidateStaleClaims(projectId);
      // ... other post-build tasks ...
    })
    .catch((error) => {
      console.error(`[graph_rebuild] Build failed: ${error}`);
    });

  return this.formatSuccess({...});
}
```

**Fixed Code**:
```typescript
async graph_rebuild(args: any): Promise<string> {
  // ... validation ...

  this.orchestrator
    .build({mode, verbose, workspaceRoot, projectId, sourceDir, ...})
    .then(async () => {
      // NEW: Sync orchestrator's index to shared ToolContext index
      const orchIndex = this.orchestrator!.getIndex();
      const orchStats = orchIndex.getStatistics();

      console.log(`[graph_rebuild] Syncing in-memory index from orchestrator...`);

      // For full rebuild, clear existing index first
      if (mode === "full") {
        this.context.index.clear();
      }

      // Copy all nodes from orchestrator index to shared index
      for (const nodeType of Object.keys(orchStats.nodesByType)) {
        const nodes = orchIndex.getNodesByType(nodeType);
        for (const node of nodes) {
          this.context.index.addNode(node.id, node.type, node.properties);
        }
      }

      console.log(`[graph_rebuild] Index synchronized: ${orchStats.totalNodes} nodes, ${orchStats.totalRelationships} relationships`);

      // Notify engines that index was updated
      console.log(`[graph_rebuild] Notifying engines of index update...`);

      const invalidated = await this.coordinationEngine!.invalidateStaleClaims(projectId);
      // ... other post-build tasks ...
    })
    .catch((error) => {
      console.error(`[graph_rebuild] Build failed: ${error}`);
    });

  return this.formatSuccess({...});
}
```

**Why**:
- Populates shared index with build results
- Enables embedding generation to work correctly
- Makes progress tracking work for current project
- Synchronizes in-memory cache with database

### Fix 2.3: Load Index from Memgraph on Engine Initialization

**File**: `src/tools/tool-handlers.ts`

**Location**: `initializeEngines()` method (line ~290)

**Current Code**:
```typescript
private initializeEngines(): void {
  if (this.context.config.architecture) {
    this.archEngine = new ArchitectureEngine(
      this.context.config.architecture.layers,
      this.context.config.architecture.rules,
      this.context.index,
    );
  }

  this.testEngine = new TestEngine(this.context.index);
  this.progressEngine = new ProgressEngine(
    this.context.index,
    this.context.memgraph,
  );
  // ...
}
```

**Fixed Code**:
```typescript
private async initializeEnginesAsync(): Promise<void> {
  // Attempt to load index from Memgraph for current project
  const context = this.getActiveProjectContext();

  if (this.context.memgraph.isConnected()) {
    try {
      console.log(`[initializeEngines] Loading graph index for project ${context.projectId} from Memgraph...`);

      // Load all nodes
      const nodeResult = await this.context.memgraph.executeCypher(
        `MATCH (n) WHERE n.projectId = $projectId RETURN n, labels(n) as types`,
        { projectId: context.projectId }
      );

      if (nodeResult.data && nodeResult.data.length > 0) {
        for (const row of nodeResult.data) {
          const node = row.n;
          const types = row.types as string[];
          const nodeType = types.find(t => t !== 'Node') || 'Node';
          this.context.index.addNode(node.id, nodeType, node.properties || {});
        }
        console.log(`[initializeEngines] Loaded ${nodeResult.data.length} nodes`);
      }

      // Load all relationships
      const relResult = await this.context.memgraph.executeCypher(
        `MATCH (from)-[r]->(to) WHERE from.projectId = $projectId RETURN r, type(r) as relType, from.id as fromId, to.id as toId`,
        { projectId: context.projectId }
      );

      if (relResult.data && relResult.data.length > 0) {
        for (const row of relResult.data) {
          const rel = row.r;
          this.context.index.addRelationship(
            rel.id,
            row.fromId,
            row.toId,
            row.relType,
            rel.properties || {}
          );
        }
        console.log(`[initializeEngines] Loaded ${relResult.data.length} relationships`);
      }
    } catch (error) {
      console.warn(`[initializeEngines] Failed to load index from Memgraph: ${error}`);
    }
  }

  // Now initialize engines with loaded index
  if (this.context.config.architecture) {
    this.archEngine = new ArchitectureEngine(
      this.context.config.architecture.layers,
      this.context.config.architecture.rules,
      this.context.index,
    );
  }

  this.testEngine = new TestEngine(this.context.index);
  this.progressEngine = new ProgressEngine(
    this.context.index,
    this.context.memgraph,
  );
  // ... rest of initialization ...
}
```

**Update Constructor**:
```typescript
constructor(private context: ToolContext) {
  this.defaultActiveProjectContext = this.defaultProjectContext();
  // Make initialization async
  this.initializeEnginesAsync().catch(error => {
    console.error(`[ToolHandlers] Engine initialization failed: ${error}`);
  });
}
```

---

## Fix Level 3: Project-Scoped Indices (8-10 hours)

### Rationale

Rather than having a single shared index, maintain a mapping of project → index. This eliminates cross-project data contamination entirely.

### Fix 3.1: Add Project Index Management to ToolHandlers

**File**: `src/tools/tool-handlers.ts`

**Location**: Add to `ToolHandlers` class (after line ~70)

**Code**:
```typescript
export class ToolHandlers {
  private archEngine?: ArchitectureEngine;
  // ... existing fields ...
  private sessionProjectContexts = new Map<string, ProjectContext>();

  // NEW: Project-scoped indices
  private projectIndices = new Map<string, GraphIndexManager>();

  // ... rest of class ...

  /**
   * Get or create index for specific project
   */
  private getIndexForProject(projectId: string): GraphIndexManager {
    if (!this.projectIndices.has(projectId)) {
      const newIndex = new GraphIndexManager();
      this.projectIndices.set(projectId, newIndex);
      console.log(`[ToolHandlers] Created new index for project: ${projectId}`);
    }
    return this.projectIndices.get(projectId)!;
  }

  /**
   * Get index for currently active project
   */
  private getActiveIndex(): GraphIndexManager {
    const context = this.getActiveProjectContext();
    return this.getIndexForProject(context.projectId);
  }

  /**
   * Clear index for specific project
   */
  private clearIndexForProject(projectId: string): void {
    const index = this.projectIndices.get(projectId);
    if (index) {
      index.clear();
      console.log(`[ToolHandlers] Cleared index for project: ${projectId}`);
    }
  }

  /**
   * Load project index from Memgraph
   */
  private async loadIndexFromMemgraph(projectId: string): Promise<void> {
    const index = this.getIndexForProject(projectId);

    if (!this.context.memgraph.isConnected()) {
      console.log(`[loadIndexFromMemgraph] Memgraph not connected, skipping load for ${projectId}`);
      return;
    }

    try {
      // Load nodes
      const nodeResult = await this.context.memgraph.executeCypher(
        `MATCH (n) WHERE n.projectId = $projectId RETURN n, labels(n) as types`,
        { projectId }
      );

      if (nodeResult.data?.length) {
        for (const row of nodeResult.data) {
          const node = row.n;
          const types = row.types as string[];
          const nodeType = types.find(t => !['Node'].includes(t)) || 'Node';
          index.addNode(node.id, nodeType, node.properties || {});
        }
      }

      // Load relationships
      const relResult = await this.context.memgraph.executeCypher(
        `MATCH (from)-[r]->(to) WHERE from.projectId = $projectId RETURN r, type(r) as relType, from.id as fromId, to.id as toId`,
        { projectId }
      );

      if (relResult.data?.length) {
        for (const row of relResult.data) {
          const rel = row.r;
          index.addRelationship(
            rel.id,
            row.fromId,
            row.toId,
            row.relType,
            rel.properties || {}
          );
        }
      }

      console.log(`[loadIndexFromMemgraph] Loaded index for project ${projectId}`);
    } catch (error) {
      console.warn(`[loadIndexFromMemgraph] Failed to load index: ${error}`);
    }
  }
}
```

### Fix 3.2: Update graph_set_workspace

**File**: `src/tools/tool-handlers.ts`

**Location**: `graph_set_workspace()` method

**Code**:
```typescript
async graph_set_workspace(args: any): Promise<string> {
  const oldContext = this.getActiveProjectContext();
  let nextContext = this.resolveProjectContext(args || {});

  // ... validation code ...

  // Switching to new project
  if (oldContext.projectId !== nextContext.projectId) {
    console.log(`[graph_set_workspace] Switching project: ${oldContext.projectId} → ${nextContext.projectId}`);

    // Load index for new project
    await this.loadIndexFromMemgraph(nextContext.projectId);
  }

  this.setActiveProjectContext(nextContext);
  await this.startActiveWatcher(nextContext);

  const watcher = this.getActiveWatcher();

  return this.formatSuccess(
    {
      success: true,
      projectContext: this.getActiveProjectContext(),
      // ... other fields ...
      message: "Workspace context updated and index loaded from database.",
    },
    profile,
  );
}
```

### Fix 3.3: Update initializeEngines to Use Project Indices

**File**: `src/tools/tool-handlers.ts`

**Location**: `initializeEngines()` method

Instead of passing `this.context.index` directly, engines should be wrapped to access the active project's index:

```typescript
private initializeEngines(): void {
  // Create a proxy that always uses the active project's index
  const createIndexProxy = (): GraphIndexManager => {
    return new Proxy(new GraphIndexManager(), {
      get: (target, prop) => {
        const activeIndex = this.getActiveIndex();
        return (activeIndex as any)[prop];
      },
    });
  };

  if (this.context.config.architecture) {
    this.archEngine = new ArchitectureEngine(
      this.context.config.architecture.layers,
      this.context.config.architecture.rules,
      createIndexProxy(),
    );
  }

  this.testEngine = new TestEngine(createIndexProxy());
  this.progressEngine = new ProgressEngine(
    createIndexProxy(),
    this.context.memgraph,
  );
  // ... rest ...
}
```

Or better yet, refactor engines to accept a callback:

```typescript
// In engine constructors, accept an indexGetter function
this.testEngine = new TestEngine(
  () => this.getActiveIndex(),
  this.context.memgraph
);
```

### Fix 3.4: Update graph_rebuild to Populate Project Index

**File**: `src/tools/tool-handlers.ts`

**Location**: `graph_rebuild()` method

```typescript
async graph_rebuild(args: any): Promise<string> {
  // ... validation ...

  const { projectId } = resolvedContext;

  this.orchestrator
    .build({mode, verbose, workspaceRoot, projectId, sourceDir, ...})
    .then(async () => {
      // Get project-specific index
      const projectIndex = this.getIndexForProject(projectId);

      // For full rebuild, clear existing index
      if (mode === "full") {
        projectIndex.clear();
      }

      // Sync orchestrator's index to project index
      const orchIndex = this.orchestrator!.getIndex();
      const orchStats = orchIndex.getStatistics();

      for (const nodeType of Object.keys(orchStats.nodesByType)) {
        const nodes = orchIndex.getNodesByType(nodeType);
        for (const node of nodes) {
          projectIndex.addNode(node.id, node.type, node.properties);
        }
      }

      console.log(`[graph_rebuild] Updated project index for ${projectId}`);

      // ... rest of post-build tasks ...
    })
    .catch(error => {
      console.error(`[graph_rebuild] Build failed: ${error}`);
    });

  return this.formatSuccess({...});
}
```

---

## Implementation Roadmap

### Phase 1: Stabilization (Week 1)
- **Fix 1.1**: Clear index on context switch (30 min)
- **Fix 1.2**: Add projectId filters to queries (1 hour)
- **Test**: Multi-project workflow with session IDs
- **Deploy**: Reduces cross-project data leakage

### Phase 2: Synchronization (Week 2)
- **Fix 2.1**: Export index from orchestrator (30 min)
- **Fix 2.2**: Sync orchestrator index after build (1 hour)
- **Fix 2.3**: Load index from Memgraph on startup (2 hours)
- **Test**: Embedding generation, progress tracking
- **Deploy**: Fixes embedding and validation engines

### Phase 3: Refactoring (Week 3)
- **Fix 3.1-3.4**: Implement project-scoped indices (8 hours)
- **Refactor**: Update engines to use index callbacks
- **Test**: Comprehensive multi-project test suite
- **Deploy**: Complete isolation, future-proof architecture

---

## Testing Strategy

### Unit Tests

```typescript
// test-graph-state.spec.ts

describe("Graph State Management", () => {

  it("should clear index on project context switch", async () => {
    const handlers = new ToolHandlers(context);

    // Setup project A
    await handlers.graph_set_workspace({projectId: "A"});
    // Manually add some nodes
    context.index.addNode("test-node", "TEST", {});

    // Switch to project B
    await handlers.graph_set_workspace({projectId: "B"});

    // Index should be cleared
    expect(context.index.getStatistics().totalNodes).toBe(0);
  });

  it("should sync orchestrator index after rebuild", async () => {
    const handlers = new ToolHandlers(context);

    // Set workspace and rebuild
    await handlers.graph_set_workspace({
      projectId: "test",
      workspaceRoot: "/test"
    });

    const rebuildResult = await handlers.graph_rebuild({});

    // Wait for async build to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Index should be populated
    const stats = context.index.getStatistics();
    expect(stats.totalNodes).toBeGreaterThan(0);
  });

  it("should load index from Memgraph on context switch", async () => {
    const handlers = new ToolHandlers(context);

    // Assuming database has data for project "existing"
    await handlers.graph_set_workspace({projectId: "existing"});

    // Index should be loaded from database
    const stats = context.index.getStatistics();
    expect(stats.totalNodes).toBeGreaterThan(0);
  });
});
```

### Integration Tests

```typescript
// test-multi-project-workflow.spec.ts

describe("Multi-Project Workflow", () => {

  it("should support switching between projects with session IDs", async () => {
    const sessionA = "sess-a";
    const sessionB = "sess-b";

    // Session A: Project A
    setRequestContext({sessionId: sessionA});
    await handlers.graph_set_workspace({projectId: "project-a"});
    await handlers.graph_rebuild({});

    const healthA = await handlers.graph_health({});
    const statsA = JSON.parse(healthA).data.graph.index;

    // Session B: Project B
    setRequestContext({sessionId: sessionB});
    await handlers.graph_set_workspace({projectId: "project-b"});
    await handlers.graph_rebuild({});

    const healthB = await handlers.graph_health({});
    const statsB = JSON.parse(healthB).data.graph.index;

    // Stats should be different
    expect(statsA).not.toEqual(statsB);

    // Switch back to A
    setRequestContext({sessionId: sessionA});
    const healthA2 = await handlers.graph_health({});
    const statsA2 = JSON.parse(healthA2).data.graph.index;

    // Should match original
    expect(statsA2).toEqual(statsA);
  });
});
```

---

## Validation Checklist

- [ ] Index is cleared when switching projects
- [ ] ProjectId filters are applied to all Memgraph queries
- [ ] Orchestrator index is exported and accessible
- [ ] Orchestrator index is synced after build completion
- [ ] Index is loaded from Memgraph when switching projects
- [ ] Embedding engine receives populated index
- [ ] Progress tracking works for current project
- [ ] Architecture validation works for current project
- [ ] Multiple sessions maintain isolation
- [ ] No cross-project data leakage in queries

---

## Performance Considerations

### Index Loading

**Issue**: Loading all nodes/relationships from Memgraph on every context switch could be slow.

**Solution**: Implement lazy loading
```typescript
private indexPromises = new Map<string, Promise<void>>();

async getIndexForProject(projectId: string): Promise<GraphIndexManager> {
  if (!this.projectIndices.has(projectId)) {
    // Lazy load in background
    const loadPromise = this.loadIndexFromMemgraph(projectId)
      .catch(error => console.warn(`Failed to load index: ${error}`));
    this.indexPromises.set(projectId, loadPromise);
  }

  // Wait for load if in progress
  await this.indexPromises.get(projectId);
  return this.projectIndices.get(projectId)!;
}
```

### Memory Usage

**Issue**: Storing multiple project indices in memory could consume significant RAM for large projects.

**Solution**: Implement cache eviction
```typescript
private readonly MAX_CACHED_INDICES = 5;

private getIndexForProject(projectId: string): GraphIndexManager {
  if (!this.projectIndices.has(projectId)) {
    if (this.projectIndices.size >= this.MAX_CACHED_INDICES) {
      // Evict least recently used
      const lru = this.getOldestAccessedProject();
      this.projectIndices.delete(lru);
    }
    this.projectIndices.set(projectId, new GraphIndexManager());
  }
  return this.projectIndices.get(projectId)!;
}
```

---

## Rollback Plan

If issues arise during implementation:

1. **Phase 1 Issues**: Revert Fix 1.1 and 1.2 (low-risk, isolated changes)
2. **Phase 2 Issues**: Revert Fix 2.1-2.3 (index sync can be disabled via env var)
3. **Phase 3 Issues**: Keep Phase 1+2, fall back to single shared index

Recommended: Add feature flags
```typescript
const ENABLE_INDEX_CLEARING = env.LXRAG_ENABLE_INDEX_CLEARING !== "false";
const ENABLE_INDEX_SYNC = env.LXRAG_ENABLE_INDEX_SYNC !== "false";
const ENABLE_PROJECT_SCOPED_INDICES = env.LXRAG_PROJECT_SCOPED_INDICES === "true";
```
