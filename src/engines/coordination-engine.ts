/**
 * @file engines/coordination-engine
 * @description Manages agent claim lifecycle, conflict detection, and fleet coordination state.
 * @remarks Uses extracted query/constants and pure utilities for maintainability.
 */

import type MemgraphClient from "../graph/client.js";
import { CoordinationQueries as Q } from "./coordination-queries.js";
import { makeClaimId, rowToClaim } from "./coordination-utils.js";

// Re-export all public types so existing importers keep working.
export type {
  AgentClaim,
  AgentStatus,
  ClaimInput,
  ClaimResult,
  ClaimType,
  CoordinationOverview,
  InvalidationReason,
  ReleaseFeedback,
} from "./coordination-types.js";

import type {
  AgentClaim,
  AgentStatus,
  ClaimInput,
  ClaimResult,
  CoordinationOverview,
  ReleaseFeedback,
} from "./coordination-types.js";

export default class CoordinationEngine {
  constructor(private memgraph: MemgraphClient) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const conflictCheck = await this.memgraph.executeCypher(Q.CONFLICT_CHECK, {
      targetId: input.targetId,
      projectId: input.projectId,
      agentId: input.agentId,
    });

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
    const claimId = makeClaimId("claim", now);
    const targetSnapshot = await this.getTargetSnapshot(
      input.targetId,
      input.projectId,
    );

    await this.memgraph.executeCypher(Q.CREATE_CLAIM, {
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
    });

    if (targetSnapshot.targetExists) {
      await this.memgraph.executeCypher(Q.LINK_CLAIM_TO_TARGET, {
        claimId,
        targetId: input.targetId,
        projectId: input.projectId,
      });
    }

    return {
      claimId,
      status: "ok",
      targetVersionSHA: targetSnapshot.targetVersionSHA,
    };
  }

  /**
   * Close a claim.  Returns feedback indicating whether the claim was found
   * and whether it was already closed before this call — instead of silently
   * returning void.
   */
  async release(claimId: string, outcome?: string): Promise<ReleaseFeedback> {
    // First check current state so we can give accurate feedback.
    const checkResult = await this.memgraph.executeCypher(
      Q.RELEASE_CLAIM_OPEN_CHECK,
      { claimId },
    );

    if (!checkResult.data.length) {
      return { found: false, alreadyClosed: false };
    }

    const row = checkResult.data[0] as Record<string, unknown>;
    if (row.validTo != null) {
      return { found: true, alreadyClosed: true };
    }

    await this.memgraph.executeCypher(Q.RELEASE_CLAIM, {
      claimId,
      now: Date.now(),
      outcome: outcome ?? null,
    });

    return { found: true, alreadyClosed: false };
  }

  async status(agentId: string, projectId: string): Promise<AgentStatus> {
    const [claimsResult, episodesResult] = await Promise.all([
      this.memgraph.executeCypher(Q.AGENT_ACTIVE_CLAIMS, {
        projectId,
        agentId,
      }),
      this.memgraph.executeCypher(Q.AGENT_RECENT_EPISODES, {
        projectId,
        agentId,
      }),
    ]);

    const activeClaims = claimsResult.data
      .map((row) => rowToClaim(row))
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
      this.memgraph.executeCypher(Q.OVERVIEW_ACTIVE, { projectId }),
      this.memgraph.executeCypher(Q.OVERVIEW_STALE, { projectId }),
      this.memgraph.executeCypher(Q.OVERVIEW_CONFLICTS, { projectId }),
      this.memgraph.executeCypher(Q.OVERVIEW_AGENT_SUMMARY, { projectId }),
      this.memgraph.executeCypher(Q.OVERVIEW_TOTAL, { projectId }),
    ]);

    return {
      activeClaims: activeResult.data
        .map((row) => rowToClaim(row))
        .filter((row): row is AgentClaim => Boolean(row)),
      staleClaims: staleResult.data
        .map((row) => rowToClaim(row))
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
    const staleResult = await this.memgraph.executeCypher(Q.INVALIDATE_STALE, {
      projectId,
      now,
    });
    return Number(staleResult.data?.[0]?.invalidated || 0);
  }

  async onTaskCompleted(
    taskId: string,
    agentId: string,
    projectId: string,
  ): Promise<void> {
    await this.memgraph.executeCypher(Q.ON_TASK_COMPLETED, {
      projectId,
      taskId,
      now: Date.now(),
      outcome: `Task completed by ${agentId}`,
    });
  }

  /**
   * Expire all open claims older than `maxAgeMs` milliseconds.
   * Implements the previously orphaned 'expired' InvalidationReason.
   * @returns number of claims closed
   */
  async expireOldClaims(projectId: string, maxAgeMs: number): Promise<number> {
    const now = Date.now();
    const cutoffMs = now - maxAgeMs;
    const result = await this.memgraph.executeCypher(Q.EXPIRE_OLD_CLAIMS, {
      projectId,
      now,
      cutoffMs,
    });
    return Number(result.data?.[0]?.expired || 0);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async getTargetSnapshot(
    targetId: string,
    projectId: string,
  ): Promise<{ targetExists: boolean; targetVersionSHA: string }> {
    const result = await this.memgraph.executeCypher(Q.TARGET_SNAPSHOT, {
      targetId,
      projectId,
    });

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
}
