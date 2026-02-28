# Copilot Instructions for lxDIG-MCP

Dynamic Intelligence Graph (DIG) MCP server for code graph intelligence, agent memory, and multi-agent coordination — beyond RAG and GraphRAG — for VS Code Copilot, Claude Code, Claude Desktop, and Cursor.

## Primary Goal

Understand the codebase before reading files. Use graph-backed tools first for code intelligence, fall back to file reads only when needed.

## Runtime Truths

- **Stack**: TypeScript, Docker
- **Source root**: `src/`
- **Key directories**: `src/cli`, `src/engines`, `src/graph`, `src/parsers`, `src/response`, `src/tools`, `src/types`, `src/utils`, `src/vector`
- **Transport**: stdio (default) or HTTP (`MCP_TRANSPORT=http MCP_PORT=9000`)
- **Databases**: Memgraph (port 7687), Qdrant (port 6333) — both must be running

## Available Commands

- `build`: `tsc`
- `dev`: `tsc --watch`
- `start`: `node dist/server.js`
- `start:http`: `node scripts/start-http-supervisor.mjs`
- `start:http:raw`: `MCP_TRANSPORT=http MCP_PORT=9000 node dist/server.js`
- `test`: `vitest run`
- `test:watch`: `vitest watch`
- `test:coverage`: `vitest run --coverage`
- `lint`: `eslint src --ext .ts`
- `benchmark:check-regression`: `python3 scripts/check_benchmark_regression.py`

## Required Session Flow

**One-shot (recommended):**
```
init_project_setup({ projectId: "my-proj", workspaceRoot: "/abs/path" })
```
This sets workspace context, triggers a full graph rebuild, and writes copilot instructions in one call.

**Manual (step-by-step):**
1. `graph_set_workspace({ projectId, workspaceRoot })` — anchor the session
2. `graph_rebuild({ projectId, mode: "full", workspaceRoot })` — index source; **capture `txId` from the response**
3. `graph_health({ profile: "balanced" })` — verify nodes > 0
4. `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 8", projectId })` — confirm data

**HTTP transport extra steps:**
- Capture `mcp-session-id` header from `initialize` response
- Include it on every subsequent request

## Tool Decision Guide

| Goal | First choice | Fallback |
|---|---|---|
| Count/list nodes | `graph_query` (Cypher) | `graph_health` |
| Understand a symbol | `code_explain` (symbol name) | `semantic_slice` |
| Find related code | `find_similar_code` | `semantic_search` |
| Check arch violations | `arch_validate` | `blocking_issues` |
| Place new code | `arch_suggest` | — |
| Docs lookup | `search_docs` → `index_docs` if empty | file read |
| Tests after change | `test_select` → `test_run` | `suggest_tests` |
| Track decisions | `episode_add` (DECISION) | — |
| Release agent lock | `agent_release` with `claimId` | — |

## Correct Tool Signatures (tested & verified)

### graph
```jsonc
graph_set_workspace({ "projectId": "proj", "workspaceRoot": "/abs/path" })
graph_rebuild({ "projectId": "proj", "mode": "full", "workspaceRoot": "/abs/path" })
// ↳ response contains { txId: "tx-..." } — save it for diff_since
graph_health({ "profile": "balanced" })
graph_query({ "query": "MATCH (f:FILE) RETURN f.relativePath LIMIT 10", "projectId": "proj" })
diff_since({ "since": "<txId-from-rebuild | ISO-8601>", "projectId": "proj" })
ref_query({ "query": "natural language or symbol", "repoPath": "/abs/path", "limit": 5 })
tools_list({})
```

### semantic / code intelligence
```jsonc
semantic_search({ "query": "text description", "projectId": "proj", "limit": 5 })
// ↳ requires graph_rebuild to have run first; returns error otherwise

find_pattern({ "pattern": "handler registry pattern", "projectId": "proj", "limit": 5 })
find_similar_code({ "elementId": "proj:file.ts:FunctionName:12", "projectId": "proj", "limit": 5 })
// ↳ elementId format: "projectId:filename:symbolName:line"

code_explain({ "element": "SymbolName", "depth": 2, "projectId": "proj" })
// ↳ "element" accepts symbol name or relative file path — NOT a qualified ID

semantic_diff({ "elementId1": "proj:a.ts:fn:10", "elementId2": "proj:b.ts:fn:20", "projectId": "proj" })
// ↳ fields: elementId1 / elementId2  (NOT elementA / elementB)

semantic_slice({ "symbol": "MyClass", "context": "body", "projectId": "proj" })
// ↳ accepts symbol | query | file  (NOT entryPoint)
```

### clustering & architecture
```jsonc
code_clusters({ "type": "file", "count": 10, "projectId": "proj" })
// ↳ "type" enum: "function" | "class" | "file"  (NOT granularity)

arch_validate({ "projectId": "proj", "files": ["src/engines/my-engine.ts"] })
arch_suggest({ "name": "MyNewEngine", "codeType": "engine", "dependencies": ["utils", "types"], "projectId": "proj" })
// ↳ "name" field  (NOT codeName)

blocking_issues({ "projectId": "proj" })
```

### docs
```jsonc
index_docs({ "projectId": "proj", "paths": ["/abs/README.md", "/abs/docs/GUIDE.md"] })
// ↳ call this before search_docs if search returns 0 results

search_docs({ "query": "architecture layers", "limit": 5, "projectId": "proj" })
search_docs({ "symbol": "HandlerBridge", "limit": 3, "projectId": "proj" })
// ↳ can search by free-text query OR by code symbol name
```

### impact & tests
```jsonc
impact_analyze({ "changedFiles": ["src/engines/x.ts", "src/config.ts"], "projectId": "proj" })
contract_validate({ "tool": "graph_rebuild", "arguments": { "projectId": "proj", "mode": "full" } })

test_categorize({ "projectId": "proj" })
test_select({ "changedFiles": ["src/engines/x.ts"], "projectId": "proj" })
suggest_tests({ "elementId": "proj:file.ts:symbolName:line", "limit": 5 })
// ↳ requires a FULLY QUALIFIED element ID (projectId:file:symbol:line)

test_run({ "testFiles": ["src/utils/__tests__/validation.test.ts"], "parallel": false })
```

### progress & features
```jsonc
feature_status({ "featureId": "list" })        // list all feature IDs
feature_status({ "featureId": "phase-1" })     // detail for one feature
progress_query({ "query": "completed features", "projectId": "proj" })
// ↳ "query" is REQUIRED (NOT "status")

task_update({ "taskId": "my-task", "status": "completed", "note": "done", "projectId": "proj" })
```

### memory (episodes)
```jsonc
episode_add({
  "type": "DECISION",                          // "DECISION" | "LEARNING" | "OBSERVATION" (uppercase)
  "content": "Adopted X because Y",
  "entities": ["SymbolA", "SymbolB"],
  "outcome": "success",                        // "success" | "failure" | "partial"
  "metadata": { "rationale": "..." }           // DECISION REQUIRES metadata.rationale
})
episode_add({
  "type": "LEARNING",
  "content": "Observed that X leads to Y",
  "outcome": "success"
  // LEARNING does not require metadata.rationale
})
episode_recall({ "query": "language agnostic", "limit": 5 })
decision_query({ "query": "architecture decisions", "limit": 5 })
// ↳ "query" field  (NOT "topic")

reflect({ "limit": 10, "profile": "balanced" })
```

### coordination
```jsonc
agent_claim({
  "agentId": "agent-01",
  "targetId": "src/engines/my-engine.ts",      // file path or element — field is "targetId" (NOT "target")
  "intent": "Refactoring engine for multi-lang",
  "taskId": "refactor-task",
  "sessionId": "session-001"
})
// ↳ response contains { claimId: "claim-xxx..." } — save it for agent_release

agent_status({ "agentId": "agent-01" })
coordination_overview({ "projectId": "proj" })

context_pack({
  "task": "Implement multi-tenant support",    // REQUIRED free-text task description
  "taskId": "my-task-id",
  "agentId": "agent-01",
  "includeLearnings": true
})

agent_release({
  "claimId": "claim-xxx...",                   // captured from agent_claim response (NOT agentId/taskId)
  "outcome": "Refactor complete"
})
```

### setup
```jsonc
init_project_setup({ "projectId": "proj", "workspaceRoot": "/abs/path" })
setup_copilot_instructions({ "targetPath": "/abs/path", "projectName": "MyProj", "overwrite": true })
```

## Common Pitfalls

| Wrong | Correct |
|---|---|
| `code_explain({ elementId: "proj:f.ts:fn:10" })` | `code_explain({ element: "SymbolName" })` |
| `semantic_diff({ elementA: ..., elementB: ... })` | `semantic_diff({ elementId1: ..., elementId2: ... })` |
| `semantic_slice({ entryPoint: "X" })` | `semantic_slice({ symbol: "X" })` |
| `code_clusters({ granularity: "module" })` | `code_clusters({ type: "file" })` |
| `arch_suggest({ codeName: "X" })` | `arch_suggest({ name: "X" })` |
| `episode_add({ type: "decision" })` | `episode_add({ type: "DECISION" })` (uppercase) |
| `episode_add` DECISION without `metadata.rationale` | always include `metadata: { rationale: "..." }` |
| `decision_query({ topic: "X" })` | `decision_query({ query: "X" })` |
| `progress_query({ status: "active" })` | `progress_query({ query: "active tasks" })` |
| `agent_claim({ target: "file.ts" })` | `agent_claim({ targetId: "file.ts" })` |
| `agent_release({ agentId, taskId })` | `agent_release({ claimId: "claim-xxx" })` |
| `context_pack({})` without `task` | `context_pack({ task: "Description..." })` |
| `diff_since({ since: "HEAD~3" })` | `diff_since({ since: txId })` from rebuild response |
| `suggest_tests({ elementId: "symbolName" })` | `suggest_tests({ elementId: "proj:file.ts:symbol:line" })` |

## Copilot Skills — Usage Patterns

### Skill: Explore unfamiliar codebase
```
1. init_project_setup({ projectId, workspaceRoot })          — init + rebuild
2. graph_query("MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 10")
3. code_explain({ element: "MainClass" })                    — key entry point
4. find_similar_code({ elementId: "proj:server.ts:fn:10" })  — discover siblings
```

### Skill: Safe refactor + test impact
```
1. impact_analyze({ changedFiles: ["src/x.ts"] })
2. test_select({ changedFiles: ["src/x.ts"] })
3. arch_validate({ files: ["src/x.ts"] })
4. test_run({ testFiles: [...from test_select result...] })
5. episode_add({ type: "DECISION", content: "...", metadata: { rationale: "..." } })
```

### Skill: Find where to add new code
```
1. arch_suggest({ name: "NewFeature", codeType: "engine", dependencies: ["utils"] })
2. blocking_issues({})                                        — check blockers first
3. semantic_search({ query: "similar existing pattern" })
```

### Skill: Multi-agent safe edit
```
1. agent_claim({ agentId, targetId: "src/file.ts", intent: "..." })  → save claimId
2. … make changes …
3. agent_release({ claimId, outcome: "done" })
```

### Skill: Track architectural decisions
```
episode_add({
  type: "DECISION",
  content: "Chose X over Y because Z",
  entities: ["AffectedClass"],
  outcome: "success",
  metadata: { rationale: "Z is faster and simpler" }
})
```

### Skill: Docs workflow (cold start)
```
1. search_docs({ query: "topic" })         — if count=0:
2. index_docs({ paths: ["/abs/README.md", "/abs/docs/..."] })
3. search_docs({ query: "topic" })         — now returns results
```

## Source of Truth

`README.md`, `QUICK_START.md`, `ARCHITECTURE.md`, `docs/TOOL_PATTERNS.md`.
