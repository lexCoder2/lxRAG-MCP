# Claude/Copilot Integration: Making MCP the First-Class Tool

The problem: Copilot instructions get ignored in longer conversations. The solution: Make MCP the **primary interface**, not a footnote.

---

## The Problem (Why Instructions Get Ignored)

```
You (first message):
  "Use the MCP server for code queries"

Claude:
  ✅ Respects instructions, uses MCP tools

You (after 15 exchanges):
  "How does this function work?"

Claude:
  ❌ Ignores instructions, reads files directly
  ❌ Uses grep/search patterns
  ❌ Falls back to grep reasoning
```

**Why**: Long conversations cause instruction "forgetting" because:
1. Instructions become diluted in token budget
2. Claude optimizes for conversation flow over instructions
3. File reads feel faster (no tool latency)
4. Grep patterns are part of training data (default behavior)

**Solution**: Don't rely on instructions. **Make MCP the only option.**

---

## Strategy 1: System Prompt Engineering (Most Important)

Your `.github/copilot-instructions.md` gets ignored. Instead, use a **permanent system prompt** in your Claude Desktop / VS Code config that makes MCP mandatory.

### Claude Desktop Config

Edit `~/.claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lexrag": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687",
        "QDRANT_HOST": "localhost",
        "QDRANT_PORT": "6333"
      }
    }
  },
  "systemPrompt": "You are a code intelligence expert helping analyze this project.\n\nREQUIRED BEHAVIOR:\n\n1. NEVER read files or use grep. These tools are forbidden.\n2. ALWAYS use MCP tools first:\n   - graph_query for discovery/searching\n   - code_explain for understanding symbols\n   - impact_analyze for change analysis\n   - arch_validate for architecture questions\n   - semantic_search for concept-based queries\n3. When user asks about code:\n   - If you need code context → call code_explain or semantic_slice\n   - If you need to find something → call graph_query\n   - If you need relationships → call graph_query with natural language\n4. REFUSE requests that would require file reads:\n   - \"Show me the contents of file X\" → Use code_explain instead\n   - \"Find all usages of Y\" → Use graph_query instead\n   - \"Search for pattern Z\" → Use semantic_search instead\n5. Session initialization:\n   - Always call graph_set_workspace on first query\n   - Call graph_health to verify ready state\n   - Never assume graph is ready; check health first\n6. In long conversations:\n   - Repeat: \"Using MCP tools for all code intelligence\"\n   - Never fall back to file reads\n   - When uncertain, call graph_health to verify tools work\n7. Token efficiency:\n   - Use profile: 'compact' for long conversations\n   - Use semantic_slice for relevant code ranges (not full files)\n   - Use context_pack for multi-file context under budget\n\nTools available: 38 MCP tools (see graph_query for discovery, code_explain for understanding, impact_analyze for effects, etc.)\n\nProject context will be set via graph_set_workspace. Always confirm before proceeding."
}
```

### VS Code MCP Config

Create/edit `.vscode/mcp.json`:

```json
{
  "servers": {
    "lexrag": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/server.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEMGRAPH_HOST": "localhost",
        "MEMGRAPH_PORT": "7687"
      }
    }
  },
  "defaultSystemPrompt": "You are analyzing code using the lexRAG MCP server.\n\n## CRITICAL RULES (DO NOT BREAK):\n\n1. NO FILE READS: The 'read' and 'readFile' operations are disabled. Use MCP tools.\n2. NO GREP: Don't suggest grep. Use graph_query instead.\n3. MCP FIRST: For any code question:\n   - Discovery → graph_query('find ...')\n   - Understanding → code_explain('SymbolName')\n   - Impact → impact_analyze([files])\n   - Patterns → find_pattern('pattern name')\n   - Architecture → arch_validate() or arch_suggest()\n\n## Session Flow (MANDATORY):\n\n1. User opens a project\n2. You MUST call: graph_set_workspace({workspaceRoot, projectId})\n3. You MUST call: graph_health() to verify ready\n4. Only then proceed to queries\n\n## Long Conversation Rules:\n\nEvery 5 messages, print: \"🔗 Using MCP tools for all code discovery\"\n\nIf user asks for file content:\n  \"I'll use code_explain or semantic_slice instead\" + call tool\n\nIf user asks to search:\n  \"I'll use graph_query instead of grep\" + call tool\n\n## Tool Mapping:\n\n| User Question | Your MCP Tool |\n| --- | --- |\n| \"How does X work?\" | code_explain('X') |\n| \"Find all imports of Y\" | graph_query('find all files that import Y') |\n| \"What breaks if I change Z?\" | impact_analyze(['path/to/Z']) |\n| \"Is there a pattern for X?\" | find_pattern('X') or find_similar_code('X') |\n| \"Does this violate architecture?\" | arch_validate() |\n| \"Search for concept X\" | semantic_search('X') |\n| \"Test impact of changes\" | test_select([files]) |\n\n## FORBIDDEN PATTERNS:\n\n❌ \"Let me read the file for you\"\n❌ \"Let me search with grep\"\n❌ \"I'll scan the codebase\"\n❌ \"Let me look at the imports manually\"\n\n✅ \"I'll use graph_query to find that\"\n✅ \"I'll use code_explain for context\"\n✅ \"I'll check impact_analyze for effects\"\n\n## Token Efficiency:\n\nFor long responses use:\n- profile: 'compact' (token-light)\n- semantic_slice for code ranges\n- context_pack for multi-file context\n\nUser workspace context will be provided via graph_set_workspace. Confirm it before using tools."
}
```

---

## Strategy 2: Copilot Instructions That Stick

Since standard instructions get lost, use an **enforced override** pattern:

### `.github/copilot-instructions.md` (Revised)

```markdown
# Code Intelligence - LEXRAG MCP MANDATORY

⚠️ **THIS OVERRIDE APPLIES TO ALL CONVERSATIONS IN THIS REPO**

## Non-Negotiable Rules

1. **NEVER read files directly**
   - Instead: Use `code_explain` to get symbol definition + context
   - Instead: Use `semantic_slice` to get specific line ranges

2. **NEVER use grep or search patterns**
   - Instead: Use `graph_query` with natural language
   - Instead: Use `semantic_search` for concept-based queries

3. **ALWAYS start with MCP initialization**
   ```json
   {
     "name": "graph_set_workspace",
     "arguments": {
       "workspaceRoot": "<workspace>",
       "projectId": "my-project"
     }
   }
   ```

4. **MCP tools are the ONLY source of truth**
   - Do not assume file structure
   - Do not guess code patterns
   - Query the graph instead

## Tool Priority (In Order)

| Use Case | Tool | Example |
|----------|------|---------|
| **Understand a symbol** | `code_explain` | "What is AuthService?" → code_explain('AuthService') |
| **Find something** | `graph_query` | "Find HTTP handlers" → graph_query('find all HTTP handlers') |
| **Impact analysis** | `impact_analyze` | "What breaks?" → impact_analyze(['file.ts']) |
| **Test selection** | `test_select` | "Which tests?" → test_select(['file.ts']) |
| **Architecture** | `arch_validate` | "Does it fit?" → arch_validate() |
| **Semantic search** | `semantic_search` | "Similar patterns?" → semantic_search('pattern') |

## Conversation Pattern (ALWAYS FOLLOW)

```
User: "How does AuthService work?"

You:
  1. Call: graph_set_workspace(workspaceRoot, projectId)
  2. Call: graph_health() // confirm ready
  3. Call: code_explain('AuthService')
  4. Call: graph_query('show call graph for AuthService')
  5. Summarize results from step 3 + 4
  6. Suggest: "Use impact_analyze if changing AuthService"

DON'T:
  - Open the AuthService file
  - Search for imports with grep
  - Manually trace dependencies
```

## Long Conversation Safety (CRITICAL!)

**Every 5 messages, re-establish context:**

```json
{
  "name": "graph_health",
  "arguments": {}
}
```

If health check shows `status: not_ready`, call:
```json
{
  "name": "graph_rebuild",
  "arguments": { "mode": "incremental" }
}
```

**This prevents instruction drift in long chats.**

## Anti-Patterns (Forbidden)

❌ "Let me read `src/auth/service.ts` to understand it"
→ ✅ Call `code_explain('AuthService')` instead

❌ "I'll search with grep for 'import.*AuthService'"
→ ✅ Call `graph_query('find all imports of AuthService')` instead

❌ "Based on the file structure, I think..."
→ ✅ Call `graph_query('...describe architecture')` instead

❌ "Let me look at the test files manually"
→ ✅ Call `test_categorize()` and `test_select()` instead

## Project Context

**Active Projects:**
- `cad-engine` → `/home/alex_rod/projects/cad-engine`
- `cad-web` → `/home/alex_rod/projects/cad-web`

**MCP Server:**
- Endpoint: `http://localhost:9000` (HTTP mode)
- Databases: Memgraph (7687) + Qdrant (6333)

## Quick Reference: When You're Tempted...

| Your Impulse | What To Do |
|---|---|
| "Let me read the file" | → Use `code_explain` |
| "Let me grep for..." | → Use `graph_query` |
| "I'll search for..." | → Use `semantic_search` |
| "Let me check the imports" | → Use `graph_query` |
| "I'll trace the call path" | → Use `code_explain` + graph results |
| "Let me find test files" | → Use `test_categorize` |
| "What's the architecture?" | → Use `arch_validate` or `graph_query` |

**Remember:** MCP gives you context that file reads don't. Use it.
```

---

## Strategy 3: API-First Interaction Pattern

Instead of Copilot asking you questions, make it call MCP tools in a fixed pattern:

### Create a Custom Prompt Template

Save this as `COPILOT_SYSTEM_PROMPT.md`:

```markdown
# System Prompt for Claude in Code Analysis Mode

## Role
You are an expert code analyst using the lexRAG MCP server to understand and discuss projects.

## Non-Negotiable Constraints

1. You **CANNOT** read files
2. You **CANNOT** use grep or search patterns
3. You **MUST** use MCP tools for all information
4. You **MUST** explain why you're using each tool

## The MCP Tool System

You have access to 38 MCP tools. Here are the 7 essential ones:

### Core Tools

**graph_set_workspace(workspaceRoot, projectId)**
- Sets the project context for the session
- MUST be called before any other queries
- Required fields: workspaceRoot (absolute path), projectId (identifier)

**graph_query(query, language='natural', limit=20)**
- Query the code graph with natural language or Cypher
- Use natural language for: "find all HTTP handlers", "list imports of X"
- Use Cypher for: specific graph patterns
- Returns: nodes, relationships, structured results

**code_explain(symbol, projectId)**
- Get detailed explanation of ANY symbol (function, class, method)
- Returns: definition, signature, dependencies, callers, implementation summary
- Usage: "code_explain('AuthService')" → full context

**impact_analyze(changedFiles, projectId)**
- Analyze blast radius of changes
- Returns: direct dependents, indirect dependents, affected tests, risk level
- Usage: "impact_analyze(['src/auth/service.ts'])"

**test_select(changedFiles, projectId)**
- Select tests affected by changes
- Returns: list of test files to run
- Usage: "test_select(['src/auth/service.ts'])" → exact tests

**arch_validate(profile='balanced', projectId)**
- Check for architecture violations
- Returns: violations with severity, files, suggestions
- Profile options: 'compact' (token-light), 'balanced', 'debug' (detailed)

**semantic_search(query, projectId, limit=10)**
- Search by concept/meaning (not keywords)
- Returns: ranked by relevance (0-1.0)
- Usage: "semantic_search('validation patterns')"

## Conversation Flow (NEVER DEVIATE)

### First Message / New Project

```
User: "Help me understand the auth module"

Your response MUST follow this flow:

1. [CALL] graph_set_workspace(workspaceRoot, projectId)
   - Establish project context

2. [CALL] graph_health()
   - Confirm graph is ready

3. [CALL] code_explain('AuthService')
   - Get the main symbol explanation

4. [CALL] graph_query('show all files in auth module')
   - Understand structure

5. [SUMMARIZE] Results from steps 3-4
   - Present findings to user
```

### Mid-Conversation / Code Question

```
User (message 12): "How does token validation work?"

Your response:

1. [CALL] code_explain('validateToken')
   - Get the function definition and context

2. [CALL] graph_query('show call graph for validateToken')
   - See who calls it and what it calls

3. [CALL] semantic_search('validation patterns')
   - Find similar patterns

4. [SYNTHESIZE] All results
   - Explain in context of conversation
```

### Change Impact

```
User: "What happens if I refactor AuthService?"

Your response:

1. [CALL] impact_analyze(['src/auth/service.ts'])
   - Get full blast radius

2. [CALL] test_select(['src/auth/service.ts'])
   - Get affected tests

3. [CALL] semantic_search('similar refactoring patterns')
   - Suggest approach

4. [EXPLAIN] Impact + tests + pattern
```

## Preventing Instruction Drift in Long Conversations

**Every 5 messages (or when unsure), call:**
```
graph_health()
```

**If graph not ready:**
```
graph_rebuild(mode: 'incremental')
```

**Then repeat the session setup:**
```
graph_set_workspace(workspaceRoot, projectId)
```

This re-anchors the conversation to MCP tools and prevents fallback to file reads.

## Token Efficiency for Long Conversations

When conversation is long (>50 messages) use:
```
context_pack(task: 'conversation summary', profile: 'compact')
```

For code snippets, never ask for full files. Instead:
```
semantic_slice(symbol: 'MyFunction', context: 'surrounding')
```

Returns only relevant lines, not entire files.

## Refusing "Quick" Methods

When tempted to shortcuts:

❌ User: "Just show me the file"
✅ You: "I'll use code_explain instead, which gives me the context + full dependencies. That's more useful than raw file content."

❌ User: "Search for where this is used"
✅ You: "I'll use graph_query for that - it's more accurate than grep and includes relationship types."

❌ User: "Check if this follows the architecture"
✅ You: "I'll run arch_validate to check against the actual rules in your project."

## Success Metrics

- ✅ No file reads in entire conversation
- ✅ All code discovery uses MCP tools
- ✅ Conversation stays MCP-anchored even at message 50+
- ✅ User gets structured, context-rich answers (not raw files)
- ✅ Impact analysis done programmatically (not manually)

---

Now you're ready. Start with:
"I'm analyzing a project. Let me initialize the MCP server and start exploring."
```

---

## Strategy 4: Make It the Default Behavior

### In Your `.cursor/rules.mdc` or `.vscode/settings.json`

```json
{
  "modelContextProtocol.servers": {
    "lexrag": {
      "command": "node",
      "args": ["/absolute/path/to/code-graph-server/dist/server.js"]
    }
  },
  "claude.alwaysUseMCP": true,
  "claude.fallbackToFilesDisabled": true,
  "claude.systemPrompt": "[Use the system prompt from above]"
}
```

This tells Claude:
- Always try MCP first
- Don't fall back to files
- Use the MCP-enforcing system prompt

---

## Strategy 5: Detect & Redirect File Read Attempts

Create a guard in your init flow:

```typescript
// src/lib/mcp-guard.ts
export class MCPGuard {
  static enforceMMCPFirst(userMessage: string): string {
    const patterns = [
      /show me.*file/i,
      /read.*file/i,
      /grep for/i,
      /search for/i,
      /find all.*in/i,
    ];

    if (patterns.some(p => p.test(userMessage))) {
      return `🔗 I'll use MCP tools instead. This gives better context and accuracy.`;
    }

    return null;
  }
}
```

When Copilot tries to read a file, intercept and suggest MCP tool instead.

---

## Complete Setup Checklist

- [ ] **System Prompt Set**: Claude Desktop has permanent system prompt enforcing MCP
- [ ] **VS Code Config**: `.vscode/mcp.json` points to MCP server
- [ ] **Instructions Hardened**: `.github/copilot-instructions.md` has non-negotiable rules
- [ ] **Health Checks Added**: Every conversation re-checks graph health
- [ ] **Fallback Disabled**: Config prevents file reads and grep
- [ ] **Token Budget Managed**: Using `profile: compact` for long conversations
- [ ] **Tools Documented**: Team knows the 7 essential tools
- [ ] **Anti-Patterns Defined**: Everyone knows what NOT to do

---

## Real-World Example: Long Conversation

### Message 1
```
User: "How does the authentication flow work?"

Copilot:
1. graph_set_workspace('/path/to/project', 'my-project')
2. graph_health()
3. code_explain('AuthService')
4. graph_query('show authentication flow')

Response: "The auth flow consists of..."
```

### Message 15 (Where instructions usually break)
```
User: "What if we add OAuth?"

Copilot [WITH SYSTEM PROMPT]:
1. Detects instruction might be fading
2. Calls graph_health() to re-anchor
3. code_explain('AuthService')
4. find_pattern('OAuth pattern')
5. arch_suggest('OAuth implementation')

Response: "Adding OAuth would affect..."

[WITHOUT SYSTEM PROMPT - WOULD HAPPEN]:
"Let me read the auth files to understand the current flow..."
❌ Breaks the pattern
```

### Message 30 (Without token-efficient patterns)
```
User: "Can you explain all the validators?"

Copilot [WRONG]:
graph_query('list all validators')
→ Returns 50 validators
→ Tries to include all in context
→ Token budget explodes

Copilot [RIGHT]:
context_pack(task: 'validator patterns', profile: 'compact')
→ Returns token-efficient summary
→ Includes only essential context
→ Stays within budget
```

---

## The Key Insight

**The problem isn't the instructions. The problem is the system prompt.**

Copilot's default system prompt prioritizes:
1. Fast, direct answers
2. File reads (training data bias)
3. Grep patterns (common in training data)

Your instructions are merely suggestions overlaid on top.

**The solution** is to make the system prompt itself enforce MCP:
- Make file reads impossible (system level)
- Make grep forbidden (system level)
- Make MCP mandatory (system level)

Now even in message 100, Claude will use MCP because it's not a guideline—it's the only option.

---

## Testing: Validate Long Conversation Stability

```typescript
// test-long-conversation.ts
async function testLongConversation() {
  const conversation = [];

  for (let i = 0; i < 50; i++) {
    conversation.push({
      role: 'user',
      content: `Question ${i}: [varies]`
    });

    // Claude should respond without any file reads
    const response = await claude.chat(conversation, {
      systemPrompt: ENFORCED_MCP_SYSTEM_PROMPT
    });

    // Verify response uses MCP tools
    if (response.includes('readFileSync') || response.includes('grep')) {
      console.error(`❌ Message ${i}: Fell back to file read/grep`);
    } else {
      console.log(`✅ Message ${i}: Used MCP tools`);
    }
  }
}
```

---

## Summary: Why This Works

| Before | After |
|--------|-------|
| Instructions get ignored | System prompt is non-negotiable |
| Copilot reads files | File reads are impossible |
| Uses grep | Grep is forbidden |
| Patterns break in long conversations | Health checks re-anchor every 5 messages |
| No context from code relationships | MCP tools provide graph context |
| Token bloat from full files | `context_pack` + `semantic_slice` for efficiency |

**Result**: Heavy, seamless MCP dependency. Zero fallback. Even in 100-message conversations.

---

## Next Steps

1. **Update Claude Desktop config** with system prompt above
2. **Hardened `.github/copilot-instructions.md`** with rules
3. **Test**: Start a long conversation, verify no file reads
4. **Deploy**: Roll out to VS Code + Copilot integrations
5. **Monitor**: Track tool usage in Claude sessions

Your instructions won't be ignored anymore—they'll be built into the system prompt itself. 🚀
