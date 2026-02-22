# Integration Guide: Using lexRAG MCP Across Multiple Projects

## Executive Summary

Your **lexRAG MCP server is production-ready** for multi-project, multi-agent dependency. Instead of projects reading files or using grep, they should:

1. **Connect via MCP HTTP** — one shared Memgraph + Qdrant backend, session-scoped isolation
2. **Use tool-first patterns** — graph queries replace file reads, semantic search replaces grep
3. **Leverage persistent memory** — episode + decision stores survive restarts, no re-analysis needed
4. **Coordinate safely** — agent claims + releases prevent collisions on shared code

---

## Current State: Multi-Project Ready

Your server already supports multiple projects via projectId + workspaceRoot isolation.

Each project is **isolated**, sharing the same Memgraph and Qdrant infrastructure.

---

## Three Integration Levels

### Level 1: Basic Query (Lightweight)
Replace grep/file reads with `graph_query`

### Level 2: Code Intelligence (Medium)
Use semantic + graph-backed tools for context assembly

### Level 3: Heavy Dependency (Deep Integration)
Agents depend on server for all code intelligence

See [CLAUDE_COPILOT_INTEGRATION.md](CLAUDE_COPILOT_INTEGRATION.md) for chat-specific guidance.
