# lxDIG MCP — Roadmap

This document is the single source of truth for planned and pending work. It consolidates findings from audit reports, internal action plans, the alternatives research, and feature requests into one prioritized backlog.

Items are organized by tier — near-term reliability work first, then capability expansion, then platform and scale. Within each tier, items are ordered by impact.

---

## How to read this file

| Symbol | Meaning |
|---|---|
| 🔴 | Known bug or active degradation — affects users today |
| 🟡 | Gap or limitation — degrades quality but does not break |
| 🟢 | Planned improvement — not a bug, adds new value |
| 🔵 | Long-term / strategic — significant scope or dependency |

---

## Tier 1 — Stability and reliability

These are bugs, active degradations, and hardening gaps identified across audit cycles. They should be resolved before the feature backlog is expanded.

### 1.1 🔴 `test_run` inherits wrong Node.js from server PATH

**Source:** Self-audit SX4 (2026-02-24)

`test_run` calls `child_process.exec("npx vitest run ...")` and inherits the server process's `PATH`, which may resolve to the system Node (e.g. v10.19.0) instead of the project's managed Node (nvm/volta/pkgx).

**Fix:** In `test_run`, resolve the `node` binary to `process.execPath` and derive `npx` from the same directory, instead of relying on inherited `PATH`.

---

### 1.2 🔴 Graph/index readiness gates not enforced

**Source:** PLANS_PENDING_ACTIONS_SUMMARY P0.1, AUDITS_EVALUATIONS_SUMMARY

Analysis tools (`impact_analyze`, `test_select`, `semantic_search`, etc.) can be called before `graph_rebuild` completes and return empty or misleading results with no clear error.

**Fix:** Add a readiness gate check at the start of all analysis tools. If graph state is stale or rebuild is in progress, return a structured error with a direct remediation hint (`graph_health` → `graph_rebuild`).

---

### 1.3 🔴 REFERENCES edges not created for TypeScript `.js` imports

**Source:** Self-audit SX3 (2026-02-24) — fix applied, requires restart + full rebuild

`resolveImportPath()` in `builder.ts` did not strip `.js`/`.jsx` before probing disk candidates, producing 0 REFERENCES edges for TypeScript projects using `moduleResolution: node16/bundler`. Without REFERENCES edges, `impact_analyze` and `test_select` return 0 results.

**Status:** Fix applied in source. Requires server restart + `graph_rebuild(mode: full)` to activate.

---

### 1.4 🟡 CLASS and FUNCTION nodes missing `path` property

**Source:** Self-audit SX2

All CLASS and FUNCTION nodes have `path: null`. Path is only accessible by traversing the `CONTAINS` edge to the parent FILE node. This forces an extra JOIN in any tool that resolves a symbol to a file path, and breaks community detection (see SX5).

**Fix:** Add `filePath` property (= parent FILE's absolute path) to CLASS and FUNCTION nodes in `builder.ts` at index time.

---

### 1.5 🟡 SECTION.title not populated without summarizer

**Source:** Self-audit SX1

All 943 SECTION nodes have `title: null` when `LXDIG_SUMMARIZER_URL` is not configured. Search results and doc lookups surface no human-readable title.

**Fix:** Add heuristic H1/H2 heading extraction to the markdown parser as a fallback, so SECTION nodes always have a title regardless of summarizer availability.

---

### 1.6 🟡 Embedding coverage is zero when summarizer is unconfigured

**Source:** Self-audit F5 (related to F8)

When `LXDIG_SUMMARIZER_URL` is not set, 0 embeddings are generated across all FUNCTION and CLASS nodes. All semantic tools (`semantic_search`, `find_similar_code`, `code_clusters`) fall back to lexical-only results with no warning to the user.

**Fix:** Surface a clear warning in `graph_health` output when embedding coverage is 0% — distinct from the normal "Qdrant not connected" case. Document the `LXDIG_SUMMARIZER_URL` requirement more prominently in setup.

---

### 1.7 🟡 Contract strictness and argument normalization gaps

**Source:** PLANS_PENDING_ACTIONS_SUMMARY P1.3, AUDITS_EVALUATIONS_SUMMARY

Edge-case argument handling and input normalization is inconsistent across tools. Clients that pass slightly malformed arguments get varying error shapes.

**Fix:** Sweep all tool contracts in `src/tools/registry.ts` and handler modules. Normalize edge cases. Align error envelopes to a single shape across all profile levels.

---

### 1.8 🟡 Missing lifecycle failure-mode tests

**Source:** PLANS_PENDING_ACTIONS_SUMMARY P1.4

No test coverage exists for: graph rebuild in-progress state, session reconnect after drop, stale index queries, or the stdio vs HTTP mode boundary conditions.

**Fix:** Add integration tests covering these scenarios to prevent regressions in known failure families.

---

### 1.9 🟡 Workspace/session path ambiguity at onboarding

**Source:** PLANS_PENDING_ACTIONS_SUMMARY P0.2, AUDITS_EVALUATIONS_SUMMARY

Host path vs `/workspace` container path confusion is the most common first-run failure. Documentation gives different examples in different places.

**Fix:** Normalize all path examples in `README.md`, `QUICK_START.md`, and `docs/MCP_INTEGRATION_GUIDE.md` to one canonical section per transport mode. Add a runtime guard that detects Docker context and emits a path-format hint.

---

## Tier 2 — Core capability improvements

These are well-scoped improvements to existing tools and subsystems. They increase the quality and reliability of what lxDIG already does.

### 2.1 🟢 Risk-aware metadata on `impact_analyze` and `code_explain`

**Source:** Alternatives research (CodeMCP pattern)

`impact_analyze` returns blast radius but does not attach ownership (who wrote the code being changed) or hotspot scoring (is this a frequently modified volatile file?). Agents making change decisions have to infer risk from the raw data.

**Improvement:** Add `gitBlameOwner` (time-weighted last author) and `changeFrequency` (commits in last 90 days) fields to `impact_analyze` and `code_explain` responses. Return a pre-computed `riskScore` so agents do not need to infer it.

---

### 2.2 🟢 Compound tool: `change_risk_pack`

**Source:** Alternatives research (CodeMCP compound operations — up to 70% fewer tool calls)

A common agent workflow requires 4 sequential calls to answer "is it safe to change this?": `graph_query` → `code_explain` → `impact_analyze` → `test_select`. Each round trip costs tokens and latency.

**Improvement:** Add a compound tool `change_risk_pack` (or extend `context_pack`) that executes all four internally and returns a single structured answer: blast radius + owners + affected tests + architectural violations + risk score.

---

### 2.3 🟢 Heuristic section title extraction (no summarizer required)

**Source:** Self-audit SX1

Partial overlap with 1.5 — the broader improvement is making section/doc indexing genuinely useful at zero configuration, without requiring an external LLM summarizer endpoint.

**Improvement:** Parse H1–H3 headings from markdown as section titles. Optionally use first non-empty paragraph as description. The summarizer, if configured, upgrades these with semantic titles.

---

### 2.4 🟢 Observability and KPI cadence

**Source:** PLANS_PENDING_ACTIONS_SUMMARY P2.6

No structured baseline exists for rebuild latency, health failures, contract failures, or benchmark drift. Regression detection is manual.

**Improvement:** Define a recurring KPI set. Publish snapshot summaries per release. Wire `benchmark:check-regression` into CI as a non-blocking advisory check with drift thresholds.

---

### 2.5 🟢 `test_run` resolves `vitest` from project's local `node_modules`

**Source:** Self-audit SX4 (broader fix than the PATH workaround)

Even after fixing the Node PATH issue, `test_run` needs to resolve `vitest` from the indexed project's own `node_modules/.bin`, not from the server's context. Projects may use different test runners or versions.

**Improvement:** Make `test_run` resolve the test runner binary from `{workspaceRoot}/node_modules/.bin/` with a fallback to `npx`. Support configurable runner (`vitest`, `jest`, `mocha`) per project.

---

## Tier 3 — New capabilities

These are features that do not exist yet and expand what lxDIG can do.

### 3.1 🟢 Real-time transparent graph sync

Continuous file-watching already exists, but graph and vector index updates are not surfaced as observable events. Agents poll `graph_health` to know when the graph is current, and users have no passive signal.

**Target:** Surface graph sync state as a live observable — emit events when files change, when a rebuild starts, and when the graph becomes consistent. Agents and IDE extensions can subscribe without polling.

---

### 3.2 🟢 Automatic API surface mapping

**Source:** Alternatives research (CIE kraklabs pattern)

No framework-aware parsing exists. Express routes, Fastify plugins, FastAPI paths, and Spring endpoints are stored as generic function nodes — an agent must infer that a function is an HTTP endpoint.

**Target:** Framework-aware parsers that tag `ENDPOINT` nodes with HTTP method + path on the graph. Support Express, Fastify (TypeScript/JS), FastAPI (Python), Spring (Java). An agent can ask "what routes does this service expose?" and get a structured list.

---

### 3.3 🟢 Domain knowledge layer

Link external knowledge sources — documentation, standards, specifications, research articles — directly to code symbols as graph nodes, connected via typed edges.

**Examples:**
- `calculateBMI` function → linked to CDC/WHO clinical reference
- `processPayment` function → linked to PCI-DSS requirements
- `UserProfile` model with GDPR-scoped fields → linked to GDPR article nodes
- `encryptData` function → linked to NIST cryptographic standards

**Target:** A `domain_link` tool to attach external sources to symbols. A `domain_search` tool to query what real-world context is attached to a symbol or file. Domain nodes are first-class graph citizens, searchable via BM25 and vector queries alongside code nodes.

---

### 3.4 🟢 Language Server Protocol (LSP) integration

**Source:** README roadmap

Tree-sitter provides syntactic structure. LSP provides semantic structure: hover types, go-to-definition, find-all-references, rename symbols — compiler-accurate for any language with an LSP server.

**Target:** Optional LSP backend (`LXDIG_LSP=true`) that enriches graph nodes with LSP-derived type information and cross-file reference resolution. Complements tree-sitter (which handles speed and zero-config) with semantic depth for projects that have a working language server.

---

### 3.5 🟢 SCIP precision tier (opt-in)

**Source:** Alternatives research (CodeMCP, CIE patterns)

Tree-sitter is syntactic and struggles with polymorphic calls and implicit types. SCIP (Semantic Code Intelligence Protocol) is compiler-accurate: it resolves which concrete implementation is called, tracks interface dispatch, and produces stable cross-repository symbol IDs.

**Target:** SCIP as an opt-in precision tier (`LXDIG_PARSER=scip`). Language support: TypeScript (via `scip-typescript`), Go (`scip-go`), Java (`scip-java`). SCIP symbol IDs are stored on graph nodes alongside SCIP IDs, enabling cross-repo graph linking.

---

### 3.6 🟢 Interface dispatch resolution

**Source:** Alternatives research (CIE pattern)

`code_explain` on an interface or abstract class shows callers of the interface, but not which concrete implementation executes at runtime. Agents must guess.

**Target:** Add `resolvedImplementations` to `code_explain` for interface/abstract symbols — "this `UserRepository` call resolves to `PostgresUserRepository` in the production config." Requires either LSP (3.4) or SCIP (3.5) as a backing parser.

---

### 3.7 🟢 MCP `resources` surface

**Source:** README roadmap, MCP specification 2025-06-18

The MCP protocol supports `resources` as a first-class concept (alongside `tools` and `prompts`). Graph nodes — files, functions, classes, documents — are natural resources.

**Target:** Expose graph nodes as MCP resources so clients that support resource browsing (file trees, symbol lists) can navigate the graph without making tool calls. Resources stay in sync with the live graph.

---

### 3.8 🟢 Webhook-triggered graph rebuilds

**Source:** README roadmap

Today, rebuilds are triggered manually or by the file watcher during active sessions. In CI environments, the server may be remote and the file watcher is not active.

**Target:** HTTP endpoint (`POST /webhook/push`) that accepts a GitHub/GitLab/Gitea push event payload and triggers an incremental graph rebuild for the affected files. Enables CI-integrated graph freshness without a persistent watcher.

---

### 3.9 🟢 Plugin API for custom tool registration

**Source:** README roadmap

All 39 tools are compiled into the server. There is no way to add domain-specific tools without modifying the source.

**Target:** A plugin API that allows registering additional MCP tools from external modules. Plugins are loaded at startup from a configured directory or `package.json` `lxdig.plugins` field. Each plugin exports a tool definition and handler following the existing registry contract.

---

### 3.10 🟢 Improved Go, Rust, and Java parser coverage

**Source:** README roadmap

Tree-sitter grammars for Go, Rust, and Java are listed as optional dependencies, but symbol extraction quality (especially for generics, traits, and annotations) lags behind TypeScript/Python.

**Target:** Improve extractor coverage for:
- Go: interfaces, embedded structs, method sets
- Rust: traits, impl blocks, lifetimes (as metadata)
- Java: annotations, generics, Spring component scanning

---

## Tier 4 — Platform and scale

These are features that require significant architectural work or external dependencies. They are the longer-term direction.

### 4.1 🔵 Multi-user coordination

The current coordination model (claims, releases, agent_status) is designed for multiple AI agents. Human developers working on the same repository from different machines or sessions have no shared view.

**Target:** Shared coordination state across multiple human developer sessions — shared agent memory, task ownership visible to the whole team, conflict detection when two developers (or their agents) claim the same file or task. Requires a shared Memgraph instance (already possible with HTTP transport) and an identity/session model.

---

### 4.2 🔵 Pre-indexed bundle registry

**Source:** Alternatives research (CodeGraphContext pattern)

Every repository must be indexed from scratch. For popular open-source libraries (React, Express, Django, FastAPI, Spring Boot), this is redundant work that every user repeats.

**Target:** A community-maintained registry of pre-built graph bundles for popular open-source libraries. Bundles are loaded alongside the project graph and enable agents to traverse into dependency internals. Natural seed for lxDIG Cloud's managed graph service.

---

### 4.3 🔵 lxDIG Cloud

A hosted, zero-infrastructure version of lxDIG for individuals and teams who want the full capability without running Memgraph and Qdrant themselves.

**Scope:**
- Managed Memgraph + Qdrant, provisioned per workspace
- One-click GitHub/GitLab repository connect with webhook-driven graph sync
- Team workspaces with shared agent memory and multi-user coordination (4.1)
- Usage analytics: query patterns, agent activity, impact trends
- Subscription plans for individuals, teams, and organizations

---

## Tracking template

Use this in issues and PRs to link work back to this roadmap:

| Item | Tier | Status | PR / Issue |
|---|---|---|---|
| 1.1 test_run Node PATH | T1 | Not started | — |
| 1.2 readiness gates | T1 | Not started | — |
| 1.3 REFERENCES edges | T1 | Fix applied, pending restart | — |
| 1.4 CLASS/FN path prop | T1 | Not started | — |
| 1.5 SECTION.title fallback | T1 | Not started | — |
| 1.6 embedding coverage warning | T1 | Not started | — |
| 1.7 contract normalization | T1 | Not started | — |
| 1.8 lifecycle tests | T1 | Not started | — |
| 1.9 path ambiguity docs | T1 | Not started | — |
| 2.1 risk-aware metadata | T2 | Not started | — |
| 2.2 change_risk_pack | T2 | Not started | — |
| 2.3 section title heuristics | T2 | Not started | — |
| 2.4 KPI cadence | T2 | Not started | — |
| 2.5 test runner resolution | T2 | Not started | — |
| 3.1 real-time graph sync | T3 | Not started | — |
| 3.2 API surface mapping | T3 | Not started | — |
| 3.3 domain knowledge layer | T3 | Not started | — |
| 3.4 LSP integration | T3 | Not started | — |
| 3.5 SCIP precision tier | T3 | Not started | — |
| 3.6 interface dispatch | T3 | Not started | — |
| 3.7 MCP resources surface | T3 | Not started | — |
| 3.8 webhook rebuilds | T3 | Not started | — |
| 3.9 plugin API | T3 | Not started | — |
| 3.10 Go/Rust/Java parsers | T3 | Not started | — |
| 4.1 multi-user coordination | T4 | Planning | — |
| 4.2 bundle registry | T4 | Planning | — |
| 4.3 lxDIG Cloud | T4 | Planning | — |

---

## Sources

Internal:
- `docs/PLANS_PENDING_ACTIONS_SUMMARY.md`
- `docs/AUDITS_EVALUATIONS_SUMMARY.md`
- `docs/lxdig-self-audit-2026-02-24.md`
- `docs/TOOLS_INFORMATION_GUIDE.md`
- `plan/Researching Alternative Solutions.md`
- `README.md` roadmap section

External:
- MCP specification 2025-06-18 (modelcontextprotocol.io)
- Alternatives analysis: CodeGraphContext, CodeMCP (SimplyLiz), CIE (kraklabs), Scaffold
