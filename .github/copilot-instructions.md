# lxDIG-MCP — Copilot Instructions

TypeScript ESM MCP server providing graph intelligence and agent memory for codebases.

## Stack & Build

- **Language:** TypeScript ESM (`moduleResolution: "bundler"`, `module: "ESNext"`)
- **Runtime:** Node.js v22.17.0
- **Build:** `npm run build` → `tsc && bash scripts/fix-esm-imports.sh`
- **Test:** `npx vitest run` (506 tests across 29 files)
- **Type-check:** `npx tsc --noEmit` (run after every code change)
- **Databases:** Memgraph (bolt://localhost:7687), Qdrant (http://localhost:6333)

## Source Structure

```
src/
  graph/          ← builder.ts, orchestrator.ts, client.ts, index.ts
  engines/        ← architecture, community, coordination, docs, progress, test
  parsers/        ← typescript, python, go, rust, java, docs
  tools/          ← 39 MCP tool handlers across 11 handler files
  vector/         ← embedding-engine.ts, qdrant-client.ts
  types/          ← shared type definitions
  utils/          ← validation, logger, helpers
  response/       ← response formatting
  config.ts, env.ts, server.ts
```

## Two-Phase Builder Pattern

The builder produces `BuildResult { nodes, edges }` — two separate arrays. The orchestrator runs all node MERGEs first, then all edge MATCHes. This avoids "node not found" errors on edge creation.

```typescript
// ✅ Correct — classify every statement
const result: BuildResult = { nodes: [], edges: [] };
result.nodes.push({ query: "MERGE (f:FILE {id: $id})", params: { id } });
result.edges.push({ query: "MATCH (f:FILE {id: $fid}) MATCH (fn:FUNCTION {id: $fnid}) MERGE (f)-[:CONTAINS]->(fn)", params: { fid, fnid } });

// ❌ Wrong — flat array loses the node/edge distinction
const stmts: CypherStatement[] = [];
stmts.push(...);
```

## Cypher Safety

Always use `$params` for user-supplied values — never string interpolation. Memgraph does not support prepared statements, so interpolation is an injection risk.

```typescript
// ✅ Correct
{ query: "MERGE (n:Node {id: $id, name: $name})", params: { id, name } }

// ❌ Wrong — injection risk
{ query: `MERGE (n:Node {id: "${id}", name: "${name}"})`, params: {} }
```

## ESM Imports

Do not add `.js` extensions to TypeScript source imports — `scripts/fix-esm-imports.sh` adds them at build time. Adding them manually causes double-extension bugs.

```typescript
// ✅ Correct
import { GraphBuilder } from "../graph/builder";

// ❌ Wrong — build script will produce builder.js.js
import { GraphBuilder } from "../graph/builder.js";
```

Never use `require()` or `__dirname` — this is pure ESM.

## Graph Writes

All writes go through `MemgraphClient.executeBatch()`. Direct session usage bypasses the circuit breaker and chunking logic, which causes failures on large graphs.

- Bulk chunk size: `BULK_CHUNK_SIZE = 1500` statements per transaction
- Circuit breaker threshold: `CIRCUIT_BREAKER_BULK_THRESHOLD = 50` consecutive failures

## Vector / Qdrant

All vector operations go through `EmbeddingEngine` → `QdrantManager`. Collections are static (`"functions"`, `"classes"`, `"files"`, `"document_sections"`). Filter by `payload.projectId` on every search — never return cross-project results.

## projectId Scoping

Every graph node and vector point is scoped to a 4-char base-36 project fingerprint. Use `computeProjectFingerprint(workspaceRoot)` from `src/utils/validation.ts`. Never use user-supplied strings as graph keys.

## Testing Conventions

- Location: `src/<module>/__tests__/<name>.test.ts`
- Framework: vitest (`describe`, `it`, `expect`, `vi.fn()`, `vi.mock()`)

```typescript
// Standard Memgraph mock
const mockClient = {
  isConnected: vi.fn().mockReturnValue(false),
  executeBatch: vi.fn().mockResolvedValue([]),
  executeQuery: vi.fn().mockResolvedValue({ records: [] }),
};

// Always clean up temp dirs
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
```

## Anti-Patterns

- Do not push to a flat `CypherStatement[]` — always classify into `nodes` or `edges`
- Do not use Memgraph sessions directly outside `src/graph/client.ts`
- Do not hardcode connection strings — read from `src/env.ts`
- Do not omit `try/finally` when toggling bulk mode on `MemgraphClient`
- Do not add `.js` to source-level imports
