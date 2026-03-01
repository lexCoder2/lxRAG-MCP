<div align="center">
  <img src="docs/brain-logo.svg" alt="lxDIG MCP — MCP server for code graph intelligence, persistent agent memory, and multi-agent coordination" width="180" />
  <h1>lxDIG MCP — Code Graph Intelligence & Persistent Agent Memory for AI Coding Assistants</h1>
  <em>Stop RAGing, start DIGging.</em>
  <br/><br/>
  <p><strong>Dynamic Intelligence Graph · Agent Memory · Multi-Agent Coordination</strong></p>
  <p>An open-source <a href="https://modelcontextprotocol.io">Model Context Protocol (MCP)</a> server that gives AI coding assistants<br/>persistent memory, structural code graph analysis, and safe multi-agent coordination — beyond static RAG and GraphRAG.</p>
</div>

<div align="center">

[![MCP](https://img.shields.io/badge/MCP-JSON--RPC%202.0-7A52F4?logo=data:image/svg+xml;base64,)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/badge/npm-%40stratsolver%2Fgraph--server-CB3837?logo=npm)](https://www.npmjs.com/package/@stratsolver/graph-server)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org)
[![Memgraph](https://img.shields.io/badge/Graph-Memgraph-00B894)](https://memgraph.com)
[![Qdrant](https://img.shields.io/badge/Vector-Qdrant-DC244C)](https://qdrant.tech)
[![License: MIT](https://img.shields.io/badge/License-MIT-F59E0B)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-402%20passing-22C55E)](src)
[![Transport](https://img.shields.io/badge/Transport-stdio%20%7C%20HTTP-0EA5E9)](QUICK_START.md)
[![Status](https://img.shields.io/badge/Status-Beta-orange)](QUICK_START.md)

</div>

---

> **Works with:** VS Code Copilot · Claude Code · Claude Desktop · Cursor · any MCP-compatible AI assistant

**Supported languages:** TypeScript · JavaScript · TSX/JSX · Python · Go · Rust · Java
**Databases:** Memgraph (graph) · Qdrant (vector)
**Transports:** stdio (local) · HTTP (remote/fleet)

---

## What is lxDIG MCP?

An open-source **Model Context Protocol (MCP) server** that adds a **persistent code intelligence layer** to AI coding assistants — Claude Code, VS Code Copilot, Cursor, and Claude Desktop. Unlike static RAG or batch-oriented GraphRAG, lxDIG MCP is a live, incrementally-updated intelligence graph that turns any repository into a queryable knowledge graph — so agents can answer architectural questions, track decisions across sessions, coordinate safely in multi-agent workflows, and run only the tests that actually changed — without re-reading the entire codebase on every turn.

It is purpose-built for the **agentic coding loop**: the cycle of understand → plan → implement → verify → remember that AI agents (Claude, Copilot, Cursor) repeat continuously.

**The core problem it solves:** most AI coding assistants are stateless and architecturally blind. They re-read unchanged files on every session, miss cross-file relationships, forget past decisions, and collide when multiple agents work in parallel. lxDIG MCP is the memory and structure layer that fixes all four.

---

## Table of Contents

- [Why lxDIG?](#why-use-a-code-graph-mcp-server-problems-lxdig-solves)
- [Key capabilities](#key-capabilities-code-graph-agent-memory--multi-agent-coordination)
- [How it works](#how-lxdig-mcp-works-graph--vector--bm25-hybrid-retrieval)
- [Visualize your code graph](#visualize-your-code-graph--lxdig-visual)
- [Quick start](#quick-start)
- [39 MCP tools — at a glance](#39-mcp-tools--at-a-glance)
- [Use cases](#use-cases-claude-code-vs-code-copilot-cursor--ci-pipelines)
- [Comparison with alternatives](#lxdig-mcp-vs-rag-graphrag-github-copilot--langchain-agents)
- [Performance](#performance)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Support the project](#support-the-project)
- [License](#license)

---

## Why Use a Code Graph MCP Server? Problems lxDIG Solves

Most code intelligence tools solve **one** of these problems. lxDIG solves all of them together:

| Problem                             | Without lxDIG                                     | With lxDIG                                                 |
| ----------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| **Context loss between sessions**   | Agent re-reads everything on restart              | Persistent episode + decision memory survives restarts     |
| **Architecturally blind retrieval** | Embeddings miss cross-file relationships          | Graph traversal finds structural dependencies              |
| **Probabilistic search misses**     | Semantic search returns nearest chunks, not facts | Hybrid graph + vector + BM25 fused with RRF                |
| **Multi-agent collisions**          | Two agents edit the same file simultaneously      | Claims/release protocol with conflict detection            |
| **Wasted CI time**                  | Full test suite on every change                   | Impact-scoped test selection — only affected tests run     |
| **Stale architecture knowledge**    | Agent guesses at layer boundaries                 | Graph-validated architecture rules + placement suggestions |
| **Queries eat context budget**      | Raw file dumps, hundreds of tokens per answer     | Cross-file answers in compact, budget-aware responses      |

---

## Key Capabilities: Code Graph, Agent Memory & Multi-Agent Coordination

### 1. Code graph intelligence

Turn your repository into a **queryable property graph** of files, functions, classes, imports, and their relationships. Ask questions in plain English or Cypher.

- Natural-language + Cypher graph queries (`graph_query`)
- Symbol-level explanation with full dependency context (`code_explain`)
- Pattern detection and architecture rule validation (`find_pattern`, `arch_validate`)
- Architecture placement suggestions for new code (`arch_suggest`)
- Semantic code slicing — targeted line ranges from a natural query (`semantic_slice`)
- Find duplicate or similar code across the codebase (`find_similar_code`, `code_clusters`)

### 2. Persistent agent memory

Your agent **remembers** what it decided, what it changed, what broke, and what it observed — even after a VS Code restart or a Claude Desktop session ends.

- Episode memory: observations, decisions, edits, test results, errors, learnings (`episode_add`, `episode_recall`)
- Decision log with semantic query (`decision_query`)
- Reflection synthesis from recent episodes (`reflect`)
- Temporal graph model: query any past code state with `asOf`, compare drift with `diff_since`

### 3. Multi-agent coordination

Run **multiple AI agents in parallel** on the same repository without conflicts.

- Claim/release protocol for file, function, or task ownership (`agent_claim`, `agent_release`)
- Fleet-wide coordination view — see what every agent is doing (`coordination_overview`, `agent_status`)
- Context packs that assemble high-signal task briefings under strict token budgets (`context_pack`)
- Blocker detection across agents and tasks (`blocking_issues`)

### 4. Test and change intelligence

Stop running your **full test suite** on every change. Know exactly what's affected.

- Change impact analysis — blast radius of modified files (`impact_analyze`)
- Selective test execution — only the tests that can fail (`test_select`, `test_run`)
- Test categorization for parallelization and prioritization (`test_categorize`, `suggest_tests`)

### 5. Documentation as a first-class knowledge source

Your **READMEs, ADRs, and changelogs** become searchable graph nodes, linked to the code they describe.

- Index all markdown docs in one call (`index_docs`)
- Full-text BM25 search across headings and content (`search_docs?query=...`)
- Symbol-linked lookup — every doc that references a class or function (`search_docs?symbol=MyClass`)
- Incremental re-index: only changed files are re-parsed

### 6. Architecture governance

Enforce **architectural boundaries** automatically and get placement guidance for new code.

- Layer/boundary rule validation (`arch_validate`)
- Graph-topology-aware placement suggestions (`arch_suggest`)
- Circular dependency and unused-code detection (`find_pattern`)

### 7. One-shot project setup

Go from a fresh clone to a fully wired AI assistant in **one tool call**.

- `init_project_setup` — sets workspace, rebuilds graph, generates Copilot instructions
- `setup_copilot_instructions` — generates `.github/copilot-instructions.md` from your repo's topology
- Works with VS Code Copilot, Claude Code, Claude Desktop, and any MCP-compatible client

---

## How lxDIG MCP Works: Graph + Vector + BM25 Hybrid Retrieval

lxDIG runs as an **MCP server** over stdio or HTTP and coordinates three data planes behind a single tool interface:

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Tool Surface (39 tools)              │
│  stdio transport (local)  │  HTTP transport (remote/fleet)   │
└──────────────┬────────────┴────────────────┬────────────────┘
               │                             │
   ┌───────────▼────────────┐   ┌────────────▼────────────┐
   │   Graph Plane          │   │   Vector Plane           │
   │   Memgraph (Bolt)      │   │   Qdrant                 │
   │   ─────────────────    │   │   ─────────────────────  │
   │   FILE · FUNC · CLASS  │   │   Semantic embeddings    │
   │   IMPORT · CALL edges  │   │   Nearest-neighbor search│
   │   Temporal tx history  │   │   Natural-language code  │
   └────────────────────────┘   └─────────────────────────┘
               │
   ┌───────────▼────────────────────────────────────────────┐
   │   Hybrid Retrieval (RRF fusion)                         │
   │   Graph expansion + Vector similarity + BM25 lexical   │
   └────────────────────────────────────────────────────────┘
```

When you call `graph_query` in natural language mode, retrieval runs as **hybrid fusion**:

1. Vector similarity search (semantic concepts)
2. BM25 lexical search (keyword matches)
3. Graph expansion from seed nodes (structural relationships)
4. **Reciprocal Rank Fusion (RRF)** merges all three signals into a single ranked result

The result: structurally accurate, semantically relevant answers — not just the closest embedding match.

### System diagram

![System Architecture](docs/diagrams/system-architecture.svg)

---

## Visualize Your Code Graph — lxDIG Visual

**[lxDIG Visual](https://github.com/lexCoder2/lxDIG-visual)** is the open-source browser-based visualization layer for lxDIG MCP. It renders your code dependency graph as an **interactive, navigable canvas** — turning abstract code relationships into a tangible spatial representation you can explore.

**Key features:**

- **Force-directed interactive graph** — files, functions, and classes rendered as explorable nodes with physics-based positioning
- **Expand-by-depth navigation** — double-click any node to progressively reveal its direct relationships
- **Architecture layer awareness** — color-coded module boundaries and structural compliance indicators
- **Multi-agent visualization** — real-time view of coordination when multiple AI agents are active via lxDIG MCP
- **Live + mock modes** — connects to your running Memgraph instance or uses built-in fallback data

**Setup** (shares the same Memgraph instance as lxDIG MCP — no extra database needed):

```bash
git clone https://github.com/lexCoder2/lxDIG-visual.git
cd lxDIG-visual
npm install && cp .env.example .env
npm run dev:all
# Open http://localhost:5173
```

After indexing with `graph_rebuild`, changes appear in the visual explorer immediately — no manual refresh required.

> → [github.com/lexCoder2/lxDIG-visual](https://github.com/lexCoder2/lxDIG-visual)

---

## Quick Start

> **Recommended setup:** Memgraph + Qdrant in Docker, MCP server on your host via stdio. Your editor spawns and owns the process — no HTTP ports, no session headers.

### Prerequisites

| Requirement             | Version  |
| ----------------------- | -------- |
| Node.js                 | 24+      |
| Docker + Docker Compose | 24+ (v2) |

### 1. Clone and build

```bash
git clone https://github.com/lexCoder2/lxDIG-MCP.git
cd lxDIG-MCP
npm install && npm run build
```

### 2. Start the databases

```bash
docker compose up -d memgraph qdrant
docker compose ps   # wait for "healthy" (~30 s)
```

### 3. Wire your editor

**VS Code — add to `.vscode/mcp.json`:**

```json
{
  "servers": {
    "lxdig": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/lxDIG-MCP/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333"
      }
    }
  }
}
```

**Claude Desktop — add to `claude_desktop_config.json`:**

```json
{
  "mcpServers": {
    "lxdig": {
      "command": "node",
      "args": ["/absolute/path/to/lxDIG-MCP/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333"
      }
    }
  }
}
```

### 4. Initialize your project (one call)

```json
{
  "name": "init_project_setup",
  "arguments": {
    "workspaceRoot": "/absolute/path/to/your-project",
    "sourceDir": "src",
    "projectId": "my-repo"
  }
}
```

This single call sets the workspace context, rebuilds the code graph, and generates `.github/copilot-instructions.md` for your project. Your agent is ready to query.

**Total setup time: ~5 minutes.** See [QUICK_START.md](QUICK_START.md) for the full guide including Docker, Claude Desktop, and HTTP transport.

---

## 39 MCP Tools — At a Glance

| Category                  | Tools                                                                              | What they do                                   |
| ------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Graph / querying**      | `graph_set_workspace` `graph_rebuild` `graph_health` `graph_query`                 | Index and query the code graph                 |
| **Code intelligence**     | `code_explain` `find_pattern` `semantic_slice` `context_pack` `diff_since`         | Understand structure and change                |
| **Architecture**          | `arch_validate` `arch_suggest`                                                     | Enforce boundaries, guide placement            |
| **Semantic / similarity** | `semantic_search` `find_similar_code` `code_clusters` `semantic_diff`              | Find related code by meaning                   |
| **Test intelligence**     | `test_select` `test_categorize` `impact_analyze` `test_run` `suggest_tests`        | Run only what matters                          |
| **Progress / ops**        | `progress_query` `task_update` `feature_status` `blocking_issues`                  | Track delivery and blockers                    |
| **Agent memory**          | `episode_add` `episode_recall` `decision_query` `reflect`                          | Persist and retrieve agent knowledge           |
| **Coordination**          | `agent_claim` `agent_release` `agent_status` `coordination_overview`               | Safe multi-agent parallelism                   |
| **Documentation**         | `index_docs` `search_docs`                                                         | Search your READMEs and ADRs like code         |
| **Reference**             | `ref_query`                                                                        | Query a sibling repo for patterns and examples |
| **Setup**                 | `init_project_setup` `setup_copilot_instructions` `contract_validate` `tools_list` | One-shot onboarding                            |

---

## Use Cases: Claude Code, VS Code Copilot, Cursor & CI Pipelines

### Individual developer — Claude Code or VS Code Copilot

- Ask "what calls `AuthService.login` across the whole repo?" and get a graph answer, not a file dump
- Resume a refactoring task after a VS Code restart — your agent remembers every decision
- Run `impact_analyze` before committing — know exactly which tests to run
- Use `arch_validate` to catch layer violations before they become bugs
- Explore your dependency graph visually with [lxDIG Visual](https://github.com/lexCoder2/lxDIG-visual)

### Engineering team — multi-agent workflows

- Run a planning agent and an implementation agent in parallel without file conflicts
- Use `coordination_overview` to see what every agent is working on
- `context_pack` hands off a high-signal task briefing between agents in one call
- Persistent decision memory means the second agent doesn't repeat work the first already did

### CI / automation pipeline

- `graph_health` as a startup readiness gate
- `test_select` + `test_run` for impact-scoped CI that's 5–10x faster than full suite
- `arch_validate` as an automated architecture compliance check on every PR

### Repository onboarding

- `init_project_setup` on a new codebase — graph + copilot instructions in ~30 seconds
- `code_explain` to understand unfamiliar subsystems with full dependency context
- `setup_copilot_instructions` generates AI assistant instructions tailored to your repo's topology

---

## lxDIG MCP vs RAG, GraphRAG, GitHub Copilot & LangChain Agents

| Feature                         | lxDIG MCP                | Plain RAG / embeddings | GitHub Copilot (built-in) | Custom LangChain agent |
| ------------------------------- | ------------------------ | ---------------------- | ------------------------- | ---------------------- |
| Cross-file structural reasoning | ✅ Graph edges           | ❌ Chunks only         | ⚠️ Limited                | ⚠️ Manual setup        |
| Persistent agent memory         | ✅ Episodes + decisions  | ❌ Stateless           | ❌ Stateless              | ⚠️ Custom DB needed    |
| Multi-agent coordination        | ✅ Claims/releases       | ❌ None                | ❌ None                   | ❌ Custom setup        |
| Temporal code model             | ✅ `asOf` + `diff_since` | ❌                     | ❌                        | ❌                     |
| Impact-scoped test selection    | ✅ Built-in              | ❌                     | ❌                        | ❌                     |
| Architecture validation         | ✅ Rule-based            | ❌                     | ❌                        | ❌                     |
| Interactive graph visualization | ✅ lxDIG Visual          | ❌                     | ❌                        | ❌                     |
| MCP-native (any AI client)      | ✅ 39 tools              | ❌                     | ❌                        | ❌                     |
| Open source / self-hosted       | ✅ MIT                   | ⚠️ Varies              | ❌ Closed                 | ✅                     |
| Setup complexity                | Medium (Docker)          | Low                    | None                      | High                   |

---

## Performance

Benchmarks run against a synthetic 20-scenario agent task suite (`benchmarks/`):

| Metric                                                      | Result                                          |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Scenarios where lxDIG was faster than baseline              | **15 / 20**                                     |
| MCP-only successful scenarios (baseline could not complete) | **4 / 20**                                      |
| vs Grep / manual file reads                                 | **9x–6000x faster**, <1% false positives        |
| vs pure vector RAG                                          | **5x token savings**, 10x more relevant results |

> Benchmarks are workload-dependent. Run `npm run benchmark:check-regression` against your own repository for accurate numbers.

---

## What's Already Shipped

Every feature below is **production-ready today**:

- ✅ **Hybrid retrieval** for `graph_query` — vector + BM25 + graph expansion fused with RRF
- ✅ **AST-accurate parsers** via tree-sitter for TypeScript, TSX, JS/MJS/CJS, JSX, Python, Go, Rust, Java
- ✅ **Watcher-driven incremental rebuilds** — graph stays fresh without manual intervention _(requires `LXDIG_ENABLE_WATCHER=true`)_
- ✅ **Temporal code model** — `asOf` queries any past graph state; `diff_since` shows what changed
- ✅ **Indexing-time symbol summaries** — compact-profile answers stay useful in tight token budgets
- ✅ **Leiden community detection + PageRank PPR** with JS fallbacks for non-MAGE environments
- ✅ **SCIP IDs** on all FILE, FUNCTION, and CLASS nodes for precise cross-tool symbol references
- ✅ **Episode memory, agent coordination, context packs, and response budget shaping**
- ✅ **Docs & ADR indexing** — markdown parsed into graph nodes; queried by text or symbol association
- ✅ **Interactive graph visualization** via [lxDIG Visual](https://github.com/lexCoder2/lxDIG-visual) — force-directed canvas explorer
- ✅ **402 tests** across parsers, builders, engines, and tool handlers — all green

---

## Runtime Modes

| Mode                     | Best for                                             | Command              |
| ------------------------ | ---------------------------------------------------- | -------------------- |
| **stdio** ✅ recommended | VS Code Copilot, Claude Code, Claude Desktop, Cursor | `npm run start`      |
| **HTTP**                 | Remote agents, multi-client fleets, CI pipelines     | `npm run start:http` |

### Useful scripts

```bash
npm run start                       # stdio server (recommended)
npm run start:http                  # HTTP supervisor (multi-session)
npm run build                       # compile TypeScript
npm test                            # run all 402 tests
npm run benchmark:check-regression  # check latency/token regressions
```

---

## Repository Map

| Path                                 | What's inside                                                       |
| ------------------------------------ | ------------------------------------------------------------------- |
| `src/server.ts`, `src/mcp-server.ts` | MCP + HTTP transport surfaces                                       |
| `src/tools/`                         | Tool handlers, registry, all 39 tool implementations                |
| `src/graph/`                         | Graph client, orchestrator, hybrid retriever, watcher, docs builder |
| `src/engines/`                       | Architecture, test, progress, coordination, episode, docs engines   |
| `src/parsers/`                       | AST + markdown parsers (tree-sitter + regex fallback)               |
| `src/response/`                      | Response shaping, profile budgets, summarization                    |
| `docs/GRAPH_EXPERT_AGENT.md`         | Full agent runbook — tool priority, path rules, response shaping    |
| `docs/MCP_INTEGRATION_GUIDE.md`      | Deep-dive integration guide                                         |
| `QUICK_START.md`                     | Step-by-step deployment + editor wiring (~5 min)                    |

---

## Integration Tips

- **Start every session** with `graph_set_workspace` → `graph_rebuild` (or configure `init_project_setup` to run automatically)
- **Prefer `graph_query` over file reads** for discovery — far fewer tokens, cross-file context included
- **Use `profile: compact`** in autonomous loops; switch to `balanced` or `debug` when you need detail
- **Rebuild incrementally** after meaningful edits; the file watcher handles this automatically during active sessions
- **Run `impact_analyze` before tests** so your agent only executes what's actually affected
- **Open [lxDIG Visual](https://github.com/lexCoder2/lxDIG-visual)** alongside your editor for a spatial view of the graph while your agent works

---

## Roadmap

lxDIG is open source and self-hosted today. Planned work ahead — see [ROADMAP.md](ROADMAP.md) for the full prioritized backlog with detail on each item.

- [ ] Language server protocol (LSP) integration for deeper symbol resolution
- [ ] Go, Rust, Java parser improvements
- [ ] MCP `resources` surface (expose graph nodes as MCP resources)
- [ ] Webhook-triggered graph rebuilds for CI environments
- [ ] Plugin API for custom tool registration
- [ ] **Real-time transparent graph sync** — continuous file-watching with live graph and vector index updates surfaced as observable events, so agents and users always know when the graph is current without polling `graph_health` or triggering manual rebuilds
- [ ] **Domain knowledge layer** — attach external knowledge sources (documentation, standards, specs, research articles) directly to code symbols as graph nodes; a `calculateBMI` function links to CDC/WHO references, a payment function links to PCI-DSS rules, a GDPR-scoped model links to regulation articles — giving agents real-world context alongside structural context
- [ ] Multi-user coordination — shared agent memory, task ownership, and conflict detection across multiple developers on the same repository
- [ ] lxDIG Cloud — hosted, zero-infrastructure version for individuals and teams

---

## Contributing

Pull requests are welcome. Whether it's a new parser, a tool improvement, a bug fix, or better docs — contributions of all sizes move this project forward.

- **Bugs / features** — open an issue first to align on scope
- **New tools** — follow the handler + registration pattern in `src/tools/`; include tests
- **New language parsers** — add tree-sitter grammar + tests in `src/parsers/`
- **Docs** — typos, clarifications, and examples are always appreciated

[→ Open a pull request](https://github.com/lexCoder2/lxDIG-MCP/pulls) · [→ Browse open issues](https://github.com/lexCoder2/lxDIG-MCP/issues)

---

## Support the Project

lxDIG MCP is built and maintained in personal time — researching graph retrieval techniques, designing the tool surface, writing tests, and keeping everything working across MCP protocol updates. If it saves you time or makes your AI-assisted workflows meaningfully better, consider supporting the work:

- **GitHub Sponsors** → [github.com/sponsors/lexCoder2](https://github.com/sponsors/lexCoder2)
- **Buy Me a Coffee** → [buymeacoffee.com/hi8g](https://buymeacoffee.com/hi8g)

---

## FAQ

**Q: Does lxDIG require a cloud service or API key?**
No. lxDIG runs entirely on your machine. Memgraph and Qdrant run in Docker containers you control. No data leaves your environment.

**Q: Does it work with Cursor?**
Yes. Any MCP-compatible client works. Add the stdio config to Cursor's MCP settings the same way as VS Code.

**Q: How large a codebase can it handle?**
The graph plane (Memgraph) scales to millions of nodes. For very large monorepos, use `sourceDir` to scope indexing to the relevant subdirectory. Incremental rebuilds keep the graph fresh without re-indexing everything.

**Q: Do I need to run Qdrant?**
Qdrant is optional but recommended for large codebases. Without it, `semantic_search` and `find_similar_code` are unavailable; all other tools continue to work via graph-only or BM25 retrieval.

**Q: Can multiple developers on a team share one lxDIG instance?**
Yes, via HTTP transport. One running instance handles multiple independent sessions. Team-level shared memory is on the lxDIG Cloud roadmap.

**Q: Is this production-ready?**
The core tools are stable and tested (402 tests, all green). Treat it as beta — APIs may change before a 1.0 release. Pin your version and watch the changelog.

**Q: Is lxDIG MCP the same as GraphRAG?**
No. GraphRAG is a batch retrieval technique applied to documents. lxDIG MCP is a live, incrementally-updated **code graph** with persistent agent memory, multi-agent coordination, and impact-scoped test selection — not just a retrieval improvement.

**Q: How do I add persistent memory to Claude Code?**
Install lxDIG MCP, add the stdio config to `.vscode/mcp.json`, and call `init_project_setup` once per repository. From that point, Claude Code can call `episode_add` / `episode_recall` and `decision_query` to read and write memory that persists across sessions.

**Q: Can I visualize the code graph?**
Yes. [lxDIG Visual](https://github.com/lexCoder2/lxDIG-visual) is the companion browser-based graph explorer. It shares the same Memgraph instance — run `npm run dev:all` in the lxDIG-visual repo and open `http://localhost:5173`.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

<div align="center">
  <sub>Built with care for the agentic coding era · <a href="https://github.com/lexCoder2/lxDIG-MCP">github.com/lexCoder2/lxDIG-MCP</a></sub>
</div>
