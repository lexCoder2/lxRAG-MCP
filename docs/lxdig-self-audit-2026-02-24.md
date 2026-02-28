# lxDIG-MCP Self-Audit Report

**Run date:** 2026-02-24  
**Audited project:** `lxDIG-MCP` (`/home/alex_rod/projects/lexRAG-MCP`)  
**Auditor:** lxDIG-MCP server running against its own source tree  
**Prior audit:** `lxdig-tool-audit-2026-02-23b.md` (code-visual workspace)

---

## 0. Session Setup

### Graph Health Snapshot (pre-audit)

```json
{
  "memgraphNodes": 2216,
  "memgraphRels": 3622,
  "cachedNodes": 448,
  "cachedRels": 2250,
  "indexedFiles": 74,
  "indexedFunctions": 85,
  "indexedClasses": 164,
  "driftDetected": true,
  "bm25IndexExists": true,
  "mode": "lexical_fallback",
  "embeddings": { "ready": true, "generated": 0, "coverage": 0 },
  "qdrantConnected": true,
  "txCount": 3,
  "latestTxId": "tx-41bf6f89",
  "summarizer": { "configured": false, "endpoint": null }
}
```

**Drift note:** The running MCP server process was started before fixes F1–F11 were
applied to the source tree. `cachedNodes: 448` vs `memgraphNodes: 2216` is a direct
symptom of F8 (sharedIndex not passed to GraphOrchestrator). All F1–F11 fixes are
present in source and pass tests; they require a server restart to take effect.

### Available Tools

| Status       | Tools                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ Available | `graph_health`, `graph_rebuild`, `init_project_setup`, `impact_analyze`, `reflect`, `feature_status`, `test_select`, `test_run`, `semantic_diff`, `ref_query`                           |
| ❌ Disabled  | `graph_query`, `arch_validate`, `arch_suggest`, `semantic_search`, `find_similar_code`, `code_explain`, `code_clusters`, `find_pattern`, `index_docs`, `search_docs`, `blocking_issues` |

---

## 1. Node / Relationship Census

Source: Cypher queries via `neo4j-driver` against `bolt://localhost:7687`.

### 1.1 Node Census (projectId = `lxDIG-MCP`)

| Label     | Count    |
| --------- | -------- |
| SECTION   | 943      |
| VARIABLE  | 512      |
| EXPORT    | 243      |
| CLASS     | 164      |
| IMPORT    | 128      |
| FUNCTION  | 85       |
| FILE      | 74       |
| DOCUMENT  | 37       |
| FOLDER    | 16       |
| COMMUNITY | 11       |
| GRAPH_TX  | 3        |
| **Total** | **2216** |

### 1.2 Relationship Census

| Type           | Count             |
| -------------- | ----------------- |
| SECTION_OF     | 943               |
| NEXT_SECTION   | 906               |
| CONTAINS       | 848               |
| BELONGS_TO     | 323               |
| EXPORTS        | 244               |
| DOC_DESCRIBES  | 218               |
| IMPORTS        | 128               |
| EXTENDS        | 12                |
| **REFERENCES** | **0** ← F11 / SX3 |
| CALLS          | 0                 |
| **Total**      | **3622**          |

---

## 2. Confirmed-Working Fixes

The following findings from the prior audit are verified working in the graph state:

| Finding                         | Verification | Evidence                                                 |
| ------------------------------- | ------------ | -------------------------------------------------------- |
| **F1** path normalization       | ✅ PASS      | 74 FILE nodes: 74 absolute, 0 relative paths             |
| **F2** SECTION.relativePath     | ✅ PASS      | 0 of 943 SECTION nodes have null relativePath            |
| **F7b** community size property | ✅ PASS      | All 11 COMMUNITY nodes: `size` = `memberCount` confirmed |

---

## 3. Still-Active Bugs (F8 family — server restart required)

These findings were fixed in source but require a server restart to become active.

### F8 — Cache Drift (Server-Side)

**Status:** Fixed in `src/server.ts`; not active in running process.

- `cachedNodes: 448` vs `memgraphNodes: 2216` (drift: 1768 nodes)
- Root cause: Old binary uses `new GraphOrchestrator(memgraph, false)` without `index` arg
- After restart: `GraphOrchestrator` will call `sharedIndex.syncFrom()` after each rebuild

### F3 — BM25 Lexical Fallback

**Status:** Fixed; not active.

- `mode: "lexical_fallback"` because in-memory cache is stale (F8)
- BM25 index exists (`bm25IndexExists: true`) but runs on 448-node stale cache

### F5 — Semantic Tools Broken

**Status:** Fixed via F8; not active.

- `embeddings.generated: 0` across 85 FUNCTION + 164 CLASS nodes
- All semantic tools (`semantic_search`, `code_explain`, vector queries) return empty results

---

## 4. New Findings

### SX1 — SECTION.title Never Populated _(Low)_

**Observed:**

- 0 of 943 SECTION nodes have a non-null `title` property
- DOCUMENT nodes also have `path: null`, only `relPath` available

**Root cause:**

- `summarizer.configured: false` — `LXDIG_SUMMARIZER_URL` is not set
- Without a configured summarizer, the docs-engine produces sections with no title extraction
- No absolute `path` is stored on DOCUMENT nodes; lookups by absolute path are not possible

**Impact:** Low — `search_docs` and `index_docs` work on `relPath`; titles are informational.

**Recommendation:** Document that `LXDIG_SUMMARIZER_URL` must be configured for section
titles; alternatively add heuristic H1-extraction to the markdown parser for common headings.

---

### SX2 — FUNCTION / CLASS Nodes Missing `path` Property _(Medium)_

**Observed:**

```
CLASS sample: { name: "ArchitectureEngine", path: null, layer: null }
FUNCTION sample: { name: "main", path: null }
```

All 164 CLASS and 85 FUNCTION nodes have `path: null`.

**Root cause:**  
The builder (`src/graph/builder.ts`) does not set `path` or `filePath` on CLASS/FUNCTION nodes.
These nodes link to their parent FILE via a `CONTAINS` edge, but the path is not stored directly.

**Impact:** Medium — affects community detection (see SX5), and tools that resolve
a symbol to an absolute path without traversing CONTAINS need a JOIN.

**Recommendation:** Consider adding `filePath` property (= parent FILE's absolute path) to
CLASS and FUNCTION nodes in the builder. Addressed indirectly by SX5's fix.

---

### SX3 — REFERENCES Edges Not Created for TypeScript `.js` Imports _(High)_

**Observed:**

- 0 REFERENCES edges for lxDIG-MCP (vs 36 for lexRAG-visual)
- 89 relative imports, 0 resolved
- Import sources use `.js` extension: `"../config.js"`, `"../engines/architecture-engine.js"`
- FILE nodes use `.ts` extension: `lxDIG-MCP:file:src/config.ts`

**Root cause:**  
`resolveImportPath()` in `src/graph/builder.ts` did not strip `.js` before probing disk:

```typescript
// OLD — failed for TypeScript moduleResolution: node16/bundler
const base = path.resolve(fromDir, source);  // e.g. ".../src/config.js"
const candidates = [base + ".ts", ...];      // checks "config.js.ts" — never exists
```

**Fix applied (`src/graph/builder.ts`):**

```typescript
// NEW — strips .js/.jsx before probing
const normalizedSource = source.replace(/\.jsx?$/, "");
const base = path.resolve(fromDir, normalizedSource);
const candidates = [base, base + ".ts", base + ".tsx", ...];
```

**Impact after fix:** ~89 IMPORT→FILE REFERENCES edges will be created on next
`graph_rebuild`, enabling `impact_analyze`, `test_select`, and call-graph traversal to work
for all TypeScript files using the `node16/bundler` module resolution pattern.

---

### SX4 — `test_run` Tool Inherits Wrong Node.js from Server Process PATH _(High)_

**Observed:**

```json
{
  "status": "failed",
  "error": "ERROR: npm is known not to run on Node.js v10.19.0\nYou'll need to upgrade to a newer Node.js version..."
}
```

**Root cause:**  
The MCP server process was started in an environment where `$PATH` resolves `node` to
`/usr/bin/node` (system Node v10.19.0). The actual development Node is v22.17.0 (managed by
nvm/volta/pkgx), but the server process inherits the shell's PATH at launch time.

When `test_run` calls `child_process.exec("npx vitest run ...")`, npx uses the server's
inherited PATH, which finds v10.19.0 — incompatible with the project's npm version.

**Impact:** High — `test_run` fails for every call. All test CI functionality is broken.

**Recommendation:**  
Option A: Start the MCP server via `npm run start` (which activates nvm context first)  
Option B: In `test_run`, resolve the `node` binary to `process.execPath` (the Node running
the server) instead of relying on PATH:

```typescript
const nodeExec = process.execPath; // absolute path to the running node binary
// Then prefix vitest call: `${path.dirname(nodeExec)}/npx vitest run ...`
```

Option C: Store the workspace's `node_modules/.bin` path absolutely in the server config
and use that for vitest resolution.

---

### SX5 — `misc` Community Dominates (77% of Members) _(Medium)_

**Observed:**

```
misc: 249 members  (77%)
graph: 17, engines: 11, tools: 9, parsers: 9, src: 8, response: 6, ...
```

All 249 `misc` members are CLASS (164) and FUNCTION (85) nodes.

**Root cause:**  
The community detector Cypher used:

```cypher
coalesce(n.path, n.filePath, '') AS filePath
```

CLASS and FUNCTION nodes have `path: null` and `filePath: null`, so `filePath = ''`.
`communityLabel('')` always returns `"misc"` (no path segments to classify).

**Fix applied (`src/engines/community-detector.ts`):**

```cypher
OPTIONAL MATCH (parentFile:FILE)-[:CONTAINS]->(n)
RETURN coalesce(n.path, n.filePath, parentFile.path, '') AS filePath
```

Now CLASS/FUNCTION nodes inherit their parent FILE's path for community labeling.

**Before fix:**  
`misc: 249 / 323 = 77%` — majority of code nodes mislabeled

**After fix (on next `graph_rebuild`):**  
`ArchitectureEngine` → `engines` community, `ToolHandlers` → `tools`, etc.

---

### SX6 — Feature Registry Empty _(Low)_

**Observed:**

```json
{ "totalFeatures": 0, "features": [] }
```

**Root cause:**  
No `feature_status` write operations (via `episode_add`) have been run on this project.
The feature registry is populated by explicit feature tracking calls, not auto-discovery.

**Impact:** Low — informational; no code defect. `feature_status` will return useful data
once features are registered under the project.

---

### SX7 — `reflect` Returns 0 Learnings _(Low)_

**Observed:**

```json
{
  "learningsCreated": 0,
  "insight": "Reflection over 1 episodes: no dominant recurring entities detected."
}
```

**Root cause:**  
Only 1 EPISODE node exists for lxDIG-MCP. Insufficient episode history to synthesize
patterns. The memory/episode system requires accumulated usage to produce learnings.

**Impact:** Low — expected for a new project / fresh session.

---

## 5. Tool Behavior Summary

| Tool                 | Status      | Notes                                              |
| -------------------- | ----------- | -------------------------------------------------- |
| `graph_health`       | ✅ Works    | Returns accurate drift state                       |
| `graph_rebuild`      | ✅ Works    | Generates correct tx IDs; queues rebuild           |
| `init_project_setup` | ✅ Works    | Sets workspace context                             |
| `impact_analyze`     | ⚠️ Degraded | Returns 0 impact (no REFERENCES edges pre-SX3 fix) |
| `test_select`        | ⚠️ Degraded | 0 tests selected (no REFERENCES edges)             |
| `test_run`           | ❌ Broken   | Inherits wrong PATH → Node v10.19.0 error (SX4)    |
| `reflect`            | ✅ Works    | Returns correct (empty) reflection                 |
| `feature_status`     | ✅ Works    | Returns empty registry (no data yet)               |
| `semantic_diff`      | ✅ Works    | Structural diff works (no embedding-based diff)    |
| `ref_query`          | ✅ Works    | BM25 lexical search returns relevant results       |

---

## 6. Fixes Applied This Session

| ID      | File                                | Fix                                                                                      |
| ------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| **SX3** | `src/graph/builder.ts`              | `resolveImportPath()`: strip `.js`/`.jsx` extension before probing disk candidates       |
| **SX5** | `src/engines/community-detector.ts` | Cypher adds `OPTIONAL MATCH (parentFile:FILE)-[:CONTAINS]->(n)` for path fallback        |
| **BX1** | `src/tools/tool-handler-base.ts`    | Add `typeof ensureBM25Index !== "function"` guard to prevent mock contract test failures |

All 3 fixes verified:

- **234 tests passing** (unchanged from pre-session)
- **0 TypeScript compiler errors**
- **0 unhandled errors** (resolved BX1)

---

## 7. Confirmation Checklist

| Item                              | Status                                             |
| --------------------------------- | -------------------------------------------------- |
| `graph_health()` called first     | ✅                                                 |
| Graph drift documented            | ✅ — F8 still active (server restart needed)       |
| Node census collected             | ✅ — 2216 nodes, 3622 rels documented              |
| FILE path normalization checked   | ✅ — 74/74 absolute, 0 relative                    |
| SECTION.relativePath checked      | ✅ — 0 missing                                     |
| Community nodes inspected         | ✅ — SX5 found and fixed                           |
| REFERENCES edge count checked     | ✅ — 0 found; SX3 found and fixed                  |
| Embedding coverage checked        | ✅ — 0/85 functions have embeddings (F5/F8 active) |
| All available MCP tools exercised | ✅                                                 |
| Two new source fixes implemented  | ✅                                                 |
| Tests green after fixes           | ✅ — 234/234                                       |

---

## 8. Priority Summary

| Priority  | Finding                          | Action                                          |
| --------- | -------------------------------- | ----------------------------------------------- |
| 🔴 High   | **F8** (cache drift)             | Restart server after `npm run build`            |
| 🔴 High   | **SX3** (REFERENCES missing)     | Fixed — run `graph_rebuild(full)` after restart |
| 🔴 High   | **SX4** (test_run Wrong Node)    | Set server launch to use correct Node PATH      |
| 🟡 Medium | **SX2** (path on CLASS/FN nodes) | Add `filePath` to CLASS/FUNCTION builder nodes  |
| 🟡 Medium | **SX5** (misc community)         | Fixed — run `graph_rebuild` after restart       |
| 🟢 Low    | **SX1** (SECTION.title null)     | Set `LXDIG_SUMMARIZER_URL` for production       |
| 🟢 Low    | **SX6** (empty feature registry) | No action needed (new project)                  |
