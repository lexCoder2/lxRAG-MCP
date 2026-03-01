# lxdig-docs Skill

**Description:**
Search project documentation using lxDIG, with automatic cold-start indexing when the index is empty. Use when looking up architecture guides, ADRs, READMEs, or any markdown documentation.

**When to use:**
- Looking up project documentation by topic or symbol name
- Need to find architecture guides, ADRs, or README content
- Checking why an architectural decision was made

**Workflow:**
1. Search docs with `search_docs` (query: topic/symbol, limit: 8)
2. If no results, check graph health (`graph_health`), index docs (`index_docs`), then search again
3. If input is a code symbol, also search by symbol name
4. Present matching sections (source, heading, excerpt, line number)
5. If still no results, suggest `/lxdig-explore` for code search or `/lxdig-decision` for recorded decisions

**Profile tip:** Use `compact` for lookups. Use `balanced` when presenting doc content to the user.

**Tools:**
- search_docs
- index_docs
- graph_health
