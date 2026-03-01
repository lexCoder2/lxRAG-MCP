# lxdig-init Skill

**Description:**
Initialize a project with lxDIG — sets workspace context, rebuilds the code graph, and writes copilot instructions. Use when starting work on a new or unfamiliar codebase with lxDIG available.

**When to use:**
- First time working in a codebase
- Need to (re)initialize the project graph
- lxDIG tools are available but not yet configured

**Context needed:**
- Absolute path to the project root (`workspaceRoot`)
- Optional: `projectId` (defaults to folder name), `sourceDir` (defaults to `src`)

**Workflow:**
1. List available lxDIG tools (`tools_list`)
2. Run one-shot init (`init_project_setup`) — pass `workspaceRoot` (required), `sourceDir`, `projectId`
3. Write copilot instructions (`setup_copilot_instructions`)
4. Verify graph health (`graph_health`)
5. Query node type breakdown (`graph_query`)
6. Summarize projectId, workspaceRoot, node counts, and copilot-instructions path
7. Suggest next step: `/lxdig-explore`

**Profile tip:** Use `compact` throughout. The init tools are optimized for compact output.

**Tools:**
- tools_list
- init_project_setup
- setup_copilot_instructions
- graph_health
- graph_query
