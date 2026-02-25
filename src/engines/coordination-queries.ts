/**
 * @file engines/coordination-queries
 * @description Shared Cypher query constants consumed by the coordination engine.
 * @remarks Isolating queries improves readability, testability, and optimization review.
 */

export const CoordinationQueries = {
  /** Check for an active conflicting claim on the same target from a *different* agent */
  CONFLICT_CHECK: `
    MATCH (c:CLAIM)-[:TARGETS]->(t {id: $targetId, projectId: $projectId})
    WHERE c.validTo IS NULL
      AND c.agentId <> $agentId
    RETURN c.id AS claimId, c.agentId AS agentId, c.intent AS intent, c.validFrom AS since
    ORDER BY c.validFrom DESC
    LIMIT 1`,

  /** Look up snapshot info (hash/commit) for a target node */
  TARGET_SNAPSHOT: `
    MATCH (t {id: $targetId, projectId: $projectId})
    RETURN t.validFrom AS validFrom,
           t.contentHash AS contentHash,
           t.hash AS hash,
           t.gitCommit AS gitCommit
    ORDER BY t.validFrom DESC
    LIMIT 1`,

  /** Create a new CLAIM node */
  CREATE_CLAIM: `
    CREATE (c:CLAIM {
      id: $id,
      agentId: $agentId,
      sessionId: $sessionId,
      taskId: $taskId,
      claimType: $claimType,
      targetId: $targetId,
      intent: $intent,
      validFrom: $validFrom,
      targetVersionSHA: $targetVersionSHA,
      validTo: null,
      invalidationReason: null,
      outcome: null,
      projectId: $projectId
    })`,

  /** Create TARGETS edge from a claim to its target node */
  LINK_CLAIM_TO_TARGET: `
    MATCH (c:CLAIM {id: $claimId, projectId: $projectId})
    MATCH (t {id: $targetId, projectId: $projectId})
    MERGE (c)-[:TARGETS]->(t)`,

  /** Close (release) a claim — checks it is still open first */
  RELEASE_CLAIM_OPEN_CHECK: `
    MATCH (c:CLAIM {id: $claimId})
    RETURN c.validTo AS validTo, c.id AS id`,

  /** Actually close the claim */
  RELEASE_CLAIM: `
    MATCH (c:CLAIM {id: $claimId})
    WHERE c.validTo IS NULL
    SET c.validTo = $now,
        c.invalidationReason = 'released',
        c.outcome = $outcome`,

  /** Active claims for a single agent */
  AGENT_ACTIVE_CLAIMS: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
      AND c.agentId = $agentId
      AND c.validTo IS NULL
    RETURN c
    ORDER BY c.validFrom DESC`,

  /** Recent episodes for a single agent */
  AGENT_RECENT_EPISODES: `
    MATCH (e:EPISODE)
    WHERE e.projectId = $projectId
      AND e.agentId = $agentId
    RETURN e.id AS id, e.type AS type, e.content AS content,
           e.timestamp AS timestamp, e.taskId AS taskId
    ORDER BY e.timestamp DESC
    LIMIT 10`,

  /** All active claims in a project */
  OVERVIEW_ACTIVE: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
      AND c.validTo IS NULL
    RETURN c
    ORDER BY c.validFrom DESC`,

  /** Stale claims — target node has been updated since the claim was created */
  OVERVIEW_STALE: `
    MATCH (c:CLAIM)-[:TARGETS]->(t)
    WHERE c.projectId = $projectId
      AND c.validTo IS NULL
      AND t.projectId = $projectId
      AND t.validFrom > c.validFrom
    RETURN c
    ORDER BY c.validFrom DESC`,

  /** Conflicting claim pairs — two open claims on the same target from different agents */
  OVERVIEW_CONFLICTS: `
    MATCH (c1:CLAIM)-[:TARGETS]->(t)<-[:TARGETS]-(c2:CLAIM)
    WHERE c1.projectId = $projectId
      AND c2.projectId = $projectId
      AND c1.validTo IS NULL
      AND c2.validTo IS NULL
      AND c1.id < c2.id
      AND c1.agentId <> c2.agentId
    RETURN t.id AS targetId,
           c1.id AS claimAId, c1.agentId AS claimAAgent, c1.intent AS claimAIntent, c1.validFrom AS claimASince,
           c2.id AS claimBId, c2.agentId AS claimBAgent, c2.intent AS claimBIntent, c2.validFrom AS claimBSince
    ORDER BY targetId`,

  /** Agent-level summary (claim counts + last seen) */
  OVERVIEW_AGENT_SUMMARY: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
      AND c.validTo IS NULL
    RETURN c.agentId AS agentId,
           count(c) AS claimCount,
           max(c.validFrom) AS lastSeen
    ORDER BY claimCount DESC, lastSeen DESC`,

  /** Total claim count for a project */
  OVERVIEW_TOTAL: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
    RETURN count(c) AS totalClaims`,

  /** Invalidate stale claims whose target node has been updated */
  INVALIDATE_STALE: `
    MATCH (c:CLAIM)-[:TARGETS]->(t)
    WHERE c.projectId = $projectId
      AND c.validTo IS NULL
      AND t.projectId = $projectId
      AND t.validFrom > c.validFrom
    SET c.validTo = $now,
        c.invalidationReason = 'code_changed'
    RETURN count(c) AS invalidated`,

  /** Close all open claims for a completed task */
  ON_TASK_COMPLETED: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
      AND c.taskId = $taskId
      AND c.validTo IS NULL
    SET c.validTo = $now,
        c.invalidationReason = 'task_completed',
        c.outcome = coalesce(c.outcome, $outcome)`,

  /** Expire claims older than a given timestamp (TTL enforcement) */
  EXPIRE_OLD_CLAIMS: `
    MATCH (c:CLAIM)
    WHERE c.projectId = $projectId
      AND c.validTo IS NULL
      AND c.validFrom < $cutoffMs
    SET c.validTo = $now,
        c.invalidationReason = 'expired'
    RETURN count(c) AS expired`,
} as const;
