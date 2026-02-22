# Grep Replacement Patterns

**Never use grep/find/file reads again.** Use MCP tools instead.

## Pattern Examples

### ❌ GREP: Find symbol usage
```bash
grep -r "MyClass" src/ --include="*.ts"
```

### ✅ MCP: Find symbol usage
```typescript
await mcp.query('find all files that reference MyClass', 'natural');
```

**Benefits**: Exact file + line, relationship type, no false positives

---

## Pattern Table

| Task | Grep Command | MCP Tool | Why Better |
|------|---|---|---|
| Find imports | `grep -r "import.*X"` | `graph_query` | Cross-file graph, exact types |
| List functions | `grep "^function"` | `code_explain` | AST-accurate, hierarchy |
| Find test files | `find -name "*.test.ts"` | `test_categorize` | Categorized, complete |
| Impact analysis | Manual checking | `impact_analyze` | Complete, risk score |
| Search by meaning | `grep keywords` | `semantic_search` | Ranked by relevance |

---

## Key Insight

For EVERY grep command, there's an MCP tool that's faster, more accurate, and provides context.

See [CLAUDE_COPILOT_INTEGRATION.md](CLAUDE_COPILOT_INTEGRATION.md) for how Claude should replace your grep usage.
