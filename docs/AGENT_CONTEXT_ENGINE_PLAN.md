# Agent Context Engine — Implementation Plan

> **Vision**: Make `code-graph-server` the external long-term memory and coordination layer for any fleet of LLM agents. Agents stop spending tokens re-reading code, re-arguing about decisions, or losing state between calls. They query the tool, get exactly what they need in the smallest possible package, and execute.

---

## 0. SOTA Research — What Exists and What We Can Learn

This section maps the current research landscape and production systems that have attempted similar problems. Each has important patterns to adopt.

### 0.1 Existing Systems Surveyed

| System | Type | Core Insight | Stars | Our Relevance |
|---|---|---|---|---|
| **GraphRAG** (Microsoft, arXiv:2404.16130) | Graph RAG | LLM-extracted knowledge graphs + Leiden community summaries → global & local query modes | 31k | Community detection on code graph; global/local retrieval modes |
| **LightRAG** (HKUDS, arXiv:2410.05779, EMNLP'25) | Graph+Vector RAG | Dual-level retrieval (specific entities + abstract concepts) + incremental graph updates | 28k | Dual-level retrieval; already uses Memgraph; incremental design |
| **HippoRAG 2** (OSU, NeurIPS'24) | Neurobiological RAG | LLM + KG + Personalized PageRank → 20% better multi-hop QA, 10-30x cheaper than iterative retrieval | 3.2k | **Use PPR for context_pack retrieval** — best fit for code graph traversal |
| **Graphiti / Zep** (arXiv:2501.13956) | Temporal KG for agents | Bi-temporal model (event time ≠ ingestion time) + hybrid search (semantic+BM25+graph) + MCP server | 23k | **Closest design to our goal**; bi-temporal model replaces snapshots; episode-based memory |
| **Mem0** (YC S24) | Memory layer | Multi-level memory (User/Session/Agent) + self-improving extraction → 26% accuracy, 91% faster, 90% fewer tokens | 47.7k | Adaptive memory extraction from agent interactions; self-improvement loop |
| **MemGPT/Letta** (arXiv:2310.08560) | OS-inspired memory | Hierarchical memory tiers (in-context = RAM, external = disk) + interrupt-driven paging | 21.2k | Virtual context packing; "page in" only what the agent needs |
| **Generative Agents** (Stanford, arXiv:2304.03442) | Agent architecture | Observation → Reflection → Planning loop; synthesize low-level events into high-level insights | - | Reflection/synthesis layer: periodic consolidation of agent patterns into INSIGHT nodes |
| **Cognee** | Knowledge engine | Graph + vector + self-improvement pipeline (`cognify` + `memify`) | 12.5k | Pipeline metaphor for ingestion; `memify` analogue for code |

### 0.2 Key Architectural Patterns to Adopt

#### Pattern 1: Bi-Temporal Model (from Graphiti)
Every graph node and edge should carry two time dimensions:
- **Valid time** (`validFrom` / `validTo`): when this code state was actually true
- **Transaction time** (`createdAt`): when we learned/ingested this fact

This makes the snapshot approach (Phase 6) obsolete. Instead of creating point-in-time snapshots, every graph write is automatically time-stamped. Queries like "what was the codebase like at T?" become a simple time filter.

```cypher
// Find all functions as they existed at commit time T
MATCH (f:FUNCTION {projectId: $pid})
WHERE f.validFrom <= $T AND (f.validTo IS NULL OR f.validTo > $T)
RETURN f
```

#### Pattern 2: Personalized PageRank for Context Retrieval (from HippoRAG)
HippoRAG's central finding: vector similarity alone is weak for multi-hop retrieval. Running **Personalized PageRank (PPR)** starting from query-matched nodes propagates relevance through the graph — naturally surfacing callers, callees, shared dependencies, and related decisions.

For `context_pack`:
1. Vector search → top-5 seed nodes (files/functions matching the task description)
2. PPR from seeds → ranked subgraph with relevance scores
3. Cut at relevance threshold → minimal but complete context

This replaces the current "get direct deps, list files" approach.

#### Pattern 3: Dual-Level Retrieval (from LightRAG)
Separate retrieval modes for different question types:
- **Local mode**: specific entities — "what does `save()` call?" → graph traversal
- **Global mode**: abstract patterns — "what are the main architectural concerns?" → community summaries

The code graph should maintain **community summaries** (Leiden clustering, recomputed on rebuild) for global mode.

#### Pattern 4: Episode-Based Memory (from Graphiti)
Replace raw `CHECKPOINT` nodes with **episodes** — atomic, immutable records of an agent interaction. An episode is:
```
{
  agentId, sessionId, taskId,
  timestamp,
  type: 'observation' | 'edit' | 'decision' | 'test_result' | 'error',
  content: string,    // what happened, in natural language
  entities: string[], // file/function/class IDs this episode involves
  outcome: 'success' | 'failure' | 'partial'
}
```
Episodes chain temporally. Retrieval uses hybrid search (vector + BM25 + temporal recency). A `recall` query finds the most relevant episodes, not just the latest checkpoint.

#### Pattern 5: Self-Improving Extraction (from Mem0)
When agents mark tasks complete, the server should automatically:
1. Extract key patterns from the episode chain (what edits were made, what decisions were taken)
2. Store these as `LEARNING` nodes linked to the affected code
3. Surface these learnings in future `context_pack` calls for similar tasks

Mem0 accomplishes this with an LLM extraction pass. Ours can be simpler: structural analysis of what changed between episodes.

#### Pattern 6: Relevance-Ranked Context Budget (from Mem0 / MemGPT)
Mem0's 90% token reduction comes from **intelligent selection**, not truncation. MemGPT's OS analogy: the LLM's context window is RAM; only page in what's needed. 

Implement a `ContextBudget`:
```typescript
interface ContextBudget {
  maxTokens: number;          // hard limit
  allocation: {
    coreCode: number;          // 40% — the exact symbols being edited
    dependencies: number;     // 25% — direct callers/callees
    decisions: number;        // 20% — relevant past decisions
    plan: number;             // 10% — current task plan
    episodeHistory: number;   //  5% — recent agent episodes
  };
}
```
Each section is filled by PPR-ranked retrieval until its allocation is consumed, then cut. No arbitrary character truncation.

#### Pattern 7: Contradiction Handling via Temporal Invalidation (from Graphiti)
Graphiti doesn't delete old facts — it sets `validTo` on them. This handles contradictions automatically: if a function signature changes, the old version gets `validTo = now` and the new one gets `validFrom = now`. Queries always see the current view unless they request a historical one.

This pattern replaces both the "snapshot" approach and the TTL-based claim expiry in the original plan.

#### Pattern 8: Structure-Aware Chunking (from DKB / SCIP)
Slice code **only at AST syntactic boundaries** — never split in the middle of a function, class, or block. A chunk is exactly one of: a full function body, a full class definition, a full import block, or a full test suite.

This is the prerequisite for every downstream feature — PPR, Meta-RAG summaries, and semantic_slice all depend on chunks that are semantically complete.

```
Good chunk boundary:  | function foo() { ... full body ... }
Bad chunk boundary:   | function foo() { ... |
                       | ...truncated mid-logic }
```

Applies to: `graph_rebuild` indexing, `semantic_slice` output, BM25 index units, Meta-RAG summarization input.

#### Pattern 9: Meta-RAG Code Summarization (indexing-time LLM summaries)
Inspired by Meta-RAG (arXiv) — deploy an LLM **during the indexing phase** to summarize every AST-extracted function and class into a single natural-language sentence. Achieves ~79.8% token compression in retrieval responses.

Scheme:
1. On `graph_rebuild`, for each FUNCTION and CLASS node, generate: `{name} in {file}: {one-sentence NL summary}`
2. Store summary as `summary` property on the node
3. Embed the summary (not the raw code) for Qdrant vector index
4. BM25 index also runs over summaries + symbol names
5. In compact-profile tool responses, return `node.summary` instead of `node.code`; `code` only in balanced/debug profile

This means querying "what does ToolHandlers do?" returns a 15-token summary, not 800 tokens of raw code.

```typescript
// graph/builder.ts — node property added on index
functionNode.summary = await llm.summarize(
  `${functionNode.name} in ${file}: ${functionNode.code}`,
  { maxTokens: 30 }
);
```

#### Pattern 10: SCIP-Style Human-Readable Node IDs
Inspired by SCIP Code Intelligence Protocol — use **stable, human-readable string identifiers** for all graph nodes instead of UUIDs or integer hashes.

Format: `{relativePath}::{ClassName}::{methodName}` or `{relativePath}::{functionName}`

Examples:
```
src/tools/tool-handlers.ts::ToolHandlers::callTool
src/engines/progress-engine.ts::ProgressEngine::loadFromGraph
src/graph/client.ts::MemgraphClient
```

Benefits:
- **O(changes) incremental indexing**: `MERGE` on stable ID → only changed nodes need updating
- **Cross-reference resolution**: any tool can construct the ID from a file path + symbol name without an ID lookup table
- **Human-readable Cypher**: graph queries are self-documenting
- **Stable across rebuilds**: no UUID churn on every full rebuild

This replaces UUID-based IDs in the builder and becomes the primary identifier for all FUNCTION, CLASS, FILE nodes.

### 0.3 Key Differentiator vs Existing Systems

| Dimension | GraphRAG | LightRAG | Graphiti | **code-graph-server (target)** |
|---|---|---|---|---|
| Domain | General text | General text | Conversation/enterprise data | **Source code** |
| Graph structure | LLM-extracted entities | LLM-extracted entities | Episodic memory + entities | **AST-precise** (functions, classes, imports, call graphs) |
| Retrieval | Community summaries | Dual-level | Hybrid temporal | **Hybrid + PPR + code structure** |
| Agent memory | None | None | Episodes + temporal KG | **Episodes + decisions + claims + code graph** |
| Multi-agent coordination | None | None | None | **Claim system + episode broadcast** |
| Code-specific features | None | None | None | **Architecture validation, test impact, semantic slicing** |
| Temporal model | Basic | Incremental | **Bi-temporal** | **Bi-temporal (adopted from Graphiti)** |
| Node identifiers | Opaque integers | Opaque hashes | UUIDs | **SCIP-style `file::Class::method`** |
| Code summarization | LLM communities | LLM communities | None | **Meta-RAG per function/class (indexing-time)** |
| Agent interop protocol | None | None | None | **A2A Agent Card + MCP via SSE** |

This server fills a gap none of these address: **code-specific, agent-coordinating, bi-temporal, multi-hop-retrievable memory for software development agents**.

### 0.4 Interoperability Protocols

Three emerging open standards complement each other and map directly onto this server's architecture:

#### MCP (Model Context Protocol) — already implemented
JSON-RPC 2.0 client-server architecture. This server exposes all tools via MCP. Two transports:
- **stdio**: zero-latency, secure local execution (default, used by Claude Code / VS Code)
- **SSE / StreamableHTTP**: remote API connections, enables multi-host agent fleets

The server already implements both (`MCP_TRANSPORT=stdio|http`).

#### A2A (Agent2Agent Protocol) — add in Phase 4
Open Google protocol for **peer-to-peer, opaque agent collaboration**. Agents advertise capabilities via a JSON-LD "Agent Card" served at `GET /.well-known/agent.json`. Task delegation is asynchronous via SSE streaming.

For this server, the Agent Card:
- Advertises the 34 MCP tools as A2A capabilities
- Signals that this server is a **memory + coordination** specialist agent
- Allows other A2A-aware orchestrators (LangGraph, AutoGen, etc.) to discover and delegate memory tasks to it automatically

Phase 4 adds: `GET /.well-known/agent.json` endpoint serving a static Agent Card. No full A2A task delegation infrastructure needed — just discovery.

```json
// /.well-known/agent.json (static, Phase 4 addition)
{
  "@context": "https://schema.a2aprotocol.dev/v1",
  "@type": "Agent",
  "name": "code-graph-server",
  "description": "External long-term memory and coordination layer for LLM agent fleets working on software codebases.",
  "capabilities": ["code-graph", "agent-memory", "multi-agent-coordination", "context-packing"],
  "mcpEndpoint": "/mcp",
  "version": "1.0.0"
}
```

#### SAMEP (Secure Agent Memory Exchange Protocol) — Phase 3 consideration
Vector-based semantic search + AES-256-GCM cryptographic access controls for cross-boundary context sharing. Relevant when episode/decision memory from one agent must be shared with another agent that has a different trust scope.

For this server: the `sensitive: true` flag on EPISODE nodes (already planned in Phase 7 Design Rule #7) is the lightweight version. Full SAMEP integration (AES-256-GCM encrypted episode payloads, per-agent decryption keys) is a post-Phase-4 hardening step — noted here so the episode schema does not preclude it.

#### ACP (Agent Communication Protocol) — future consideration
Federated orchestration with decentralized identity verification and semantic intent mapping. Relevant if this server operates in a zero-trust multi-organization environment. Not in scope for current phases but the A2A Agent Card design does not conflict with it.

---

---

## 1. Problem Analysis — Current State

### 1.1 What the server does today

| Layer | What exists |
|---|---|
| Graph (Memgraph) | TypeScript-only AST → nodes (FILE, FUNCTION, CLASS, IMPORT) + edges |
| Vector (Qdrant) | Embedding-backed semantic similarity search |
| 14 MCP Tools | `graph_query`, `code_explain`, `find_pattern`, `arch_validate`, `arch_suggest`, `test_*`, `progress_*`, `graph_rebuild` |
| Progress engine | In-memory features/tasks; wiped on restart |
| Architecture engine | Layer rule validation (TS only) |

### 1.2 Identified Gaps (root causes of poor agent interaction)

#### Gap 1 — Verbosity kills token efficiency
Every tool returns a JSON blob with full data objects. `compact` profile exists but still truncates at 320 chars arbitrarily. An agent asking "what does `ToolHandlers` depend on?" gets hundreds of tokens of noise instead of a 3-line answer.

#### Gap 2 — No persistent agent scratchpad / working memory
There is no way for an agent to write its **current reasoning state**, **decisions made**, or **partial plan** to the server. When the context window fills, everything is lost. A second agent or a resumed session starts from zero.

#### Gap 3 — No agent handoff protocol
When agent A finishes and hands off to agent B, B must be re-briefed by copying messages. The server has no "get me what agent A knew" mechanism. This is the #1 source of inter-agent communication errors.

#### Gap 4 — Progress engine is ephemeral
Features and tasks live in RAM and in raw graph nodes. There is no structured persistence, no change history, no rollback, and no locking. Two agents can simultaneously claim the same task.

#### Gap 5 — No "mission pack" — single-shot context entry point
An agent starting a new task must call 4-8 tools: `graph_rebuild` → `graph_query` (structure) → `code_explain` (deps) → `progress_query` (state) → `blocking_issues`. There is no single tool that says: _"Give me the full briefing for task X"_.

#### Gap 6 — No cross-agent coordination / ownership
Multiple agents can work on the same file or task concurrently with no awareness of each other. No locking, no claiming, no status broadcasting.

#### Gap 7 — Only TypeScript is parsed
Python, Go, Rust, and Java projects cannot use this server at all.

#### Gap 8 — Weak natural-language-to-Cypher translation
The NL query path does regex intent classification then falls back to broad Cypher. Complex questions ("which functions call save() and are also touched by open tasks?") fail silently.

#### Gap 9 — No incremental watch / push model
Graph rebuild is manual and async. Agents must poll `graph_health` to know when it's ready. File changes are not reflected until the next explicit rebuild.

#### Gap 10 — No code snapshot / audit trail
There is no way to say "what did the codebase look like when we started task T?" or "what changed since the last agent ran?" — critical for rollback and blame.

---

## 2. Target Architecture

```
┌────────────────────────────────────────────────────────┐
│                  Agent Fleet (any LLM)                  │
│   Agent A       Agent B       Agent C       Agent D    │
└──────┬──────────────┬──────────────┬──────────────┬────┘
       │              │              │              │
       └──────────────┴──────────────┴──────────────┘
                             │  MCP (HTTP)
              ┌──────────────▼──────────────────────┐
              │         code-graph-server            │
              │                                      │
              │  ┌─────────────────────────────────┐ │
              │  │       Tool Surface (~34 tools)  │ │
              │  │  context_pack   episode_add      │ │
              │  │  agent_claim    semantic_slice   │ │
              │  │  decision_query diff_since       │ │
              │  │  reflect        + 14 existing    │ │
              │  └──────────────┬──────────────────┘ │
              │                 │                     │
              │  ┌──────────────▼──────────────────┐ │
              │  │        Core Engines              │ │
              │  │  PPR Context Packer              │ │
              │  │  Episode Memory (bi-temporal)    │ │
              │  │  Coordination (temporal claims)  │ │
              │  │  Hybrid Retriever (vec+BM25+PPR) │ │
              │  │  Community Detector (Leiden)     │ │
              │  │  Multi-lang Parser (Tree-sitter) │ │
              │  └──────────┬───────────┬───────────┘ │
              │             │           │             │
              │  ┌──────────▼──┐  ┌─────▼──────────┐ │
              │  │  Memgraph   │  │  Qdrant         │ │
              │  │  (bi-temp.  │  │  (embeddings +  │ │
              │  │   KG + PPR) │  │   BM25 index)   │ │
              │  └─────────────┘  └────────────────┘ │
              └─────────────────────────────────────────┘
```

---

## 3. Implementation Phases (Revised with SOTA Insights)

### Phase 1 — Foundation: Response Quality & Context Budget
**Goal**: Halve the tokens each existing tool returns without losing information density. Use relevance-ranked selection (not truncation).  
**Estimated effort**: 1–2 weeks  
**Unblocks**: Every subsequent phase. Agents cannot reliably work with the server until token efficiency and answer-first formatting are in place.  
**Research backing**: Mem0 (90% token reduction via intelligent selection), MemGPT (RAM/disk paging model)  
**Acceptance criteria**:
- `npx tsc --noEmit` clean
- compact profile: `_tokenEstimate ≤ 300` for at least 80% of `benchmark_graph_tools.py` cases
- Every tool response includes `summary` and `_tokenEstimate` fields
- `CODE_GRAPH_SUMMARIZER_URL` optional; server starts without it

**Implementation status (2026-02-21)**:
- ✅ Added `src/response/budget.ts` with profile budgets, `ContextBudget`, `makeBudget()`, token estimation, and `fillSlot()`.
- ✅ Added `src/response/shaper.ts` with answer-first envelope (`summary`, `_tokenEstimate`) and shared error formatting.
- ✅ Added `src/response/schemas.ts` with field-priority schemas and budget-aware field dropping.
- ✅ Integrated `ToolHandlers` to use the shared shaper for success/error responses; `graph_query`, `graph_rebuild`, and `graph_health` now pass tool-specific summaries.
- ✅ Verified compile (`npm run build`) and MCP chat smoke call (`graph_query`) after integration.
- ⏳ Remaining in Phase 1: full schema coverage for all tools and indexing-time summarization integration (`summarizer.ts` + builder wiring).

#### 1.1 Context Budget System

**File**: `src/response/budget.ts` (new)

Replace `compactValue()` / `shapeValue()` in `tool-handlers.ts` with a proper `ContextBudget` class that allocates tokens by relevance category. Inspired by Mem0's approach — reduce tokens by **selecting** the right things, not by cutting strings.

```typescript
// src/response/budget.ts
export const DEFAULT_TOKEN_BUDGETS: Record<string, number> = {
  compact:  300,
  balanced: 1200,
  debug:    Infinity,
};

export interface BudgetAllocation {
  coreCode:       number;  // 40% — exact symbols being edited/asked about
  dependencies:   number;  // 25% — direct callers/callees (PPR-ranked post Phase 5)
  decisions:      number;  // 20% — relevant past DECISION episodes (post Phase 3)
  plan:           number;  // 10% — current task plan / progress state
  episodeHistory: number;  //  5% — recent agent episodes
}

export interface ContextBudget {
  maxTokens:  number;
  profile:    'compact' | 'balanced' | 'debug';
  allocation: BudgetAllocation;
}

export function makeBudget(
  profile: 'compact' | 'balanced' | 'debug',
  override?: Partial<ContextBudget>,
): ContextBudget {
  const max = DEFAULT_TOKEN_BUDGETS[profile];
  return {
    maxTokens: max,
    profile,
    allocation: {
      coreCode:       Math.floor(max * 0.40),
      dependencies:   Math.floor(max * 0.25),
      decisions:      Math.floor(max * 0.20),
      plan:           Math.floor(max * 0.10),
      episodeHistory: Math.floor(max * 0.05),
    },
    ...override,
  };
}

/** Fill a budget slot: add items from ranked list until slot is full. */
export function fillSlot<T>(
  items:         T[],
  tokenFn:       (item: T) => number,
  slotBudget:    number,
): { selected: T[]; usedTokens: number } {
  let usedTokens = 0;
  const selected: T[] = [];
  for (const item of items) {
    const cost = tokenFn(item);
    if (usedTokens + cost > slotBudget) break;
    selected.push(item);
    usedTokens += cost;
  }
  return { selected, usedTokens };
}
```

Each allocation slot is filled by relevance-ranked retrieval until consumed. Slots with no relevant data are skipped entirely — they do not waste tokens on empty arrays.

**Migration path**: `shapeValue()` in `tool-handlers.ts` is the current interim implementation. Once `budget.ts` is shipped, `shapeValue()` becomes a thin wrapper calling the budget system.

#### 1.2 Answer-first response format

**File**: `src/response/shaper.ts` (new)

Every tool response gains a mandatory `summary` field (written by the tool, not auto-generated). Agents in compact mode read `summary` alone and skip `data`. The `_tokenEstimate` field allows the agent to decide whether to request a wider profile.

```typescript
// src/response/shaper.ts
export interface ToolResponse {
  ok:             boolean;
  summary:        string;         // 1–3 sentences, answer-first, always present
  profile:        string;
  _tokenEstimate: number;
  data?:          Record<string, unknown>;  // omitted in compact if budget met by summary
  hint?:          string;         // always present on errors
  errorCode?:     string;         // machine-readable error class
}

export function formatResponse(
  summary:  string,
  data:     Record<string, unknown> | null,
  budget:   ContextBudget,
  hint?:    string,
): ToolResponse {
  const dataStr   = data ? JSON.stringify(data) : '';
  const summaryTokens = Math.ceil(summary.length / 4);
  const dataTokens    = Math.ceil(dataStr.length / 4);
  const total         = summaryTokens + dataTokens;

  // In compact profile: omit data entirely if summary+data exceeds budget
  const includeData = budget.profile !== 'compact' || total <= budget.maxTokens;

  return {
    ok:             true,
    summary,
    profile:        budget.profile,
    _tokenEstimate: total,
    data:           includeData && data ? data : undefined,
    hint,
  };
}

export function errorResponse(
  errorCode: string,
  message:   string,
  hint:      string,
): ToolResponse {
  return {
    ok:             false,
    summary:        message,
    profile:        'compact',
    _tokenEstimate: Math.ceil((message + hint).length / 4),
    errorCode,
    hint,
  };
}
```

**Token estimate rule**: `Math.ceil(JSON.stringify(payload).length / 4)`. This is the same formula already used in `tool-handlers.ts::estimateTokens()`. The estimate is intentionally conservative — it over-counts rather than under-counts.

#### 1.3 Tool-specific response schemas and field priorities

**File**: `src/response/schemas.ts` (new)

Each tool declares an `OutputSchema` with field importance weights. The shaper preserves high-importance fields at any compression level and drops low-importance ones first when over budget.

```typescript
// src/response/schemas.ts
export type FieldPriority = 'required' | 'high' | 'medium' | 'low';

export interface OutputField {
  key:          string;
  priority:     FieldPriority;
  description:  string;
}

export const TOOL_OUTPUT_SCHEMAS: Record<string, OutputField[]> = {
  graph_query: [
    { key: 'results',  priority: 'required', description: 'Query results array' },
    { key: 'count',    priority: 'high',     description: 'Result count' },
    { key: 'cypher',   priority: 'medium',   description: 'Executed Cypher string' },
    { key: 'warnings', priority: 'low',      description: 'Query warnings' },
  ],
  code_explain: [
    { key: 'summary',      priority: 'required', description: 'Answer-first natural language explanation' },
    { key: 'type',         priority: 'required', description: 'Node type: FILE|FUNCTION|CLASS' },
    { key: 'dependencies', priority: 'high',     description: 'Outgoing deps (imports, calls)' },
    { key: 'dependents',   priority: 'high',     description: 'Incoming refs (who uses this)' },
    { key: 'lineRange',    priority: 'medium',   description: 'startLine, endLine' },
    { key: 'raw',          priority: 'low',      description: 'Full raw Cypher node data' },
  ],
  impact_analyze: [
    { key: 'blastRadius',  priority: 'required', description: 'Number of impacted files/tests' },
    { key: 'directTests',  priority: 'required', description: 'Tests that directly import changed files' },
    { key: 'transitiveTests', priority: 'high',  description: 'Tests impacted through dep chain' },
    { key: 'graph',        priority: 'low',      description: 'Full traversal graph' },
  ],
  arch_validate: [
    { key: 'violations',   priority: 'required', description: 'List of violations (may be empty)' },
    { key: 'summary',      priority: 'required', description: 'Pass/fail summary' },
    { key: 'checkedFiles', priority: 'medium',   description: 'Files checked' },
  ],
  // ... (all 14 existing tools have schemas; see full table in §4)
};

/** Drop low-priority fields first until response fits within budget. */
export function applyFieldPriority(
  data:    Record<string, unknown>,
  schema:  OutputField[],
  budget:  number,
): Record<string, unknown> {
  const priorities: FieldPriority[] = ['low', 'medium', 'high', 'required'];
  let result = { ...data };

  for (const level of priorities) {
    if (Math.ceil(JSON.stringify(result).length / 4) <= budget) break;
    for (const field of schema.filter(f => f.priority === level)) {
      delete result[field.key];
    }
  }
  return result;
}
```

**Invariant**: `required` fields are NEVER dropped regardless of budget. If required fields alone exceed budget, the tool returns an error advising `profile: 'balanced'`.

#### 1.4 Meta-RAG Indexing-Time Summarization
**Goal**: Achieve ~79.8% token compression for compact-profile responses by storing a one-sentence LLM summary on every FUNCTION and CLASS node during indexing. Tools return `node.summary` instead of raw code in compact mode.

**Research backing**: Meta-RAG Code Summarization — summarizing every indexed unit during ingestion, not at query time, amortizes the LLM cost across all future queries.

**File**: `src/graph/summarizer.ts` (new)

```typescript
// src/graph/summarizer.ts
export interface SummarizerConfig {
  url:        string;   // OpenAI-compatible /v1/chat/completions endpoint
  model:      string;   // default: 'gpt-4o-mini'
  maxTokens:  number;   // default: 30 — keep summaries tight
  batchSize:  number;   // default: 20 — concurrent requests
  timeout:    number;   // default: 5000ms per request
}

export async function summarizeSymbol(
  name: string,
  kind: 'function' | 'class' | 'method',
  code: string,
  file: string,
  cfg:  SummarizerConfig,
): Promise<string> {
  // Trim code to first 300 chars to stay within context limits
  const codeSample = code.slice(0, 300);
  const prompt = `In one sentence (max 15 words), describe what ${kind} \`${name}\` in ${file} does: \`\`\`${codeSample}\`\`\``;
  // ... OpenAI-compatible API call
}

/** Heuristic fallback when no summarizer URL is configured. */
export function extractHeuristicSummary(code: string, name: string): string {
  // Try JSDoc / docstring first
  const jsdoc = code.match(/\/\*\*\s*(.*?)\s*\*\//s)?.[1]?.split('\n')[0]?.trim();
  if (jsdoc) return jsdoc.replace(/^\*\s*/, '');
  // Try first non-blank non-comment line
  const firstLine = code.split('\n').find(l => l.trim() && !l.trim().startsWith('//'));
  return firstLine?.trim() ?? `${name} implementation`;
}
```

**Integration in `src/graph/builder.ts`**:
1. After AST parse, for each FUNCTION/CLASS node, call `summarizeSymbol()` or `extractHeuristicSummary()` depending on `CODE_GRAPH_SUMMARIZER_URL`
2. Store result as `summary: string` property on the node
3. **Qdrant embedding uses `summary` text** (not raw code) — dramatically improves semantic search because summaries are domain-language
4. BM25-Plus index (Phase 8) also runs over `summary + name` fields
5. `graph_rebuild` logs: `"Summarized N symbols (M cached)"` to help operators monitor cost

```typescript
// builder.ts — per-node flow
const summaryText = process.env.CODE_GRAPH_SUMMARIZER_URL
  ? await summarizeSymbol(node.name, node.kind, node.code, relPath, summarizerCfg)
  : extractHeuristicSummary(node.code, node.name);

node.summary = summaryText;
// Store in Memgraph node property
// Qdrant: embed summaryText (not node.code)
```

**Cost control**: Summaries are cached by `(scip_id, contentHash)`. If the file hash has not changed since last rebuild, the cached summary is reused — no LLM call. This makes incremental rebuilds almost free even with a remote summarizer.

This is the single biggest lever for hitting the Phase 1 target of `_tokenEstimate ≤ 300` in compact mode.

---

### Phase 2 — Bi-Temporal Graph Model
**Goal**: Every graph write is automatically time-stamped. Historical queries become trivial. Replaces both manual snapshots and TTL-based expiry.  
**Estimated effort**: 1–2 weeks  
**Depends on**: Phase 1 (SCIP-style IDs make MERGE-based temporal writes safe)  
**Unblocks**: Phase 3 (episodes need `validFrom` on code nodes), Phase 4 (claims reference `validFrom` hashes), Phase 10 (watcher uses `GRAPH_TX` nodes)  
**Research backing**: Graphiti/Zep (arXiv:2501.13956) — bi-temporal model is the defining architectural innovation for agent memory graphs.  
**Acceptance criteria**:
- All FILE, FUNCTION, CLASS, IMPORT nodes carry `validFrom`, `validTo`, `createdAt`, `txId`
- `graph_rebuild` creates a `GRAPH_TX` node and links all affected FILE nodes to it
- `graph_query` accepts `asOf` parameter and produces correct historical results
- `diff_since` tool returns meaningful diff for two consecutive rebuilds

**Implementation status (2026-02-21)**:
- ✅ Added bi-temporal properties (`validFrom`, `validTo`, `createdAt`, `txId`) to FILE/FUNCTION/CLASS/IMPORT node writes in `src/graph/builder.ts`.
- ✅ Added transaction propagation (`txId`, `txTimestamp`) through `src/graph/orchestrator.ts` build options/results.
- ✅ Added `GRAPH_TX` creation on `graph_rebuild` start in `src/tools/tool-handlers.ts`.
- ✅ Added `graph_query.asOf` (natural-language mode) and exposed schema support in both `src/server.ts` and `src/mcp-server.ts`.
- ✅ Added `graph_health` transaction metadata (`latestTxId`, `latestTxTimestamp`, `txCount`).
- ⏳ Remaining in Phase 2: full historical filtering for arbitrary Cypher mode and `diff_since` tool implementation.

#### 2.1 Temporal schema extension

Add bi-temporal properties to all mutable node types. Apply in `src/graph/builder.ts` during the `MERGE/SET` step for every node write.

```cypher
// Cypher properties added to FILE, FUNCTION, CLASS, IMPORT nodes
{
  validFrom:  $validFrom,   // epoch ms — when this code version became true
  validTo:    null,         // epoch ms | null — null means current/active
  createdAt:  $createdAt,   // epoch ms — when this row was ingested (transaction time)
  txId:       $txId         // links to GRAPH_TX node
}
```

**SCIP ID + bi-temporal = safe MERGE**: Because node IDs are stable (`src/tools/tool-handlers.ts::ToolHandlers::callTool`), `MERGE` on ID finds the existing node. The temporal update flow is:

```cypher
// Step 1: Retire the old version (set validTo)
MATCH (n {id: $scip_id, projectId: $pid, validTo: null})
SET n.validTo = $now;

// Step 2: Create the new version
CREATE (n2 {id: $scip_id + '#' + $txId, projectId: $pid,
            validFrom: $now, validTo: null, createdAt: $now, txId: $txId,
            /* all other properties */});

// Step 3: SUPERSEDES edge
MATCH (old {id: $scip_id, validTo: $now}),
      (new {txId: $txId, id: $scip_id + '#' + $txId})
CREATE (new)-[:SUPERSEDES]->(old);
```

**Nothing is ever deleted** — `validTo` being set is the only "deletion". Historical queries simply filter `validTo > $T`.

**Stable SCIP query ID convention**: The "current" version of any symbol is always the node with `validTo = null`. To query at a point in time:
```cypher
// Current version
MATCH (fn:FUNCTION {id: $scipId}) WHERE fn.validTo IS NULL RETURN fn

// As of a specific timestamp T
MATCH (fn:FUNCTION {id: $scipId})
WHERE fn.validFrom <= $T AND (fn.validTo IS NULL OR fn.validTo > $T)
RETURN fn
```

#### 2.2 Transaction log — GRAPH_TX nodes

Every rebuild, file-change event, and agent edit creates one `GRAPH_TX` node. This is the audit trail.

```cypher
// Full GRAPH_TX schema
CREATE (tx:GRAPH_TX {
  id:            $txId,           // UUID — transactions use UUIDs (nodes use SCIP IDs)
  type:          $type,           // 'full_rebuild' | 'incremental_rebuild' | 'file_change' | 'agent_edit'
  agentId:       $agentId,        // null if system-initiated
  sessionId:     $sessionId,
  gitCommit:     $sha,            // null if no git integration
  timestamp:     $ts,
  mode:          $mode,           // 'full' | 'incremental'
  filesAffected: $paths,          // string[] — relative paths
  nodeCount:     $nodeCount,      // how many nodes were written
  durationMs:    $durationMs
})

// Link: GRAPH_TX → each affected FILE node
MATCH (tx:GRAPH_TX {id: $txId}), (f:FILE {path: $path, projectId: $pid, validTo: null})
CREATE (tx)-[:AFFECTS]->(f)
```

**`GRAPH_TX` IDs remain UUIDs** because transactions are not addressable by source path — they're events, not code symbols.

#### 2.3 `diff_since` — new tool (Phase 2)

**File**: new handler in `src/tools/tool-handlers.ts`, registered in `src/mcp-server.ts` + `src/server.ts`

```typescript
// Input schema
interface DiffSinceArgs {
  since:        string;   // txId UUID | ISO-8601 timestamp | agentId | git commit SHA
  projectId?:   string;
  types?:       ('FILE' | 'FUNCTION' | 'CLASS')[];  // default: all
  profile?:     'compact' | 'balanced' | 'debug';
}

// Response
interface DiffSinceResult {
  summary:  string;      // "3 functions added, 1 deleted, 2 modified since <since>"
  added:    NodeDelta[];
  removed:  NodeDelta[];
  modified: NodeDelta[];
  txIds:    string[];    // transaction IDs covered by the diff
}

interface NodeDelta {
  scip_id:      string;
  type:         'FILE' | 'FUNCTION' | 'CLASS';
  path:         string;
  symbolName?:  string;
  validFrom:    number;
  validTo?:     number;
}
```

**Resolution of `since` parameter**:
1. Looks like a UUID → treat as `txId`
2. Looks like ISO-8601 → use as epoch timestamp
3. Looks like a git SHA (hex 7–40) → query `GRAPH_TX {gitCommit: $sha}`
4. Anything else → treat as `agentId` → find last `GRAPH_TX` by that agent

**Cypher for modified nodes**:
```cypher
MATCH (tx:GRAPH_TX)
WHERE tx.timestamp >= $sinceTs
WITH collect(tx.id) AS txIds
MATCH (n)-[:SUPERSEDES]->(old)
WHERE n.txId IN txIds
RETURN n, old, 'modified' AS changeType
UNION
MATCH (n)
WHERE n.txId IN txIds AND NOT (n)-[:SUPERSEDES]->()
RETURN n, null AS old, 'added' AS changeType
```

#### 2.4 Updated existing tools

| Tool | Change |
|---|---|
| `graph_query` | Add optional `asOf: string` parameter (ISO-8601 or txId). When set, appends `WHERE n.validFrom <= $T AND (n.validTo IS NULL OR n.validTo > $T)` to all node matches |
| `graph_rebuild` | Creates `GRAPH_TX` before indexing, links FILE nodes after, stores `txId` in return value |
| `graph_health` | New field: `latestTxId`, `latestTxTimestamp`, `txCount` — from latest `GRAPH_TX` node |
| `code_explain` | Adds `validFrom`, `validTo` to output in balanced/debug profile |

---

### Phase 3 — Episode-Based Agent Memory
**Goal**: Agents can persist structured observations, decisions, and edits that survive restarts and are retrievable by semantic + temporal + graph search.  
**Estimated effort**: 1–2 weeks  
**Depends on**: Phase 2 (episodes reference `validFrom` on code nodes; bi-temporal model lets episodes survive rebuilds without becoming stale)  
**Unblocks**: Phase 4 (coordination reads episodes), Phase 5 (`context_pack` surfaces relevant decisions + learnings)  
**Research backing**: Graphiti (episodic memory), Generative Agents (observation → reflection → planning)  
**Acceptance criteria**:
- `episode_add` persists to Memgraph and survives server restart
- `episode_recall` returns correct results for vector + temporal + graph proximity queries
- `reflect()` produces `REFLECTION` and `LEARNING` nodes from ≥ 3 episodes
- Sensitive episodes (`sensitive: true`) excluded from default queries

**Implementation status (2026-02-21)**:
- ✅ Added `src/engines/episode-engine.ts` with persistent EPISODE writes to Memgraph, `NEXT_EPISODE` chaining, and `INVOLVES` links.
- ✅ Added tool handlers in `src/tools/tool-handlers.ts`: `episode_add`, `episode_recall`, `decision_query`, and `reflect`.
- ✅ Added Phase 3 tool schemas in both MCP surfaces (`src/server.ts`, `src/mcp-server.ts`).
- ✅ `reflect` now creates `REFLECTION` episodes and materializes `LEARNING` nodes with `APPLIES_TO` links.
- ⏳ Remaining in Phase 3: Qdrant-backed embedding retrieval path and stricter type-specific metadata validation contracts.

#### 3.1 New Engine: `EpisodeEngine`

**File**: `src/engines/episode-engine.ts`

```typescript
// src/engines/episode-engine.ts
export type EpisodeType =
  | 'OBSERVATION'   // agent read code or queried the graph
  | 'DECISION'      // agent made a binding technical choice
  | 'EDIT'          // agent modified code
  | 'TEST_RESULT'   // tests were run
  | 'ERROR'         // agent encountered unexpected state
  | 'REFLECTION'    // synthesized insight from multiple episodes (internal)
  | 'LEARNING';     // durable pattern extracted from reflections

export interface EpisodeInput {
  agentId:    string;
  sessionId:  string;
  taskId?:    string;
  type:       EpisodeType;
  content:    string;          // human-readable natural language summary
  entities?:  string[];        // SCIP IDs: code nodes this episode involves
  outcome?:   'success' | 'failure' | 'partial';
  metadata?:  Record<string, unknown>;  // type-specific extras (see below)
  sensitive?: boolean;         // if true: excluded from default queries
}

export interface Episode extends EpisodeInput {
  id:               string;    // UUID
  timestamp:        number;    // epoch ms
  contentEmbedding: number[];  // Qdrant vector of `content`
  prevEpisodeId?:   string;    // previous episode in agent's session chain
}

export class EpisodeEngine {
  constructor(
    private memgraph:  MemgraphClient,
    private qdrant:    QdrantClient,
    private embedding: EmbeddingEngine,
  ) {}

  async add(input: EpisodeInput): Promise<string>;
  async recall(query: RecallQuery): Promise<Episode[]>;
  async reflect(opts: ReflectOptions): Promise<ReflectionResult>;
  async decisionQuery(q: DecisionQueryArgs): Promise<Episode[]>;
  private async linkToPreviousEpisode(ep: Episode): Promise<void>;
  private async linkToCodeNodes(ep: Episode): Promise<void>;
}
```

**Episode type-specific metadata contracts**:

| Type | Required metadata fields |
|---|---|
| `DECISION` | `title: string`, `rationale: string`, `tradeoffs: string[]`, `affectedFiles: string[]` |
| `EDIT` | `file: string`, `diffSummary: string`, `linesBefore: number`, `linesAfter: number`, `reason: string` |
| `TEST_RESULT` | `passed: number`, `failed: number`, `testFiles: string[]`, `coverageDelta?: number` |
| `ERROR` | `errorType: string`, `stackSummary: string`, `recoveryAction?: string` |
| `OBSERVATION` | `confidence?: number` (0–1), `queryUsed?: string` |

#### 3.2 Graph schema for episodes

```cypher
// Episode node — full schema
CREATE (e:EPISODE {
  id:          $id,           // UUID
  agentId:     $agentId,
  sessionId:   $sessionId,
  taskId:      $taskId,       // nullable
  type:        $type,
  content:     $content,      // NL summary — always human-readable
  timestamp:   $ts,
  outcome:     $outcome,      // 'success' | 'failure' | 'partial' | null
  sensitive:   $sensitive,    // boolean — exclude from default queries
  metadata:    $metadataJson, // JSON string of type-specific extras
  projectId:   $projectId
  // Note: contentEmbedding is stored in Qdrant, not Memgraph
})

// Session chain: episodes are linked in order within a session
MATCH (prev:EPISODE {id: $prevId}), (curr:EPISODE {id: $currId})
CREATE (prev)-[:NEXT_EPISODE]->(curr)

// Episode ↔ code node links (many-to-many)
MATCH (e:EPISODE {id: $epId}), (n {id: $scipId, projectId: $pid})
CREATE (e)-[:INVOLVES]->(n)

// Reflection derived from source episodes
MATCH (r:EPISODE {type: 'REFLECTION'}), (src:EPISODE {id: $srcId})
CREATE (r)-[:DERIVED_FROM]->(src)

// Learning node applied to code
CREATE (l:LEARNING {
  id:          $lid,
  content:     $nlSummary,
  extractedAt: $ts,
  agentId:     $agentId,
  taskId:      $taskId,
  confidence:  $confidence,   // 0.0–1.0
  projectId:   $pid
})
MATCH (l:LEARNING {id: $lid}), (n {id: $scipId, projectId: $pid})
CREATE (l)-[:APPLIES_TO]->(n)
```

**Qdrant collection**: `episodes_{projectId}` — each point:
```json
{
  "id":      "<uuid>",
  "vector":  [/* embedding of episode.content */],
  "payload": {
    "agentId":   "...",
    "sessionId": "...",
    "taskId":    "...",
    "type":      "DECISION",
    "timestamp": 1234567890,
    "entities":  ["src/tools/tool-handlers.ts::ToolHandlers::callTool"],
    "sensitive": false
  }
}
```

#### 3.3 `episode_recall` — hybrid search algorithm

Recall combines three signals with weighted sum then re-ranks:

```
Score(episode) =
  α × VectorSimilarity(query_embedding, episode.contentEmbedding)   // α = 0.50
  + β × TemporalRecency(episode.timestamp)                           // β = 0.30
  + γ × GraphProximity(query_entities, episode.entities)             // γ = 0.20

where:
  TemporalRecency(ts) = exp(-λ × age_in_days)    // λ = 0.05 (half-life ≈ 14 days)
  GraphProximity = |query_entities ∩ episode.entities| / |query_entities ∪ episode.entities|
                  (Jaccard similarity on SCIP ID sets)
```

```typescript
interface RecallQuery {
  query:      string;      // natural language
  agentId?:   string;      // if set: only episodes from this agent
  taskId?:    string;
  types?:     EpisodeType[];
  entities?:  string[];    // SCIP IDs to boost proximity score
  limit?:     number;      // default: 5
  since?:     number;      // epoch ms — exclude older episodes
}
```

#### 3.4 Reflection synthesis — from Generative Agents

`reflect()` is called:
- On demand via the `reflect` MCP tool
- Automatically when `task_update(..., status: 'completed')` is called (Phase 4 integration)
- Periodically via a background timer if `CODE_GRAPH_AUTO_REFLECT_INTERVAL_MS` is set

**Algorithm**:
```typescript
async reflect(opts: { taskId?: string; agentId?: string; limit?: number }): Promise<ReflectionResult> {
  // 1. Fetch last N episodes for task/agent (default N = 20)
  const source = await this.recall({ taskId, agentId, limit: opts.limit ?? 20 });

  // 2. Identify patterns:
  //    - Files touched by ≥ 3 EDITs → likely hotspot
  //    - DECISION nodes near ERROR nodes → decision led to failure
  //    - Repeated similar OBSERVATIONs → the agent is re-reading the same code
  const patterns = analyzeEpisodePatterns(source);

  // 3. Build REFLECTION node
  const reflection = await this.add({
    type: 'REFLECTION',
    content: synthesizeInsight(patterns),  // structured NL summary
    entities: patterns.hotspotFiles,
    metadata: { sourceEpisodeIds: source.map(e => e.id), patterns },
  });

  // 4. Extract LEARNING nodes for each pattern with confidence ≥ 0.7
  const learnings = patterns
    .filter(p => p.confidence >= 0.7)
    .map(p => this.createLearning(p, reflection.id));

  return { reflectionId: reflection.id, learnings, patterns };
}
```

**LEARNING node creation triggers**: learnings are linked to the code nodes involved in the reflection's patterns. Future `context_pack` calls that reach those code nodes via PPR will surface the learnings automatically.

#### 3.5 New Tools

```typescript
// episode_add
interface EpisodeAddArgs {
  type:      EpisodeType;
  content:   string;
  entities?: string[];    // SCIP IDs
  taskId?:   string;
  outcome?:  'success' | 'failure' | 'partial';
  metadata?: Record<string, unknown>;
  sensitive?:boolean;
}
// → returns { episodeId: string, summary: string }

// episode_recall
interface EpisodeRecallArgs {
  query:    string;
  agentId?: string;
  taskId?:  string;
  types?:   EpisodeType[];
  limit?:   number;       // default: 5
  since?:   string;       // ISO-8601
  profile?: 'compact' | 'balanced' | 'debug';
}
// → returns ranked list of episodes with relevance scores

// decision_query
interface DecisionQueryArgs {
  query:          string;
  affectedFiles?: string[];
  limit?:         number;
}
// → same as episode_recall but type=['DECISION'] and graph proximity weighted higher (γ = 0.5)

// reflect
interface ReflectArgs {
  taskId?:  string;
  agentId?: string;
  limit?:   number;   // max episodes to analyse, default: 20
}
// → { reflectionId, insight: string, learningsCreated: number, patterns: PatternSummary[] }
```

---

### Phase 4 — Agent Coordination (Temporal Invalidation)
**Goal**: Multiple agents coordinate on tasks without message-passing. Claims self-invalidate when underlying code changes.  
**Estimated effort**: 1 week  
**Depends on**: Phase 2 (claim staleness detects code node `validFrom` changes; SUPERSEDES edges drive auto-invalidation), Phase 3 (`task_update` triggers reflection)  
**Unblocks**: Phase 5 (`context_pack` reads `activeBlockers` from live CLAIM nodes)  
**Research backing**: Graphiti (temporal edge invalidation instead of TTL deletion), A2A Agent Cards (§0.4 — discoverable capability declaration)  
**Acceptance criteria**:
- `agent_claim` returns `CONFLICT` when another active claim targets the same node
- Claims that target code nodes subsequently rebuilt have `validTo` set automatically
- `coordination_overview` reflects real-time claim state including stale detection
- `task_update(status: 'completed')` calls `EpisodeEngine.reflect()` and auto-releases open claims for that task
- `GET /.well-known/agent.json` returns valid A2A Agent Card JSON-LD (HTTP mode)

**Implementation status (2026-02-21)**:
- ✅ Added `src/engines/coordination-engine.ts` with `claim`, `release`, `status`, `overview`, `invalidateStaleClaims`, and `onTaskCompleted`.
- ✅ Added Phase 4 handlers in `src/tools/tool-handlers.ts`: `agent_claim`, `agent_release`, `agent_status`, `coordination_overview`.
- ✅ Integrated stale-claim invalidation after background `graph_rebuild` completion.
- ✅ Integrated `task_update(status: 'completed')` to auto-release task claims, trigger `reflect`, and persist a `DECISION` episode.
- ✅ Added Phase 4 tool schemas to both MCP surfaces (`src/server.ts`, `src/mcp-server.ts`).

#### 4.1 New Engine: `CoordinationEngine`

**File**: `src/engines/coordination-engine.ts`

Uses **temporal invalidation** instead of TTL: a claim is invalidated when the code node it targets is superseded (new GRAPH_TX writes a new version with `validFrom > claim.validFrom`).

```typescript
export type ClaimType = 'task' | 'file' | 'function' | 'feature';
export type InvalidationReason = 'released' | 'code_changed' | 'task_completed' | 'expired';

export interface AgentClaim {
  id:                  string;         // UUID
  agentId:             string;
  sessionId:           string;
  taskId?:             string;
  claimType:           ClaimType;
  targetId:            string;         // SCIP ID or task ID
  intent:              string;         // NL description of what this agent is doing
  validFrom:           number;         // epoch ms when claim was created
  targetVersionSHA?:   string;         // gitCommit or contentHash at claim time
  validTo:             number | null;  // null = active; set when invalidated
  invalidationReason?: InvalidationReason;
  projectId:           string;
}

export class CoordinationEngine {
  async claim(input: ClaimInput): Promise<ClaimResult>;
  async release(claimId: string, outcome?: string): Promise<void>;
  async status(agentId: string): Promise<AgentStatus>;
  async overview(projectId: string): Promise<CoordinationOverview>;
  async invalidateStaleClaims(projectId: string): Promise<number>; // returns invalidated count
  async onTaskCompleted(taskId: string, agentId: string): Promise<void>;
}
```

#### 4.2 Cypher schema for CLAIM nodes

```cypher
// CLAIM node — full schema
CREATE (c:CLAIM {
  id:                  $id,
  agentId:             $agentId,
  sessionId:           $sessionId,
  taskId:              $taskId,
  claimType:           $type,          // 'task' | 'file' | 'function' | 'feature'
  intent:              $intent,
  validFrom:           $now,
  targetVersionSHA:    $sha,
  validTo:             null,
  invalidationReason:  null,
  projectId:           $projectId
})

// Link claim to its target code node
MATCH (c:CLAIM {id: $cId}), (t {id: $targetId, projectId: $pid})
CREATE (c)-[:TARGETS]->(t)

// Staleness detection query (run after each graph_rebuild)
// → returns claims whose target code node has been superseded
MATCH (c:CLAIM)-[:TARGETS]->(t)
WHERE c.validTo IS NULL
  AND t.validFrom > c.validFrom
RETURN c.id, t.id, t.validFrom AS newVersion
```

**Conflict detection query** (run before inserting a new claim):
```cypher
MATCH (c:CLAIM)-[:TARGETS]->(t {id: $targetId, projectId: $pid})
WHERE c.validTo IS NULL
  AND c.agentId <> $requestingAgentId
RETURN c.id, c.agentId, c.intent, c.validFrom
```

**Auto-invalidation** is triggered inside `graph_rebuild` completion handler:
```typescript
// In GraphOrchestrator.onRebuildComplete():
const count = await coordinationEngine.invalidateStaleClaims(projectId);
if (count > 0) logger.info(`[coordination] Invalidated ${count} stale claims post-rebuild`);
```

#### 4.3 New Tool Interfaces

```typescript
// agent_claim
interface ClaimInput {
  targetId:  string;       // SCIP ID, file path, or task ID
  claimType: ClaimType;
  intent:    string;
  taskId?:   string;
}
interface ClaimResult {
  claimId:             string;
  status:              'ok' | 'CONFLICT';
  conflict?:           { agentId: string; intent: string; since: number };
  targetVersionSHA:    string;  // snapshot at claim time — client should monitor for drift
}

// agent_release
interface ReleaseArgs {
  claimId:  string;
  outcome?: string;   // NL summary of what was accomplished
}

// agent_status
interface AgentStatus {
  agentId:       string;
  activeClaims:  AgentClaim[];
  recentEpisodes:Episode[];      // last 10
  currentTask?:  string;
}

// coordination_overview
interface CoordinationOverview {
  activeClaims:  AgentClaim[];
  staleClaims:   AgentClaim[];    // validTo IS NULL but target has newer version
  conflicts:     ConflictPair[];  // two agents with active claims on same target
  agentSummary:  { agentId: string; claimCount: number; lastSeen: number }[];
  totalClaims:   number;
}
```

#### 4.4 `task_update` integration

When `task_update(taskId, { status: 'completed' })` is called:
1. `CoordinationEngine.onTaskCompleted(taskId, agentId)`:
   - Set `validTo = now`, `invalidationReason = 'task_completed'` on all claims for this task
2. `EpisodeEngine.reflect({ taskId })` — create REFLECTION + LEARNING nodes
3. Add a `DECISION` episode with outcome = 'success' or 'failure' (from task status)

#### 4.5 A2A Agent Card (cross-reference §0.4)

In HTTP mode, `GET /.well-known/agent.json` returns:
```json
{
  "@context": "https://schema.org",
  "@type":    "SoftwareAgent",
  "name":     "<CODE_GRAPH_SERVER_NAME>",
  "version":  "2.0.0",
  "capabilities": ["code-graph", "episodic-memory", "agent-coordination"],
  "mcpEndpoint":  "/mcp",
  "a2aVersion":   "1.0"
}
```
This endpoint was already added in the cleanup phase. Phase 4 extends the `capabilities` array to include `"agent-coordination"` once `CoordinationEngine` is live.

---

### Phase 5 — Context Pack with PPR (The Key Feature)
**Goal**: Single tool call = complete task briefing. Uses Personalized PageRank for relevance-ranked retrieval.  
**Estimated effort**: 2 weeks  
**Depends on**: Phase 1 (budget/shaper), Phase 2 (temporal node versions), Phase 3 (EPISODE/LEARNING nodes), Phase 4 (CLAIM nodes for active-blockers)  
**Unblocks**: Phase 6 (`semantic_slice` materialises code for context_pack `coreSymbols`)  
**Research backing**: HippoRAG (PPR for multi-hop retrieval — 20% better than vector alone, 10-30× cheaper than iterative LLM chains)  
**Acceptance criteria**:
- `context_pack` completes in < 500ms for graphs ≤ 10 000 nodes
- Returns non-empty `coreSymbols` and `summary` for any valid task string
- `ContextPack.tokenEstimate` ≤ budget for profile in use (compact=300, balanced=1200, debug=∞)
- Interface-consumer expansion includes at least 1 concrete implementation for any abstract seed
- `activeBlockers` contains claims from other agents when present in graph

**Implementation status (2026-02-21)**:
- ✅ Added `src/graph/ppr.ts` with weighted graph traversal + Personalized PageRank-style scoring (`runPPR`).
- ✅ Added `context_pack` handler in `src/tools/tool-handlers.ts` with seed selection, interface-seed expansion, PPR ranking, code-slice materialization, and blocker/decision/learning/episode aggregation.
- ✅ Added budget-aware trimming and `tokenEstimate` in `context_pack` output prior to response shaping.
- ✅ Added `context_pack` tool schemas to both MCP surfaces (`src/server.ts`, `src/mcp-server.ts`) and response-priority schema (`src/response/schemas.ts`).

#### 5.1 New router module: `src/graph/ppr.ts`

```typescript
// src/graph/ppr.ts
export interface PPROptions {
  seedIds:      string[];       // node IDs to personalise from
  edgeWeights?: Record<string, number>; // relationship type → weight (see defaults below)
  damping?:     number;         // default: 0.85
  iterations?:  number;         // default: 20
  maxResults?:  number;         // default: 50
  projectId:    string;
}

export interface PPRResult {
  nodeId:   string;
  score:    number;
  type:     string;             // FILE | FUNCTION | CLASS | EPISODE | LEARNING ...
  filePath: string;
  name:     string;
}

// Default edge weights — tuned for code graph
const DEFAULT_EDGE_WEIGHTS = {
  CALLS:          0.9,
  IMPORTS:        0.7,
  CONTAINS:       0.5,
  TESTS:          0.4,
  DEFINED_IN:     0.6,
  INVOLVES:       0.3,          // EPISODE → code nodes
  APPLIES_TO:     0.4,          // LEARNING → code nodes
};

export async function runPPR(opts: PPROptions, client: MemgraphClient): Promise<PPRResult[]> {
  // Calls Memgraph CALL pagerank.get(graph, opts) via Cypher
  // Returns sorted by score DESC, limited to maxResults
}
```

#### 5.2 New module: `src/tools/context-pack.ts`

```typescript
// src/tools/context-pack.ts
export interface ContextPackRequest {
  task:              string;
  taskId?:           string;
  agentId?:          string;      // if provided, auto-creates CLAIM
  budget?:           Partial<ContextBudget>;
  profile?:          'compact' | 'balanced' | 'debug';
  includeDecisions?: boolean;     // default: true
  includeEpisodes?:  boolean;     // default: true
  includeLearnings?: boolean;     // default: true
}

export interface CodeSlice {
  file:             string;
  startLine:        number;
  endLine:          number;
  code:             string;           // actual source lines from filesystem
  symbolName:       string;
  pprScore:         number;
  incomingCallers:  SymbolRef[];
  outgoingCalls:    SymbolRef[];
  validFrom:        string;
  relevantDecisions:string[];         // DECISION episode IDs
  relevantLearnings:string[];         // LEARNING node IDs
}

export interface ContextPack {
  summary:        string;             // 2-4 sentences: what to do and where
  entryPoint:     string;             // best file/function to start at
  coreSymbols:    CodeSlice[];        // PPR-ranked code slices
  dependencies:   DepEdge[];          // immediate callers/callees
  decisions:      DecisionEpisode[];
  learnings:      Learning[];
  activeBlockers: ClaimInfo[];
  plan:           PlanNode | null;
  tokenEstimate:  number;
  pprScores?:     Record<string, number>; // only in debug profile
}

export async function buildContextPack(
  req:    ContextPackRequest,
  deps:   ContextPackDeps,
): Promise<ContextPack>
```

#### 5.3 PPR-based retrieval pipeline (algorithm detail)

```
1. Semantic search → top-5 seed node IDs (Qdrant vector similarity on req.task)

2. Interface-consumer expansion (DKB pattern):
   MATCH (iface {projectId: $pid})
   WHERE iface.id IN $seedIds
     AND iface.kind IN ['interface', 'abstract']
   OPTIONAL MATCH (iface)-[:IMPLEMENTED_BY]->(impl)
   WITH collect(DISTINCT impl.id) + $seedIds AS expandedSeeds
   → union of original seeds + their concrete implementations

3. Run PPR from expandedSeeds via ppr.ts (sub-100ms Memgraph built-in)
   Edge weights: CALLS 0.9, IMPORTS 0.7, CONTAINS 0.5, TESTS 0.4, INVOLVES 0.3

4. Apply Phase 1 budget allocation:
   budget = makeBudget(profile)
   for each slot in ['decisions', 'learnings', 'code', 'graph', 'meta']:
     fill from PPR results (highest score for that node type)
     stop when slot exhausted

5. For each selected code node:
   - Read file from disk, extract lines [node.startLine, node.endLine]
   - Read immediate graph neighbours: incomingCallers, outgoingCalls
   - Collect linked DECISION and LEARNING node IDs → CodeSlice

6. Query CLAIM nodes for activeBlockers:
   MATCH (c:CLAIM)-[:TARGETS]->(t)
   WHERE c.validTo IS NULL
     AND t.id IN $selectedIds
     AND c.agentId <> $requestingAgentId

7. Look up existing PlanNode for taskId (if provided)

8. Synthesise summary using Phase 1 summarizer.ts (extractHeuristicSummary)
   or LLM call to CODE_GRAPH_SUMMARIZER_URL if configured

9. Apply formatResponse(pack, profile, budget) → ContextPack trimmed to budget
```

#### 5.4 CodeSlice materialisation

```typescript
// Read actual source lines for a graph node
async function materializeCodeSlice(node: GraphNode, pprScore: number): Promise<CodeSlice> {
  const rawCode = await readLines(node.filePath, node.startLine, node.endLine);
  // Trim to Phase 1 budget slot: code slot = 300 chars compact / 1200 balanced
  const trimmed = trimToTokenBudget(rawCode, budget.code);
  return { file: node.filePath, startLine: node.startLine, endLine: node.endLine,
           code: trimmed, symbolName: node.name, pprScore, ... };
}
```

---

### Phase 6 — Semantic Code Slicing
**Goal**: Return actual relevant code lines with graph-enriched context, not file paths.  
**Estimated effort**: 1 week  
**Depends on**: Phase 2 (node `startLine`/`endLine` stored bi-temporally), Phase 5 (`pprScore` passed from context_pack into slices)  
**Unblocks**: nothing directly — this is a standalone consumer-facing tool that improves all upstream outputs  
**Research backing**: MemGPT (page in only what's needed — exact lines, not whole files)  
**Acceptance criteria**:
- `semantic_slice` with `context='body'` returns exact source lines matching the graph node's `startLine`/`endLine`
- `context='with-deps'` includes at least 1 caller and 1 callee from graph
- `context='full'` includes relevant decisions and learnings linked to the sliced symbol
- Symbol lookup by name falls back to hybrid search when not found by exact ID

**Implementation status (2026-02-21)**:
- ✅ Added `semantic_slice` tool handler in `src/tools/tool-handlers.ts` supporting `signature`, `body`, `with-deps`, and `full` contexts.
- ✅ Added symbol resolution flow: exact id (`::`), `file+symbol`, symbol-only lookup, query fallback, and file fallback.
- ✅ Implemented exact line materialization from filesystem via node `startLine`/`endLine` with context-specific range rules.
- ✅ Added dependency enrichment (`incomingCallers`, `outgoingCalls`) and full-context knowledge enrichment (`relevantDecisions`, `relevantLearnings`).
- ✅ Registered `semantic_slice` schemas on both MCP surfaces (`src/server.ts`, `src/mcp-server.ts`) and response field priorities (`src/response/schemas.ts`).

#### 6.1 New module: `src/tools/semantic-slice.ts`

```typescript
// src/tools/semantic-slice.ts
export type SliceContext = 'signature' | 'body' | 'with-deps' | 'full';

export interface SemanticSliceRequest {
  file?:     string;            // relative or absolute path
  symbol?:   string;            // exact name: "ToolHandlers.callTool" or just "callTool"
  query?:    string;            // NL fallback: "the auth check logic"
  context?:  SliceContext;      // default: 'body'
  pprScore?: number;            // passed in from context_pack pipeline
  profile?:  'compact' | 'balanced' | 'debug';
}

// CodeSlice is the same interface as defined in context-pack.ts (shared type)
export async function buildSemanticSlice(
  req:    SemanticSliceRequest,
  deps:   SliceDeps,
): Promise<CodeSlice>
```

#### 6.2 Symbol lookup algorithm

```
1. If req.symbol is provided and contains '::' → assume SCIP ID → exact graph lookup:
   MATCH (n {id: $symbol, projectId: $pid}) RETURN n

2. If req.symbol is a simple name AND req.file is provided:
   MATCH (f:FILE {path: $file, projectId: $pid})-[:CONTAINS*]->(n)
   WHERE n.name = $symbol RETURN n LIMIT 1

3. If req.symbol only (no file):
   MATCH (n {projectId: $pid}) WHERE n.name = $symbol RETURN n LIMIT 1

4. If not found by any graph path AND req.query provided:
   → fall back to hybrid search (Phase 8 when available, or Qdrant vector search now)
   → pick highest-scored result as slice anchor

5. If nothing found: return error with suggestions (similar names via fuzzy string match on graph `name` property)
```

#### 6.3 Context mode detail

| mode | content returned | graph enrichment |
|---|---|---|
| `signature` | First line only (function declaration) | none |
| `body` | Full function/class from `startLine` to `endLine` | none |
| `with-deps` | Body + `incomingCallers` list + `outgoingCalls` list | callers/callees from graph |
| `full` | Body + callers + callees + `relevantDecisions` + `relevantLearnings` | all linked EPISODE/LEARNING nodes |

```typescript
// context mode → source lines strategy
function computeLineRange(node: GraphNode, context: SliceContext): [number, number] {
  if (context === 'signature') return [node.startLine, node.startLine];
  return [node.startLine, node.endLine];
}
// Budget cap: 'signature' ≤ 80 chars, 'body' ≤ 1200 chars balanced / 300 chars compact
```

#### 6.4 Graph enrichment queries

```cypher
// Callers (who calls this function)
MATCH (caller)-[:CALLS]->(target {id: $nodeId, projectId: $pid})
RETURN caller.id, caller.name, caller.filePath LIMIT 10

// Callees (what this function calls)
MATCH (target {id: $nodeId, projectId: $pid})-[:CALLS]->(callee)
RETURN callee.id, callee.name, callee.filePath LIMIT 10

// Relevant decisions (EPISODE nodes of type DECISION involving this node)
MATCH (e:EPISODE {type: 'DECISION'})-[:INVOLVES]->(n {id: $nodeId})
RETURN e.id, e.content, e.timestamp ORDER BY e.timestamp DESC LIMIT 3

// Relevant learnings
MATCH (l:LEARNING)-[:APPLIES_TO]->(n {id: $nodeId})
RETURN l.id, l.content, l.confidence ORDER BY l.confidence DESC LIMIT 3
```

#### 6.5 `pprScore` propagation

When `semantic_slice` is called from within the `context_pack` pipeline (Phase 5 step 5), the `pprScore` for each node is already computed. It is passed into `buildSemanticSlice` as `req.pprScore` and stored in the returned `CodeSlice.pprScore`. This allows the agent to rank the returned slices by relevance without additional computation.

---

### Phase 7 — Community Detection & Global Mode
**Goal**: Agents can ask "what are the main architectural concerns?" and get accurate answers from community summaries.  
**Estimated effort**: 1 week  
**Depends on**: Phase 1 (Meta-RAG summarizer generates community summaries), Phase 2 (temporal nodes give community detection accurate edges)  
**Unblocks**: Phase 8 (community labels improve BM25 index relevance)  
**Research backing**: GraphRAG (Leiden communities + summaries), LightRAG (dual-level local/global retrieval)  
**Acceptance criteria**:
- Community detection runs automatically after each full graph rebuild (not incremental)
- `graph_query` with `mode: 'global'` returns answer derived from community summaries, not raw nodes
- Auto-generated community labels are human-readable (e.g. `"AuthServices"`, `"DataLayer"`)
- LLM-backed community summaries fall back to heuristic summaries if `CODE_GRAPH_SUMMARIZER_URL` is not set

**Implementation status (2026-02-21)**:
- ✅ Added `src/engines/community-detector.ts` with heuristic community clustering over FILE/FUNCTION/CLASS nodes.
- ✅ `graph_rebuild` full-mode completion now triggers `CommunityDetector.run(projectId)` asynchronously in `src/tools/tool-handlers.ts`.
- ✅ Added `graph_query.mode` support (`local`, `global`, `hybrid`) and global-mode retrieval from COMMUNITY summaries in `src/tools/tool-handlers.ts`.
- ✅ Added `graph_query.mode` schema support on both MCP surfaces (`src/server.ts`, `src/mcp-server.ts`).
- ✅ Community labels are auto-derived from dominant path segments with fallback to `misc`, and summaries are heuristic when no external summarizer is configured.

#### 7.1 Leiden community detection — when it runs

```
graph_rebuild (full) completes
  └─ GraphOrchestrator.onRebuildComplete()
       ├─ CoordinationEngine.invalidateStaleClaims()  ← Phase 4
       └─ CommunityDetector.run(projectId)             ← Phase 7 (async)
            ├─ CALL community_detection.get(graph)     ← Memgraph built-in Leiden
            ├─ auto-label each community
            ├─ generate/update COMMUNITY nodes
            └─ schedule summary generation (batched, async)
```

Detection is **async and non-blocking**: `graph_rebuild` returns status `QUEUED` immediately; communities are populated within seconds.

#### 7.2 Community detection Cypher

```cypher
// Run Leiden algorithm via Memgraph module
CALL community_detection.get(
  subgraphQuery := 'MATCH (n)-[r:CALLS|IMPORTS]->(m) RETURN n, r, m',
  config := {weight_property: 'weight', resolution: 1.0}
) YIELD node, community_id
SET node.communityId = community_id;

// Create COMMUNITY aggregator nodes
MATCH (n {projectId: $pid})
WHERE n.communityId IS NOT NULL
WITH n.communityId AS cId, collect(n) AS members
MERGE (c:COMMUNITY {id: toString($pid) + '::community::' + cId, projectId: $pid})
SET c.memberCount = size(members),
    c.computedAt  = $ts,
    c.label       = null  // populated below by auto-label heuristic
FOREACH (m IN members | MERGE (m)-[:BELONGS_TO]->(c))

// Auto-label: most common top-level path segment among member files
MATCH (c:COMMUNITY {projectId: $pid})<-[:BELONGS_TO]-(n)
WITH c, n.filePath AS fp
WITH c, head(split(fp, '/')) AS segment, count(*) AS cnt
ORDER BY cnt DESC
WITH c, collect(segment)[0] AS topSegment
SET c.label = topSegment
```

#### 7.3 COMMUNITY node full schema

```cypher
CREATE (c:COMMUNITY {
  id:          $id,             // "<pid>::community::<int>"
  projectId:   $pid,
  label:       $autoLabel,      // "tools", "engines", "graph", "parsers", etc.
  summary:     $nlSummary,      // LLM or heuristic NL description of what this cluster does
  memberCount: $n,
  centralNode: $mostConnectedId,// highest-degree node in community
  computedAt:  $ts
})
```

#### 7.4 Auto-labeling heuristic

```typescript
function autoLabel(memberFilePaths: string[]): string {
  // Count occurrences of each path segment (excluding root)
  const freq: Record<string, number> = {};
  for (const p of memberFilePaths) {
    const segments = p.split('/').filter(Boolean);
    for (const s of segments) freq[s] = (freq[s] ?? 0) + 1;
  }
  // Most frequent meaningful segment (skip generic names like 'src', 'lib')
  const ignored = new Set(['src', 'lib', 'dist', 'build', 'node_modules']);
  const best = Object.entries(freq)
    .filter(([seg]) => !ignored.has(seg))
    .sort(([,a],[,b]) => b - a)[0];
  return best ? best[0] : 'misc';
}
```

#### 7.5 `graph_query` — global mode

New `mode` parameter for `graph_query`:
- `local` (default): existing Cypher/hybrid traversal on raw nodes
- `global`: query COMMUNITY summary nodes → synthesize cross-community answer via summarizer
- `hybrid`: run both → format as two sections (global context + local detail)

```cypher
// global mode — retrieve community summaries relevant to the query
MATCH (c:COMMUNITY {projectId: $pid})
WHERE c.summary CONTAINS $keywordHint
   OR c.label IN $detectedLabels
RETURN c.id, c.label, c.summary, c.memberCount
ORDER BY c.memberCount DESC
```

Global mode falls back to returning all community node summaries if the query is highly open-ended (e.g. "overview of the codebase").

---

### Phase 8 — Hybrid Retrieval (Replacing NL→Cypher for most queries)
**Goal**: Replace fragile regex NL→Cypher translation with a robust hybrid retrieval pipeline.  
**Estimated effort**: 1–2 weeks  
**Depends on**: Phase 1 (Meta-RAG summaries as BM25 index field), Phase 7 (community labels improve BM25 precision)  
**Unblocks**: nothing — terminal improvement; makes all tools more accurate  
**Research backing**: Graphiti (semantic+BM25+graph hybrid at sub-second latency), LightRAG (dual-level hybrid), HippoRAG (PPR as primary ranker)  
**Acceptance criteria**:
- `graph_query` with `language: 'natural'` uses hybrid retriever, not regex Cypher
- `language: 'cypher'` still passes directly to Memgraph (escape hatch)
- BM25-Plus index covers `name` and `summary` fields for all FUNCTION, CLASS, FILE nodes
- RRF fusion score outperforms vector-only baseline on benchmark set (target: ≥5% improvement on P@5)
- No regression in `test_select`, `impact_analyze`, `code_explain` (all use hybrid internally)

#### 8.1 Architecture change: NL→Hybrid instead of NL→Cypher

Current flow:
```
NL question → routeNaturalToCypher() [regex intent detection → hardcoded Cypher template] → graph
```

New flow:
```
NL question ─┬─► Retriever 1: Vector similarity (Qdrant)   ─┐
              ├─► Retriever 2: BM25-Plus (Memgraph text_search) ─► RRF fusion ─► ranked results
              └─► Retriever 3: Graph traversal from top BM25+Vec results ───────┘
```

Reserve raw Cypher for **explicit structural queries only** (`language: 'cypher'`).

#### 8.2 New module: `src/graph/hybrid-retriever.ts`

```typescript
// src/graph/hybrid-retriever.ts
export interface RetrievalOptions {
  query:      string;
  projectId:  string;
  limit?:     number;       // default: 10
  types?:     string[];     // filter by node type
  mode?:      'vector' | 'bm25' | 'graph' | 'hybrid'; // default: 'hybrid'
  rrfK?:      number;       // RRF constant k (default: 60)
}

export interface RetrievalResult {
  nodeId:    string;
  name:      string;
  filePath:  string;
  type:      string;
  rrfScore:  number;
  scores:    { vector?: number; bm25?: number; graph?: number };
}

export class HybridRetriever {
  async retrieve(opts: RetrievalOptions): Promise<RetrievalResult[]>;
  private async vectorSearch(query: string, opts: RetrievalOptions): Promise<RankedNode[]>;
  private async bm25Search(query: string, opts: RetrievalOptions): Promise<RankedNode[]>;
  private async graphExpansion(seedIds: string[], opts: RetrievalOptions): Promise<RankedNode[]>;
  private fusionRRF(lists: RankedNode[][], k: number): RetrievalResult[];
}
```

#### 8.3 RRF fusion formula

$$\text{score}(d) = \sum_{i=1}^{N} \frac{1}{k + \text{rank}_i(d)}$$

where:
- $k = 60$ (standard constant — minimises sensitivity to high-rank outliers)
- $\text{rank}_i(d)$ = 1-based rank of document $d$ in list $i$
- Documents not present in a list get $\text{rank}_i(d) = \infty$ (contribute 0)
- $N$ = number of retrievers (3: vector, BM25, graph)

```typescript
function fusionRRF(lists: RankedNode[][], k = 60): RetrievalResult[] {
  const scores: Map<string, number> = new Map();
  for (const list of lists) {
    list.forEach((node, i) => {
      const prev = scores.get(node.id) ?? 0;
      scores.set(node.id, prev + 1 / (k + i + 1));
    });
  }
  return [...scores.entries()]
    .sort(([,a], [,b]) => b - a)
    .map(([id, rrfScore]) => ({ nodeId: id, rrfScore, ... }));
}
```

#### 8.4 BM25-Plus index setup

Use **BM25-Plus** (not standard BM25). BM25-Plus adds a lower-bound $\delta$ to term-frequency, preventing long documents from being disproportionately penalised. Critical for code where symbol frequency varies wildly.

$$\text{BM25-Plus}(q,d) = \sum_{t \in q} \text{IDF}(t) \cdot \left(\delta + \frac{f(t,d) \cdot (k_1+1)}{f(t,d) + k_1(1-b+b \cdot |d|/\text{avgdl})}\right)$$

Recommended: $k_1=1.2$, $b=0.75$, $\delta=0.25$.

**Fields indexed** (Memgraph `text_search` module):

```cypher
// Create full-text index (Memgraph 2.x)
CALL text_search.create_index('symbol_index', 'FUNCTION|CLASS|FILE',
  ['name', 'summary', 'path'], {analyzer: 'standard'});

// Query
CALL text_search.search('symbol_index', $queryText)
YIELD node, score
WHERE node.projectId = $pid
RETURN node, score ORDER BY score DESC LIMIT $k
```

- `name` — exact symbol name (boost ×3 — highest precision signal)
- `summary` — Phase 1.4 Meta-RAG-generated NL summary (boost ×2)
- `path` — file path segments (boost ×1 — catches "find all files in tools/")
- Raw `code` is **NOT indexed in BM25** — too large and noisy; `summary` replaces it

#### 8.5 Drop-in swap in `tool-handlers.ts`

The existing `routeNaturalToCypher()` function (marked `TODO: replace with hybrid retriever in Phase 8`) is replaced:

```typescript
// Before (Phase 8 not yet applied):
const result = await routeNaturalToCypher(args.query, client, projectId);

// After (Phase 8 applied):
const retriever = new HybridRetriever(client, qdrant, embedding);
const results = await retriever.retrieve({ query: args.query, projectId, limit: args.limit ?? 10 });
```

All tools that called `routeNaturalToCypher` benefit automatically: `graph_query`, `find_pattern`, `arch_validate` natural mode.

**Implementation status (2026-02-21)**:
- ✅ Added `src/graph/hybrid-retriever.ts` with hybrid retrieval pipeline: vector retrieval, BM25-style lexical retrieval, graph expansion, and RRF fusion.
- ✅ Integrated `HybridRetriever` into `src/tools/tool-handlers.ts` for `graph_query` when `language: 'natural'` in both `local` and `hybrid` modes.
- ✅ Removed legacy regex `routeNaturalToCypher()` path from natural query handling and retained direct Memgraph passthrough for `language: 'cypher'`.
- ✅ Added temporal filtering over hybrid retrieval rows for `asOf` in natural mode.
- ✅ Smoke-validated `graph_query` over MCP session flow (`initialize` + `mcp-session-id` + `graph_set_workspace`) on fresh build.
- ℹ️ BM25 path currently uses in-memory lexical scoring (name/path/summary token matching). Memgraph `text_search` can be re-enabled later where full-text indexes are guaranteed.

---

### Phase 9 — Multi-Language Support
**Goal**: Server works identically for Python, Go, Rust, and Java projects.  
**Estimated effort**: 3–4 weeks  
**Depends on**: Phase 2 (SCIP IDs already language-agnostic encoding), Phase 8 (hybrid retriever is language-agnostic)  
**Unblocks**: nothing — expands user base while keeping all existing tools intact  
**Research backing**: Tree-sitter is the industry standard (used by GitHub Linguist, Neovim, VS Code syntax engine)  
**Acceptance criteria**:
- `graph_rebuild` on a Python project creates FILE/FUNCTION/CLASS nodes with correct SCIP IDs
- `code_explain` works on a Python function: correct callers/callees
- All existing TypeScript tests still pass after parser refactor
- Language detection works by file extension
- Fallback: unknown languages get FILE nodes only (no function/class breakdown)

#### 9.1 Parser abstraction interface

**File**: `src/parsers/parser-interface.ts`

```typescript
// src/parsers/parser-interface.ts
export interface ParsedSymbol {
  type:       'function' | 'class' | 'method' | 'variable' | 'interface' | 'import';
  name:       string;
  startLine:  number;
  endLine:    number;
  kind?:      string;            // 'async', 'exported', 'abstract', 'interface', etc.
  scopePath?: string;            // parent class/namespace for SCIP ID generation
  calls?:     string[];          // direct call references within this symbol
  imports?:   string[];          // modules imported (for FILE-level symbols)
}

export interface ParseResult {
  file:     string;
  language: string;
  symbols:  ParsedSymbol[];
}

export interface LanguageParser {
  readonly language: string;        // 'typescript' | 'python' | 'go' | 'rust'
  readonly extensions: string[];    // ['.ts', '.tsx']
  parse(filePath: string, content: string): Promise<ParseResult>;
}
```

#### 9.2 Parser registry

**File**: `src/parsers/parser-registry.ts`

```typescript
export class ParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();

  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) this.parsers.set(ext, parser);
  }

  async parse(filePath: string, content: string): Promise<ParseResult | null> {
    const ext = path.extname(filePath).toLowerCase();
    const parser = this.parsers.get(ext);
    if (!parser) return null; // returns FILE node only from builder
    return parser.parse(filePath, content);
  }
}

// Registration in GraphBuilder constructor:
registry.register(new TypeScriptParser());  // Tree-sitter TypeScript
registry.register(new PythonParser());
registry.register(new GoParser());
registry.register(new RustParser());
```

#### 9.3 Language-to-import mapping

| Language | Import construct | IMPORT edge source |
|---|---|---|
| TypeScript | `import { X } from 'mod'` | Both named and default imports |
| Python | `import mod`, `from mod import X` | Module-level; `from . import X` for relative |
| Go | `import "pkg/path"` | Package path string |
| Rust | `use crate::module::Symbol` | `use` statement path segments |
| Java | `import com.example.Class` | Fully-qualified class references |

All produce `(file)-[:IMPORTS]->(dep)` edges where `dep` may be an external node (no source in graph).

#### 9.4 Tree-sitter setup

```bash
npm install --save node-tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-go tree-sitter-rust
```

```typescript
// src/parsers/tree-sitter-base.ts
import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';

export abstract class TreeSitterParser implements LanguageParser {
  protected parser: Parser;
  constructor(language: Parser.Language) {
    this.parser = new Parser();
    this.parser.setLanguage(language);
  }
  async parse(filePath: string, content: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    return this.walkTree(filePath, tree);
  }
  protected abstract walkTree(filePath: string, tree: Parser.Tree): ParseResult;
}
```

#### 9.5 Migration from current regex TypeScript parser

The current `src/parsers/typescript-parser.ts` uses regex patterns. Migration is non-breaking:
1. New `src/parsers/tree-sitter-typescript-parser.ts` implements `LanguageParser` using Tree-sitter
2. Both parsers coexist during transition, controlled by `CODE_GRAPH_USE_TREE_SITTER=true` env var
3. After verification (all existing tests pass), old regex parser is removed
4. `src/parsers/typescript-parser.ts` becomes a re-export shim for backwards compat

---

### Phase 10 — File Watch / Incremental Push
**Goal**: Graph stays current automatically. Agents never need to manually trigger rebuilds.  
**Estimated effort**: 1 week  
**Depends on**: Phase 2 (GRAPH_TX for each incremental rebuild), Phase 9 (parsers are file-level so watcher can process one file at a time)  
**Unblocks**: nothing — enables all tools to reflect live filesystem state without manual intervention  
**Research backing**: LightRAG (incremental update algorithm as core design principle), chokidar (battle-tested Node.js file watcher)  
**Acceptance criteria**:
- Saving a TypeScript file triggers a graph update within 1.5 s (500ms debounce + parse + MERGE)
- `graph_health.pendingChanges` accurately reflects files queued but not yet processed
- Watcher ignores `node_modules`, `dist`, `.git`, and paths in `CODE_GRAPH_IGNORE_PATTERNS`
- Each incremental update creates a `GRAPH_TX` node (type = 'incremental') in Memgraph
- SCIP O(changes): unchanged files touch zero graph writes

#### 10.1 New module: `src/graph/watcher.ts`

```typescript
// src/graph/watcher.ts
import chokidar from 'chokidar';

export interface WatcherOptions {
  workspaceRoot: string;
  projectId:     string;
  debounceMs?:   number;        // default: 500
  ignorePatterns?:string[];     // added to built-in ignore list
}

export class FileWatcher {
  private watcher:     chokidar.FSWatcher;
  private state:       WatcherState = 'idle';
  private pending:     Set<string> = new Set();
  private debounceTimer?: NodeJS.Timeout;

  constructor(private opts: WatcherOptions, private orchestrator: GraphOrchestrator) {}

  start(): void;
  stop(): void;
  get pendingChanges(): number { return this.pending.size; }
}

type WatcherState = 'idle' | 'detecting' | 'debouncing' | 'rebuilding';
```

#### 10.2 State machine

```
                 file change detected
idle ──────────────────────────────────► detecting
                                              │
                                    start 500ms timer
                                              │
                          more changes arrive │ reset timer
                                              ▼
                                         debouncing
                                              │
                                    timer fires (no new changes)
                                              │
                                              ▼
                                         rebuilding ◄─────────────────────────────────┐
                                              │                                        │
                                   incremental rebuild runs                            │
                               (process pending file list only)                        │
                                              │                                        │
                                   rebuild complete → GRAPH_TX                         │
                                              │                                        │
                                              ├─ new files detected during rebuild? ───┘
                                              │
                                              ▼
                                           idle
```

#### 10.3 O(changes) incremental rebuild — SCIP principle

Because all nodes use stable SCIP-style human-readable IDs, incremental updates are pure `MERGE` operations — only nodes whose source has changed are re-parsed:

```typescript
// FileWatcher triggers:
await orchestrator.rebuildIncremental({
  projectId: opts.projectId,
  changedFiles: [...this.pending],  // only modified/added/deleted files
});
this.pending.clear();
```

```cypher
// Phase 2 MERGE pattern — reused for incremental
// For each changed file, invalidate old version and create new:
MATCH (old:FILE {path: $path, projectId: $pid, validTo: null})
SET old.validTo = $now;

MERGE (f:FILE {id: $scip_id, projectId: $pid})
ON CREATE SET f.createdAt = $now
SET f.validFrom = $now,
    f.validTo   = null,
    f.path      = $path,
    f.language  = $lang;

// Create GRAPH_TX for this incremental update
CREATE (tx:GRAPH_TX {
  id:           $txId,
  projectId:    $pid,
  type:         'incremental',
  timestamp:    $now,
  filesAffected:$changedFiles,
  nodeCount:    $nodesWritten,
  durationMs:   $elapsed
})
```

Unchanged files: **zero graph writes**. For a 1000-file codebase where 2 files changed, exactly 2 files are re-parsed.

#### 10.4 `graph_health` pendingChanges integration

```typescript
// In graph_health handler:
const watcher = watcherRegistry.get(projectId);
return {
  ...existingHealthFields,
  pendingChanges: watcher?.pendingChanges ?? 0,
  watcherState:   watcher?.state ?? 'not_started',
};
```

#### 10.5 Startup integration in `graph_set_workspace`

When `graph_set_workspace` is called in HTTP mode, a `FileWatcher` is created and started for the workspace root. In stdio mode, watcher is opt-in via `CODE_GRAPH_ENABLE_WATCHER=true` env var (default false — stdio sessions are typically short-lived).

```typescript
// In tool-handlers.ts, graph_set_workspace handler:
if (process.env.MCP_TRANSPORT === 'http' || process.env.CODE_GRAPH_ENABLE_WATCHER === 'true') {
  const watcher = new FileWatcher({ workspaceRoot, projectId, debounceMs: 500 }, orchestrator);
  watcherRegistry.set(projectId, watcher);
  watcher.start();
}
```

---

## 4. New Tool Inventory (complete list)

After all phases, the server will expose the following tools:

### Existing (improved)
| Tool | Changes |
|---|---|
| `graph_query` | Answer-first format; `mode: local\|global\|hybrid`; `asOf` param; hybrid retrieval for NL |
| `code_explain` | Returns `semantic_slice` per dep; `summary` field; PPR scores |
| `find_pattern` | Grouped violations with fix suggestions |
| `arch_validate` | Multi-language; community-aware layer checks |
| `arch_suggest` | Uses `context_pack` + community context internally |
| `test_select` | Temporal-aware (affected since `validFrom` change) |
| `test_categorize` | Multi-language test file detection |
| `impact_analyze` | Integrates with coordination claims |
| `test_run` | Token-efficient output; stores result as `TEST_RESULT` episode |
| `progress_query` | Persistent (graph-backed), paginated, filterable |
| `task_update` | Releases claims on completion; triggers learning extraction |
| `feature_status` | Includes code coverage from graph |
| `blocking_issues` | Includes claim conflicts |
| `graph_rebuild` | Creates `GRAPH_TX` node; starts Leiden community detection |
| `graph_set_workspace` | Starts file watcher (Phase 10) |
| `graph_health` | Adds `pendingChanges` and `recentEvents` |

### New Phase 2 — Bi-Temporal Model
_(No new tools — changes the graph schema. All existing query tools gain `asOf` param.)_

### New Phase 3 — Episode Memory
| Tool | Description |
|---|---|
| `episode_add` | Persist an observation, decision, edit, test result, or error |
| `episode_recall` | Hybrid search: vector + temporal + graph proximity |
| `decision_query` | Find DECISION episodes affecting given files/symbols |
| `reflect` | Synthesize recent episodes into REFLECTION + LEARNING nodes |

### New Phase 4 — Coordination
| Tool | Description |
|---|---|
| `agent_claim` | Claim a task/file with intent (temporal invalidation, not TTL) |
| `agent_release` | Release a claim; stores outcome as EPISODE |
| `agent_status` | Active claims + recent episodes for an agent |
| `coordination_overview` | Fleet view: who owns what, stale claims, conflicts |

### New Phase 5 — Context Pack
| Tool | Description |
|---|---|
| `context_pack` | Single-call PPR-ranked full briefing: code + decisions + learnings |

### New Phase 6 — Code Slicing
| Tool | Description |
|---|---|
| `semantic_slice` | Relevant code lines with PPR score + graph context |

### New Phase 7 — Community Detection
_(No new tools by default — `graph_query` gains `mode: global` param. Optional `community_list` tool.)_

### New Phase 8 — Temporal Diff
| Tool | Description |
|---|---|
| `diff_since` | What changed since a txId / gitCommit / agentId / ISO timestamp |

**Total: ~34 tools** (14 existing improved + 10 new)

---

## 5. Execution Sequence (Priority Order)

Ordered by agent ROI × implementation effort ratio:

```
Priority 1 — Foundation (must come first; everything else builds on these):
  Phase 1:  Response quality + context budget model
  Phase 2:  Bi-temporal model (validFrom/validTo on all nodes)

Priority 2 — Core agent memory (unblocks persistent workflows):
  Phase 3:  Episode-based memory (EPISODE, DECISION, LEARNING, REFLECTION nodes)
  Phase 4:  Agent coordination (CLAIM nodes with temporal invalidation)

Priority 3 — The flagship feature (justifies the whole project):
  Phase 5:  context_pack with PPR-ranked retrieval

Priority 4 — Quality + completeness:
  Phase 6:  semantic_slice (actual code lines, not paths)
  Phase 7:  Community detection (Leiden + summaries, global query mode)
  Phase 8:  Hybrid retrieval (replaces NL→Cypher for most queries)

Priority 5 — Platform breadth:
  Phase 9:  Multi-language parsers (Tree-sitter)
  Phase 10: File watcher (incremental push)
```

---

## 6. Data Model Summary (Graph additions)

```
New node types:
  EPISODE      — atomic agent interaction record (observation/edit/decision/etc.)
  REFLECTION   — synthesized higher-level insight from multiple episodes
  LEARNING     — durable extracted pattern linked to code nodes
  CLAIM        — agent ownership of task/file (temporal invalidation)
  COMMUNITY    — Leiden cluster of tightly-coupled files/modules
  GRAPH_TX     — transaction record for each rebuild/file-change

New relationship types:
  (EPISODE)-[:INVOLVES]->(FILE|FUNCTION|CLASS)
  (EPISODE)-[:NEXT_EPISODE]->(EPISODE)
  (REFLECTION)-[:DERIVED_FROM]->(EPISODE)
  (LEARNING)-[:APPLIES_TO]->(FILE|FUNCTION)
  (CLAIM)-[:TARGETS]->(TASK|FILE|FEATURE)
  (FILE)-[:BELONGS_TO]->(COMMUNITY)
  (GRAPH_TX)-[:AFFECTS]->(FILE)

Modified existing nodes (bi-temporal fields added to ALL):
  FILE, FUNCTION, CLASS, IMPORT:
    +validFrom: timestamp
    +validTo:   timestamp | null
    +createdAt: timestamp
    +txId:      string
```

---

## 7. Key Design Rules

1. **Answer-first**: Every tool response starts with a `summary` field. Agents read that; full `data` is optional.
2. **Fail with hints**: Errors always include a `hint` field with a concrete next action.
3. **No TTLs — temporal invalidation**: Claims are invalidated by code change events (`validTo` set), not by timer. This makes coordination reliable across long-running agents.
4. **Graph is source of truth**: All state (episodes, decisions, claims, learnings) lives in Memgraph, not RAM. The progress engine is migrated to be fully graph-backed.
5. **Profiles everywhere**: All tools accept `profile: 'compact' | 'balanced' | 'debug'`. Default is `compact`.
6. **One workspace = one projectId**: All nodes are scoped. Multi-project support is automatic.
7. **No secrets in the graph**: Code structure only. Episodes/decisions containing secrets must be flagged as `sensitive: true` and excluded from default query results.
8. **Nothing is deleted — only superseded**: The bi-temporal model means old node versions are preserved with `validTo` set. Historical queries are always available.
9. **PPR over iterative retrieval**: Use Personalized PageRank for context gathering. Never chain 5+ graph lookups when PPR can do it in one traversal.
10. **Self-improving**: As agents complete tasks, `reflect()` extracts learnings that improve future `context_pack` quality.
11. **Structure-aware chunking only**: Code is never sliced mid-function or mid-class. Every indexing unit (for BM25, vectors, Meta-RAG summaries, and semantic_slice) is a complete AST syntactic unit — function body, class definition, or import block. Partial chunks are a correctness bug, not a compression strategy.
12. **SCIP-style human-readable IDs**: All FUNCTION, CLASS, and FILE nodes use `{relativePath}::{ClassName}::{method}` identifiers. UUIDs are never used as primary graph node keys. This enables O(changes) incremental indexing via `MERGE` and makes Cypher queries self-documenting.

---

## 8. File Structure (target)

```
src/
  engines/
    architecture-engine.ts   (existing)
    coordination-engine.ts   ← NEW Phase 4
    episode-engine.ts        ← NEW Phase 3
    migration-engine.ts      (existing)
    progress-engine.ts       (existing → migrate to graph-backed)
    test-engine.ts           (existing)
  graph/
    builder.ts               (existing → add validFrom/validTo/txId to all nodes)
    cache.ts                 (existing)
    client.ts                (existing)
    community-detector.ts    ← NEW Phase 7 (Leiden via Memgraph algorithm)
    hybrid-retriever.ts      ← NEW Phase 8 (vector + BM25 + PPR fusion)
    index.ts                 (existing)
    orchestrator.ts          (existing → add buildFile, GRAPH_TX creation)
    ppr.ts                   ← NEW Phase 5 (Personalized PageRank wrapper)
    types.ts                 (extend with temporal + episode types)
    watcher.ts               ← NEW Phase 10
  parsers/
    parser-interface.ts      ← NEW Phase 9
    typescript-parser.ts     (existing → migrate to Tree-sitter)
    treesitter-parser.ts     ← NEW Phase 9 (all languages)
  response/
    budget.ts                ← NEW Phase 1 (ContextBudget allocation)
    shaper.ts                ← NEW Phase 1 (answer-first formatter)
  tools/
    context-pack.ts          ← NEW Phase 5
    coordination-tools.ts    ← NEW Phase 4
    episode-tools.ts         ← NEW Phase 3
    semantic-slice.ts        ← NEW Phase 6
    tool-handlers.ts         (existing, extend)
    vector-tools.ts          (existing)
```

---

## 9. Success Metrics

| Metric | Current | Target | Phase |
|---|---|---|---|
| Avg tokens per tool call (response) | ~800 | <300 (compact profile) | 1 |
| Tool calls needed to start a task | 5–8 | 1 (`context_pack`) | 5 |
| Agent memory persistence across restarts | None | Full (EPISODE nodes) | 3 |
| Cross-agent state conflicts | Undetected | 0 (claim + temporal invalidation) | 4 |
| Historical query support ("what was true at T?") | None | Full (`asOf` on all queries) | 2 |
| Multi-hop QA accuracy (NL queries) | ~60% | >80% (PPR-based retrieval) | 5 |
| Languages supported | 1 (TypeScript) | 4 (TS, Python, Go, Rust) | 9 |
| Graph staleness after file change | Until next rebuild | <5 seconds (watcher) | 10 |
| Context pack token efficiency vs. 8 calls | N/A — tool doesn't exist | ≥10x reduction | 5 |
