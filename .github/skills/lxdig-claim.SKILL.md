# lxdig-claim Skill

**Description:**
Multi-agent safe-edit workflow using lxDIG coordination — claims a file or task, makes changes, then releases the lock. Use in multi-agent environments to avoid conflicts.

**When to use:**
- Editing a file or task in a multi-agent environment
- Need to avoid edit conflicts with other agents

**Context needed:**
- The target file path or task ID to claim
- A brief intent description (what you plan to do with the target)

**Workflow:**
1. Check for active claims (`coordination_overview`)
2. Load context (`context_pack`)
3. Claim the target (`agent_claim`) — pass `targetId` (file path or task ID), `claimType` (task | file | function | feature), and `intent` (natural language description of your plan); save the returned `claimId`
4. Verify claim is active (`agent_status`)
5. Proceed with edits
6. Release claim when done (`agent_release`) — pass the `claimId` from step 3
7. Optionally record episode (`episode_add`) — set `type: EDIT`

**Profile tip:** Use `compact` throughout.

**Tools:**
- coordination_overview
- context_pack
- agent_claim
- agent_status
- agent_release
- episode_add
