# lxdig-progress Skill

**Description:**
Query and update task and feature progress using lxDIG — lists active/blocked items, updates status, and surfaces blockers. Use when managing delivery state or tracking what is in-flight.

**When to use:**
- Checking what tasks or features are in progress, blocked, or complete
- Updating task status after completing work
- Surfacing blockers before starting a new task

**Workflow:**
1. Query current tasks or features (`progress_query`) — pass `status`: all | active | blocked | completed
2. Check for blockers (`blocking_issues`)
3. Inspect feature-level rollup when needed (`feature_status`) — pass `featureId` from a `progress_query` result (required; skip if no features returned)
4. Update task status when work completes (`task_update`) — pass `taskId` (from step 1), new `status`, and optional `notes`
5. Record significant state changes as episodes (`episode_add`, type: OBSERVATION)

**Profile tip:** Use `compact` in autonomous loops. Use `balanced` when reporting status to a user.

**Tools:**
- progress_query
- task_update
- feature_status
- blocking_issues
- episode_add
