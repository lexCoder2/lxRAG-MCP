# Copilot Instructions - lxRAG MCP Server (Template)

Copy this file to `.github/copilot-instructions.md` in your project and replace placeholders.

---

## Core Rules

1. Use MCP tools first for code intelligence and dependency analysis.
2. Initialize session context before deep analysis.
3. Re-anchor with `graph_health()` periodically on long threads.

---

## Recommended Init Flow

Preferred one-shot setup:

```json
{
  "tool": "init_project_setup",
  "args": {
    "workspaceRoot": "/path/to/project",
    "projectId": "project-id",
    "sourceDir": "src",
    "rebuildMode": "incremental"
  }
}
```

Alternative explicit flow:

1. `graph_set_workspace(workspaceRoot, projectId, sourceDir)`
2. `graph_rebuild(mode="incremental")`
3. `graph_health()`

Long threads: call `graph_health()` every ~5 messages.

---

## Tool Quick Reference

| Question              | Tool                                | Example                  |
| --------------------- | ----------------------------------- | ------------------------ |
| Find code             | `graph_query`                       | "find all HTTP handlers" |
| Understand symbol     | `code_explain`                      | Symbol, class, or file   |
| Impact before edit    | `impact_analyze`                    | Changed file list        |
| Select tests          | `test_select`                       | Changed file list        |
| Search by concept     | `semantic_search`                   | "validation patterns"    |
| Validate architecture | `arch_validate` / `arch_suggest`    | File or module context   |
| Persist decisions     | `episode_add`                       | Decision + rationale     |
| Recall decisions      | `decision_query` / `episode_recall` | Topic or task            |

Full reference: [QUICK_REFERENCE.md](../QUICK_REFERENCE.md) (39 tools)

---

## Project Placeholders

- Project: `[YOUR_PROJECT_NAME]`
- Workspace root: `[YOUR_WORKSPACE_PATH]`
- Project ID: `[YOUR_PROJECT_ID]`

---

## Related Docs

- [MCP Integration Guide](../MCP_INTEGRATION_GUIDE.md)
- [Tool Patterns](../TOOL_PATTERNS.md)
- [Tools Information Guide](../TOOLS_INFORMATION_GUIDE.md)
- [Quick Reference](../../QUICK_REFERENCE.md)
