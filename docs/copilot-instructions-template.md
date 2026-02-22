# Copilot Instructions - lexRAG MCP Server

**Use this as your `.github/copilot-instructions.md` in each project.**

---

## 🎯 Primary Goal

Use lexRAG MCP server for **ALL code intelligence**. Never fall back to file reads or grep.

---

## ⚡ Non-Negotiable Rules

### Rule 1: NEVER Read Files
- ❌ "Let me read src/auth/service.ts"
- ✅ Use: `code_explain('AuthService')`

### Rule 2: NEVER Use Grep
- ❌ "I'll search with grep for..."
- ✅ Use: `graph_query('find all...')`

### Rule 3: ALWAYS Initialize Session
On first query:
```
1. Call: graph_set_workspace(workspaceRoot, projectId)
2. Call: graph_health()
3. Then answer the question
```

### Rule 4: Re-anchor Every 5 Messages
To prevent instruction drift in long conversations:
```
Every 5 messages: Call graph_health()
```

---

## 📊 Tool Quick Reference

| Your Question | MCP Tool | Example |
|---|---|---|
| "Find X" | `graph_query` | find all HTTP handlers |
| "How does X work?" | `code_explain` | AuthService |
| "What breaks?" | `impact_analyze` | [changed files] |
| "Which tests?" | `test_select` | [changed files] |
| "Violates architecture?" | `arch_validate` | {} |
| "Search by concept" | `semantic_search` | "validation patterns" |
| "Similar code?" | `find_similar_code` | AuthService |
| "Remember this" | `episode_add` | decision, reasoning |

See [docs/QUICK_REFERENCE.md](../docs/QUICK_REFERENCE.md) for all 38 tools.

---

## 🔄 Session Flow (MANDATORY)

### First Query
```json
{
  "tool": "graph_set_workspace",
  "args": {
    "workspaceRoot": "/absolute/path/to/project",
    "projectId": "PROJECT_ID",
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

Then answer the question with MCP tools.

### Long Conversations
After message 5, 10, 15, 20, etc:
```json
{
  "tool": "graph_health",
  "args": {}
}
```

If not ready:
```json
{
  "tool": "graph_rebuild",
  "args": { "mode": "incremental" }
}
```

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
  2. graph_query('show call graph for AuthService')
  3. Summarize with context
```

### Pattern 3: Impact Analysis
```
User: "What if I refactor AuthService?"
You:
  1. impact_analyze(['src/auth/service.ts'])
  2. test_select(['src/auth/service.ts'])
  3. Explain impact + tests needed
```

### Pattern 4: Architecture Check
```
User: "Does this fit the architecture?"
You:
  1. arch_validate()
  2. arch_suggest(filePath)
  3. Explain placement + rules
```

---

## ✅ Checklist: Good Response

- [ ] Called `graph_set_workspace` on first query
- [ ] Called `graph_health` before intensive queries
- [ ] Used MCP tools (not file reads)
- [ ] No grep patterns mentioned
- [ ] Explained which tool was used
- [ ] Provided context from graph (not guessed)
- [ ] For long responses, re-anchored with `graph_health`

---

## ❌ Checklist: Bad Response

- [ ] Used `readFileSync` or file operations
- [ ] Mentioned grep or search patterns
- [ ] Guessed code structure (didn't query graph)
- [ ] Traced dependencies manually
- [ ] Said "Let me read the file..."
- [ ] In message 20+ without `graph_health` calls

---

## 🚀 Active Projects

| Project | Path | projectId |
|---------|------|-----------|
| [Add your projects here] | | |

---

## 📁 Project Setup

### 1. Add `.mcp-config.json` to project root
```json
{
  "projectId": "your-project-id",
  "workspaceRoot": "/absolute/path",
  "sourceDir": "src",
  "serverUrl": "http://localhost:9000"
}
```

### 2. Configure Claude Desktop
Edit `~/.claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "lexrag": {
      "command": "node",
      "args": ["/path/to/code-graph-server/dist/server.js"]
    }
  }
}
```

### 3. Restart Claude
Close and reopen Claude completely.

---

## 🔧 Implementation Steps

### Step 1: Infrastructure (One Time)
```bash
cd /path/to/code-graph-server
docker-compose up -d memgraph qdrant
npm run build
npm run start:http
```

### Step 2: Claude Setup
- Update `~/.claude_desktop_config.json` with MCP server
- Restart Claude Desktop
- Test with: "How does [file] work?"

### Step 3: VS Code (Optional)
Create `.vscode/mcp.json`:
```json
{
  "servers": {
    "lexrag": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/code-graph-server/dist/server.js"]
    }
  }
}
```

### Step 4: Per-Project Setup
- Add `.mcp-config.json` with projectId
- Add this file as `.github/copilot-instructions.md`
- Commit both files

---

## 📚 Documentation

| Document | Purpose |
|----------|---------|
| [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md) | Why instructions get ignored + system prompt fix |
| [docs/MCP_INTEGRATION_GUIDE.md](../docs/MCP_INTEGRATION_GUIDE.md) | Full integration guide + architecture |
| [docs/TOOL_PATTERNS.md](../docs/TOOL_PATTERNS.md) | Before/after patterns replacing grep |
| [QUICK_START.md](../QUICK_START.md) | Server deployment |
| [QUICK_REFERENCE.md](../QUICK_REFERENCE.md) | All 38 tools reference |

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| Claude reads files | Check system prompt in Claude Desktop config |
| Long conversation breaks | Ensure `graph_health()` calls every 5 messages |
| MCP server won't start | Run: `docker-compose ps` |
| Graph not indexing | Run: `graph_rebuild(mode: 'full')` |
| "Tool not found" | Verify MCP server is running and healthy |

---

## 🎓 Training

For new team members:

1. **Understand the problem**: Read [docs/CLAUDE_INTEGRATION.md](../docs/CLAUDE_INTEGRATION.md)
2. **Learn the tools**: Check [docs/TOOL_PATTERNS.md](../docs/TOOL_PATTERNS.md)
3. **See examples**: Review `QUICK_REFERENCE.md`
4. **Practice**: Ask code questions and verify MCP tool calls

---

## 📈 Success Metrics

- ✅ Zero file reads in any conversation
- ✅ Long conversations (50+ messages) don't degrade
- ✅ All code discovery uses MCP tools
- ✅ False positive rate < 1%
- ✅ Response time < 100ms (with cache)

---

## 🚫 Forbidden Patterns

❌ "Let me read the file to understand..."
❌ "I'll search with grep for..."
❌ "Based on the file structure, I think..."
❌ "Let me trace through the code manually..."
❌ "I'll look for imports of..."

---

## ✨ Remember

**The goal is zero fallback to grep or file reads.**

With proper system prompt and session management, Claude can use MCP tools exclusively, even in 100+ message conversations.

You get:
- 10x faster responses
- Zero false positives
- Full dependency context
- Session persistence
- Safe multi-agent coordination

**Use the tools. Trust the graph. 🚀**
