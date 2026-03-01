# lxdig-ref Skill

**Description:**
Search a sibling repository on the same machine for architecture patterns, conventions, design examples, or symbol references — without indexing it into the main graph. Use when borrowing context from a well-structured reference repo.

**When to use:**
- Looking for how a pattern is implemented in another local repo
- Need architecture or convention examples from a sibling project
- Searching for a specific symbol (function/class/interface) in another codebase

**Context needed:**
- Absolute path to the reference repository on this machine

**Workflow:**
1. Query the reference repo (`ref_query`) with `repoPath`, `query`, and optional `symbol`
   - `mode: auto` (default) — infers docs vs code vs architecture from query text
   - `mode: docs` or `architecture` — markdown/ADR files only
   - `mode: code` or `patterns` — source files only
   - `mode: structure` — directory tree only
   - `mode: all` — everything
2. Present findings (file, heading or excerpt, score)
3. Suggest next step: `/lxdig-explore` to search the current repo for the same pattern

**Profile tip:** Use `compact` for quick lookups. Use `balanced` when presenting findings to the user.

**Tools:**
- ref_query
