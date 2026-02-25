/**
 * @file engines/coordination-utils
 * @description Pure helper functions for coordination IDs, mapping, and normalization.
 * @remarks Utility functions are side-effect free and independently testable.
 */

import type {
  AgentClaim,
  ClaimType,
  InvalidationReason,
} from "./coordination-types.js";

/**
 * Maps a raw Memgraph row (or the nested `c` property) to an AgentClaim.
 * Returns null if the row lacks a required `id` field.
 */
export function rowToClaim(row: Record<string, unknown>): AgentClaim | null {
  const claim =
    (row.c as Record<string, unknown>) ||
    (row.claim as Record<string, unknown>) ||
    row;

  if (!claim || typeof claim !== "object" || !claim.id) {
    return null;
  }

  return {
    id: String(claim.id),
    agentId: String(claim.agentId ?? "unknown"),
    sessionId: String(claim.sessionId ?? "unknown"),
    taskId: claim.taskId ? String(claim.taskId) : undefined,
    claimType: (claim.claimType ?? "task") as ClaimType,
    targetId: String(claim.targetId ?? ""),
    intent: String(claim.intent ?? ""),
    validFrom: Number(claim.validFrom ?? Date.now()),
    targetVersionSHA: claim.targetVersionSHA
      ? String(claim.targetVersionSHA)
      : undefined,
    validTo: claim.validTo == null ? null : Number(claim.validTo),
    invalidationReason: claim.invalidationReason
      ? (String(claim.invalidationReason) as InvalidationReason)
      : undefined,
    outcome: claim.outcome ? String(claim.outcome) : undefined,
    projectId: String(claim.projectId ?? "unknown"),
  };
}

/**
 * Generate a time-prefixed pseudo-unique ID.
 * @param prefix  e.g. "claim"
 * @param now     injectable timestamp (ms) — defaults to Date.now(); pass a
 *                fixed value in tests to get deterministic IDs.
 */
export function makeClaimId(prefix: string, now: number = Date.now()): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}
