# lxdig-place Skill

**Description:**
Find the best location for new code using lxDIG — checks architecture rules, blockers, and existing patterns before writing anything. Use when adding a new component, service, hook, or module.

**When to use:**
- Adding a new component, service, hook, context, utility, engine, class, or module

**Context needed:**
- Name of the new code element (e.g. "UserService")
- Type: one of `component` | `hook` | `service` | `context` | `utility` | `engine` | `class` | `module`

**Workflow:**
1. Check for blockers (`blocking_issues`)
2. Get architecture suggestion (`arch_suggest`) — pass `name` and `type` (component/hook/service/context/utility/engine/class/module); optionally `dependencies` (list of imports it will use)
3. Find similar code (`semantic_search`) — pass a natural language `query` describing the new element
4. Check for patterns (`find_pattern`) — pass `pattern` (search string) and `type` (circular | unused | violation | pattern)
5. Show cluster context (`code_clusters`)
6. Validate target path (`arch_validate`) — pass `files: [<proposed path>]`
7. Present recommended location with rationale
8. Optionally record episode (`episode_add`) — set `type: DECISION`
9. Suggest next step: `/lxdig-refactor` to safely implement the change

**Profile tip:** Use `compact` throughout.

**Tools:**
- arch_suggest
- blocking_issues
- semantic_search
- find_pattern
- arch_validate
- code_clusters
- episode_add
