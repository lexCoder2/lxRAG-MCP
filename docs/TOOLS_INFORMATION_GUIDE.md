# Tools Information Guide

## Purpose

This document consolidates tool-level information scattered across the repository into one operational reference:

- What tools exist now.
- How they are grouped.
- How to choose the right tool quickly.
- What runtime assumptions affect tool behavior.

---

## Current Tool Inventory (Authoritative)

Based on the built runtime registry (`dist/tools/registry.js`), the server currently exposes **39 tools**.

### Category counts

| Category | Count |
|---|---:|
| graph | 4 |
| utility | 3 |
| code | 7 |
| test | 5 |
| coordination | 5 |
| setup | 2 |
| arch | 2 |
| docs | 2 |
| ref | 1 |
| task | 4 |
| memory | 4 |
| **Total** | **39** |

### Complete tool list

#### Graph
- `graph_query`
- `graph_rebuild`
- `graph_set_workspace`
- `graph_health`

#### Utility
- `diff_since`
- `tools_list`
- `contract_validate`

#### Code intelligence
- `code_explain`
- `find_pattern`
- `semantic_search`
- `find_similar_code`
- `code_clusters`
- `semantic_diff`
- `semantic_slice`

#### Test intelligence
- `test_select`
- `test_categorize`
- `impact_analyze`
- `test_run`
- `suggest_tests`

#### Coordination
- `context_pack`
- `agent_claim`
- `agent_release`
- `agent_status`
- `coordination_overview`

#### Setup
- `init_project_setup`
- `setup_copilot_instructions`

#### Architecture
- `arch_validate`
- `arch_suggest`

#### Documentation
- `index_docs`
- `search_docs`

#### Reference
- `ref_query`

#### Task / progress
- `progress_query`
- `task_update`
- `feature_status`
- `blocking_issues`

#### Memory
- `episode_add`
- `episode_recall`
- `decision_query`
- `reflect`

---

## Tool Selection Cheatsheet

### Use graph tools when you need structural truth
- Start with `graph_set_workspace` + `graph_rebuild`.
- Use `graph_health` to verify readiness.
- Use `graph_query` for natural/cypher discovery.

### Use code tools for understanding and retrieval
- `code_explain` for dependency-aware symbol explanation.
- `semantic_*` tools for similarity and ranked slices.
- `find_pattern` for violations, circularity, and pattern checks.

### Use test tools to reduce execution cost
- `impact_analyze` before running tests.
- `test_select` to scope execution.
- `test_run` only on selected suites.

### Use memory and coordination for multi-agent continuity
- `episode_add` / `episode_recall` for persistent memory.
- `agent_claim` / `agent_release` to avoid collision.
- `context_pack` when entering a task or handoff.

### Use setup tools at session start
- `init_project_setup` when onboarding a repo quickly.
- `setup_copilot_instructions` when scaffolding assistant behavior docs.

---

## Runtime Notes That Affect Tool Behavior

1. **Session-scoped context**
   - Workspace/project context is tied to MCP session.
   - Re-initialize session tools after reconnect/restart.

2. **Asynchronous rebuild model**
   - `graph_rebuild` may return queued/completed state depending on threshold and load.
   - Poll with `graph_health` until graph/index state is stable.

3. **Engine availability is contextual**
   - Some outputs degrade when Memgraph/Qdrant are disconnected.
   - `errorEnvelope` responses often include recoverable hints.

4. **Profile-driven output shaping**
   - `compact` is optimized for low token budgets.
   - `balanced` and `debug` surface progressively more details.

---

## Inputs and Output Contracts

### Contract validation
- Use `contract_validate` when integrating new clients.
- It normalizes arguments and returns warnings before execution.

### Response shaping
- Standard response profile controls live in `src/response` (`budget`, `schemas`, `shaper`).
- Expected envelope shape: success/error + profile + summary + data.

---

## Known Operational Pitfalls

From audit history and integration docs:

- Calling analysis tools before `graph_rebuild` completes.
- Using wrong workspace path (`/workspace` in container vs native host path).
- Assuming one global state across multiple MCP sessions.
- Ignoring drift/health diagnostics before troubleshooting higher-level tools.

---

## External Standards Context (Research)

To keep this tool layer future-proof, the implementation aligns with:

1. **MCP specification (2025-06-18)**
   - JSON-RPC based protocol.
   - Stateful capability negotiation.
   - Tool/resource/prompt model and trust-safety constraints.

2. **Memgraph capabilities**
   - Cypher querying and graph algorithm ecosystem (MAGE).
   - Text and vector search support in querying surfaces.
   - Production deployment support (Docker/K8s/cloud, HA guidance).

3. **Qdrant capabilities**
   - AI-native vector database for semantic retrieval.
   - Collection-based indexing and performance optimization pathways.
   - Local and cloud quickstart paths.

---

## Canonical Sources

Primary internal references:
- `README.md`
- `QUICK_REFERENCE.md`
- `QUICK_START.md`
- `ARCHITECTURE.md`
- `docs/MCP_INTEGRATION_GUIDE.md`
- `docs/TOOL_PATTERNS.md`
- `src/tools/registry.ts`

External references consulted:
- https://modelcontextprotocol.io/specification/2025-06-18
- https://memgraph.com/docs
- https://qdrant.tech/documentation/
