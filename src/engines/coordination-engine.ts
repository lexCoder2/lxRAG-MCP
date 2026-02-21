import type MemgraphClient from "../graph/client.js";

export type ClaimType = "task" | "file" | "function" | "feature";
export type InvalidationReason =
  | "released"
  | "code_changed"
  | "task_completed"
  | "expired";

export interface AgentClaim {
  id: string;
  agentId: string;
  sessionId: string;
  taskId?: string;
  claimType: ClaimType;
  targetId: string;
  intent: string;
  validFrom: number;
  targetVersionSHA?: string;
  validTo: number | null;
  invalidationReason?: InvalidationReason;
  outcome?: string;
  projectId: string;
}

export interface ClaimInput {
  agentId: string;
  sessionId: string;
  projectId: string;
  targetId: string;
  claimType: ClaimType;
  intent: string;
  taskId?: string;
}

export interface ClaimResult {
  claimId: string;
  status: "ok" | "CONFLICT";
  conflict?: { agentId: string; intent: string; since: number };
  targetVersionSHA: string;
}

export interface AgentStatus {
  agentId: string;
  activeClaims: AgentClaim[];
  recentEpisodes: Array<{
    id: string;
    type: string;
    content: string;
    timestamp: number;
    taskId?: string;
  }>;
  currentTask?: string;
}

export interface CoordinationOverview {
  activeClaims: AgentClaim[];
  staleClaims: AgentClaim[];
  conflicts: Array<{
    targetId: string;
    claimA: { claimId: string; agentId: string; intent: string; since: number };
    claimB: { claimId: string; agentId: string; intent: string; since: number };
  }>;
  agentSummary: Array<{
    agentId: string;
    claimCount: number;
    lastSeen: number;
  }>;
  totalClaims: number;
}

export default class CoordinationEngine {
  constructor(private memgraph: MemgraphClient) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const conflictCheck = await this.memgraph.executeCypher(
      `MATCH (c:CLAIM)-[:TARGETS]->(t {id: $targetId, projectId: $projectId})
       WHERE c.validTo IS NULL
         AND c.agentId <> $agentId
       RETURN c.id AS claimId, c.agentId AS agentId, c.intent AS intent, c.validFrom AS since
       ORDER BY c.validFrom DESC
       LIMIT 1`,
      {
        targetId: input.targetId,
        projectId: input.projectId,
        agentId: input.agentId,
      },
    );

    const conflict = conflictCheck.data?.[0];
    if (conflict) {
      return {
        claimId: "",
        status: "CONFLICT",
        conflict: {
          agentId: String(conflict.agentId || "unknown"),
          intent: String(conflict.intent || ""),
          since: Number(conflict.since || Date.now()),
        },
        targetVersionSHA: "unknown",
      };
    }

    const now = Date.now();
    const claimId = this.makeId("claim");
    const targetSnapshot = await this.getTargetSnapshot(
      input.targetId,
      input.projectId,
    );

    await this.memgraph.executeCypher(
      `CREATE (c:CLAIM {
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
      {
        id: claimId,
        agentId: input.agentId,
        sessionId: input.sessionId,
        taskId: input.taskId || null,
        claimType: input.claimType,
        targetId: input.targetId,
        intent: input.intent,
        validFrom: now,
        targetVersionSHA: targetSnapshot.targetVersionSHA,
        projectId: input.projectId,
      },
    );

    if (targetSnapshot.targetExists) {
      await this.memgraph.executeCypher(
        `MATCH (c:CLAIM {id: $claimId, projectId: $projectId})
         MATCH (t {id: $targetId, projectId: $projectId})
         MERGE (c)-[:TARGETS]->(t)`,
        {
          claimId,
          targetId: input.targetId,
          projectId: input.projectId,
        },
      );
    }

    return {
      claimId,
      status: "ok",
      targetVersionSHA: targetSnapshot.targetVersionSHA,
    };
  }

  async release(claimId: string, outcome?: string): Promise<void> {
    await this.memgraph.executeCypher(
      `MATCH (c:CLAIM {id: $claimId})
       WHERE c.validTo IS NULL
       SET c.validTo = $now,
           c.invalidationReason = 'released',
           c.outcome = $outcome`,
      {
        claimId,
        now: Date.now(),
        outcome: outcome || null,
      },
    );
  }

  async status(agentId: string, projectId: string): Promise<AgentStatus> {
    const claimsResult = await this.memgraph.executeCypher(
      `MATCH (c:CLAIM)
       WHERE c.projectId = $projectId
         AND c.agentId = $agentId
         AND c.validTo IS NULL
       RETURN c
       ORDER BY c.validFrom DESC`,
      { projectId, agentId },
    );

    const episodesResult = await this.memgraph.executeCypher(
      `MATCH (e:EPISODE)
       WHERE e.projectId = $projectId
         AND e.agentId = $agentId
       RETURN e.id AS id, e.type AS type, e.content AS content, e.timestamp AS timestamp, e.taskId AS taskId
       ORDER BY e.timestamp DESC
       LIMIT 10`,
      { projectId, agentId },
    );

    const activeClaims = claimsResult.data
      .map((row) => this.rowToClaim(row))
      .filter((row): row is AgentClaim => Boolean(row));

    return {
      agentId,
      activeClaims,
      recentEpisodes: episodesResult.data.map((row) => ({
        id: String(row.id),
        type: String(row.type || "OBSERVATION"),
        content: String(row.content || ""),
        timestamp: Number(row.timestamp || Date.now()),
        taskId: row.taskId ? String(row.taskId) : undefined,
      })),
      currentTask: activeClaims.find((claim) => Boolean(claim.taskId))?.taskId,
    };
  }

  async overview(projectId: string): Promise<CoordinationOverview> {
    const [
      activeResult,
      staleResult,
      conflictsResult,
      summaryResult,
      totalResult,
    ] = await Promise.all([
      this.memgraph.executeCypher(
        `MATCH (c:CLAIM)
           WHERE c.projectId = $projectId
             AND c.validTo IS NULL
           RETURN c
           ORDER BY c.validFrom DESC`,
        { projectId },
      ),
      this.memgraph.executeCypher(
        `MATCH (c:CLAIM)-[:TARGETS]->(t)
           WHERE c.projectId = $projectId
             AND c.validTo IS NULL
             AND t.projectId = $projectId
             AND t.validFrom > c.validFrom
           RETURN c
           ORDER BY c.validFrom DESC`,
        { projectId },
      ),
      this.memgraph.executeCypher(
        `MATCH (c1:CLAIM)-[:TARGETS]->(t)<-[:TARGETS]-(c2:CLAIM)
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
        { projectId },
      ),
      this.memgraph.executeCypher(
        `MATCH (c:CLAIM)
           WHERE c.projectId = $projectId
             AND c.validTo IS NULL
           RETURN c.agentId AS agentId,
                  count(c) AS claimCount,
                  max(c.validFrom) AS lastSeen
           ORDER BY claimCount DESC, lastSeen DESC`,
        { projectId },
      ),
      this.memgraph.executeCypher(
        `MATCH (c:CLAIM)
           WHERE c.projectId = $projectId
           RETURN count(c) AS totalClaims`,
        { projectId },
      ),
    ]);

    return {
      activeClaims: activeResult.data
        .map((row) => this.rowToClaim(row))
        .filter((row): row is AgentClaim => Boolean(row)),
      staleClaims: staleResult.data
        .map((row) => this.rowToClaim(row))
        .filter((row): row is AgentClaim => Boolean(row)),
      conflicts: conflictsResult.data.map((row) => ({
        targetId: String(row.targetId || "unknown"),
        claimA: {
          claimId: String(row.claimAId || ""),
          agentId: String(row.claimAAgent || "unknown"),
          intent: String(row.claimAIntent || ""),
          since: Number(row.claimASince || Date.now()),
        },
        claimB: {
          claimId: String(row.claimBId || ""),
          agentId: String(row.claimBAgent || "unknown"),
          intent: String(row.claimBIntent || ""),
          since: Number(row.claimBSince || Date.now()),
        },
      })),
      agentSummary: summaryResult.data.map((row) => ({
        agentId: String(row.agentId || "unknown"),
        claimCount: Number(row.claimCount || 0),
        lastSeen: Number(row.lastSeen || Date.now()),
      })),
      totalClaims: Number(totalResult.data?.[0]?.totalClaims || 0),
    };
  }

  async invalidateStaleClaims(projectId: string): Promise<number> {
    const now = Date.now();
    const staleResult = await this.memgraph.executeCypher(
      `MATCH (c:CLAIM)-[:TARGETS]->(t)
       WHERE c.projectId = $projectId
         AND c.validTo IS NULL
         AND t.projectId = $projectId
         AND t.validFrom > c.validFrom
       SET c.validTo = $now,
           c.invalidationReason = 'code_changed'
       RETURN count(c) AS invalidated`,
      { projectId, now },
    );

    return Number(staleResult.data?.[0]?.invalidated || 0);
  }

  async onTaskCompleted(
    taskId: string,
    agentId: string,
    projectId: string,
  ): Promise<void> {
    await this.memgraph.executeCypher(
      `MATCH (c:CLAIM)
       WHERE c.projectId = $projectId
         AND c.taskId = $taskId
         AND c.validTo IS NULL
       SET c.validTo = $now,
           c.invalidationReason = 'task_completed',
           c.outcome = coalesce(c.outcome, $outcome)`,
      {
        projectId,
        taskId,
        now: Date.now(),
        outcome: `Task completed by ${agentId}`,
      },
    );
  }

  private async getTargetSnapshot(
    targetId: string,
    projectId: string,
  ): Promise<{ targetExists: boolean; targetVersionSHA: string }> {
    const result = await this.memgraph.executeCypher(
      `MATCH (t {id: $targetId, projectId: $projectId})
       RETURN t.validFrom AS validFrom,
              t.contentHash AS contentHash,
              t.hash AS hash,
              t.gitCommit AS gitCommit
       ORDER BY t.validFrom DESC
       LIMIT 1`,
      { targetId, projectId },
    );

    if (!result.data.length) {
      return { targetExists: false, targetVersionSHA: `unknown-${Date.now()}` };
    }

    const row = result.data[0] || {};
    const sha =
      row.contentHash ||
      row.hash ||
      row.gitCommit ||
      `vf-${String(row.validFrom || Date.now())}`;

    return {
      targetExists: true,
      targetVersionSHA: String(sha),
    };
  }

  private rowToClaim(row: Record<string, unknown>): AgentClaim | null {
    const claim =
      (row.c as Record<string, unknown>) ||
      (row.claim as Record<string, unknown>) ||
      row;

    if (!claim || typeof claim !== "object" || !claim.id) {
      return null;
    }

    return {
      id: String(claim.id),
      agentId: String(claim.agentId || "unknown"),
      sessionId: String(claim.sessionId || "unknown"),
      taskId: claim.taskId ? String(claim.taskId) : undefined,
      claimType: (claim.claimType || "task") as ClaimType,
      targetId: String(claim.targetId || ""),
      intent: String(claim.intent || ""),
      validFrom: Number(claim.validFrom || Date.now()),
      targetVersionSHA: claim.targetVersionSHA
        ? String(claim.targetVersionSHA)
        : undefined,
      validTo: claim.validTo == null ? null : Number(claim.validTo),
      invalidationReason: claim.invalidationReason
        ? (String(claim.invalidationReason) as InvalidationReason)
        : undefined,
      outcome: claim.outcome ? String(claim.outcome) : undefined,
      projectId: String(claim.projectId || "unknown"),
    };
  }

  private makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
