// ── Coordination Engine — Tests ───────────────────────────────────────────────
// Tests for:
//   - coordination-utils (pure functions, no mock needed)
//   - CoordinationEngine public API (MemgraphClient mocked via vi.fn())
//
// Conventions match ./progress-engine.test.ts: vi.fn() stubs for executeCypher,
// cast as any for the mock. See also ./architecture-engine.test.ts for patterns.

import { describe, expect, it, vi } from "vitest";
import CoordinationEngine from "./coordination-engine.js";
import { makeClaimId, rowToClaim } from "./coordination-utils.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Creates a minimal MemgraphClient mock where executeCypher returns no rows. */
function makeMockMemgraph(overrides: Record<string, unknown[]> = {}) {
  return {
    executeCypher: vi.fn(
      async (query: string, params: Record<string, unknown>) => {
        // Return override data if the first matching key appears in the query.
        for (const [key, data] of Object.entries(overrides)) {
          if (query.includes(key)) return { data };
        }
        return { data: [] };
      },
    ),
  } as any;
}

// ── coordination-utils ────────────────────────────────────────────────────────

describe("rowToClaim", () => {
  it("maps a flat row with all fields", () => {
    const row = {
      id: "claim-1",
      agentId: "agent-a",
      sessionId: "sess-1",
      taskId: "task-x",
      claimType: "file",
      targetId: "file:src/foo.ts",
      intent: "editing foo.ts",
      validFrom: 1000,
      targetVersionSHA: "abc123",
      validTo: null,
      invalidationReason: null,
      outcome: null,
      projectId: "my-project",
    };

    const claim = rowToClaim(row);

    expect(claim).not.toBeNull();
    expect(claim?.id).toBe("claim-1");
    expect(claim?.agentId).toBe("agent-a");
    expect(claim?.claimType).toBe("file");
    expect(claim?.validTo).toBeNull();
    expect(claim?.taskId).toBe("task-x");
  });

  it("handles Memgraph nested row (row.c)", () => {
    const row = {
      c: {
        id: "claim-2",
        agentId: "agent-b",
        sessionId: "sess-2",
        claimType: "task",
        targetId: "task-y",
        intent: "doing task y",
        validFrom: 2000,
        validTo: 3000,
        projectId: "proj",
      },
    };

    const claim = rowToClaim(row);
    expect(claim?.id).toBe("claim-2");
    expect(claim?.validTo).toBe(3000);
    expect(claim?.agentId).toBe("agent-b");
  });

  it("returns null when row has no id", () => {
    expect(rowToClaim({ agentId: "x" })).toBeNull();
    expect(rowToClaim({})).toBeNull();
  });

  it("fills in defaults for missing optional fields", () => {
    const claim = rowToClaim({ id: "claim-3", projectId: "p" });
    expect(claim?.agentId).toBe("unknown");
    expect(claim?.claimType).toBe("task");
    expect(claim?.intent).toBe("");
    expect(claim?.invalidationReason).toBeUndefined();
    expect(claim?.outcome).toBeUndefined();
    expect(claim?.taskId).toBeUndefined();
  });
});

describe("makeClaimId", () => {
  it("produces id with expected prefix", () => {
    const id = makeClaimId("claim");
    expect(id).toMatch(/^claim-\d+-[a-z0-9]+$/);
  });

  it("accepts injectable timestamp for deterministic output", () => {
    const id = makeClaimId("claim", 1234567890);
    expect(id.startsWith("claim-1234567890-")).toBe(true);
  });

  it("produces different ids on successive calls", () => {
    const a = makeClaimId("claim");
    const b = makeClaimId("claim");
    // Random suffix makes collision vanishingly unlikely.
    expect(a).not.toBe(b);
  });
});

// ── CoordinationEngine ────────────────────────────────────────────────────────

describe("CoordinationEngine.claim", () => {
  it("returns ok status when no conflict exists", async () => {
    const memgraph = makeMockMemgraph({
      // CONFLICT_CHECK returns empty → no conflict
    });
    const engine = new CoordinationEngine(memgraph);

    const result = await engine.claim({
      agentId: "agent-a",
      sessionId: "sess-1",
      projectId: "proj",
      targetId: "task-1",
      claimType: "task",
      intent: "working on task-1",
    });

    expect(result.status).toBe("ok");
    expect(result.claimId).toMatch(/^claim-/);
    expect(result.targetVersionSHA).toMatch(/^unknown-/);
  });

  it("returns CONFLICT when another agent holds the claim", async () => {
    const memgraph = makeMockMemgraph({
      // CONFLICT_CHECK returns one conflicting row
      CONFLICT_CHECK: [
        {
          claimId: "claim-other",
          agentId: "agent-b",
          intent: "other work",
          since: 1000,
        },
      ],
    });
    // Override: return conflict row for the first query (conflict check)
    memgraph.executeCypher = vi.fn().mockResolvedValueOnce({
      data: [{ agentId: "agent-b", intent: "other work", since: 1000 }],
    });

    const engine = new CoordinationEngine(memgraph);

    const result = await engine.claim({
      agentId: "agent-a",
      sessionId: "sess-1",
      projectId: "proj",
      targetId: "task-1",
      claimType: "task",
      intent: "competing work",
    });

    expect(result.status).toBe("CONFLICT");
    expect(result.conflict?.agentId).toBe("agent-b");
    expect(result.claimId).toBe("");
  });
});

describe("CoordinationEngine.release", () => {
  it("returns found:true alreadyClosed:false when claim is open", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        // First call: RELEASE_CLAIM_OPEN_CHECK — claim found, validTo = null
        .mockResolvedValueOnce({ data: [{ id: "claim-1", validTo: null }] })
        // Second call: RELEASE_CLAIM — actual update
        .mockResolvedValueOnce({ data: [] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const feedback = await engine.release("claim-1", "done");

    expect(feedback.found).toBe(true);
    expect(feedback.alreadyClosed).toBe(false);
  });

  it("returns alreadyClosed:true when claim was already closed", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({
        data: [{ id: "claim-1", validTo: 9999999 }],
      }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const feedback = await engine.release("claim-1");

    expect(feedback.found).toBe(true);
    expect(feedback.alreadyClosed).toBe(true);
    // No second Cypher call should be made (no update needed)
    expect(memgraph.executeCypher).toHaveBeenCalledTimes(1);
  });

  it("returns found:false when claim does not exist", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({ data: [] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const feedback = await engine.release("nonexistent-claim");

    expect(feedback.found).toBe(false);
    expect(feedback.alreadyClosed).toBe(false);
    expect(memgraph.executeCypher).toHaveBeenCalledTimes(1);
  });
});

describe("CoordinationEngine.status", () => {
  it("returns activeClaims and recentEpisodes for an agent", async () => {
    const claimRow = {
      c: {
        id: "claim-10",
        agentId: "agent-a",
        sessionId: "s",
        taskId: "task-2",
        claimType: "task",
        targetId: "task-2",
        intent: "do it",
        validFrom: 100,
        validTo: null,
        projectId: "proj",
      },
    };
    const episodeRow = {
      id: "ep-1",
      type: "OBSERVATION",
      content: "did something",
      timestamp: 200,
      taskId: "task-2",
    };

    const memgraph = {
      executeCypher: vi
        .fn()
        .mockResolvedValueOnce({ data: [claimRow] }) // AGENT_ACTIVE_CLAIMS
        .mockResolvedValueOnce({ data: [episodeRow] }), // AGENT_RECENT_EPISODES
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const status = await engine.status("agent-a", "proj");

    expect(status.agentId).toBe("agent-a");
    expect(status.activeClaims).toHaveLength(1);
    expect(status.activeClaims[0]?.id).toBe("claim-10");
    expect(status.currentTask).toBe("task-2");
    expect(status.recentEpisodes).toHaveLength(1);
    expect(status.recentEpisodes[0]?.content).toBe("did something");
  });

  it("returns empty lists when agent has no claims or episodes", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce({ data: [] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const status = await engine.status("agent-unknown", "proj");

    expect(status.activeClaims).toHaveLength(0);
    expect(status.recentEpisodes).toHaveLength(0);
    expect(status.currentTask).toBeUndefined();
  });
});

describe("CoordinationEngine.invalidateStaleClaims", () => {
  it("returns count of invalidated claims", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        .mockResolvedValueOnce({ data: [{ invalidated: 3 }] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const count = await engine.invalidateStaleClaims("proj");

    expect(count).toBe(3);
  });

  it("returns 0 when no stale claims", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({ data: [] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    expect(await engine.invalidateStaleClaims("proj")).toBe(0);
  });
});

describe("CoordinationEngine.expireOldClaims", () => {
  it("fires the EXPIRE_OLD_CLAIMS query with correct cutoff", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({ data: [{ expired: 5 }] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    const count = await engine.expireOldClaims("proj", 3_600_000); // 1 hour TTL

    expect(count).toBe(5);
    const [, params] = memgraph.executeCypher.mock.calls[0] as [
      string,
      Record<string, number>,
    ];
    expect(params.projectId).toBe("proj");
    expect(params.cutoffMs).toBeLessThan(params.now);
    expect(params.now - params.cutoffMs).toBeCloseTo(3_600_000, -2);
  });

  it("returns 0 when no claims expired", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({ data: [] }),
    } as any;
    const engine = new CoordinationEngine(memgraph);
    expect(await engine.expireOldClaims("proj", 1000)).toBe(0);
  });
});

describe("CoordinationEngine.onTaskCompleted", () => {
  it("calls ON_TASK_COMPLETED query with correct params", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValueOnce({ data: [] }),
    } as any;

    const engine = new CoordinationEngine(memgraph);
    await engine.onTaskCompleted("task-7", "agent-a", "proj");

    expect(memgraph.executeCypher).toHaveBeenCalledOnce();
    const [, params] = memgraph.executeCypher.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params.taskId).toBe("task-7");
    expect(params.projectId).toBe("proj");
    expect(String(params.outcome)).toContain("agent-a");
  });
});
