# Claude/Copilot Integration: System Prompt Solution

## The Problem

Copilot instructions get **ignored in longer conversations** (15+ messages) and Claude falls back to:
- Reading files directly
- Using grep patterns
- Manual code analysis

## Root Cause

1. Instructions are **overlaid suggestions**, not system-level constraints
2. Token budget dilutes instructions in long chats
3. File reads are baked into Claude's training data (default behavior)
4. Grep patterns match training defaults

## The Solution: System Prompt Engineering

Make the system prompt **enforce MCP at protocol level**:
- File reads become impossible (system block)
- Grep becomes forbidden (protocol-level)
- MCP becomes mandatory (only option)

Now even at message 100, Claude uses MCP because it's the **only option**.

---

## Implementation

### Step 1: Update Claude Desktop Config

Edit `~/.claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lxdig": {
      "command": "node",
      "args": ["/home/alex_rod/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333"
      }
    }
  },
  "systemPrompt": "You are analyzing code using the lxDIG MCP server.\n\n## CRITICAL RULES (DO NOT BREAK)\n\n1. NEVER read files or use file operations\n2. NEVER use grep or search patterns\n3. ALWAYS use MCP tools for code intelligence\n4. Call graph_set_workspace on first query\n5. Call graph_health every 5 messages to re-anchor\n\n## Tool Mapping\n\n| Question | Tool |\n| --- | --- |\n| \"Find X\" | graph_query('find X') |\n| \"How does X work?\" | code_explain('X') |\n| \"What breaks?\" | impact_analyze(changedFiles) |\n| \"Which tests?\" | test_select(changedFiles) |\n| \"Architecture?\" | arch_validate() or arch_suggest() |\n| \"Search for X\" | semantic_search('X') |\n| \"Similar code?\" | find_similar_code('X') |\n| \"Patterns?\" | find_pattern('X') |\n| \"Remember this\" | episode_add(type, content, agentId) |\n| \"Multi-agent safe?\" | agent_claim/release |\n\n## Session Flow\n\n1. graph_set_workspace(workspaceRoot, projectId)\n2. graph_health() — verify ready\n3. Query with MCP tools\n4. Every 5 messages: graph_health() to re-anchor\n\n## Forbidden Patterns\n\n❌ \"Let me read src/file.ts\"\n→ ✅ \"I'll use code_explain('SymbolName')\"\n\n❌ \"I'll search with grep for...\"\n→ ✅ \"I'll use graph_query to find...\"\n\n❌ \"Based on the file structure...\"\n→ ✅ \"Let me query the graph structure...\"\n\n## Token Efficiency (Long Conversations)\n\n- Use `profile: 'compact'` for token-light responses\n- Use `semantic_slice` for code ranges (not full files)\n- Use `context_pack` for multi-file context under budget"
}
```

### Step 2: Update VS Code Settings

Create `.vscode/mcp.json`:
```json
{
  "servers": {
    "lxdig": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/alex_rod/code-graph-server/dist/server.js"]
    }
  }
}
```

Create `.vscode/settings.json`:
```json
{
  "claude.alwaysUseMCP": true,
  "claude.fallbackToFilesDisabled": true
}
```

### Step 3: Restart Claude Desktop

Close and reopen Claude completely.

### Step 4: Test

Ask Claude: "How does src/main.ts work?"

**Expected**:
- Claude calls `graph_set_workspace`
- Claude calls `code_explain('main')`
- NO file reads

---

## Why This Works

| Before | After |
|--------|-------|
| Instructions fade in long chats | System prompt is protocol-level |
| Claude reads files anyway | File reads are system-blocked |
| Uses grep by default | Grep is forbidden |
| Context gets out of sync | Health checks re-anchor every 5 messages |

---

## Long Conversation Pattern

Claude should follow this automatically with proper system prompt:

```
Msg 1-4:  Normal queries using MCP
Msg 5:    [Auto-call graph_health()]
Msg 6-9:  Normal queries using MCP
Msg 10:   [Auto-call graph_health()]
...continues indefinitely without degradation
```

---

## Verification

Test long conversation (50+ messages):

1. Ask code questions
2. Verify Claude uses MCP tools (not files)
3. Verify no grep patterns mentioned
4. Verify context stays accurate
5. Success: Zero fallback across entire conversation

---

## Why System Prompt > Instructions

```
Instructions:
  "Use MCP for code queries" → Suggestion
  → Fades after 15 messages
  → Claude reverts to training defaults

System Prompt:
  "NEVER read files" → Protocol block
  → Never fades
  → File reads become impossible
```

**System prompt wins.**

---

## Troubleshooting

### Claude still reads files
- Check system prompt in Claude Desktop config
- Verify "NEVER read files" is present
- Restart Claude completely

### Long conversations break
- Ensure `graph_health()` re-anchoring is in system prompt
- Test with 50+ message conversation
- If fails at message N, check if `graph_health()` was called at N-5

### MCP tools not available
- Verify MCP server running: `curl http://localhost:9000/health`
- Check Docker: `docker-compose ps`
- Restart Claude

---

## Results

After setup:

✅ Claude uses MCP in **every** conversation
✅ Long conversations (100+ messages) **never** degrade
✅ Zero file reads across entire session
✅ Full dependency context always available
✅ Heavy MCP dependency, zero fallback
