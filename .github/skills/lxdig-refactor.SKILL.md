# lxdig-refactor Skill

**Description:**
Safe refactor workflow using lxDIG — runs impact analysis, selects affected tests, validates architecture, and records the decision. Use before making structural code changes.

**When to use:**
- Refactoring a file or symbol
- Need to assess impact, test coverage, and architecture compliance
- About to make structural code changes

**Context needed:**
- The file path(s) or symbol name being refactored (used in steps 1 and 3)

**Workflow:**
1. Analyze impact (`impact_analyze`) — pass `changedFiles: [<file path>]`
2. Check for blockers (`blocking_issues`)
3. Select affected tests (`test_select`) — pass `changedFiles: [<file path>]`
4. Categorize tests (`test_categorize`)
5. Validate architecture (`arch_validate`) — optionally pass `files: [<file path>]` to scope
6. Suggest missing tests (`suggest_tests`) — pass `elementId` from a `graph_query` result
7. Run tests (`test_run`)
8. Record decision with rationale (`episode_add`) — set `type: DECISION`, pass rationale in `metadata: { rationale: "..." }` (required for DECISION type)
9. Show diff since last change (`diff_since`) — pass `since` as ISO timestamp or epoch ms (e.g. from `git log -1 --format=%cI`)

**Profile tip:** Use `compact` throughout. Switch to `debug` if a tool returns unexpected results.

**Tools:**
- impact_analyze
- test_select
- test_categorize
- arch_validate
- suggest_tests
- test_run
- blocking_issues
- episode_add
- diff_since
