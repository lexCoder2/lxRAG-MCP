// ── Episode Engine — Tests ─────────────────────────────────────────────────
//
// Tests for:
//   - EpisodeEngine.add()         → CREATE node + INVOLVES links + NEXT_EPISODE
//   - EpisodeEngine.recall()      → filter + hybrid lexical/temporal/graph score
//   - EpisodeEngine.decisionQuery() → delegate with DECISION type filter
//   - EpisodeEngine.reflect()     → aggregate patterns → REFLECTION + LEARNING
//
// Memgraph is mocked via vi.fn(). executeCypher is keyed on query substrings.
//
// Conventions match ./progress-engine.test.ts and ./coordination-engine.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import EpisodeEngine, { type EpisodeInput } from "../episode-engine.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Builds a minimal MemgraphClient mock.
 *
 * @param overrides  Map of query-substring → row array to return.
 *                   First matching key wins. Defaults to empty rows.
 */
function makeMockMemgraph(overrides: Record<string, unknown[]> = {}) {
  return {
    executeCypher: vi.fn(async (query: string) => {
      for (const [key, data] of Object.entries(overrides)) {
        if (query.includes(key)) {
          return { data };
        }
      }
      return { data: [] };
    }),
  } as any;
}

/** Pre-built episode row that matches the shape rowToEpisode() expects. */
function makeEpisodeRow(overrides: Record<string, unknown> = {}) {
  return {
    e: {
      properties: {
        id: "ep-123",
        agentId: "agent-a",
        sessionId: "sess-1",
        taskId: "task-1",
        type: "OBSERVATION",
        content: "worked on the parser module",
        timestamp: Date.now() - 3600_000, // 1 hour ago
        outcome: "success",
        metadata: '{"note":"foo"}',
        sensitive: false,
        entities: ["src/parsers/typescript-parser.ts"],
        projectId: "proj-a",
        ...overrides,
      },
    },
  };
}

// ── add() ───────────────────────────────────────────────────────────────────

describe("EpisodeEngine.add()", () => {
  it("creates an EPISODE node via executeCypher and returns a string id", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    const input: EpisodeInput = {
      agentId: "agent-a",
      sessionId: "sess-1",
      type: "OBSERVATION",
      content: "initial observation",
    };

    const id = await engine.add(input, "proj-a");

    expect(typeof id).toBe("string");
    expect(id.startsWith("ep-")).toBe(true);

    // First call is CREATE EPISODE
    const firstCall = memgraph.executeCypher.mock.calls[0];
    expect(firstCall[0]).toContain("CREATE (e:EPISODE");
    expect(firstCall[1]).toMatchObject({
      agentId: "agent-a",
      sessionId: "sess-1",
      type: "OBSERVATION",
      projectId: "proj-a",
    });
  });

  it("creates INVOLVES links for each entity", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    const input: EpisodeInput = {
      agentId: "agent-a",
      sessionId: "sess-1",
      type: "DECISION",
      content: "refactored parsers",
      entities: ["src/parsers/typescript-parser.ts", "src/parsers/regex-language-parsers.ts"],
    };

    await engine.add(input, "proj-a");

    const involveCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("INVOLVES"),
    );

    expect(involveCalls).toHaveLength(2);
    expect(involveCalls[0][1]).toMatchObject({
      entityId: "src/parsers/typescript-parser.ts",
    });
    expect(involveCalls[1][1]).toMatchObject({
      entityId: "src/parsers/regex-language-parsers.ts",
    });
  });

  it("caps entities at 100 items", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);
    const tooManyEntities = Array.from({ length: 150 }, (_, i) => `entity-${i}`);

    await engine.add(
      {
        agentId: "a",
        sessionId: "s",
        type: "OBSERVATION",
        content: "c",
        entities: tooManyEntities,
      },
      "proj-a",
    );

    const involveCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("INVOLVES"),
    );
    expect(involveCalls).toHaveLength(100);
  });

  it("attempts to link to previous episode in same session", async () => {
    const memgraph = makeMockMemgraph({
      NEXT_EPISODE: [], // prev lookup returns nothing
    });
    const engine = new EpisodeEngine(memgraph as any);

    await engine.add(
      { agentId: "agent-a", sessionId: "sess-1", type: "OBSERVATION", content: "c" },
      "proj-a",
    );

    const prevLookup = memgraph.executeCypher.mock.calls.find(
      ([q]: [string]) =>
        q.includes("NEXT_EPISODE") ||
        (q.includes("ORDER BY e.timestamp DESC") && q.includes("LIMIT 1")),
    );
    expect(prevLookup).toBeTruthy();
  });

  it("creates NEXT_EPISODE link when a previous episode exists", async () => {
    const memgraph = makeMockMemgraph({
      "LIMIT 1": [{ id: "ep-prev-001" }],
    });
    const engine = new EpisodeEngine(memgraph as any);

    await engine.add(
      { agentId: "agent-a", sessionId: "sess-1", type: "OBSERVATION", content: "c" },
      "proj-a",
    );

    const mergeCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("NEXT_EPISODE"),
    );
    expect(mergeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("handles missing optional fields gracefully (taskId, outcome, metadata)", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    const id = await engine.add(
      { agentId: "a", sessionId: "s", type: "LEARNING", content: "content" },
      "proj-a",
    );

    expect(id).toBeTruthy();
    const createCall = memgraph.executeCypher.mock.calls[0];
    expect(createCall[1].taskId).toBeNull();
    expect(createCall[1].outcome).toBeNull();
    expect(createCall[1].sensitive).toBe(false);
  });
});

// ── recall() ────────────────────────────────────────────────────────────────

describe("EpisodeEngine.recall()", () => {
  it("returns empty array when no episodes in DB", async () => {
    const engine = new EpisodeEngine(makeMockMemgraph() as any);
    const episodes = await engine.recall({ query: "test", projectId: "proj-a" });
    expect(episodes).toEqual([]);
  });

  it("maps DB rows to Episode objects with hybrid relevance scores", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow()],
    });
    const engine = new EpisodeEngine(memgraph as any);

    const episodes = await engine.recall({
      query: "parser module",
      projectId: "proj-a",
    });

    expect(episodes).toHaveLength(1);
    expect(episodes[0].id).toBe("ep-123");
    expect(episodes[0].agentId).toBe("agent-a");
    expect(typeof episodes[0].relevance).toBe("number");
    expect(episodes[0].relevance).toBeGreaterThanOrEqual(0);
    expect(episodes[0].relevance).toBeLessThanOrEqual(1);
  });

  it("filters by agentId when provided", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", agentId: "agent-x" });

    const cypher = memgraph.executeCypher.mock.calls[0][0];
    expect(cypher).toContain("e.agentId = $agentId");
    expect(memgraph.executeCypher.mock.calls[0][1]).toMatchObject({ agentId: "agent-x" });
  });

  it("filters by taskId when provided", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", taskId: "my-task" });

    const cypher = memgraph.executeCypher.mock.calls[0][0];
    expect(cypher).toContain("e.taskId = $taskId");
  });

  it("filters by types array when provided", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", types: ["DECISION", "LEARNING"] });

    const { types } = memgraph.executeCypher.mock.calls[0][1];
    expect(types).toEqual(["DECISION", "LEARNING"]);
  });

  it("filters by since timestamp when provided", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);
    const since = Date.now() - 86400_000;

    await engine.recall({ query: "q", projectId: "proj-a", since });

    expect(memgraph.executeCypher.mock.calls[0][1]).toMatchObject({ since });
  });

  it("caps limit to 50", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", limit: 999 });

    const { limit } = memgraph.executeCypher.mock.calls[0][1];
    expect(limit).toBe(50);
  });

  it("enforces minimum limit of 1 (limit:1 is preserved)", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", limit: 1 });

    const { limit } = memgraph.executeCypher.mock.calls[0][1];
    expect(limit).toBe(1);
  });

  it("defaults limit to 5 when limit is 0 (falsy)", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.recall({ query: "q", projectId: "proj-a", limit: 0 });

    const { limit } = memgraph.executeCypher.mock.calls[0][1];
    expect(limit).toBe(5); // 0 is falsy → 0||5 = 5 → clamp(1,50) = 5
  });

  it("scores higher for episodes with matching entity overlap", async () => {
    const sharedEntity = "src/parsers/typescript-parser.ts";
    const rowWithEntity = makeEpisodeRow({ entities: [sharedEntity] });
    const rowNoEntity = makeEpisodeRow({
      id: "ep-456",
      content: "unrelated content",
      entities: [],
    });

    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [rowWithEntity, rowNoEntity],
    });
    const engine = new EpisodeEngine(memgraph as any);

    const episodes = await engine.recall({
      query: "parser",
      projectId: "proj-a",
      entities: [sharedEntity],
    });

    // Both returned but entity-matched episode should score higher
    expect(episodes.length).toBeGreaterThanOrEqual(1);
    const entityMatched = episodes.find((e) => e.id === "ep-123");
    const noEntity = episodes.find((e) => e.id === "ep-456");
    if (entityMatched && noEntity) {
      expect(entityMatched.relevance).toBeGreaterThan(noEntity.relevance!);
    }
  });

  it("handles rows with nested .properties structure", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow()],
    });
    const engine = new EpisodeEngine(memgraph as any);
    const episodes = await engine.recall({ query: "parser", projectId: "proj-a" });

    expect(episodes[0].content).toBe("worked on the parser module");
  });

  it("handles flat row structure (no .properties wrapper)", async () => {
    const flatRow = {
      id: "ep-flat",
      agentId: "a",
      sessionId: "s",
      type: "OBSERVATION",
      content: "flat row test",
      timestamp: Date.now(),
      entities: [],
      projectId: "proj-a",
    };
    const memgraph = makeMockMemgraph({ "MATCH (e:EPISODE)": [flatRow] });
    const engine = new EpisodeEngine(memgraph as any);

    const episodes = await engine.recall({ query: "flat", projectId: "proj-a" });
    expect(episodes[0].id).toBe("ep-flat");
  });

  it("parses JSON metadata from stored string", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow({ metadata: '{"rationale":"speed"}' })],
    });
    const engine = new EpisodeEngine(memgraph as any);
    const episodes = await engine.recall({ query: "q", projectId: "proj-a" });

    expect(episodes[0].metadata).toEqual({ rationale: "speed" });
  });

  it("returns undefined metadata for invalid JSON", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow({ metadata: "not-json{{{" })],
    });
    const engine = new EpisodeEngine(memgraph as any);
    const episodes = await engine.recall({ query: "q", projectId: "proj-a" });

    expect(episodes[0].metadata).toBeUndefined();
  });

  it("skips null/invalid rows gracefully (rowToEpisode returns null)", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [null, makeEpisodeRow(), undefined],
    });
    const engine = new EpisodeEngine(memgraph as any);
    const episodes = await engine.recall({ query: "q", projectId: "proj-a" });

    // Only the valid row is returned
    expect(episodes).toHaveLength(1);
  });
});

// ── decisionQuery() ──────────────────────────────────────────────────────────

describe("EpisodeEngine.decisionQuery()", () => {
  it("delegates to recall() with types=['DECISION']", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [
        makeEpisodeRow({ type: "DECISION", content: "chose typescript over js" }),
      ],
    });
    const engine = new EpisodeEngine(memgraph as any);

    const results = await engine.decisionQuery({
      query: "typescript",
      projectId: "proj-a",
    });

    expect(results).toHaveLength(1);
    // Verify the types filter was applied
    const { types } = memgraph.executeCypher.mock.calls[0][1];
    expect(types).toEqual(["DECISION"]);
  });
});

// ── reflect() ────────────────────────────────────────────────────────────────

describe("EpisodeEngine.reflect()", () => {
  it("returns a reflection with insight and learningsCreated=0 when no episodes", async () => {
    const engine = new EpisodeEngine(makeMockMemgraph() as any);

    const result = await engine.reflect({ projectId: "proj-a" });

    expect(result.learningsCreated).toBe(0);
    expect(result.insight).toContain("0 episodes");
    expect(result.patterns).toEqual([]);
    expect(typeof result.reflectionId).toBe("string");
  });

  it("extracts entity patterns from multiple episodes", async () => {
    const entity = "src/engines/episode-engine.ts";
    const rows = [
      makeEpisodeRow({ entities: [entity], content: "worked on memory" }),
      makeEpisodeRow({ id: "ep-456", entities: [entity], content: "more memory work" }),
      makeEpisodeRow({ id: "ep-789", entities: [entity], content: "again memory" }),
    ];
    const memgraph = makeMockMemgraph({ "MATCH (e:EPISODE)": rows });
    const engine = new EpisodeEngine(memgraph as any);

    const result = await engine.reflect({ projectId: "proj-a" });

    expect(result.patterns).toHaveLength(1);
    expect(result.patterns[0].file).toBe(entity);
    expect(result.patterns[0].count).toBe(3);
  });

  it("creates LEARNING nodes for top 3 patterns", async () => {
    const entities = ["src/file-a.ts", "src/file-b.ts", "src/file-c.ts", "src/file-d.ts"];
    const rows = entities.map((e, i) =>
      makeEpisodeRow({ id: `ep-${i}`, entities: [e], content: `content about ${e}` }),
    );
    // Add more occurrences of first entity to make it high-frequency
    rows.push(makeEpisodeRow({ id: "ep-extra-a1", entities: [entities[0]], content: "more a" }));
    rows.push(
      makeEpisodeRow({ id: "ep-extra-a2", entities: [entities[0]], content: "more a again" }),
    );

    const memgraph = makeMockMemgraph({ "MATCH (e:EPISODE)": rows });
    const engine = new EpisodeEngine(memgraph as any);

    const result = await engine.reflect({ projectId: "proj-a" });

    // Should create at most 3 learnings
    expect(result.learningsCreated).toBeLessThanOrEqual(3);

    const learningCalls = memgraph.executeCypher.mock.calls.filter(([q]: [string]) =>
      q.includes("CREATE (l:LEARNING"),
    );
    expect(learningCalls.length).toBe(result.learningsCreated);
  });

  it("filters by agentId when provided", async () => {
    const memgraph = makeMockMemgraph();
    const engine = new EpisodeEngine(memgraph as any);

    await engine.reflect({ projectId: "proj-a", agentId: "agent-x" });

    // First call is recall → check agentId filter
    const { agentId } = memgraph.executeCypher.mock.calls[0][1];
    expect(agentId).toBe("agent-x");
  });

  it("generates an insight listing top patterns", async () => {
    const rows = [
      makeEpisodeRow({ entities: ["src/a.ts"], content: "about a" }),
      makeEpisodeRow({ id: "e2", entities: ["src/b.ts"], content: "about b" }),
    ];
    const memgraph = makeMockMemgraph({ "MATCH (e:EPISODE)": rows });
    const engine = new EpisodeEngine(memgraph as any);

    const result = await engine.reflect({ projectId: "proj-a" });

    expect(result.insight).toContain("Reflection over");
    expect(result.insight).toContain("episodes");
  });
});

// ── Internal helpers (tested via public API) ──────────────────────────────────

describe("EpisodeEngine private helpers (via recall)", () => {
  it("jaccard returns 1 for identical token sets", async () => {
    // Same content and query → lexical score should be high
    const content = "typescript parser engine analysis";
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow({ content })],
    });
    const engine = new EpisodeEngine(memgraph as any);

    const [episode] = await engine.recall({
      query: content,
      projectId: "proj-a",
    });

    // lexical jaccard(same, same) = 1.0
    expect(episode.relevance).toBeGreaterThan(0.4);
  });

  it("jaccard returns 0 when sets are disjoint", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow({ content: "zzz yyy xxx" })],
    });
    const engine = new EpisodeEngine(memgraph as any);

    // Query has completely different tokens
    const [episode] = await engine.recall({
      query: "aaa bbb ccc",
      projectId: "proj-a",
    });

    // lexical score should be near 0, but temporal score lifts it slightly
    expect(episode.relevance).toBeLessThanOrEqual(0.5);
  });

  it("returns 4-decimal precision on relevance score", async () => {
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [makeEpisodeRow()],
    });
    const engine = new EpisodeEngine(memgraph as any);
    const [episode] = await engine.recall({ query: "parser", projectId: "proj-a" });

    // toFixed(4) result - should have at most 4 decimal places
    const decimals = String(episode.relevance).split(".")[1] ?? "";
    expect(decimals.length).toBeLessThanOrEqual(4);
  });

  it("sorts results by relevance descending", async () => {
    const old = makeEpisodeRow({
      id: "old-ep",
      timestamp: Date.now() - 30 * 86400_000, // 30 days ago
      content: "old unrelated xyz",
    });
    const recent = makeEpisodeRow({
      id: "recent-ep",
      timestamp: Date.now() - 100,
      content: "very recent important",
    });
    const memgraph = makeMockMemgraph({
      "MATCH (e:EPISODE)": [old, recent],
    });
    const engine = new EpisodeEngine(memgraph as any);

    const results = await engine.recall({ query: "recent important", projectId: "proj-a" });

    // The result is sorted desc by relevance
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].relevance!).toBeGreaterThanOrEqual(results[i].relevance!);
    }
  });
});
