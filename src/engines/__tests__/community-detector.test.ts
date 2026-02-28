// ── Community Detector — Tests ────────────────────────────────────────────────
//
// Tests for:
//   - CommunityDetector.run()           → MAGE Leiden → directory fallback
//   - tryMageCommunityDetection()       → tested indirectly via run()
//   - runDirectoryHeuristic()           → tested indirectly via run()
//   - communityLabel()                  → tested indirectly (via directory grouping)
//   - labelForGroup()                   → tested via MAGE path
//   - centralNode()                     → implicit via writeCommunities
//   - writeCommunities()                → verified via executeCypher call count
//
// Conventions match ./coordination-engine.test.ts: vi.fn() stubs for executeCypher.

import { describe, expect, it, vi, beforeEach } from "vitest";
import CommunityDetector from "../community-detector.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Standard member node row returned by the initial MATCH query. */
function makeMemberRow(id: string, filePath: string, type = "FILE", name?: string) {
  return {
    id,
    filePath,
    type,
    name: name ?? id,
  };
}

/**
 * Builds a MemgraphClient mock with configurable per-query responses.
 *
 * @param overrides  Map of query-fragment → row array. First match wins.
 */
function makeMockMemgraph(overrides: Record<string, unknown[] | { error: true }> = {}) {
  return {
    executeCypher: vi.fn(async (query: string) => {
      for (const [key, val] of Object.entries(overrides)) {
        if (query.includes(key)) {
          if (val && typeof val === "object" && "error" in val) {
            return { error: "mocked-error", data: [] };
          }
          return { data: val as unknown[] };
        }
      }
      return { data: [] };
    }),
  } as any;
}

// ── run() — empty graph ───────────────────────────────────────────────────────

describe("CommunityDetector.run() — empty graph", () => {
  it("returns {communities:0, members:0, mode:'directory_heuristic'} when no nodes", async () => {
    const memgraph = makeMockMemgraph();
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result).toEqual({ communities: 0, members: 0, mode: "directory_heuristic" });
    // Should NOT attempt community detection when members is empty
    expect(memgraph.executeCypher).toHaveBeenCalledTimes(1);
  });
});

// ── run() — MAGE available ───────────────────────────────────────────────────

describe("CommunityDetector.run() — MAGE Leiden available", () => {
  it("uses mage_leiden mode when MAGE query returns community data", async () => {
    const members = [
      makeMemberRow("file:a", "src/engines/episode-engine.ts"),
      makeMemberRow("file:b", "src/engines/coordination-engine.ts"),
    ];
    const mageRows = [
      { nodeId: "file:a", cid: 0 },
      { nodeId: "file:b", cid: 0 },
    ];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result.mode).toBe("mage_leiden");
    expect(result.communities).toBe(1); // both files in same community
    expect(result.members).toBeGreaterThan(0);
  });

  it("groups members into separate communities by MAGE cid", async () => {
    const members = [
      makeMemberRow("file:a", "src/engines/episode-engine.ts"),
      makeMemberRow("file:b", "src/graph/client.ts"),
      makeMemberRow("file:c", "src/tools/registry.ts"),
    ];
    const mageRows = [
      { nodeId: "file:a", cid: 0 },
      { nodeId: "file:b", cid: 1 },
      { nodeId: "file:c", cid: 2 },
    ];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result.mode).toBe("mage_leiden");
    expect(result.communities).toBe(3);
  });

  it("writes COMMUNITY nodes via MERGE and BELONGS_TO edges", async () => {
    const members = [makeMemberRow("file:a", "src/engines/episode-engine.ts")];
    const mageRows = [{ nodeId: "file:a", cid: 0 }];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    await detector.run("proj-a");

    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("MERGE (c:COMMUNITY"),
    );
    const belongsCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("BELONGS_TO"),
    );
    expect(mergeCalls).toHaveLength(1);
    expect(belongsCalls).toHaveLength(1);
  });

  it("skips members not in MAGE community map", async () => {
    const members = [
      makeMemberRow("file:a", "src/engines/episode-engine.ts"),
      makeMemberRow("file:orphan", "src/unknown.ts"),
    ];
    const mageRows = [{ nodeId: "file:a", cid: 0 }];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    // Only 1 member was in the MAGE map
    expect(result.members).toBe(1);
  });
});

// ── run() — MAGE unavailable → directory fallback ────────────────────────────

describe("CommunityDetector.run() — MAGE fallback", () => {
  it("falls back to directory_heuristic when MAGE returns empty data", async () => {
    const members = [
      makeMemberRow("file:a", "src/engines/episode-engine.ts"),
      makeMemberRow("file:b", "src/graph/client.ts"),
    ];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      // community_detection.get() returns empty → falls back
    });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result.mode).toBe("directory_heuristic");
  });

  it("falls back when MAGE query returns error", async () => {
    const members = [makeMemberRow("file:a", "src/engines/episode-engine.ts")];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": { error: true },
    });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result.mode).toBe("directory_heuristic");
    expect(result.members).toBe(1);
  });

  it("groups files from the same src/ directory into one community", async () => {
    const members = [
      makeMemberRow("file:ep", "src/engines/episode-engine.ts"),
      makeMemberRow("file:coord", "src/engines/coordination-engine.ts"),
      makeMemberRow("file:client", "src/graph/client.ts"),
    ];

    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    expect(result.mode).toBe("directory_heuristic");
    // 2 directories: engines + graph
    expect(result.communities).toBe(2);
  });

  it("writes COMMUNITY nodes for each directory group", async () => {
    const members = [
      makeMemberRow("file:ep", "src/engines/episode-engine.ts"),
      makeMemberRow("file:client", "src/graph/client.ts"),
    ];

    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    await detector.run("proj-a");

    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("MERGE (c:COMMUNITY"),
    );
    // 2 communities → 2 MERGE calls
    expect(mergeCalls).toHaveLength(2);
  });
});

// ── communityLabel() (tested via directory heuristic) ────────────────────────

describe("communityLabel via directory heuristic grouping", () => {
  it("groups absolute paths by the directory after src/", async () => {
    const members = [
      makeMemberRow("n1", "/home/alex/myproject/src/engines/foo.ts"),
      makeMemberRow("n2", "/home/alex/myproject/src/engines/bar.ts"),
      makeMemberRow("n3", "/home/alex/myproject/src/graph/client.ts"),
    ];

    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    // Should group into 2 communities: engines, graph
    expect(result.communities).toBe(2);
  });

  it("uses root marker itself when next segment is a filename", async () => {
    // When the path is src/a.ts (file directly in src/), we use "src" label
    const members = [makeMemberRow("n1", "src/index.ts"), makeMemberRow("n2", "src/server.ts")];
    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    // Both files are in src/ directly → single "src" community
    expect(result.communities).toBe(1);
  });

  it("falls back to 'misc' when path has no recognizable structure", async () => {
    const members = [makeMemberRow("n1", ""), makeMemberRow("n2", "")];
    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    const result = await detector.run("proj-a");

    // All map to "misc" → single community
    expect(result.communities).toBe(1);
  });
});

// ── labelForGroup() (tested via MAGE path) ───────────────────────────────────

describe("labelForGroup via MAGE path", () => {
  it("picks the most frequent path prefix as the community label", async () => {
    const members = [
      makeMemberRow("f:a", "src/engines/a.ts"),
      makeMemberRow("f:b", "src/engines/b.ts"),
      makeMemberRow("f:c", "src/graph/c.ts"),
    ];
    const mageRows = [
      { nodeId: "f:a", cid: 0 },
      { nodeId: "f:b", cid: 0 },
      { nodeId: "f:c", cid: 0 },
    ];
    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    await detector.run("proj-a");

    // Community MERGE params should have label="engines" (most common)
    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("MERGE (c:COMMUNITY"),
    );
    const labels = mergeCalls.map(([, params]: [string, Record<string, unknown>]) => params.label);
    expect(labels).toContain("engines");
  });
});

// ── writeCommunities community ID format ─────────────────────────────────────

describe("community ID naming convention", () => {
  it("sets community id in format '<projectId>::community::<prefix>::<idx>'", async () => {
    const members = [makeMemberRow("file:a", "src/engines/ep.ts")];

    const memgraph = makeMockMemgraph({ "MATCH (n)": members });
    const detector = new CommunityDetector(memgraph as any);

    await detector.run("proj-a");

    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("MERGE (c:COMMUNITY"),
    );
    const { id } = mergeCalls[0][1] as Record<string, string>;
    expect(id).toMatch(/^proj-a::community::(dir|leiden)::\d+$/);
  });
});

// ── centralNode preference ────────────────────────────────────────────────────

describe("centralNode prefers FUNCTION type", () => {
  it("selects FUNCTION node as centralNode when available", async () => {
    const members = [
      makeMemberRow("file:a", "src/engines/ep.ts", "FILE"),
      makeMemberRow("fn:x", "src/engines/ep.ts", "FUNCTION"),
    ];
    const mageRows = [
      { nodeId: "file:a", cid: 0 },
      { nodeId: "fn:x", cid: 0 },
    ];

    const memgraph = makeMockMemgraph({
      "MATCH (n)": members,
      "community_detection.get()": mageRows,
    });
    const detector = new CommunityDetector(memgraph as any);

    await detector.run("proj-a");

    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("MERGE (c:COMMUNITY"),
    );
    const { centralNode } = mergeCalls[0][1] as Record<string, string>;
    expect(centralNode).toBe("fn:x");
  });
});
