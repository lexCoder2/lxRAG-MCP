/**
 * @file engines/coordination-types
 * @description Public type contracts for coordination workflows.
 * @remarks Kept separate so callers can import types without importing engine runtime code.
 */

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

/** Typed result for the release() method — replaces the original void return. */
export interface ReleaseFeedback {
  /** true if the claim existed and was open when release was called */
  found: boolean;
  /** true if the claim existed but was already closed before this call */
  alreadyClosed: boolean;
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
