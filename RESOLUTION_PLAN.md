# LexDIG-MCP Resolution Plan

**Status**: Ready for Implementation  
**Last Updated**: 2026-02-22  
**Analysis Method**: lxDIG Tools Only

---

## Executive Summary

Analysis using only lxDIG tools has identified **3 critical blockers** preventing full code intelligence:

1. **Backend BigInt Error** - Prevents graph health verification
2. **Missing Architecture Configuration** - Files unassigned to layers
3. **Incomplete Graph Rebuild** - Limited symbol data available

**Estimated Time to Resolution**: 3-5 days for phases 1-2, 2+ weeks for full roadmap

---

## Phase 1: Backend Stabilization & Configuration (CRITICAL)

**Duration**: 1 day | **Dependency**: None | **Blocks**: Everything

### 1.1 Fix BigInt Type Conversion Error

**Problem**: `TypeError: Cannot mix BigInt and other types, use explicit conversions`

**Location**: lxDIG backend graph_health check

**Resolution Steps**:

```bash
# 1. Check lxDIG setup
docker ps | grep -E "memgraph|qdrant"

# 2. Verify MCP server status
curl http://localhost:9000/health

# 3. Look for BigInt issues in backend
find . -type f -name "*.ts" -o -name "*.js" | xargs grep -l "BigInt" 2>/dev/null

# 4. If backend, patch conversion:
# Change: timestamp + metadata (mixing types)
# To: BigInt(timestamp) + BigInt(metadata)
```

**Validation**:

```bash
# After fix, this should succeed:
npm run test:mcp-integration
# Should see: "graph_health OK"
```

### 1.2 Create Architecture Configuration

**Problem**: `.lxdig/config.json` missing or incomplete

**File**: `.lxdig/config.json` (create if missing)

**Required Content**:

```json
{
  "projectId": "lexdig-mcp",
  "sourceDir": "src",
  "layers": [
    {
      "id": "types",
      "name": "Type System",
      "paths": ["src/types/**"],
      "description": "Core type definitions"
    },
    {
      "id": "infrastructure",
      "name": "Infrastructure",
      "paths": [
        "src/parsers/**",
        "src/vector/**",
        "src/response/**",
        "src/utils/**"
      ],
      "description": "Low-level infrastructure"
    },
    {
      "id": "graph",
      "name": "Graph Engine",
      "paths": ["src/graph/**"],
      "description": "Code graph building and querying"
    },
    {
      "id": "tools",
      "name": "Tool Implementations",
      "paths": ["src/tools/**"],
      "description": "MCP tool handlers"
    },
    {
      "id": "engines",
      "name": "Execution Engines",
      "paths": ["src/engines/**"],
      "description": "Analysis engines (architecture, docs, episodes, etc.)"
    },
    {
      "id": "core",
      "name": "Core Server",
      "paths": [
        "src/index.ts",
        "src/mcp-server.ts",
        "src/server.ts",
        "src/config.ts",
        "src/env.ts"
      ],
      "description": "Server entry points and configuration"
    },
    {
      "id": "cli",
      "name": "CLI Commands",
      "paths": ["src/cli/**"],
      "description": "Command-line interface"
    }
  ],
  "rules": [
    {
      "from": "types",
      "to": "*",
      "allow": true,
      "reason": "Type layer can be imported by all"
    },
    {
      "from": "infrastructure",
      "to": "*",
      "allow": true,
      "reason": "Infrastructure available to all"
    },
    {
      "from": "graph",
      "to": ["infrastructure", "types"],
      "allow": true
    },
    {
      "from": "tools",
      "to": ["engines", "graph", "infrastructure", "types"],
      "allow": true
    },
    {
      "from": "engines",
      "to": ["graph", "infrastructure", "tools", "types"],
      "allow": true
    },
    {
      "from": "core",
      "to": "*",
      "allow": true,
      "reason": "Core server orchestrates all"
    },
    {
      "from": "cli",
      "to": ["core", "tools", "engines"],
      "allow": true
    }
  ]
}
```

**Validation**:

```bash
# Test configuration
npm run validate:arch

# Should show:
# ✓ All files assigned to layers
# ✓ 0 violations
# ✓ Dependencies valid
```

### 1.3 Force Graph Rebuild

**Command**:

```bash
# Full rebuild with new config
npm run graph:rebuild -- --full --verbose

# Monitor progress (in another terminal):
npm run graph:health -- --poll 5s
```

**Expected Output**:

```
✓ Graph initialized
✓ Parsing src/ directory ...
✓ Building dependency graph ...
✓ Indexing 26 documents ...
✓ Creating vector embeddings ...
✓ Rebuild complete (elapsed: ~45s)
```

### 1.4 Validate Phase 1

**Checklist**:

- [ ] `npm run test:mcp-integration` passes
- [ ] `graph_health` returns 200 OK
- [ ] `arch_validate` shows 0 violations
- [ ] 20+ code symbols indexed
- [ ] 26 documents indexed with embeddings

**Move to Phase 2 when**: All checks ✓

---

## Phase 2: Code Intelligence Activation (HIGH)

**Duration**: 2-3 days | **Dependency**: Phase 1 | **Blocks**: Agent engine

### 2.1 Validate All Tools Work

```bash
# Test each major tool
npm run test:tools -- --category graph
npm run test:tools -- --category architecture
npm run test:tools -- --category impact
npm run test:tools -- --category patterns
```

**Expected**: All tools return data, 0 timeouts

### 2.2 Run Pattern Detection

**Test TODO/FIXME Detection**:

```bash
npm run pattern:find -- --pattern "TODO|FIXME|BUG|HACK"
```

**Expected Output**:

```
Found patterns:
  src/engines/episode-engine.ts:42 TODO: Implement bi-temporal queries
  src/tools/tool-handlers.ts:108 FIXME: Handle null context
  ...
```

### 2.3 Test Impact Analysis

```bash
# Test with common change scenarios
npm run impact:analyze -- src/graph/builder.ts
npm run impact:analyze -- src/engines/architecture-engine.ts
```

**Expected**: Shows affected tests, blast radius, dependencies

### 2.4 Enable Documentation Search

```bash
# Verify indexing
npm run docs:index -- --with-embeddings

# Test search
npm run docs:search -- "agent context engine"
npm run docs:search -- "graph state"
```

**Expected**: Returns relevant sections with scores

### 2.5 Run Full Test Suite

```bash
npm run test:all
npm run test:integration
```

**Validation**:

- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Pattern detection working
- [ ] Impact analysis accurate
- [ ] Doc search operational

**Move to Phase 3 when**: All validations ✓

---

## Phase 3: Agent Context Engine (MEDIUM)

**Duration**: 1-2 weeks | **Dependency**: Phase 2

Based on `docs/AGENT_CONTEXT_ENGINE_PLAN.md`

### 3.1 Implement Episode Storage

**Files to Create/Modify**:

- `src/engines/episode-engine.ts` - Main implementation
- `src/graph/episode-nodes.ts` - Graph schema
- `src/types/episode.ts` - Type definitions

**Key Features**:

- [ ] Episode entity (observation, decision, code edit)
- [ ] Temporal metadata (validFrom, validTo)
- [ ] Bi-temporal queries
- [ ] Semantic indexing

### 3.2 Implement Memory Persistence

**Features**:

- [ ] Save episodes to Memgraph
- [ ] Vector embedding for semantic search
- [ ] TTL/expiry policies
- [ ] Concurrent episode management

### 3.3 Test Episode Workflows

```bash
npm run test:episodes -- --scenario "agent-learns"
npm run test:episodes -- --scenario "memory-recall"
```

---

## Phase 4: CLI & Validation (MEDIUM)

**Duration**: 1 week | **Dependency**: Phase 2

### 4.1 Complete CLI Commands

**Build Command**:

```bash
lxdig build [--project projectId] [--full|--incremental]
```

**Query Command**:

```bash
lxdig query "find all HTTP handlers" [--project projectId]
```

**Test Affected**:

```bash
lxdig test-affected [files...] [--report json]
```

**Validate**:

```bash
lxdig validate [--strict] [--fix]
```

### 4.2 Testing Infrastructure

- [ ] Unit test generation
- [ ] Integration test templates
- [ ] Mutation testing
- [ ] Performance profiling

---

## Phase 5: Performance & Optimization (LOW)

**Duration**: 1 week | **Dependency**: Phase 3

### 5.1 Benchmarking

From `benchmarks/` directory:

1. **Graph Tool Performance**
   - [ ] Complete GRAPH_TOOLS_BENCHMARK_MATRIX.md
   - [ ] Identify slow operations
   - [ ] Profile graph queries

2. **Agent Mode**
   - [ ] Run synthetic agent tests
   - [ ] Compare agent_mode_artifacts/
   - [ ] Measure context pack generation time

### 5.2 Optimization

- [ ] Cache frequent queries
- [ ] Optimize graph traversal
- [ ] Batch vector operations
- [ ] Connection pooling

---

## Implementation Checklist

### Phase 1: Backend (1 day)

- [x] Create `.lxdig/config.json`
- [x] Fix BigInt error in local source (`src/tools/tool-handlers.ts`)
- [x] Add regression test coverage for BigInt health metrics
- [x] Force graph rebuild
- [x] Validate all systems locally (`npm run build`, `npm test`)
- [ ] Validate hosted/runtime `mcp_lxdig_graph_health` after service restart

**Completion Criteria**:

- `arch_validate` → 0 violations (after runtime sync)
- `graph_health` → OK (after runtime sync)
- 20+ symbols indexed

### Phase 2: Intelligence (2-3 days)

- [ ] Run all tool tests (runtime)
- [ ] Verify pattern detection
- [ ] Validate impact analysis
- [ ] Enable doc search
- [ ] Run full test suite

**Completion Criteria**:

- All tests ✓ passing
- All tools return data
- No BigInt errors

### Phase 3: Agent Engine (1-2 weeks)

- [ ] Episode storage
- [ ] Memory persistence
- [ ] Episode search
- [ ] Integration tests

**Completion Criteria**:

- Episodes persist across sessions
- Semantic search works
- Agent can recall context

### Phase 4: CLI (1 week)

- [ ] Build command complete
- [ ] Query command complete
- [ ] Test-affected working
- [ ] Validate command complete

**Completion Criteria**:

- CLI end-to-end tested
- Help docs complete

### Phase 5: Performance (1 week)

- [ ] Benchmarks complete
- [ ] Bottlenecks identified
- [ ] Optimizations applied
- [ ] Performance improved 20%+

**Completion Criteria**:

- Regression tests pass
- Performance targets met

---

## Risk Assessment

### High Risk Items

1. **BigInt Error** (Phase 1)
   - Risk: Backend compatibility issue
   - Mitigation: Check Node.js version (need 15.7+)
   - Fallback: Downgrade to safe math library

2. **Graph Rebuild Timeout** (Phase 1)
   - Risk: Large codebases take time
   - Mitigation: Monitor with `--verbose` flag
   - Fallback: Incremental rebuild or skip docs

### Medium Risk Items

1. **Performance Regression** (Phase 3-5)
   - Risk: Agent memory adds overhead
   - Mitigation: Cache strategies, TTL policies
   - Fallback: Optional feature flag

2. **Integration Complexity** (Phase 3)
   - Risk: Bi-temporal model tricky
   - Mitigation: Extensive testing, clear types
   - Fallback: Simplified episode model first

---

## Success Definition

### Phase 1: ✓ Passing

- Backend errors resolved
- Architecture configured
- Graph building successfully

### Phase 2: ✓ Active

- All tools operational
- Pattern detection enabled
- Doc search working
- Impact analysis accurate

### Phase 3: ✓ Planned

- Episodes stored
- Memory persists
- Semantic search on episodes
- Agents can recall context

### Overall Success:

**Full lxDIG suite operational with agent memory integration**

---

## Monitoring & Metrics

### Track These Metrics

```
Phase 1:
  - BigInt errors/week: < 1
  - Rebuild time: < 1 min
  - Arch violations: 0

Phase 2:
  - Tool success rate: > 99%
  - Pattern detection accuracy: > 95%
  - Query latency: < 500ms

Phase 3:
  - Episode persistence rate: 100%
  - Memory recall accuracy: > 90%
  - Semantic search NDCG: > 0.8

Phase 4:
  - CLI command success: 100%
  - Test coverage: > 80%

Phase 5:
  - P99 query latency: < 1s
  - Throughput: > 100 ops/sec
```

---

## Support Resources

| Issue               | Reference                                        |
| ------------------- | ------------------------------------------------ |
| BigInt errors       | `ERROR_REPORT.md`, `GRAPH_STATE_FIXES.md`        |
| Architecture config | `ARCHITECTURE.md`, `docs/INTEGRATION_SUMMARY.md` |
| Tool reference      | `QUICK_REFERENCE.md`                             |
| Integration guide   | `docs/MCP_INTEGRATION_GUIDE.md`                  |
| Roadmap             | `docs/AGENT_CONTEXT_ENGINE_PLAN.md`              |
| Benchmarks          | `benchmarks/GRAPH_TOOLS_BENCHMARK_MATRIX.md`     |

---

## Next Immediate Actions

1. **Right Now**:
   - Review this plan
   - Create `.lxdig/config.json` (provided above)

2. **Within 1 hour**:
   - Run Phase 1 validation checklist
   - Fix any errors

3. **Within 1 day**:
   - Complete Phase 1
   - Start Phase 2

4. **This week**:
   - Complete Phases 2-3
   - Begin Phase 4

---

**Plan created by**: lxDIG Analysis Tools  
**Confidence**: High (based on actual project analysis)  
**Ready for**: Immediate implementation
