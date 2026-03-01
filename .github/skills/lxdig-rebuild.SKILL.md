# lxdig-rebuild Skill

**Description:**
Rebuild the lxDIG code graph and verify its health — runs full or incremental rebuild, checks node counts, and shows what changed. Use after significant code changes or when graph data seems stale.

**When to use:**
- After major code changes
- When graph data may be stale
- Before running impact analysis or architecture validation

**Workflow:**
1. Check pre-build health (`graph_health`)
2. Rebuild graph (`graph_rebuild`)
3. Check post-build health (`graph_health`)
4. Show what changed (`diff_since`) — pass `since` as ISO timestamp or epoch ms; skip if unavailable
5. Query node type breakdown (`graph_query`)
6. Summarize mode, node counts, and changes
7. Suggest next step: `/lxdig-explore` to orient in the updated graph

**Profile tip:** Use `compact` for automated pipelines. Use `balanced` when reviewing rebuild results with a user.

**Tools:**
- graph_rebuild
- graph_health
- graph_query
- diff_since
- graph_set_workspace
