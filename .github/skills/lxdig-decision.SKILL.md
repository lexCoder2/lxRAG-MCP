# lxdig-decision Skill

**Description:**
Record or query architectural decisions using lxDIG memory. Use when making a significant design choice, or to recall why something was built a certain way.

**When to use:**
- Making or recording a design/architecture decision
- Querying or reflecting on past decisions

**Workflow — detect intent and follow the matching path:**

**Path A — Query/Recall** (input is a question or topic):
1. Search decisions (`decision_query`) — pass `query` as a topic or question string
2. Search episodes (`episode_recall`) — pass the same query
3. Present results

**Path B — Reflect** (no input or "reflect"):
1. Surface recent decisions (`reflect`)
2. Present summary

**Path C — Record** (input describes a new decision):
1. Check for duplicates (`decision_query`) — pass the decision topic as `query`
2. Record with rationale (`episode_add`) — set `type: DECISION`, `content`: short summary, `metadata: { rationale: "..." }` (**required** for DECISION type or call will fail)
3. Confirm recording

**Profile tip:** Use `compact` for record operations. Use `balanced` when presenting recalled decisions to the user.

**Tools:**
- episode_add
- episode_recall
- decision_query
- reflect
