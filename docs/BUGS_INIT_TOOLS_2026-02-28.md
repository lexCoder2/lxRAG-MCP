# Init Tools — Bug Report

**Date:** 2026-02-28
**Scope:** `tools_list`, `init_project_setup`, `setup_copilot_instructions`, `graph_set_workspace`, `graph_health`, `graph_query`, `graph_rebuild`
**Skill reference:** `.github/skills/lxdig-init.SKILL.md`

---

## Skill Workflow (as specified)

```
tools_list → init_project_setup → setup_copilot_instructions → graph_health → graph_query
```

---

## Summary Table

| # | Tool | Severity | Description |
|---|------|----------|-------------|
| 1 | `tools_list` | **High** | `setup` category entirely missing from `KNOWN_CATEGORIES` |
| 2 | `tools_list` | Low | `tools_list` itself miscategorized as `graph` |
| 3 | `init_project_setup` | **High** | Failures wrapped in `formatSuccess` — `ok` always `true` on abort |
| 4 | `init_project_setup` | **High** | `setup_copilot_instructions` result never checked for error |
| 5 | `init_project_setup` | Medium | Rebuild failure doesn't abort init (inconsistent with workspace failure) |
| 6 | `setup_copilot_instructions` | Low | `overwritten` flag evaluated after write — always wrong |
| 7 | `setup_copilot_instructions` | **High** | Generated template uses Cypher without `language: "cypher"` |
| 8 | `setup_copilot_instructions` | Medium | `targetPath` not validated as a directory |
| 9 | `graph_set_workspace` | Medium | `src`-only fallback; contradicts multi-candidate list used in `setup_copilot_instructions` |
| 10 | `graph_set_workspace` | Low | `formatSuccess` called without `toolName` argument |
| 11 | `graph_health` | **High** | Embedding count is cross-project (ERR-A) |
| 12 | `graph_health` | Medium | Embedding recommendation suppressed for fresh projects |
| 13 | `graph_query` | Medium | `profile` missing from `inputShape` — undiscoverable to MCP clients |
| 14 | `graph_query` | **High** | `hybridRetriever!` non-null assertion throws when engine is absent |
| 15 | `graph_rebuild` | Medium | `GRAPH_TX` node created before workspace existence check — dangling nodes |

---

## Detailed Findings

---

### Bug 1 — `tools_list`: setup category entirely missing from `KNOWN_CATEGORIES`

**File:** `src/tools/handlers/core-utility-tools.ts:27-58`
**Severity:** High

`init_project_setup` and `setup_copilot_instructions` are not listed in any category inside
`KNOWN_CATEGORIES`. They will never appear as `available` even when fully registered and working.
The `"setup"` category is entirely absent from the map.

```ts
// KNOWN_CATEGORIES covers: graph, architecture, semantic, docs, test, memory, progress, coordination
// "setup" is missing — init_project_setup and setup_copilot_instructions invisible to tools_list
```

**Fix:** Add a `setup` key to `KNOWN_CATEGORIES`:

```ts
setup: ["init_project_setup", "setup_copilot_instructions"],
```

---

### Bug 2 — `tools_list`: tool miscategorized as `graph`

**File:** `src/tools/handlers/core-utility-tools.ts:30`
**Severity:** Low

`tools_list` is listed under `graph` in `KNOWN_CATEGORIES`, but its `ToolDefinition` declares
`category: "utility"` and it lives in `coreUtilityToolDefinitions`.

**Fix:** Move `tools_list` from the `graph` entry to a `utility` entry. `ref_query` should also be
verified — it is currently in `graph` but is defined with category `"ref"`.

---

### Bug 3 — `init_project_setup`: aborts wrapped in `formatSuccess`

**File:** `src/tools/handlers/core-setup-tools.ts:86-91`, `105-110`
**Severity:** High

When `graph_set_workspace` fails, the function returns `ctx.formatSuccess(...)` with
`abortedAt: "graph_set_workspace"` instead of `ctx.errorEnvelope(...)`. The outer envelope always
has `ok: true`, so callers cannot detect that initialization failed via standard envelope inspection.

```ts
// current — always ok: true
return ctx.formatSuccess(
  { steps, abortedAt: "graph_set_workspace" },
  profile,
  "Initialization aborted at workspace setup",
  "init_project_setup",
);

// should be
return ctx.errorEnvelope(
  "INIT_WORKSPACE_SETUP_FAILED",
  `Workspace setup failed: ${setJson.error?.reason ?? setJson.error}`,
  false,
);
```

---

### Bug 4 — `init_project_setup`: `setup_copilot_instructions` result never checked

**File:** `src/tools/handlers/core-setup-tools.ts:148-163`
**Severity:** High

`ctx.callTool(...)` never throws — it always returns a JSON string. The surrounding `try/catch`
therefore never catches anything for this call. If `setup_copilot_instructions` returns an error
envelope (`ok: false`), the step is still recorded as `status: "created"`.

```ts
// callTool does not throw — catch block is dead code here
try {
  await ctx.callTool("setup_copilot_instructions", { ... });
  steps.push({ step: "setup_copilot_instructions", status: "created" }); // always runs
} catch (err) {
  steps.push({ step: "setup_copilot_instructions", status: "skipped" }); // unreachable
}
```

**Fix:** Parse and check the returned JSON:

```ts
const ciResult = await ctx.callTool("setup_copilot_instructions", { ... });
const ciJson = JSON.parse(ciResult);
steps.push({
  step: "setup_copilot_instructions",
  status: ciJson?.error ? "failed" : "created",
  detail: ciJson?.error?.reason ?? ".github/copilot-instructions.md",
});
```

---

### Bug 5 — `init_project_setup`: rebuild failure does not abort init

**File:** `src/tools/handlers/core-setup-tools.ts:122-144`
**Severity:** Medium

When `graph_set_workspace` fails there is an explicit `return` that aborts. When `graph_rebuild`
fails (lines 126-130), the failure is recorded in `steps` but the init flow continues to write
copilot instructions and returns `ok: true`. This is inconsistent and results in copilot
instructions being written over a broken or empty graph.

**Fix:** Return early (or `errorEnvelope`) when `graph_rebuild` fails, consistent with the
workspace setup failure path.

---

### Bug 6 — `setup_copilot_instructions`: `overwritten` flag always wrong

**File:** `src/tools/handlers/core-setup-tools.ts:531-532`
**Severity:** Low

`overwritten` is evaluated *after* `fs.writeFileSync` has already run, so `fs.existsSync(destFile)`
is always `true`. The flag cannot distinguish "replaced existing file" from "newly created with
`overwrite=true`".

```ts
fs.writeFileSync(destFile, content, "utf-8");   // ← file written here

return ctx.formatSuccess({
  overwritten: overwrite && fs.existsSync(destFile), // always true when overwrite=true
```

**Fix:** Capture the pre-write existence check before writing:

```ts
const alreadyExisted = fs.existsSync(destFile);
fs.writeFileSync(destFile, content, "utf-8");
return ctx.formatSuccess({ overwritten: overwrite && alreadyExisted, ... });
```

---

### Bug 7 — `setup_copilot_instructions`: generated template uses Cypher without `language: "cypher"`

**File:** `src/tools/handlers/core-setup-tools.ts:387-391`
**Severity:** High

The generated copilot instructions include this example for non-MCP projects:

```
3. Explore with `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) DESC LIMIT 10" })`
```

`graph_query` defaults to `language: "natural"`. Passing a raw Cypher string in natural language
mode sends it to the hybrid retriever (BM25 + vector), not Memgraph. The query is never executed
as Cypher, and results will be nonsensical or empty.

The same issue appears in the MCP server session flow block (line 379):
```
`graph_rebuild({ "projectId": "proj", "mode": "full" })  // → { txId }`
`diff_since({ "since": "<txId | ISO-8601>" })            // NOT git refs like HEAD~3`
```
These are fine (not Cypher), but the `graph_query` Cypher examples throughout the template
(lines 379, 391, 469, 470) must all specify `language: "cypher"`.

**Fix:** Add `"language": "cypher"` to all Cypher examples in the template strings.

---

### Bug 8 — `setup_copilot_instructions`: `targetPath` not validated as a directory

**File:** `src/tools/handlers/core-setup-tools.ts:244-251`
**Severity:** Medium

`fs.existsSync(resolvedTarget)` returns `true` for files as well as directories. A caller passing a
file path would cause `path.join(resolvedTarget, ".github", "copilot-instructions.md")` to resolve
to an unexpected location.

**Fix:**

```ts
if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
  return ctx.errorEnvelope("COPILOT_INSTR_TARGET_NOT_FOUND", ...);
}
```

---

### Bug 9 — `graph_set_workspace`: `src`-only fallback contradicts `setup_copilot_instructions`

**File:** `src/tools/session-manager.ts:90`
**Severity:** Medium

`resolveProjectContext` computes `sourceDir` as:

```ts
const sourceInput = overrides.sourceDir || path.join(workspaceRoot, "src");
```

Only `src` is tried. But `setup_copilot_instructions` scans `["src", "lib", "app", "packages", "source"]`
to determine `srcDir` for the instructions file. Projects using `lib`, `app`, etc. get the right
content in their copilot instructions, but `graph_set_workspace` then fails with
`SOURCE_DIR_NOT_FOUND` unless `sourceDir` is explicitly passed.

The two tools use different detection logic and need to be aligned.

---

### Bug 10 — `graph_set_workspace`: `formatSuccess` called without `toolName`

**File:** `src/tools/handlers/core-graph-tools.ts:614-626`
**Severity:** Low

```ts
return ctx.formatSuccess(
  { success: true, projectContext: ..., ... },
  profile,
  // ← no summary string
  // ← no toolName
);
```

All peer tools (`graph_rebuild`, `graph_health`, `graph_query`) pass `summary` and `toolName` as
the 3rd and 4th arguments to `formatSuccess`. Without `toolName`, compact-mode responses omit tool
attribution in the envelope.

---

### Bug 11 — `graph_health`: embedding count is cross-project

**File:** `src/tools/handlers/core-graph-tools.ts:698-704`
**Severity:** High
**Tracking:** ERR-A (known from audit)

`getCollection("functions").pointCount` returns the total point count across **all projects** in
the collection. With multiple initialized projects, `graph_health` for any single project reports
the combined embedding count of all projects.

```ts
const [fnColl, clsColl, fileColl] = await Promise.all([
  ctx.engines.qdrant.getCollection("functions"), // total — not filtered by projectId
  ctx.engines.qdrant.getCollection("classes"),
  ctx.engines.qdrant.getCollection("files"),
]);
embeddingCount = (fnColl?.pointCount ?? 0) + (clsColl?.pointCount ?? 0) + (fileColl?.pointCount ?? 0);
```

**Fix:** Use `countByFilter(collection, projectId)` (or equivalent scroll+count) to count only
points whose `payload.projectId` matches the active project.

---

### Bug 12 — `graph_health`: embedding recommendation suppressed for fresh projects

**File:** `src/tools/handlers/core-graph-tools.ts:748-751`
**Severity:** Medium

```ts
if (embeddingDrift && ctx.isProjectEmbeddingsReady(projectId)) {
  recommendations.push("Some entities don't have embeddings...");
}
```

For a fresh project, `isProjectEmbeddingsReady` is `false` and `embeddingCount` is 0. Both
`embeddingDrift` and the guard condition evaluate such that **no recommendation is pushed**, even
though the project has zero embeddings and semantic search will silently fail.

The inline `embeddings.recommendation` string (lines 786-791) does handle this case, but the
top-level `recommendations[]` array does not. Agents that check only `recommendations` get no
guidance.

**Fix:** Decouple the recommendations push from `isProjectEmbeddingsReady`:

```ts
if (embeddingCount === 0 && memgraphFuncCount + memgraphClassCount + memgraphFileCount > 0) {
  recommendations.push("No embeddings — run graph_rebuild (full mode) to enable semantic search");
} else if (embeddingDrift) {
  recommendations.push("Embeddings incomplete — run graph_rebuild to regenerate");
}
```

---

### Bug 13 — `graph_query`: `profile` missing from `inputShape`

**File:** `src/tools/handlers/core-graph-tools.ts:111-124`
**Severity:** Medium

`graph_query` is the only graph tool that does not declare `profile` in `inputShape`. The MCP
client generates argument schemas from `inputShape`, so callers have no way to discover or pass
`profile` to control response verbosity. The implementation reads `profile` at line 133 — it works
at runtime if passed, but it is invisible to clients.

**Fix:** Add to `inputShape`:

```ts
profile: z.enum(["compact", "balanced", "debug"]).default("compact").describe("Response profile"),
```

---

### Bug 14 — `graph_query`: `hybridRetriever!` throws when engine is absent

**File:** `src/tools/handlers/core-graph-tools.ts:171`, `192`
**Severity:** High

```ts
const localResults = await hybridRetriever!.retrieve({ ... });
```

`hybridRetriever` is typed as `| undefined`. The `!` non-null assertion bypasses null-safety. If
Memgraph is unavailable at startup, the engine may be `undefined` and the call throws
`TypeError: Cannot read properties of undefined (reading 'retrieve')`, producing a 500 instead of
a clean error envelope.

**Fix:**

```ts
if (!hybridRetriever) {
  return ctx.errorEnvelope("HYBRID_RETRIEVER_UNAVAILABLE", "Hybrid retriever not initialized", true);
}
```

---

### Bug 15 — `graph_rebuild`: `GRAPH_TX` node created before workspace existence check

**File:** `src/tools/handlers/core-graph-tools.ts:344-374`
**Severity:** Medium

```ts
// line 344: TX written to Memgraph
await ctx.context.memgraph.executeCypher(`CREATE (tx:GRAPH_TX {...})`, ...);

// line 358: workspace validated *after*
if (!fs.existsSync(workspaceRoot)) {
  return ctx.errorEnvelope("WORKSPACE_NOT_FOUND", ...);
}
```

When the workspace path doesn't exist, the function returns an error but leaves a dangling
`GRAPH_TX` node in Memgraph. These phantom transactions inflate `graph_health.rebuild.txCount` and
can confuse `diff_since` anchoring.

**Fix:** Move the `fs.existsSync(workspaceRoot)` and `fs.existsSync(sourceDir)` checks to
*before* the `CREATE (tx:GRAPH_TX ...)` statement.

---

## Files Referenced

| File | Bugs |
|------|------|
| `src/tools/handlers/core-utility-tools.ts` | 1, 2 |
| `src/tools/handlers/core-setup-tools.ts` | 3, 4, 5, 6, 7, 8 |
| `src/tools/session-manager.ts` | 9 |
| `src/tools/handlers/core-graph-tools.ts` | 10, 11, 12, 13, 14, 15 |
