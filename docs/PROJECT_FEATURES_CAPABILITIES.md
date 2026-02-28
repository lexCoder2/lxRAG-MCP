# Project Features and Capabilities

## Executive Summary

lexDIG-MCP is an MCP server focused on **architecture-aware code intelligence** and **agent-ready task coordination**. It combines:

- A graph plane for structural understanding.
- A semantic retrieval plane for relevance ranking.
- A task/memory plane for execution continuity.

The result is a toolset that supports repository onboarding, impact analysis, architecture validation, semantic code search, test selection, and multi-agent handoffs.

---

## Core Capability Areas

## 1) Graph and Code Understanding

- Repository graph indexing and rebuild orchestration.
- Structural query support through graph-aware tools.
- Symbol explanation with dependency-aware context.
- Pattern/violation detection (including circularity and unused structures).

Primary tools:

- `graph_query`, `graph_rebuild`, `graph_health`, `code_explain`, `find_pattern`, `code_clusters`.

## 2) Semantic Retrieval and Comparison

- Semantic search across code elements.
- Similar-code retrieval for pattern reuse and anomaly finding.
- Semantic diff and slice extraction for focused analysis.

Primary tools:

- `semantic_search`, `find_similar_code`, `semantic_diff`, `semantic_slice`.

## 3) Testing and Change Impact

- Impact analysis to identify affected tests.
- Automated test categorization and selection.
- Execution of selected test suites.

Primary tools:

- `impact_analyze`, `test_select`, `test_categorize`, `suggest_tests`, `test_run`.

## 4) Architecture Governance

- Layer/boundary validation against intended architecture.
- Suggested placement of new code based on existing topology.

Primary tools:

- `arch_validate`, `arch_suggest`.

## 5) Agent Coordination and Memory

- Task claim/release conflict prevention.
- Context packet generation for work handoffs.
- Episode and decision memory storage/retrieval.
- Reflection synthesis from prior work episodes.

Primary tools:

- `context_pack`, `agent_claim`, `agent_release`, `agent_status`, `episode_add`, `episode_recall`, `decision_query`, `reflect`.

## 6) Setup and Developer Experience

- One-shot project setup and graph initialization.
- Copilot instruction generation from repository context.
- Contract validation and utility discovery.

Primary tools:

- `init_project_setup`, `setup_copilot_instructions`, `contract_validate`, `tools_list`.

---

## Architectural Building Blocks

### Runtime

- TypeScript/Node.js MCP server.
- stdio and Streamable HTTP operation modes.
- Response shaping and profile-based outputs (`compact`, `balanced`, `debug`).

### Data planes

- **Graph plane**: Memgraph-backed structural relationships and query execution.
- **Vector plane**: Qdrant-backed semantic embeddings and nearest-neighbor retrieval.
- **Document plane**: markdown indexing + section-level search.

### Engine layers

- Architecture engine.
- Coordination engine.
- Episode/memory engine.
- Progress and test engines.
- Docs/reference utilities.

---

## Measured Signals (Current Repo Evidence)

From benchmark artifacts (`benchmarks/graph_tools_benchmark_results.json`):

- Total scenarios: **20**.
- MCP faster: **15**.
- Baseline faster: **1**.
- MCP-only successful scenarios: **4**.

Interpretation:

- The project demonstrates strong comparative behavior on synthetic graph-tool scenarios.
- Performance claims should still be treated as workload-dependent and environment-sensitive.

---

## Integration Modes

### IDE / local assistant workflows

- Strong fit for coding assistants needing fast context and architectural grounding.

### CI and scripted workflows

- Tools can be invoked for contract checks, health checks, and focused analysis.

### Multi-agent orchestration

- Claims + memory + context packs support parallel work with reduced collision risk.

---

## Ecosystem Alignment (Research-Enriched)

### Model Context Protocol alignment

- JSON-RPC transport model with capability-driven interactions.
- Stateful session expectations and explicit tool invocation semantics.
- Safety/trust design principles for tool-executing clients.

### Memgraph alignment

- Cypher-native graph querying and graph algorithm support.
- Deployment-friendly paths for local and production use.

### Qdrant alignment

- Purpose-built vector similarity platform for semantic retrieval workloads.
- Practical local/cloud deployment options for scaling retrieval fidelity.

---

## Current Non-Goals / Limits (As Documented)

- Not a general-purpose build system replacement.
- Not a universal language server replacement.
- Requires healthy graph/index state for best results.
- Output quality depends on repository coverage and indexing freshness.

---

## Canonical Sources

Internal:

- `README.md`
- `ARCHITECTURE.md`
- `QUICK_START.md`
- `QUICK_REFERENCE.md`
- `docs/MCP_INTEGRATION_GUIDE.md`
- `docs/TOOL_PATTERNS.md`

External:

- https://modelcontextprotocol.io/specification/2025-06-18
- https://memgraph.com/docs
- https://qdrant.tech/documentation/
