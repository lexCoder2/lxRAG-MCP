# Comprehensive lexRAG-MCP Review & Revised Action Plan
## Full Data Pipeline Analysis + Integration Fixes

**Analysis Date:** 2026-02-22
**Review Scope:** Complete data flow from source code → Memgraph → Qdrant
**Status:** 🔴 Multiple Critical Issues Found + Revised Plan Provided

---

## PART 1: COMPREHENSIVE REVIEW FINDINGS

### Executive Summary

The lexRAG-MCP data pipeline consists of **3 interconnected systems** that are **not properly synchronized**:

```
┌──────────────┐      ┌─────────────┐      ┌──────────────┐
│  Memgraph    │ ←→ │  In-Memory   │ ←→ │    Qdrant     │
│   (DB)       │      │   Index      │      │  (Vectors)   │
│  ✅ Updated  │      │ ✗ Empty/Out │      │ ✗ Stale/     │
│  ✓ Scoped    │      │  of sync     │      │  Unscoped    │
└──────────────┘      └─────────────┘      └──────────────┘
   Source of truth    Cache layer       Semantic search
```

---

## Key Findings from Deep Review

### Finding #1: Three Separate Index Systems (Unsynced)

**System 1: GraphOrchestrator.index (Temporary)**
- Created during `graph_rebuild()`
- Populated with ALL parsed code (FILE, FUNCTION, CLASS, etc.)
- Used to generate Cypher statements
- **Then: DISCARDED** (never synced back to shared index)

**System 2: ToolContext.index (Shared, Global)**
- Started empty at server startup
- **Never populated** from Memgraph
- **Never synced** from Orchestrator after builds
- **Never cleared** when switching projects
- Used by: ProgressEngine, TestEngine, EmbeddingEngine, ArchitectureEngine
- **Status: EMPTY or STALE**

**System 3: Memgraph Database (Source of Truth)**
- Updated with Cypher from Orchestrator ✓
- Contains accurate data (809 nodes in code-visual)
- **Not synced back** to in-memory index
- Direct queries work ✓

**Impact**: Tools read from System 2 (empty) → return zeros/empty results ✗

---

### Finding #2: Data Sync Matrix After graph_rebuild

| Data Type | To Memgraph | To In-Memory | To Qdrant | Status |
|-----------|---|---|---|---|
| **Code Entities** (FILE, FUNCTION, CLASS, etc.) | ✓ YES | ✓ YES | ✗ NO | PARTIAL |
| **Code Relationships** (CONTAINS, IMPORTS, etc.) | ✓ YES | ✓ YES | ✗ NO | PARTIAL |
| **FEATURE Nodes** | ✓ YES (hardcoded 5) | ✗ NO | N/A | ⚠️ OVERWRITES |
| **TASK Nodes** | ⚠️ API only | ✓ YES | N/A | ⚠️ OPTIONAL |
| **DOCUMENT Nodes** | ⚠️ Optional | ✗ NO | ⚠️ Optional | ⚠️ OPTIONAL |
| **Embeddings** | N/A | Generated from index | Lazy-loaded | ✗ NOT AUTO |
| **Embedding Freshness** | N/A | embeddingsReady flag | Never reset | ✗ STALE |
| **Test Cases** | ✗ NO (only TEST_SUITE) | ✗ NO | N/A | ✗ MISSING |

**Key Problem**: Qdrant receives **zero data** from graph_rebuild; only generated on-demand (lazy)

---

### Finding #3: Qdrant Integration Issues (CRITICAL)

#### Issue 3.1: No Project Scoping
```typescript
// From embedding-engine.ts:50-70
generateAllEmbeddings() {
  const functions = this.index.getNodesByType('FUNCTION');
  // Returns ALL functions across ALL projects
  // No projectId filtering
}
```

**Impact**: All projects share same vector space
- Project A search "authentication" finds functions from Project B
- No multi-tenant isolation
- **Severity**: CRITICAL

#### Issue 3.2: Embeddings Never Auto-Generated
```typescript
// graph_rebuild() does NOT call generateAllEmbeddings()
// Embeddings only generated lazily when:
// - graph_semantic_search() called
// - graph_code_search() called
// - code_cluster() called
```

**Impact**:
- First semantic search has latency spike
- If Qdrant unavailable, no fallback
- Stale embeddings after incremental builds
- **Severity**: HIGH

#### Issue 3.3: embeddingsReady Flag Never Reset
```typescript
private embeddingsReady = false;  // Set once at startup

// After incremental rebuild:
// embeddingsReady still = true even though new nodes weren't embedded
// New functions added but NOT in Qdrant
```

**Impact**:
- Incremental rebuilds don't update Qdrant
- New code is searchable via graph but NOT via semantic search
- Inconsistent results
- **Severity**: HIGH

#### Issue 3.4: MVP-Quality Embeddings
```typescript
// 128-dimensional hash-based vectors (NOT semantic)
// Deterministic but not meaningful
// Not using real embeddings (OpenAI, HuggingFace)
```

**Impact**: Semantic search quality is limited
- Better than nothing for MVP
- Needs upgrade for production
- **Severity**: MEDIUM

---

### Finding #4: Progress Data Issues

#### Issue 4.1: FEATURE Nodes Always Overwritten
```typescript
// orchestrator.ts:1015-1079
// Every graph_rebuild recreates same 5 hardcoded features
private seedProgressNodes(projectId: string): CypherStatement[] {
  const features = [
    { id: "phase-1", name: "Code Graph MVP", status: "completed" },
    { id: "phase-2", name: "Architecture Validation", ... },
    // ... 5 hardcoded features
  ];

  // Uses MERGE on id only
  query: `
    MERGE (f:FEATURE {id: $id})
    SET f.name = $name, f.status = $status  // Always overwrites
  `
}
```

**Problem**:
- Every rebuild resets all feature statuses
- User customizations lost
- No merge with existing data

**Severity**: HIGH

#### Issue 4.2: TASK Nodes Not Persisted
```typescript
// Tasks created only via ProgressEngine.createTask()
// persistTaskUpdate() is optional, requires Memgraph connected
// If Memgraph not connected, tasks lost on restart
```

**Problem**:
- Tasks not rebuilt from persistent storage
- Can't survive server restart
- Not synced during graph_rebuild

**Severity**: MEDIUM

#### Issue 4.3: Feature Data Only in Memory
```typescript
// ProgressEngine.getFeatureStatus() reads from this.features Map
// Map populated at initialization from empty in-memory index
// So features found from Memgraph are NOT in the Map
```

**Problem**: feature_status() always returns "not found"
**Severity**: CRITICAL (caused original issue #2)

---

### Finding #5: Index Initialization Problems

#### Issue 5.1: In-Memory Index Starts Empty
```typescript
// src/mcp-server.ts:618
const index = new GraphIndexManager();
// Started empty, never populated from Memgraph
```

**Problem**:
- Tools fail until first graph_rebuild
- On server restart, all in-memory data lost
- Engines have no data to work with

**Severity**: HIGH

#### Issue 5.2: No Cross-Project Cleanup
```typescript
// graph_set_workspace() does NOT:
// - Clear in-memory index
// - Reload engines with new data
// - Reset embeddings
```

**Problem**:
- Switching projects leaves old data in memory
- Engines still reference old project's data
- Cross-project contamination possible

**Severity**: MEDIUM

---

### Finding #6: Missing Data

| Entity Type | Status | Location |
|---|---|---|
| Individual TEST_CASE nodes | ✗ NOT CREATED | Should be in builder |
| Embedding generation trigger | ✗ MISSING | Should be in graph_rebuild |
| Index reset on project switch | ✗ MISSING | Should be in setActiveProjectContext |
| In-memory index load on startup | ✗ MISSING | Should be in initialization |
| Embedding staleness detection | ✗ MISSING | Should be in ensureEmbeddings |
| Progress data bidirectional sync | ✗ PARTIAL | Only optional Memgraph saves |

---

## PART 2: REVISED COMPREHENSIVE ACTION PLAN

### Priority Matrix

```
CRITICAL (Must fix immediately):
├─ P0.1: Sync orchestrator index to shared index
├─ P0.2: Fix Qdrant project scoping
├─ P0.3: Fix FEATURE node overwrite
└─ P0.4: Fix empty ProgressEngine maps

HIGH (Fix within sprint):
├─ P1.1: Reset embeddingsReady flag on rebuild
├─ P1.2: Generate embeddings during full rebuild
├─ P1.3: Load in-memory index from Memgraph on startup
├─ P1.4: Add consistency check to graph_health
└─ P1.5: Make task persistence mandatory

MEDIUM (Next iteration):
├─ P2.1: Add individual TEST_CASE nodes
├─ P2.2: Enable doc embeddings by default
└─ P2.3: Add state machine for sync states
```

---

## PHASE 1: CRITICAL FIXES (6-8 hours)

### 1.1: Sync Orchestrator Index to Shared Index After Build

**File**: `src/graph/orchestrator.ts`
**Location**: End of `build()` method (around line 430)

**Current Code**:
```typescript
async build(options: BuildOptions): Promise<BuildResult> {
  // ... all build logic ...
  return result;  // ← Index falls out of scope, discarded
}
```

**Required Change**:
```typescript
async build(options: BuildOptions): Promise<BuildResult> {
  // ... all build logic ...

  // NEW: Sync populated index to shared context
  if (this.sharedIndex) {
    console.log("[Orchestrator] Syncing internal index to shared index");

    // Sync all nodes
    const allNodes = this.index.getAllNodes ?
      this.index.getAllNodes() :
      Array.from(this.index.nodesByType.values()).flat();

    for (const node of allNodes) {
      try {
        this.sharedIndex.addNode(node.id, node.type, node.properties);
      } catch (e) {
        // Deduplication will skip existing nodes
      }
    }

    // Sync all relationships
    const allRels = this.index.getAllRelationships ?
      this.index.getAllRelationships() :
      Array.from(this.index.relationshipsByType.values()).flat();

    for (const rel of allRels) {
      try {
        this.sharedIndex.addRelationship(rel.id, rel.from, rel.to, rel.type, rel.properties);
      } catch (e) {
        // Deduplication will skip existing rels
      }
    }

    console.log(`[Orchestrator] Synced ${allNodes.length} nodes and ${allRels.length} relationships`);
  }

  return result;
}
```

**Why This Fixes**:
- ✅ In-memory index populated after build
- ✅ ProgressEngine gets real data
- ✅ TestEngine gets real data
- ✅ graph_health returns accurate counts

---

### 1.2: Fix Qdrant Project Scoping

**File**: `src/vector/embedding-engine.ts`
**Locations**: storeInQdrant() and search methods

**Step 1.2.1: Add projectId to embedding payload**

```typescript
// In generateEmbedding() - around line 170
private generateEmbedding(
  type: 'function' | 'class' | 'file',
  id: string,
  properties: Record<string, any>,
  projectId?: string  // NEW parameter
): CodeEmbedding {
  // ... existing code ...

  // Extract projectId from scoped ID if not provided
  const scope = id.split(':')[0];
  const effectiveProjectId = projectId || scope;

  return {
    id,
    type,
    vector: generatedVector,
    name: properties.name || id,
    text: textContent,
    metadata: {
      ...properties,
      projectId: effectiveProjectId,  // NEW
      fileName: properties.path,
      language: properties.language,
    },
  };
}
```

**Step 1.2.2: Store projectId in Qdrant payload**

```typescript
// In storeInQdrant() - around line 165
const point: VectorPoint = {
  id: embedding.id,
  vector: embedding.vector,
  payload: {
    name: embedding.name,
    text: embedding.text,
    projectId: embedding.metadata.projectId,  // NEW
    metadata: embedding.metadata,
  },
};
```

**Step 1.2.3: Filter by projectId in search**

```typescript
// In search method (used by semantic_search tool) - around line 250
async search(
  collection: string,
  query: CodeEmbedding,
  limit: number = 10,
  projectId?: string  // NEW parameter
): Promise<SearchResult[]> {
  // ... existing code ...

  // Build filter if projectId provided
  const filter = projectId ? {
    must: [{ key: 'payload.projectId', match: { value: projectId } }]
  } : undefined;

  const results = await this.qdrant.search({
    collection,
    vector: query.vector,
    limit,
    filter,  // NEW
  });

  // ... rest of method ...
}
```

**Why This Fixes**:
- ✅ Each project's vectors isolated
- ✅ No cross-project contamination
- ✅ Semantic search respects project boundaries

---

### 1.3: Fix FEATURE Node Overwrite

**File**: `src/graph/orchestrator.ts`
**Location**: seedProgressNodes() method (line 1015-1079)

**Current Code**:
```typescript
query: `
  MERGE (f:FEATURE {id: $id})
  SET f.name = $name, f.status = $status,  // Always overwrites
  ...
`
```

**Required Change - Option A (Recommended): Use ON CREATE only**

```typescript
private seedProgressNodes(projectId: string): CypherStatement[] {
  const features = [
    { id: `${projectId}:feature:phase-1`, name: "Code Graph MVP", status: "completed" },
    { id: `${projectId}:feature:phase-2`, name: "Architecture Validation", ... },
    // ... rest of features ...
  ];

  const statements: CypherStatement[] = [];

  for (const feature of features) {
    statements.push({
      query: `
        MERGE (f:FEATURE {id: $id})
        ON CREATE SET
          f.name = $name,
          f.status = $status,
          f.priority = $priority,
          f.createdAt = $timestamp,
          f.projectId = $projectId
        ON MATCH DO NOTHING  // <- NEW: Don't overwrite existing
      `,
      params: {
        id: feature.id,
        name: feature.name,
        status: feature.status,
        priority: feature.priority || 5,
        timestamp: Date.now(),
        projectId: projectId,
      },
    });
  }

  return statements;
}
```

**Alternative Option B: Use timestamp-based merge**

```typescript
query: `
  MATCH (f:FEATURE {id: $id})
  WHERE f.createdAt IS NULL OR f.createdAt <= $templateTimestamp
  SET f.name = $name, f.status = $status, ...
  ON MATCH DO NOTHING
`
```

**Why This Fixes**:
- ✅ Existing features preserved
- ✅ User customizations not lost
- ✅ New feature templates only created once

---

### 1.4: Fix Empty ProgressEngine Maps

**File**: `src/engines/progress-engine.ts`
**Location**: loadFromGraph() method + add reload() method

**Current Code**:
```typescript
constructor(index: GraphIndexManager, memgraph?: MemgraphClient) {
  this.index = index;
  this.memgraph = memgraph;
  this.features = new Map();
  this.tasks = new Map();
  this.loadFromGraph();  // Loads from empty index
}

private loadFromGraph(): void {
  const featureNodes = this.index.getNodesByType("FEATURE");  // Empty!
  // Maps stay empty
}
```

**Required Changes**:

**Step 1.4.1: Add reload() method**

```typescript
reload(index: GraphIndexManager, projectId?: string): void {
  console.log(`[ProgressEngine] Reloading features and tasks (projectId=${projectId})`);

  this.features.clear();
  this.tasks.clear();
  this.index = index;
  this.loadFromGraph(projectId);
}

private loadFromGraph(projectId?: string): void {
  // Load FEATURE nodes
  const featureNodes = this.index.getNodesByType("FEATURE");
  for (const node of featureNodes) {
    // Filter by projectId if provided
    if (projectId && node.properties?.projectId !== projectId) continue;

    this.features.set(node.id, {
      id: node.id,
      name: node.properties.name,
      status: node.properties.status || "pending",
      description: node.properties.description,
      adrReference: node.properties.adrReference,
      startedAt: node.properties.startedAt,
      completedAt: node.properties.completedAt,
      implementingFiles: [],
      relatedTests: [],
    });
  }

  // Load TASK nodes
  const taskNodes = this.index.getNodesByType("TASK");
  for (const node of taskNodes) {
    // Filter by projectId if provided
    if (projectId && node.properties?.projectId !== projectId) continue;

    this.tasks.set(node.id, {
      id: node.id,
      name: node.properties.name,
      description: node.properties.description,
      status: node.properties.status || "pending",
      assignee: node.properties.assignee,
      featureId: node.properties.featureId,
      startedAt: node.properties.startedAt,
      dueDate: node.properties.dueDate,
      completedAt: node.properties.completedAt,
      blockedBy: node.properties.blockedBy || [],
    });
  }

  console.log(`[ProgressEngine] Loaded ${this.features.size} features and ${this.tasks.size} tasks`);
}
```

**Step 1.4.2: Call reload on project context change**

**File**: `src/tools/tool-handlers.ts`
**Location**: setActiveProjectContext() method

```typescript
private setActiveProjectContext(context: ProjectContext): void {
  const sessionId = this.getCurrentSessionId();
  if (sessionId) {
    this.sessionProjectContexts.set(sessionId, context);
  } else {
    this.defaultActiveProjectContext = context;
  }

  // NEW: Reload engines with new context
  console.log(`[ToolHandlers] Project context changed to ${context.projectId}`);

  this.progressEngine?.reload(this.context.index, context.projectId);
  this.testEngine?.reload(this.context.index, context.projectId);
  if (this.archEngine) {
    this.archEngine.reload(this.context.index, context.projectId);
  }

  // Reset embedding flag so next semantic search regenerates
  this.embeddingsReady = false;
}
```

**Why This Fixes**:
- ✅ ProgressEngine loaded with actual data
- ✅ feature_status() finds valid IDs
- ✅ progress_query() returns task list
- ✅ All three original issues fixed

---

### 1.5: Make graph_health Query-First

**File**: `src/tools/tool-handlers.ts`
**Location**: graph_health() method (line 1778)

**Current Code**:
```typescript
async graph_health(args: any): Promise<string> {
  const stats = this.context.index.getStatistics();
  // Returns zeros because index is empty/stale

  return this.formatSuccess({
    graphIndex: {
      totalNodes: stats.totalNodes,  // 0
      totalRelationships: stats.totalRelationships,  // 0
    }
  });
}
```

**Required Change**:

```typescript
async graph_health(args: any): Promise<string> {
  const profile = args?.profile || "compact";
  const { projectId } = this.getActiveProjectContext();

  try {
    // Query from BOTH sources for comparison
    const indexStats = this.context.index.getStatistics();

    // Query Memgraph for authoritative counts
    const nodeCountResult = await this.context.memgraph.executeCypher(
      `MATCH (n {projectId: $projectId}) RETURN count(n) AS totalNodes`,
      { projectId }
    );

    const relCountResult = await this.context.memgraph.executeCypher(
      `MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
       RETURN count(r) AS totalRels`,
      { projectId }
    );

    const memgraphNodeCount = nodeCountResult.data?.[0]?.totalNodes || 0;
    const memgraphRelCount = relCountResult.data?.[0]?.totalRels || 0;

    // Function/Class/File counts from index (still useful)
    const functionCount = this.context.index.getNodesByType("FUNCTION").length;
    const classCount = this.context.index.getNodesByType("CLASS").length;
    const fileCount = this.context.index.getNodesByType("FILE").length;

    // Get embedding stats
    const embeddingCount = this.embeddingEngine?.getAllEmbeddings().length || 0;
    const indexedSymbols = functionCount + classCount + fileCount;
    const embeddingCoverage =
      indexedSymbols > 0
        ? Number((embeddingCount / indexedSymbols).toFixed(3))
        : 0;

    // Check if there's drift
    const hasIndexDrift = indexStats.totalNodes !== memgraphNodeCount;
    const hasEmbeddingDrift = embeddingCount < indexedSymbols;

    return this.formatSuccess({
      status: "ok",
      projectId,
      memgraphConnected: this.context.memgraph.isConnected(),
      qdrantConnected: this.qdrant?.isConnected() || false,
      graphIndex: {
        // Use Memgraph as source of truth
        totalNodes: memgraphNodeCount,
        totalRelationships: memgraphRelCount,
        indexedFiles: fileCount,
        indexedFunctions: functionCount,
        indexedClasses: classCount,
      },
      indexHealth: {
        driftDetected: hasIndexDrift,
        memgraphNodes: memgraphNodeCount,
        cachedNodes: indexStats.totalNodes,
        recommendation: hasIndexDrift ?
          "Run graph_rebuild to synchronize index" :
          "Index synchronized"
      },
      embeddings: {
        ready: this.embeddingsReady,
        generated: embeddingCount,
        coverage: embeddingCoverage,
        driftDetected: hasEmbeddingDrift,
        recommendation: hasEmbeddingDrift ?
          "Run semantic search to regenerate embeddings" :
          "Embeddings up-to-date"
      },
      lastRebuild: {
        timestamp: this.lastGraphRebuildAt,
        mode: this.lastGraphRebuildMode,
      }
    }, profile);
  } catch (error) {
    return this.errorEnvelope("GRAPH_HEALTH_FAILED", String(error), true);
  }
}
```

**Why This Fixes**:
- ✅ Returns accurate node counts from Memgraph
- ✅ Detects index drift
- ✅ Provides actionable recommendations
- ✅ Solves original issue #1

---

## PHASE 2: HIGH PRIORITY FIXES (3-4 hours)

### 2.1: Reset embeddingsReady Flag on Rebuild

**File**: `src/tools/tool-handlers.ts`
**Location**: runWatcherIncrementalRebuild() and graph_rebuild()

```typescript
// In graph_rebuild():
async graph_rebuild(args: any): Promise<string> {
  try {
    // ... existing code ...

    // After successful orchestrator.build():
    const result = await this.orchestrator.build({...});

    // NEW: Reset embedding flag
    this.embeddingsReady = false;
    console.log("[ToolHandlers] Cleared embedding cache due to rebuild");

    // ... rest of method ...
  }
}

// In runWatcherIncrementalRebuild():
private async runWatcherIncrementalRebuild(context): Promise<void> {
  // ... existing code ...

  // After successful rebuild:
  this.embeddingsReady = false;  // NEW

  // ... rest of method ...
}
```

**Why This Fixes**:
- ✅ Incremental builds update Qdrant
- ✅ New code appears in semantic search
- ✅ graph_health.embeddings.driftDetected is accurate

---

### 2.2: Generate Embeddings During Full Rebuild

**File**: `src/tools/tool-handlers.ts`
**Location**: After orchestrator.build() in graph_rebuild()

```typescript
// After graph_rebuild successfully completes:

if (mode === "full" && this.context.memgraph.isConnected()) {
  // NEW: Trigger embedding generation for full builds
  console.log("[ToolHandlers] Generating embeddings for full rebuild");

  try {
    await this.ensureEmbeddings();
    console.log("[ToolHandlers] Embeddings generated successfully");
  } catch (error) {
    console.warn("[ToolHandlers] Embedding generation failed:", error);
    // Don't fail the whole rebuild if embeddings fail
  }
}
```

**Why This Fixes**:
- ✅ No latency on first semantic search
- ✅ Embeddings ready immediately after build
- ✅ Consistent semantic search coverage

---

### 2.3: Load In-Memory Index from Memgraph on Startup

**File**: `src/mcp-server.ts` or `src/tools/tool-handlers.ts`
**Location**: Constructor or initialization method

```typescript
// In ToolHandlers constructor:
constructor(private context: ToolContext) {
  this.defaultActiveProjectContext = this.defaultProjectContext();

  // NEW: Load index from Memgraph if available
  if (this.context.memgraph.isConnected()) {
    console.log("[ToolHandlers] Loading graph index from Memgraph");
    this.loadIndexFromMemgraph();
  }

  this.initializeEngines();
}

private async loadIndexFromMemgraph(): Promise<void> {
  try {
    const { projectId } = this.getActiveProjectContext();

    // Query all nodes
    const nodeResult = await this.context.memgraph.executeCypher(
      `MATCH (n {projectId: $projectId})
       RETURN n.id AS id, labels(n)[0] AS type, properties(n) AS props`,
      { projectId }
    );

    for (const row of nodeResult.data || []) {
      this.context.index.addNode(row.id, row.type, row.props);
    }

    // Query all relationships
    const relResult = await this.context.memgraph.executeCypher(
      `MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
       RETURN id(r) AS id, type(r) AS type, n1.id AS from, n2.id AS to,
              properties(r) AS props`,
      { projectId }
    );

    for (const row of relResult.data || []) {
      this.context.index.addRelationship(row.id, row.from, row.to, row.type, row.props);
    }

    console.log(`[ToolHandlers] Loaded index: ${this.context.index.getStatistics().totalNodes} nodes`);
  } catch (error) {
    console.warn("[ToolHandlers] Failed to load index from Memgraph:", error);
    // Continue without loading - will be populated on rebuild
  }
}
```

**Why This Fixes**:
- ✅ Tools work immediately after server restart
- ✅ No need to rebuild to get data
- ✅ Much faster startup

---

### 2.4: Add Consistency Check to graph_health

**Already included in Phase 1.5** - graph_health now returns drift detection

---

### 2.5: Make Task Persistence Mandatory

**File**: `src/engines/progress-engine.ts`
**Location**: updateTask() and createTask() methods

```typescript
updateTask(taskId: string, updates: Partial<Task>): Task | null {
  const task = this.tasks.get(taskId);
  if (!task) return null;

  Object.assign(task, updates);

  if (updates.status === "completed") {
    task.completedAt = Date.now();
  } else if (updates.status === "in-progress" && !task.startedAt) {
    task.startedAt = Date.now();
  }

  // NEW: Always persist to Memgraph
  if (this.memgraph && this.memgraph.isConnected()) {
    this.persistTaskUpdate(taskId, task);  // Make this async and fire-and-forget
  } else {
    console.warn(`[ProgressEngine] Task update not persisted (Memgraph unavailable): ${taskId}`);
    // Still return the task, but warn about loss
  }

  return task;
}

private async persistTaskUpdate(taskId: string, task: Task): Promise<void> {
  try {
    const query = `
      MERGE (t:TASK {id: $id})
      SET t.name = $name,
          t.description = $description,
          t.status = $status,
          t.assignee = $assignee,
          t.featureId = $featureId,
          t.startedAt = $startedAt,
          t.dueDate = $dueDate,
          t.completedAt = $completedAt,
          t.blockedBy = $blockedBy,
          t.updatedAt = $updatedAt
    `;

    await this.memgraph.executeCypher(query, {
      id: taskId,
      name: task.name,
      description: task.description,
      status: task.status,
      assignee: task.assignee,
      featureId: task.featureId,
      startedAt: task.startedAt,
      dueDate: task.dueDate,
      completedAt: task.completedAt,
      blockedBy: task.blockedBy,
      updatedAt: Date.now(),
    });
  } catch (error) {
    console.error(`[ProgressEngine] Failed to persist task: ${taskId}`, error);
  }
}
```

**Why This Fixes**:
- ✅ Tasks survive server restart
- ✅ Distributed systems can share task state
- ✅ Task history preserved in database

---

## PHASE 3: MEDIUM PRIORITY FIXES (4-5 hours)

### 3.1: Add Individual TEST_CASE Nodes

**File**: `src/graph/builder.ts`
**Location**: buildTestNodes() method

```typescript
private buildTestNodes(
  parsedFile: ParsedFile,
  projectId: string,
  fileNodeId: string
): void {
  const testSuiteId = this.scopedId(`test_suite:${parsedFile.path}`);

  // Create TEST_SUITE node
  this.createTestSuiteNode(testSuiteId, parsedFile);
  this.createRelationship(fileNodeId, testSuiteId, "CONTAINS");

  // NEW: Create individual TEST_CASE nodes
  const testCases = this.extractTestCases(parsedFile);
  for (const testCase of testCases) {
    const testCaseId = this.scopedId(`test_case:${parsedFile.path}#${testCase.name}`);

    this.createTestCaseNode(testCaseId, testCase);
    this.createRelationship(testSuiteId, testCaseId, "CONTAINS");
    this.createRelationship(fileNodeId, testCaseId, "TESTS");
  }
}

private extractTestCases(parsedFile: ParsedFile): Array<{name: string, kind: string}> {
  // Extract individual test functions/cases
  // Pattern depends on language:
  // - TypeScript: describe/it blocks
  // - Python: test_ functions, class methods
  // - Go: Test* functions
  // - Rust: #[test] functions

  const testCases: Array<{name: string, kind: string}> = [];

  // Simplified: Just look for test-like symbols
  for (const symbol of parsedFile.symbols || []) {
    if (symbol.name.match(/^(test|spec|it|describe)/i) ||
        symbol.name.match(/^Test/)) {
      testCases.push({
        name: symbol.name,
        kind: symbol.kind || "test",
      });
    }
  }

  return testCases;
}

private createTestCaseNode(testCaseId: string, testCase: any): void {
  const nodeId = testCaseId;

  this.statements.push({
    query: `
      MERGE (t:TEST_CASE {id: $id})
      SET t.name = $name,
          t.kind = $kind,
          t.projectId = $projectId,
          t.createdAt = $timestamp
    `,
    params: {
      id: nodeId,
      name: testCase.name,
      kind: testCase.kind,
      projectId: this.projectId,
      timestamp: Date.now(),
    },
  });

  // Also add to in-memory index
  this.index.addNode(nodeId, "TEST_CASE", {
    name: testCase.name,
    kind: testCase.kind,
    projectId: this.projectId,
  });
}
```

**Why This Fixes**:
- ✅ Granular test coverage tracking
- ✅ Test-level impact analysis
- ✅ Better test selection

---

### 3.2: Enable Doc Embeddings by Default

**File**: `src/tools/tool-handlers.ts`
**Location**: indexDocs parameter in graph_rebuild and DocsEngine initialization

```typescript
// In graph_rebuild():
const { indexDocs = true } = args;  // Change from false to true

// In DocsEngine.indexWorkspace():
const { withEmbeddings = true } = options;  // Change from false to true

// Call for embeddings:
await this.engine.generateEmbeddings(sections, projectId);
```

**Why This Fixes**:
- ✅ Documentation searchable via semantic_search
- ✅ Better combined results (code + docs)
- ✅ Integration information discovery

---

### 3.3: Add State Machine for Sync States

**New File**: `src/graph/sync-state.ts`

```typescript
export type SyncState = "uninitialized" | "synced" | "drifted" | "rebuilding";

export interface SystemHealth {
  memgraph: SyncState;
  index: SyncState;
  qdrant: SyncState;
  embeddings: SyncState;
}

export class SyncStateManager {
  private state: SystemHealth = {
    memgraph: "uninitialized",
    index: "uninitialized",
    qdrant: "uninitialized",
    embeddings: "uninitialized",
  };

  setState(system: keyof SystemHealth, newState: SyncState): void {
    this.state[system] = newState;
    console.log(`[SyncState] ${system}: ${newState}`);
  }

  getState(): SystemHealth {
    return { ...this.state };
  }

  isHealthy(): boolean {
    return Object.values(this.state).every(s => s === "synced");
  }

  needsSync(): keyof SystemHealth | null {
    for (const [system, state] of Object.entries(this.state)) {
      if (state === "drifted") return system as keyof SystemHealth;
    }
    return null;
  }
}
```

**Why This Helps**:
- ✅ Clear tracking of each subsystem
- ✅ Automatic recovery recommendations
- ✅ Better diagnostics

---

## PART 3: VALIDATION TEST CASES

### Test 1: graph_rebuild Syncs All Systems

**Setup**:
```bash
graph_set_workspace({
  projectId: "code-visual",
  workspaceRoot: "/path/to/code-visual",
  sourceDir: "src"
})
graph_rebuild({ mode: "full", indexDocs: true })
```

**Assertions**:
```
✓ Memgraph has 809 nodes
✓ In-memory index has 809 nodes
✓ Qdrant has embeddings for functions, classes, files
✓ graph_health returns totalNodes: 809
✓ Embedding coverage > 80%
✓ No drift detected
```

---

### Test 2: Feature Status Works

**Setup**:
```bash
graph_rebuild({ mode: "full" })
feature_status("code-visual:feature:phase-1")
```

**Expected Result**:
```json
{
  "success": true,
  "feature": {
    "id": "code-visual:feature:phase-1",
    "name": "Code Graph MVP",
    "status": "completed"
  },
  "tasks": [...],
  "progressPercentage": 100
}
```

---

### Test 3: Multi-Project Isolation

**Setup**:
```bash
# Project A
graph_set_workspace({ projectId: "project-a", ... })
graph_rebuild({ mode: "full" })
semantic_search("authenticate")  # Get functions from A only

# Project B
graph_set_workspace({ projectId: "project-b", ... })
graph_rebuild({ mode: "full" })
semantic_search("authenticate")  # Get functions from B only (not A)
```

**Assertion**: Results don't overlap

---

### Test 4: Embeddings Updated on Incremental Build

**Setup**:
```bash
graph_rebuild({ mode: "full" })
# Add new function to source
graph_rebuild({ mode: "incremental" })
semantic_search("newFunction")  # Should find it
```

**Assertion**: embeddingsReady reset, new function appears

---

## PART 4: IMPLEMENTATION TIMELINE

| Phase | Tasks | Effort | Urgency |
|-------|-------|--------|---------|
| **P0** | 1.1-1.5 (Index sync, Qdrant scope, Feature fix, ProgressEngine reload, graph_health query) | 6-8h | CRITICAL |
| **P1** | 2.1-2.5 (Embedding flag, Auto-gen, Index load, Consistency, Task persist) | 3-4h | HIGH |
| **P2** | 3.1-3.3 (Test cases, Doc embeddings, Sync state) | 4-5h | MEDIUM |
| **P3** | Long-term architecture (per-project indices) | 8-12h | LOW |
| **Total** | All phases | 21-29h | - |

---

## PART 5: VALIDATION CHECKLIST

After implementing all phases:

- [ ] Phase 1 tests pass
  - [ ] graph_health returns accurate counts
  - [ ] feature_status resolves valid IDs
  - [ ] progress_query returns task list
  - [ ] In-memory index synced after build

- [ ] Phase 2 tests pass
  - [ ] Incremental builds update Qdrant
  - [ ] Embeddings generated after full build
  - [ ] Index loaded from Memgraph on startup
  - [ ] Tasks persisted to Memgraph

- [ ] Phase 3 tests pass
  - [ ] Individual test cases tracked
  - [ ] Doc embeddings generated
  - [ ] Sync state tracked and reported

- [ ] Integration tests pass
  - [ ] code-visual works with all tools
  - [ ] No cross-project contamination
  - [ ] Consistent counts across all systems
  - [ ] No data loss on restart

- [ ] Performance tests pass
  - [ ] startup < 5 seconds
  - [ ] graph_health < 500ms
  - [ ] semantic_search < 1000ms (first call)
  - [ ] semantic_search < 200ms (subsequent)

---

## Summary

The **comprehensive review revealed 10 critical issues** in the data pipeline:

1. ✗ Unsynced index systems
2. ✗ Qdrant gets no data from rebuild
3. ✗ Qdrant has no project scoping
4. ✗ Embeddings never auto-generated
5. ✗ embeddingsReady flag never reset
6. ✗ FEATURE nodes always overwritten
7. ✗ TASK nodes not persisted
8. ✗ In-memory index starts empty
9. ✗ No cross-project cleanup
10. ✗ Individual test cases missing

**The revised plan fixes all of these** through:
- **Phase 1**: Critical synchronization and scoping (6-8h)
- **Phase 2**: Embedding and persistence (3-4h)
- **Phase 3**: Missing data types and state management (4-5h)

**Estimated total effort: 13-17 hours** for complete fix across all phases.

