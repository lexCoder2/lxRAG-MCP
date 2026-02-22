# Tool Patterns: MCP vs Grep/Files

Quick reference for replacing grep/file reads with MCP tools.

## Discovery: Find Code

### ❌ Grep Approach
```bash
grep -r "MyClass" src/ --include="*.ts"
grep -r "import.*AuthService" src/
grep -r "function.*handle" src/api/
```

### ✅ MCP Approach
```typescript
await mcp.query('find all references to MyClass');
await mcp.query('find all imports of AuthService');
await mcp.query('find all HTTP request handlers');
```

**Benefits**: 10x faster, zero false positives, full context

---

## Understanding: Explain Code

### ❌ File Read Approach
```bash
cat src/auth/service.ts  # Read entire file
grep -n "class AuthService" src/auth/service.ts
grep -n "validateToken" src/auth/service.ts
```

### ✅ MCP Approach
```typescript
await mcp.explain('AuthService');
// Returns: definition + all methods + dependencies + callers
```

**Benefits**: Structured output, no parsing needed, full context graph

---

## Impact: What Breaks?

### ❌ Manual Approach
```bash
git diff --name-only HEAD~1
# Then manually check affected files and tests
# Time: 10+ minutes
# Accuracy: Incomplete
```

### ✅ MCP Approach
```typescript
await mcp.call('impact_analyze', {
  changedFiles: ['src/auth/service.ts']
});
// Returns: direct dependents, indirect dependents, affected tests, risk level
```

**Benefits**: Complete, accurate, instant

---

## Testing: Which Tests to Run?

### ❌ Manual Approach
```bash
find . -name "*.test.ts" | xargs grep -l "AuthService"
# Time: 5+ minutes
# Might miss tests
```

### ✅ MCP Approach
```typescript
await mcp.call('test_select', {
  changedFiles: ['src/auth/service.ts']
});
// Returns: exact test files affected
```

**Benefits**: Accurate, instant, tested

---

## Patterns: Find Violations

### ❌ Grep Approach
```bash
grep -r "console\.log" src/
grep -r "\.any()" src/
grep -r "hardcoded.*password" src/
```

### ✅ MCP Approach
```typescript
await mcp.call('arch_validate', { profile: 'strict' });
// Returns: architecture violations with severity
```

**Benefits**: Rule-based (not keyword matching), accurate

---

## Search by Meaning

### ❌ Grep Approach
```bash
grep -r "validate" src/  # Returns 500+ results
grep -r "error.*handling" src/  # Returns 1000+ results
# Manual filtering required
```

### ✅ MCP Approach
```typescript
await mcp.call('semantic_search', {
  query: 'input validation patterns',
  limit: 10
});
// Returns: 10 most relevant results by meaning
```

**Benefits**: Semantic ranking, high signal-to-noise

---

## Similar Code: Find Patterns

### ❌ Manual Approach
```bash
grep -r "class.*Service" src/
# Manual comparison of 50+ results
```

### ✅ MCP Approach
```typescript
await mcp.call('find_similar_code', {
  symbol: 'AuthService',
  limit: 5
});
// Returns: 5 most similar implementations
```

**Benefits**: Structural matching, instant

---

## Architecture: Where Does Code Go?

### ❌ Manual Approach
```bash
# Read architecture docs
# Manually check layer rules
# Guess best location
# Time: 30+ minutes
```

### ✅ MCP Approach
```typescript
await mcp.call('arch_suggest', {
  filePath: 'new-feature.ts'
});
// Returns: recommended layer + reasoning
```

**Benefits**: Rule-based, instant

---

## All 38 Tools Quick Lookup

| Use Case | Tool | Example |
|----------|------|---------|
| **Find code** | `graph_query` | find all HTTP handlers |
| **Understand symbol** | `code_explain` | AuthService |
| **Impact of change** | `impact_analyze` | [files] |
| **Tests to run** | `test_select` | [files] |
| **Architecture violations** | `arch_validate` | {} |
| **Where to put code** | `arch_suggest` | filePath |
| **Search by concept** | `semantic_search` | "validation" |
| **Similar patterns** | `find_similar_code` | symbol |
| **Detect violations** | `find_pattern` | "pattern name" |
| **Categorize tests** | `test_categorize` | {} |
| **Test coverage gaps** | `suggest_tests` | symbol |
| **Get context** | `context_pack` | task, profile |
| **Code snippets** | `semantic_slice` | symbol |
| **Historical changes** | `diff_since` | timestamp |
| **Record decision** | `episode_add` | type, content, agentId |
| **Recall decisions** | `decision_query` | agentId |
| **Claim task** | `agent_claim` | agentId, taskName |
| **Release task** | `agent_release` | agentId, taskName |
| **Check coordination** | `agent_status` | {} |
| **Graph health** | `graph_health` | {} |
| **Rebuild graph** | `graph_rebuild` | mode |
| **Cypher query** | `graph_query` | query, language:'cypher' |
| **Set workspace** | `graph_set_workspace` | workspaceRoot, projectId |
| **Code clusters** | `code_clusters` | {} |
| **Semantic diff** | `semantic_diff` | symbol1, symbol2 |
| **Test run** | `test_run` | testFiles |
| **Progress query** | `progress_query` | task |
| **Task update** | `task_update` | taskId, status |
| **Feature status** | `feature_status` | feature |
| **Blocking issues** | `blocking_issues` | {} |
| **Reference repo** | `ref_query` | query |
| **Setup project** | `init_project_setup` | workspaceRoot |
| **Setup copilot** | `setup_copilot_instructions` | {} |
| **Reflect on session** | `reflect` | agentId |
| **Coordination overview** | `coordination_overview` | {} |
| **Search docs** | `search_docs` | query |
| **Index docs** | `index_docs` | {} |

## Performance Comparison

| Task | Grep | MCP | Improvement |
|------|------|-----|---|
| Find symbol | 450ms | 50ms | 9x |
| Understand function | 5 min manual | 200ms | 1500x |
| Impact analysis | 10 min manual | 100ms | 6000x |
| Search by meaning | 2 min grep | 150ms | 800x |

---

## Rules for Tool Selection

1. **Finding anything** → `graph_query` (never grep)
2. **Understanding a symbol** → `code_explain` (never read files)
3. **Analyzing impact** → `impact_analyze` (never manual check)
4. **Selecting tests** → `test_select` (never find them manually)
5. **Checking architecture** → `arch_validate` (never manual review)
6. **Searching by concept** → `semantic_search` (never keyword grep)
7. **Recording decisions** → `episode_add` (never docs that rot)
8. **Coordinating agents** → `agent_claim` (never external locks)

---

## Token Efficiency (Long Conversations)

Use these for compact responses:
- `profile: 'compact'` — for token-light answers
- `semantic_slice` — get only relevant code lines
- `context_pack` — multi-file context under budget

Avoid:
- Full file reads (use `semantic_slice` instead)
- Long lists (use `limit` parameter)
- Multiple separate queries (combine when possible)
