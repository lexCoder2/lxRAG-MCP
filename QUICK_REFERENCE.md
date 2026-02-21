# Claude + MCP - Quick Reference

## ✅ MCP Configured Globally

MCP configuration is now loaded by default from `~/.claude/mcp.json`. No flag needed!

### Basic Syntax
```bash
claude --message "Your question"
```

### Interactive Mode
```bash
claude --interactive
```

## Setup Checklist

- [ ] Services running: `docker-compose ps` (in `tools/docker/`)
- [ ] MCP server running: `node dist/server.js` (in `tools/graph-server/`)
- [ ] Graph populated: `docker-compose exec memgraph memgraph-cli --exec "MATCH (n) RETURN count(n)"`
- [ ] Claude installed: `claude --version`

## 5 Quick Examples

### 1. Architecture Violations
```bash
claude --message "What architecture violations exist?"```

### 2. Test Selection
```bash
claude --message "Which tests are affected by src/engine/calculations/columns.ts?"```

### 3. Code Explanation
```bash
claude --message "Explain LoadTakedownService and its dependencies"```

### 4. Find Patterns
```bash
claude --message "Find all circular dependencies"```

### 5. Impact Analysis
```bash
claude --message "Show blast radius of changes to BuildingContext"```

## Interactive Mode (Recommended)

Best for follow-up questions and exploration:

```bash
claude --interactive```

Then just ask naturally:
```
> What are architecture violations?
> Which tests should I run?
> Find unused code
> Show me layer statistics
> What features are in progress?
```

## All 14 Tools Available

Simply ask Claude naturally - it will use the right tool:

- **GraphRAG**: `graph_query`, `code_explain`, `find_pattern`
- **Architecture**: `arch_validate`, `arch_suggest`
- **Test Intelligence**: `test_select`, `test_categorize`, `impact_analyze`, `test_run`
- **Progress Tracking**: `progress_query`, `task_update`, `feature_status`, `blocking_issues`
- **Utility**: `graph_rebuild`

## Troubleshooting

### Command not found
```bash
which claude
# If not found, install: npm install -g @anthropic-ai/claude
```

### MCP config not loading
```bash
# Verify file exists
ls -la /home/alex_rod/stratSolver/.claude/mcp.json

# Check syntax (should be valid JSON)
cat /home/alex_rod/stratSolver/.claude/mcp.json | jq .
```

### No results from tools
```bash
# Ensure services are running
docker-compose ps

# Check graph has data
docker-compose exec memgraph memgraph-cli --exec "MATCH (n) RETURN count(n)"

# MCP server should be running
ps aux | grep "node dist/server.js"
```

### "Connection refused" error
```bash
# Start MCP server in another terminal
cd /home/alex_rod/stratSolver/tools/graph-server
node dist/server.js

# Should see: [CodeGraphServer] Started successfully (stdio transport)
```

## File Locations

| What | Location |
|------|----------|
| MCP Config | `/home/alex_rod/stratSolver/.claude/mcp.json` |
| MCP Server | `/home/alex_rod/stratSolver/tools/graph-server/dist/server.js` |
| Docs | `/home/alex_rod/stratSolver/tools/graph-server/CLAUDE_*.md` |
| Verification | `/home/alex_rod/stratSolver/tools/graph-server/verify-claude-cli.sh` |

## Common Workflows

### Pre-Commit Check
```bash
claude --message "Check for architecture violations"claude --message "Which tests should I run?"```

### Code Review Prep
```bash
claude --interactive# Then ask follow-up questions naturally
```

### Feature Planning
```bash
claude --message "Where should I implement this new feature?"claude --message "What will this depend on?"```

## Tips

- **Use interactive mode** for better follow-up questions
- **Be specific**: "Find violations in components layer" > "analyze code"
- **Combine queries**: Use interactive mode instead of multiple commands
- **Context helps**: Describe what you're working on for better results

---

**Version**: Claude CLI with `--mcp-config` flag
**Updated**: February 18, 2026
