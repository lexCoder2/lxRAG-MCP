# Claude Configuration Files - Copy & Paste Ready

Exact configs to make Claude/Copilot use MCP in all projects.

---

## 1. Claude Desktop Config

**File**: `~/.claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lexrag": {
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
  }
}
```

**Then restart Claude Desktop.**

---

## 2. VS Code MCP Config

**File**: `.vscode/mcp.json` (in each project, or globally)

```json
{
  "servers": {
    "lexrag": {
      "type": "stdio",
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
  }
}
```

---

## 3. VS Code Settings (Enforce MCP)

**File**: `.vscode/settings.json`

```json
{
  "claude.alwaysUseMCP": true,
  "claude.fallbackToFilesDisabled": true,
  "files.exclude": {
    "**/node_modules": true
  }
}
```

---

## 4. Copilot Instructions (Hardened)

**File**: `.github/copilot-instructions.md`

```markdown
# Code Intelligence - LEXRAG MCP MANDATORY

## Non-Negotiable Rules

### Rule 1: NEVER Read Files
- ❌ "Let me read the file to understand it"
- ✅ Use: `code_explain('SymbolName')`

### Rule 2: NEVER Use Grep
- ❌ "I'll search with grep for..."
- ✅ Use: `graph_query('find all...')`

### Rule 3: ALWAYS Initialize Session First
1. Call: `graph_set_workspace(workspaceRoot, projectId)`
2. Call: `graph_health()`
3. Then proceed to queries

### Rule 4: MCP Tools Only for Code Intelligence
- Finding code → `graph_query`
- Understanding symbols → `code_explain`
- Impact analysis → `impact_analyze`
- Test selection → `test_select`
- Architecture validation → `arch_validate`
- Semantic search → `semantic_search`
- Pattern finding → `find_pattern`

### Rule 5: Prevent Instruction Drift in Long Conversations
Every 5 messages, call: `graph_health()`
If not ready, call: `graph_rebuild(mode: 'incremental')`

### Rule 6: Token Efficiency
- For long conversations: use `profile: 'compact'`
- For code snippets: use `semantic_slice` instead of full files
- For multi-file context: use `context_pack`

## Active Projects
- **cad-engine** → `/home/alex_rod/projects/cad-engine` (projectId: `cad-engine`)
- **cad-web** → `/home/alex_rod/projects/cad-web` (projectId: `cad-web`)

## Tool Quick Reference
| Question | Tool |
|----------|------|
| "How does X work?" | `code_explain('X')` |
| "Find all imports of Y" | `graph_query('find all imports of Y')` |
| "What breaks?" | `impact_analyze([files])` |
| "Which tests?" | `test_select([files])` |
| "Violates architecture?" | `arch_validate()` |
| "Similar patterns?" | `semantic_search('pattern')` |

## Anti-Patterns (FORBIDDEN)
❌ File reads of any kind
❌ Using grep or search patterns
❌ Guessing code structure
❌ Manual import tracing
❌ Falling back to file exploration

## Re-Anchoring Pattern
Message 1, 6, 11, 16, etc.: Always call `graph_health()` to verify MCP is ready
```

---

## 5. Cursor Config (If Using Cursor IDE)

**File**: `.cursor/rules.mdc`

```markdown
# Cursor Rules - MCP-First Code Analysis

# MCP Server
Use the lexRAG MCP server for ALL code intelligence tasks.

# Mandatory Initialization
Before any code queries:
1. Call `graph_set_workspace(workspaceRoot, projectId)`
2. Call `graph_health()` to confirm ready
3. Proceed to queries

# Tool Mapping
- Code discovery: `graph_query(query, language='natural')`
- Symbol explanation: `code_explain(symbol)`
- Change impact: `impact_analyze(changedFiles)`
- Architecture: `arch_validate()` or `arch_suggest()`
- Testing: `test_select(changedFiles)` or `test_categorize()`
- Search by meaning: `semantic_search(query)`
- Pattern detection: `find_pattern(name)` or `find_similar_code()`

# FORBIDDEN
- Reading files with `fs.readFile` or similar
- Using `grep` or shell search commands
- Manual code scanning

# REQUIRED
- Always explain what MCP tool you're using
- Always include the tool call in your response
- Always wait for tool results before synthesizing

# Long Conversation Rules
Every 5 messages:
1. Call `graph_health()` to re-anchor
2. Restate: "Using MCP tools for all code intelligence"
3. If not ready, call `graph_rebuild(mode: 'incremental')`
```

---

## 6. Environment File (.env)

**File**: `.env.local` or `.env` in each project

```bash
# MCP Server Config
MCP_SERVER_URL=http://localhost:9000
MCP_TRANSPORT=stdio

# Project Config
PROJECT_ID=my-project
WORKSPACE_ROOT=/absolute/path/to/project
SOURCE_DIR=src

# Graph Backend
MEMGRAPH_HOST=localhost
MEMGRAPH_PORT=7687
QDRANT_HOST=localhost
QDRANT_PORT=6333

# Features
CODE_GRAPH_USE_TREE_SITTER=true
```

---

## 7. Project Config File

**File**: `.mcp-config.json` (in each project root)

```json
{
  "projectId": "my-project",
  "workspaceRoot": "/absolute/path/to/project",
  "sourceDir": "src",
  "serverUrl": "http://localhost:9000",
  "exclude": [
    "node_modules",
    "dist",
    ".git",
    "build",
    "coverage"
  ],
  "architecture": {
    "layers": [
      {
        "name": "domain",
        "paths": ["src/domain/**"]
      },
      {
        "name": "services",
        "paths": ["src/services/**"]
      },
      {
        "name": "api",
        "paths": ["src/api/**"]
      }
    ],
    "rules": [
      {
        "from": "api",
        "to": "domain",
        "allow": true
      },
      {
        "from": "domain",
        "to": "api",
        "allow": false
      }
    ]
  }
}
```

---

## 8. Git Attributes (Prevent Accidental File Reads)

**File**: `.gitattributes`

```gitattributes
# Mark files as binary to prevent editor from opening them
*.lock binary
*.min.js binary
dist/* binary
build/* binary
node_modules/** binary
```

---

## 9. EditorConfig (Optional But Useful)

**File**: `.editorconfig`

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

---

## Installation Steps (Quick Start)

### 1. Update Claude Desktop

```bash
# Edit Claude Desktop config
code ~/.claude_desktop_config.json

# Paste the config from section 1 above
# Make sure path is correct: /home/alex_rod/code-graph-server/dist/server.js

# Restart Claude Desktop
```

### 2. Update VS Code Settings

```bash
# For each project:
cd /home/alex_rod/projects/my-project

# Create .vscode directory if needed
mkdir -p .vscode

# Create mcp.json
cat > .vscode/mcp.json << 'EOF'
{
  "servers": {
    "lexrag": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/alex_rod/code-graph-server/dist/server.js"]
    }
  }
}
EOF

# Create settings.json (or update if exists)
cat > .vscode/settings.json << 'EOF'
{
  "claude.alwaysUseMCP": true,
  "claude.fallbackToFilesDisabled": true
}
EOF
```

### 3. Add Copilot Instructions

```bash
# For each project:
mkdir -p .github

cat > .github/copilot-instructions.md << 'EOF'
[Copy content from section 4 above]
EOF

git add .github/copilot-instructions.md
git commit -m "chore: add MCP-first copilot instructions"
```

### 4. Add Project Config

```bash
# For each project:
cat > .mcp-config.json << 'EOF'
[Copy content from section 7, update projectId and paths]
EOF

git add .mcp-config.json
git commit -m "chore: add MCP project configuration"
```

### 5. Verify Setup

```bash
# Make sure MCP server is running
ps aux | grep "node.*code-graph-server"

# Make sure Memgraph + Qdrant are running
docker-compose ps

# Test in Claude Desktop or VS Code
# Open a code file and ask: "How does this file work?"
# Should get MCP tool calls in the response
```

---

## Verification Checklist

- [ ] Claude Desktop config updated and restarted
- [ ] VS Code `.vscode/mcp.json` created in each project
- [ ] VS Code `settings.json` has `claude.alwaysUseMCP: true`
- [ ] `.github/copilot-instructions.md` committed to each project
- [ ] `.mcp-config.json` created with correct projectId and paths
- [ ] MCP server running: `npm run start:http` in code-graph-server
- [ ] Memgraph + Qdrant running: `docker-compose ps`
- [ ] Test conversation: Ask Claude a code question, verify it uses MCP tools
- [ ] Long conversation test: Ask 30+ questions, verify it never falls back to file reads

---

## Debugging

### Claude Desktop won't use MCP

```bash
# Check config
cat ~/.claude_desktop_config.json

# Verify path is correct
ls -la /home/alex_rod/code-graph-server/dist/server.js

# Check MCP server is running
curl http://localhost:9000/health

# Restart Claude Desktop completely
```

### VS Code won't use MCP

```bash
# Check settings
cat .vscode/mcp.json
cat .vscode/settings.json

# Reload VS Code window
Cmd+Shift+P → "Developer: Reload Window"

# Check extension logs
Output → "MCP Server"
```

### Claude still reads files

```bash
# Verify system prompt is active
# Should see in Claude Desktop settings

# Check Copilot instructions
cat .github/copilot-instructions.md

# Force re-initialization
Ask: "Let's start over. Initialize MCP server."
Claude should respond with graph_set_workspace call
```

### Graph not indexing

```bash
# Verify MCP server can access workspace
cd /home/alex_rod/code-graph-server
npm run build
npm run start:http

# Check logs for errors
# Should show project initialization messages
```

---

## One-Liner Setup (Fast Track)

```bash
# Copy configs to all projects at once
for project in cad-engine cad-web; do
  mkdir -p /home/alex_rod/projects/$project/.vscode
  mkdir -p /home/alex_rod/projects/$project/.github

  # MCP config
  cp /home/alex_rod/code-graph-server/CLAUDE_CONFIG_FILES.md \
     /home/alex_rod/projects/$project/.vscode/mcp.json

  # Instructions
  cp /home/alex_rod/code-graph-server/CLAUDE_CONFIG_FILES.md \
     /home/alex_rod/projects/$project/.github/copilot-instructions.md

  # Project config
  cp /home/alex_rod/code-graph-server/CLAUDE_CONFIG_FILES.md \
     /home/alex_rod/projects/$project/.mcp-config.json
done
```

---

## Result

After setup:

✅ Claude always uses MCP tools in chat
✅ Copilot instructions don't get ignored
✅ Long conversations stay MCP-anchored
✅ No fallback to file reads or grep
✅ Heavy, seamless MCP dependency

Your projects are now **MCP-first and MCP-only**. 🚀
