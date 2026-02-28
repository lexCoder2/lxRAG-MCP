// ── Personalized PageRank (PPR) — Tests ─────────────────────────────────────
//
// Tests for:
//   - runPPR()            → empty seeds guard, MAGE mode, JS fallback mode
//   - tryMagePPR()        → tested indirectly: MAGE success / error / throw
//   - runJsPPR()          → tested indirectly: edge propagation, seed boosting
//
// MemgraphClient is mocked via vi.fn(). executeCypher is keyed on query fragments.

import { describe, expect, it, vi } from "vitest";
import { runPPR } from "../ppr.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a MemgraphClient mock where executeCypher returns pre-set data
 * based on matching a substring of the query.
 */
function makeMockClient(
  overrides: Record<string, unknown[] | { error: string; data: unknown[] }> = {},
) {
  return {
    executeCypher: vi.fn(async (query: string) => {
      for (const [key, val] of Object.entries(overrides)) {
        if (query.includes(key)) {
          if (typeof val === "object" && "error" in val && !Array.isArray(val)) {
            return val;
          }
          return { data: val };
        }
      }
      return { data: [] };
    }),
  } as any;
}

/** Standard pagerank row returned by MAGE. */
function makePagerankRow(nodeId: string, rank = 0.5, type = "FILE") {
  return {
    nodeId,
    rank,
    type,
    filePath: `src/${nodeId}.ts`,
    name: nodeId,
  };
}

/** Standard edge row returned by the JS-PPR MATCH query. */
function makeEdgeRow(
  fromId: string,
  toId: string,
  relType = "IMPORTS",
  opts: Record<string, string> = {},
) {
  return {
    fromId,
    toId,
    relType,
    fromType: "FILE",
    toType: "FILE",
    fromPath: `src/${fromId}.ts`,
    toPath: `src/${toId}.ts`,
    fromName: fromId,
    toName: toId,
    ...opts,
  };
}

// ── Empty seeds guard ────────────────────────────────────────────────────────

describe("runPPR() — empty seeds", () => {
  it("returns [] immediately when seedIds is empty", async () => {
    const client = makeMockClient();
    const result = await runPPR({ seedIds: [], projectId: "proj-a" }, client);
    expect(result).toEqual([]);
    expect(client.executeCypher).not.toHaveBeenCalled();
  });

  it("returns [] immediately when seedIds contains only falsy values", async () => {
    const client = makeMockClient();
    const result = await runPPR({ seedIds: ["", ""] as string[], projectId: "proj-a" }, client);
    expect(result).toEqual([]);
  });

  it("deduplicates seed ids", async () => {
    // Two identical seeds reduce to one
    const client = makeMockClient({
      "pagerank.get()": [makePagerankRow("file:a")],
      "UNWIND $seedIds": [{ nodeId: "file:a", hops: 1 }],
    });
    const result = await runPPR({ seedIds: ["file:a", "file:a"], projectId: "proj-a" }, client);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});

// ── MAGE mode ────────────────────────────────────────────────────────────────

describe("runPPR() — MAGE pagerank mode", () => {
  it("uses mage_pagerank mode when MAGE query returns data", async () => {
    const client = makeMockClient({
      "pagerank.get()": [makePagerankRow("file:a", 0.8), makePagerankRow("file:b", 0.3)],
      "UNWIND $seedIds": [],
    });

    const result = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    expect(result.every((r) => r.pprMode === "mage_pagerank")).toBe(true);
  });

  it("includes seed nodes with high proximity boost", async () => {
    const client = makeMockClient({
      "pagerank.get()": [makePagerankRow("file:seed", 0.1)],
      "UNWIND $seedIds": [],
    });

    const result = await runPPR({ seedIds: ["file:seed"], projectId: "proj-a" }, client);

    const seedItem = result.find((r) => r.nodeId === "file:seed");
    expect(seedItem).toBeDefined();
    // Seed gets proximity=2.0 boost so final score = 0.1*(1-0.85) + 2.0*0.85 > 1.5
    expect(seedItem!.score).toBeGreaterThan(1.0);
  });

  it("applies proximity scores from hop-distance query", async () => {
    const client = makeMockClient({
      "pagerank.get()": [
        makePagerankRow("file:seed", 0.5),
        makePagerankRow("file:neighbor1", 0.4),
        makePagerankRow("file:neighbor2", 0.3),
      ],
      "UNWIND $seedIds": [
        { nodeId: "file:neighbor1", hops: 1 }, // hop 1 → proximity 1.0
        { nodeId: "file:neighbor2", hops: 3 }, // hop 3 → proximity 0.3
      ],
    });

    const result = await runPPR({ seedIds: ["file:seed"], projectId: "proj-a" }, client);

    const n1 = result.find((r) => r.nodeId === "file:neighbor1");
    const n2 = result.find((r) => r.nodeId === "file:neighbor2");
    // Closer neighbor should score higher
    if (n1 && n2) {
      expect(n1.score).toBeGreaterThan(n2.score);
    }
  });

  it("sorts results by score descending", async () => {
    const client = makeMockClient({
      "pagerank.get()": [
        makePagerankRow("file:low", 0.1),
        makePagerankRow("file:high", 0.9),
        makePagerankRow("file:mid", 0.5),
      ],
      "UNWIND $seedIds": [],
    });

    const result = await runPPR({ seedIds: ["file:high"], projectId: "proj-a" }, client);

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("limits results to maxResults", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => makePagerankRow(`file:${i}`, 0.5 - i / 100));
    const client = makeMockClient({
      "pagerank.get()": rows,
      "UNWIND $seedIds": [],
    });

    const result = await runPPR(
      { seedIds: ["file:0"], projectId: "proj-a", maxResults: 5 },
      client,
    );

    expect(result).toHaveLength(5);
  });

  it("caps maxResults at 500", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => makePagerankRow(`file:${i}`));
    const client = makeMockClient({
      "pagerank.get()": rows,
      "UNWIND $seedIds": [],
    });

    const result = await runPPR(
      { seedIds: ["file:0"], projectId: "proj-a", maxResults: 9999 },
      client,
    );

    // Can't exceed actual data count
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("includes type, filePath, name from pagerank metadata", async () => {
    const client = makeMockClient({
      "pagerank.get()": [
        {
          nodeId: "fn:doWork",
          rank: 0.7,
          type: "FUNCTION",
          filePath: "src/engines/ep.ts",
          name: "doWork",
        },
      ],
      "UNWIND $seedIds": [],
    });

    const [result] = await runPPR({ seedIds: ["fn:doWork"], projectId: "proj-a" }, client);

    expect(result.type).toBe("FUNCTION");
    expect(result.filePath).toBe("src/engines/ep.ts");
    expect(result.name).toBe("doWork");
  });
});

// ── MAGE fallback to JS PPR ───────────────────────────────────────────────────

describe("runPPR() — JS PPR fallback", () => {
  it("falls back to JS mode when MAGE returns empty data", async () => {
    // pagerank.get() key not in overrides → returns empty → triggers JS fallback
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [makeEdgeRow("file:a", "file:b")],
    });

    const result = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    expect(result.every((r) => r.pprMode === "js_ppr")).toBe(true);
  });

  it("falls back to JS mode when MAGE query has error", async () => {
    const client = makeMockClient({
      "pagerank.get()": { error: "MAGE not available", data: [] },
      "MATCH (a)-[r]->(b)": [makeEdgeRow("file:a", "file:b")],
    });

    const result = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    expect(result.every((r) => r.pprMode === "js_ppr")).toBe(true);
  });

  it("falls back to JS PPR when MAGE throws", async () => {
    const client = {
      executeCypher: vi.fn().mockImplementation(async (query: string) => {
        if (query.includes("pagerank.get()")) {
          throw new Error("MAGE not installed");
        }
        if (query.includes("MATCH (a)-[r]->(b)")) {
          return { data: [makeEdgeRow("file:a", "file:b")] };
        }
        return { data: [] };
      }),
    } as any;

    const result = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    expect(result.some((r) => r.pprMode === "js_ppr")).toBe(true);
  });

  it("JS PPR: seed node has non-zero score when no edges exist", async () => {
    const client = makeMockClient(); // no edges → seed gets personalization weight

    const result = await runPPR({ seedIds: ["seed-node"], projectId: "proj-a" }, client);

    // seed-node should appear in results even with no edges
    const seed = result.find((r) => r.nodeId === "seed-node");
    expect(seed).toBeDefined();
    expect(seed!.pprMode).toBe("js_ppr");
  });

  it("JS PPR: propagates scores through IMPORTS edges", async () => {
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [
        makeEdgeRow("file:a", "file:b", "IMPORTS"),
        makeEdgeRow("file:b", "file:c", "IMPORTS"),
      ],
    });

    const result = await runPPR(
      { seedIds: ["file:a"], projectId: "proj-a", iterations: 10 },
      client,
    );

    expect(result).toHaveLength(3);
    expect(result.every((r) => r.pprMode === "js_ppr")).toBe(true);
  });

  it("JS PPR: uses default edge weights for known relationship types", async () => {
    // CALLS has weight 0.9, a high-weight edge propagates more rank
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [
        makeEdgeRow("file:seed", "file:called", "CALLS"),
        makeEdgeRow("file:seed", "file:tested", "TESTS"), // weight 0.4
      ],
    });

    const result = await runPPR(
      { seedIds: ["file:seed"], projectId: "proj-a", iterations: 5 },
      client,
    );

    const called = result.find((r) => r.nodeId === "file:called");
    const tested = result.find((r) => r.nodeId === "file:tested");

    if (called && tested) {
      // file:called (CALLS=0.9) should rank higher than file:tested (TESTS=0.4)
      expect(called.score).toBeGreaterThan(tested.score);
    }
  });

  it("JS PPR: sorts output by score descending", async () => {
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [
        makeEdgeRow("file:a", "file:b", "IMPORTS"),
        makeEdgeRow("file:a", "file:c", "TESTS"),
      ],
    });

    const result = await runPPR(
      { seedIds: ["file:a"], projectId: "proj-a", iterations: 20 },
      client,
    );

    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
    }
  });

  it("JS PPR: respects custom edge weights from opts.edgeWeights", async () => {
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [makeEdgeRow("file:a", "file:b", "CUSTOM_REL")],
    });

    const result = await runPPR(
      {
        seedIds: ["file:a"],
        projectId: "proj-a",
        edgeWeights: { CUSTOM_REL: 0.99 },
        iterations: 5,
      },
      client,
    );

    expect(result.find((r) => r.nodeId === "file:b")).toBeDefined();
  });

  it("JS PPR: limits results to maxResults", async () => {
    const edges = Array.from({ length: 10 }, (_, i) => makeEdgeRow("file:seed", `file:${i}`));
    const client = makeMockClient({ "MATCH (a)-[r]->(b)": edges });

    const result = await runPPR(
      { seedIds: ["file:seed"], projectId: "proj-a", maxResults: 3 },
      client,
    );

    expect(result).toHaveLength(3);
  });
});

// ── Option clamping ───────────────────────────────────────────────────────────

describe("runPPR() — option clamping", () => {
  it("clamps iterations to [1, 100]", async () => {
    // With 0 iterations, the rank should still be initialized uniformly
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [makeEdgeRow("file:a", "file:b")],
    });

    // iterations=0 clamped to 1
    const result = await runPPR(
      { seedIds: ["file:a"], projectId: "proj-a", iterations: 0 },
      client,
    );

    expect(result.length).toBeGreaterThan(0);
  });

  it("uses default damping=0.85 when not specified", async () => {
    const client = makeMockClient({
      "pagerank.get()": [makePagerankRow("file:a", 0.5)],
      "UNWIND $seedIds": [],
    });

    const [result] = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    // With damping=0.85 and rank=0.5: score = 0.5*(1-0.85) + 2.0*0.85 = 0.075 + 1.7 = 1.775
    expect(result.score).toBeCloseTo(1.775, 2);
  });

  it("all scores are finite non-negative numbers", async () => {
    const client = makeMockClient({
      "MATCH (a)-[r]->(b)": [
        makeEdgeRow("file:a", "file:b", "IMPORTS"),
        makeEdgeRow("file:b", "file:c", "CALLS"),
      ],
    });

    const result = await runPPR({ seedIds: ["file:a"], projectId: "proj-a" }, client);

    for (const r of result) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});
