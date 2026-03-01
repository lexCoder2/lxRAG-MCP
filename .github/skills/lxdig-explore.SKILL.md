# lxdig-explore Skill

**Description:**
Explore and understand a codebase using the lxDIG graph — finds key entry points, clusters, and similar code. Use when orienting in an unfamiliar codebase or after a graph rebuild.

**When to use:**
- Exploring an unfamiliar codebase
- After a graph rebuild
- Need to locate entry points, clusters, or code patterns

**Workflow:**
1. Check graph health (`graph_health`)
2. Query node type breakdown (`graph_query`)
3. Show code clusters (`code_clusters`) — pass `type`: function | class | file
4. Explain symbol or search by topic (`code_explain` with `element` = file path/class/function name, or `semantic_search` with a natural language `query`)
5. Find similar code (`find_similar_code`) — pass `elementId` using the `id` field from a `graph_query` or `code_explain` result (not a name string)
6. Check for patterns (`find_pattern`) — pass `pattern` (search string) and `type` (circular | unused | violation | pattern)
7. Slice relevant subgraph for focused context (`semantic_slice`)
8. Present summary of entry points, clusters, and key patterns
9. Suggest next step: `/lxdig-place` to add code or `/lxdig-refactor` to modify it

**Profile tip:** Use `compact` for scanning. Switch to `balanced` when presenting findings to the user.

**Tools:**
- graph_health
- graph_query
- code_explain
- semantic_search
- code_clusters
- find_similar_code
- find_pattern
- semantic_slice
