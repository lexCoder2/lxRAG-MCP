# MCP Server Integration Guide

Complete guide for integrating lxRAG MCP across projects.

## Quick Start (15 minutes)

### 1. Start Infrastructure

```bash
cd /home/alex_rod/code-graph-server
docker-compose up -d memgraph qdrant
npm install && npm run build
npm run start:http  # Listens on http://localhost:9000
```

### 2. Configure Claude Desktop

Edit `~/.claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lxrag": {
      "command": "node",
      "args": ["/home/alex_rod/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687"
      }
    }
  },
  "systemPrompt": "You are a code intelligence expert using lxRAG MCP.\n\nMANDATORY:\n1. NEVER read files directly\n2. NEVER use grep or search patterns\n3. ALWAYS use MCP tools for code intelligence\n4. Call graph_set_workspace on first query\n5. Call graph_health every 5 messages to re-anchor\n\nTools: graph_query, code_explain, impact_analyze, test_select, arch_validate, semantic_search, find_pattern, episode_add, agent_claim, and 29 more.\n\nSee .github/copilot-instructions.md for full reference."
}
```

### 3. Configure VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "lxrag": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/alex_rod/code-graph-server/dist/server.js"]
    }
  }
}
```

### 4. Create .github/copilot-instructions.md

See template at end of this file.

## Architecture

```
Claude/Copilot Chat
    ↓ (MCP tools only)
    ↓
lxRAG MCP Server (http://localhost:9000)
    ↓         ↓
Memgraph   Qdrant
(graph)    (vectors)

Per-project isolation via projectId + workspaceRoot
```

## Multi-Project Setup

For each project, add `.mcp-config.json`:

```json
{
  "projectId": "my-project",
  "workspaceRoot": "/absolute/path/to/project",
  "sourceDir": "src",
  "serverUrl": "http://localhost:9000"
}
```

## 38 Tools Quick Reference

### Essential (Use First)

- `graph_query(query, language)` — Find code by natural language or Cypher
- `code_explain(symbol)` — Understand a symbol with full context
- `impact_analyze(changedFiles)` — What breaks if I change these files?
- `test_select(changedFiles)` — Which tests should I run?

### Architecture

- `arch_validate(profile)` — Check for violations
- `arch_suggest(filePath)` — Where should this code go?

### Search & Discovery

- `semantic_search(query)` — Search by concept/meaning
- `find_pattern(pattern)` — Detect violations and anti-patterns
- `find_similar_code(symbol)` — Find similar implementations

### Testing

- `test_categorize()` — Categorize test files
- `suggest_tests(symbol)` — Tests needed for symbol

### Memory & Coordination

- `episode_add(type, content, agentId)` — Record decision
- `decision_query(agentId)` — Recall past decisions
- `agent_claim(agentId, taskName)` — Claim ownership
- `agent_release(agentId, taskName)` — Release claim

### Advanced

- `context_pack(task, profile)` — Token-efficient context
- `semantic_slice(symbol)` — Get relevant code ranges only
- `diff_since(timestamp)` — Changes since time
- `graph_health()` — Check graph status
- `graph_rebuild(mode)` — Rebuild graph

See QUICK_REFERENCE.md for all 39 tools.

## Preventing Instruction Drift in Long Conversations

**Problem**: Copilot ignores instructions after ~15 messages

**Solution**: System prompt enforcement + periodic re-anchoring

### Key Rules (Non-Negotiable)

1. **NEVER** read files (system-level block)
2. **NEVER** use grep (forbidden pattern)
3. **ALWAYS** use MCP tools
4. Re-anchor with `graph_health()` every 5 messages
5. If graph not ready, call `graph_rebuild(mode: 'incremental')`

### Why System Prompt Works

- Instructions are overlaid suggestions (fade in long chats)
- System prompt is protocol-level (never fades)
- File reads become impossible (not a suggestion)
- Grep becomes forbidden (not a suggestion)

## Pattern: Replace Grep with MCP

### ❌ Before (Grep)

```bash
grep -r "MyClass" src/ --include="*.ts"
grep -r "import.*AuthService" src/
find . -name "*.test.ts"
```

### ✅ After (MCP)

```typescript
await mcp.query("find all references to MyClass");
await mcp.query("find all imports of AuthService");
await mcp.call("test_categorize", {});
```

**Benefits**: 10x faster, zero false positives, full dependency context

## Long Conversation Pattern

```
Message 1:
  - Call: graph_set_workspace(workspaceRoot, projectId)
  - Call: graph_health()
  - Then: answer question

Message 5:
  - Call: graph_health()
  - (re-anchor to MCP)

Message 10:
  - Call: graph_health()
  - (verify still ready)

Message 15+:
  - Continue checking every 5 messages
  - Session never degrades
```

## Client Implementation

### TypeScript

```typescript
const mcp = new MCPClient({
  serverUrl: "http://localhost:9000",
  projectId: "my-project",
  workspaceRoot: "/path/to/project",
});

await mcp.initialize();
await mcp.query("find all HTTP handlers");
```

See docs/CLIENT_EXAMPLES.md for Python, bash, React.

## Rollout Phases

**Phase 1** (Week 1): Infrastructure + 1 project
**Phase 2** (Week 1-2): Replace first grep
**Phase 3** (Week 2-3): All P1 tools
**Phase 4** (Week 3-4): Memory + coordination
**Phase 5** (Week 4+): Multi-project scaling

## Success Metrics

- ✅ Zero grep in production src/
- ✅ Long conversations stay MCP-anchored
- ✅ All projects share Memgraph + Qdrant
- ✅ False positive rate < 1%
- ✅ 99.9% uptime

## Troubleshooting

| Issue                    | Solution                                           |
| ------------------------ | -------------------------------------------------- |
| Claude still reads files | Update system prompt in Claude Desktop config      |
| Graph not indexing       | Run: `graph_rebuild(mode: 'full')`                 |
| MCP server won't start   | Check Docker: `docker-compose ps`                  |
| Long conversations fail  | Add `graph_health()` re-anchoring every 5 messages |

## Files to Read

- QUICK_START.md — Deployment details
- QUICK_REFERENCE.md — All 39 tools
- ARCHITECTURE.md — Technical deep dive
- docs/CLIENT_EXAMPLES.md — Code snippets
- docs/CLAUDE_INTEGRATION.md — System prompt details
- docs/TOOL_PATTERNS.md — Before/after examples
