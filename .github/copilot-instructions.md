# Copilot Instructions - lexRAG MCP Server

**Use this template for all projects working with lexRAG MCP.**

---

## 🎯 Primary Goal

Use lexRAG MCP for **ALL code intelligence**. Never fall back to file reads or grep.

---

## ⚡ Non-Negotiable Rules

### Rule 1: NEVER Read Files
```
❌ "Let me read src/auth/service.ts"
✅ Use: code_explain('AuthService')
```

### Rule 2: NEVER Use Grep
```
❌ "I'll search with grep for..."
✅ Use: graph_query('find all...')
```

### Rule 3: ALWAYS Initialize Session
First query MUST be:
1. `graph_set_workspace(workspaceRoot, projectId)`
2. `graph_health()`
3. Then answer the question

### Rule 4: Re-anchor Every 5 Messages
Prevent instruction drift in long conversations:
```
Every 5 messages: Call graph_health()
If not ready: Call graph_rebuild(mode: 'incremental')
```

---

## 📊 Tool Quick Reference

| Your Question | MCP Tool | Example |
|---|---|---|
| **Find X** | `graph_query` | find all HTTP handlers |
| **How does X work?** | `code_explain` | AuthService |
| **What breaks?** | `impact_analyze` | [changed files] |
| **Which tests?** | `test_select` | [changed files] |
| **Violates rules?** | `arch_validate` | {} |
| **Where to put code?** | `arch_suggest` | filePath |
| **Search by concept** | `semantic_search` | "validation patterns" |
| **Similar code?** | `find_similar_code` | AuthService |
| **Detect violations** | `find_pattern` | "pattern name" |
| **Remember this** | `episode_add` | decision, reasoning |

**Full reference**: See `docs/QUICK_REFERENCE.md` for all 38 tools.

---

## 🔄 Session Flow (MANDATORY)

### On First Query
```json
{
  "tool": "graph_set_workspace",
  "args": {
    "workspaceRoot": "/absolute/path/to/project",
    "projectId": "your-project-id",
    "sourceDir": "src"
  }
}
```

```json
{
  "tool": "graph_health",
  "args": {}
}
```

Then answer the question using MCP tools.

### Every 5 Messages (Long Conversations)
```json
{
  "tool": "graph_health",
  "args": {}
}
```

This re-anchors the session and prevents instruction drift.

---

## 🛠️ Common Patterns

### Pattern 1: Find Code
```
User: "Find all HTTP handlers"
You: graph_query('find all HTTP handlers')
```

### Pattern 2: Understand Symbol
```
User: "How does AuthService work?"
You:
  1. code_explain('AuthService')
  2. [Optional] graph_query('show call graph for AuthService')
  3. Summarize with full context
```

### Pattern 3: Impact Analysis
```
User: "What if I refactor AuthService?"
You:
  1. impact_analyze(['src/auth/service.ts'])
  2. test_select(['src/auth/service.ts'])
  3. Explain impact + affected tests
```

### Pattern 4: Architecture Check
```
User: "Does this fit the architecture?"
You:
  1. arch_validate()
  2. arch_suggest(filePath)
  3. Explain layer placement + rules
```

---

## ✅ Quality Checklist

Good response includes:
- [ ] Called `graph_set_workspace` on first query
- [ ] Called `graph_health` before heavy queries
- [ ] Used MCP tools (not file reads)
- [ ] No grep or search patterns
- [ ] Explained which tool was used
- [ ] Provided context from graph
- [ ] For long responses, re-anchored with `graph_health`

Bad response includes:
- [ ] Used file operations
- [ ] Mentioned grep
- [ ] Guessed code structure
- [ ] Traced dependencies manually
- [ ] Said "Let me read the file..."
- [ ] Long conversation without re-anchoring

---

## 📁 Active Projects

| Project | Path | projectId |
|---------|------|-----------|
| cad-engine | `/home/alex_rod/projects/cad-engine` | `cad-engine` |
| cad-web | `/home/alex_rod/projects/cad-web` | `cad-web` |

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md) | Why instructions get ignored + system prompt fix |
| [docs/MCP_INTEGRATION_GUIDE.md](../docs/MCP_INTEGRATION_GUIDE.md) | Complete integration guide |
| [docs/TOOL_PATTERNS.md](../docs/TOOL_PATTERNS.md) | Before/after: grep → MCP patterns |
| [docs/INTEGRATION_SUMMARY.md](../docs/INTEGRATION_SUMMARY.md) | Quick navigation and summary |
| [QUICK_REFERENCE.md](../QUICK_REFERENCE.md) | All 38 tools |
| [QUICK_START.md](../QUICK_START.md) | Server deployment |

---

## 🚀 Implementation Checklist

### Infrastructure (One Time)
- [ ] `docker-compose up -d memgraph qdrant`
- [ ] `npm run build && npm run start:http`
- [ ] Verify: `curl http://localhost:9000/health`

### Claude Desktop
- [ ] Edit `~/.claude_desktop_config.json`
- [ ] Add MCP server config
- [ ] Add system prompt that enforces MCP
- [ ] Restart Claude completely

### Per-Project
- [ ] Copy this file to `.github/copilot-instructions.md`
- [ ] Add `.mcp-config.json` with projectId
- [ ] Commit both files
- [ ] Test: Ask code question, verify MCP tools used

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| Claude reads files | Check system prompt in Claude Desktop config |
| Long conversation breaks | Ensure `graph_health()` every 5 messages |
| MCP server won't respond | Check: `docker-compose ps` + `curl http://localhost:9000/health` |
| Graph not indexing | Run: `graph_rebuild(mode: 'full')` |
| "Tool not found" error | Verify MCP server is running and healthy |

---

## 🎯 Remember

- **Goal**: Zero fallback to grep or file reads
- **Method**: System prompt + MCP-exclusive tool use
- **Result**: 10x faster, zero false positives, full context
- **Scale**: Shared MCP backend serving all projects

✨ **With proper system prompt and re-anchoring, Claude uses MCP exclusively even in 100+ message conversations.**

---

**For detailed setup**: See [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md)
**For tool patterns**: See [docs/TOOL_PATTERNS.md](../docs/TOOL_PATTERNS.md)
**For integration**: See [docs/INTEGRATION_SUMMARY.md](../docs/INTEGRATION_SUMMARY.md)
