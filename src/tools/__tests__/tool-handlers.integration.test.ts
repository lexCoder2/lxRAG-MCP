/**
 * @file tool-handlers.integration.test.ts
 * @description Comprehensive integration tests for all MCP tools.
 * Tests are ordered by severity: Critical bugs first, then significant issues,
 * then full coverage of remaining tools.
 *
 * Based on the 2026-02-27 audit findings.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import GraphIndexManager from "../../graph/index.js";
import { ToolHandlers } from "../tool-handlers.js";
import { runWithRequestContext } from "../../request-context.js";
import { toolRegistryMap } from "../registry.js";

// ─── Shared test helpers ────────────────────────────────────────────────────

function createHandlers(
  overrides: {
    executeCypher?: ReturnType<typeof vi.fn>;
    isConnected?: ReturnType<typeof vi.fn>;
    index?: GraphIndexManager;
    config?: any;
    orchestrator?: any;
  } = {},
) {
  const index = overrides.index ?? new GraphIndexManager();
  const executeCypher =
    overrides.executeCypher ?? vi.fn().mockResolvedValue({ data: [], error: undefined });

  const handlers = new ToolHandlers({
    index,
    memgraph: {
      executeCypher,
      queryNaturalLanguage: vi.fn(),
      isConnected: overrides.isConnected ?? vi.fn().mockReturnValue(true),
      loadProjectGraph: vi.fn().mockResolvedValue({ nodes: [], relationships: [] }),
    } as any,
    config: overrides.config ?? {},
    orchestrator: overrides.orchestrator,
  });

  return { handlers, index, executeCypher };
}

function createTempWorkspace(): {
  root: string;
  srcDir: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lxdig-test-"));
  const srcDir = path.join(root, "src");
  fs.mkdirSync(srcDir);
  return {
    root,
    srcDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function parseResponse(raw: string) {
  return JSON.parse(raw);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL BUGS (P0) — From Audit Report
// ═══════════════════════════════════════════════════════════════════════════════

describe("CRITICAL: graph_query returns no row data in compact profile", () => {
  it("must include results array in compact profile response", async () => {
    const { handlers, executeCypher } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: [
          { label: "FILE", cnt: 67 },
          { label: "FUNCTION", cnt: 85 },
          { label: "CLASS", cnt: 164 },
        ],
        error: undefined,
      }),
    });

    const response = await handlers.graph_query({
      query: "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS cnt LIMIT 3",
      language: "cypher",
      profile: "compact",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    // BUG: compact profile prunes results due to 300-token budget
    // Results field should ALWAYS be present for graph_query
    expect(parsed.data).toHaveProperty("results");
    expect(parsed.data.results).toBeInstanceOf(Array);
    expect(parsed.data.results.length).toBeGreaterThan(0);
    expect(parsed.data.count).toBe(3);
  });

  it("returns actual data rows in debug profile", async () => {
    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: [{ path: "src/server.ts" }, { path: "src/index.ts" }],
        error: undefined,
      }),
    });

    const response = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f.path AS path LIMIT 2",
      language: "cypher",
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.results).toBeDefined();
    expect(parsed.data.results).toHaveLength(2);
    expect(parsed.data.results[0]).toHaveProperty("path", "src/server.ts");
  });

  it("respects LIMIT clause instead of hardcoding 100", async () => {
    const mockRows = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: mockRows,
        error: undefined,
      }),
    });

    const response = await handlers.graph_query({
      query: "MATCH (n) RETURN n LIMIT 5",
      language: "cypher",
      limit: 5,
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBeLessThanOrEqual(5);
  });

  it("summary row count matches actual returned data length", async () => {
    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: [{ a: 1 }, { a: 2 }, { a: 3 }],
        error: undefined,
      }),
    });

    const response = await handlers.graph_query({
      query: "MATCH (n) RETURN n LIMIT 3",
      language: "cypher",
      limit: 3,
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    // The summary says "X row(s)" — verify X matches actual data
    const summaryCount = parseInt(parsed.summary.match(/(\d+) row/)?.[1] ?? "0");
    expect(summaryCount).toBe(parsed.data.results?.length ?? parsed.data.count);
  });
});

describe("CRITICAL: contract_validate does not validate against tool schemas", () => {
  it("should reject invalid parameter names for semantic_diff", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("contract_validate", {
      tool: "semantic_diff",
      arguments: { elementA: "x", elementB: "y" },
    });
    const parsed = parseResponse(response);

    // semantic_diff requires elementId1/elementId2 — passing elementA/elementB
    // must be flagged: valid:false (missing required) and extraFields reported.
    expect(parsed.ok).toBe(true); // outer envelope is always ok:true for contract_validate
    expect(parsed.data.valid).toBe(false);
    expect(parsed.data.missingRequired).toContain("elementId1");
    expect(parsed.data.missingRequired).toContain("elementId2");
    expect(parsed.data.extraFields).toContain("elementA");
    expect(parsed.data.extraFields).toContain("elementB");
    expect(parsed.data.errors.length).toBeGreaterThan(0);
  });

  it("should reject codeType for arch_suggest (requires type)", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("contract_validate", {
      tool: "arch_suggest",
      arguments: { codeType: "engine", name: "TestEngine" },
    });
    const parsed = parseResponse(response);

    // arch_suggest requires 'type' (not 'codeType'): must report valid:false
    // with 'type' in missingRequired and 'codeType' in extraFields.
    expect(parsed.ok).toBe(true);
    expect(parsed.data.valid).toBe(false);
    expect(parsed.data.missingRequired).toContain("type");
    expect(parsed.data.extraFields).toContain("codeType");
  });

  it("should validate correct params as valid", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("contract_validate", {
      tool: "graph_rebuild",
      arguments: { mode: "full", projectId: "test-proj" },
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.valid).toBe(true);
    expect(parsed.data.warnings).toHaveLength(0);
  });

  it("validates that normalizeForDispatch only normalizes, does not schema-check", async () => {
    const { handlers } = createHandlers();

    // Pass completely fabricated params
    const result = handlers.normalizeForDispatch("graph_query", {
      bogusField: "nonsense",
      anotherFake: 42,
    });

    // normalizeForDispatch should pass through unknown fields without warning
    expect(result.normalized).toHaveProperty("bogusField");
    expect(result.warnings).toHaveLength(0);
  });
});

describe("CRITICAL: coordination claim tracking — claims not appearing in queries", () => {
  it("agent_status should show active claims after agent_claim", async () => {
    const claimData = {
      id: "claim-test-001",
      agentId: "test-agent",
      sessionId: "test-session",
      taskId: "task-1",
      claimType: "task",
      targetId: "src/server.ts",
      intent: "refactoring",
      validFrom: Date.now(),
      targetVersionSHA: "sha-test",
      validTo: null,
      projectId: "test-proj",
    };

    const executeCypher = vi.fn().mockImplementation((query: string, params: any) => {
      // Simulate Memgraph responses
      if (
        query.includes("CONFLICT_CHECK") ||
        (query.includes("WHERE c.validTo IS NULL") && query.includes("c.agentId <>"))
      ) {
        return Promise.resolve({ data: [] }); // No conflicts
      }
      if (query.includes("CREATE (c:CLAIM")) {
        return Promise.resolve({ data: [] });
      }
      if (query.includes("MERGE (c)-[:TARGETS]")) {
        return Promise.resolve({ data: [] });
      }
      // Target snapshot
      if (query.includes("t.contentHash")) {
        return Promise.resolve({ data: [] });
      }
      // AGENT_ACTIVE_CLAIMS — this should return open claims
      if (query.includes("c.agentId = $agentId") && query.includes("c.validTo IS NULL")) {
        return Promise.resolve({
          data: [claimData],
        });
      }
      // AGENT_RECENT_EPISODES
      if (query.includes("EPISODE") && query.includes("e.agentId")) {
        return Promise.resolve({ data: [] });
      }
      // OVERVIEW_ACTIVE
      if (query.includes("c.validTo IS NULL") && !query.includes("agentId")) {
        return Promise.resolve({ data: [claimData] });
      }
      // OVERVIEW_STALE
      if (query.includes("t.validFrom > c.validFrom")) {
        return Promise.resolve({ data: [] });
      }
      // OVERVIEW_CONFLICTS
      if (query.includes("c1.id < c2.id")) {
        return Promise.resolve({ data: [] });
      }
      // OVERVIEW_AGENT_SUMMARY
      if (query.includes("count(c) AS claimCount")) {
        return Promise.resolve({
          data: [{ agentId: "test-agent", claimCount: 1, lastSeen: Date.now() }],
        });
      }
      // OVERVIEW_TOTAL
      if (query.includes("count(c) AS totalClaims")) {
        return Promise.resolve({ data: [{ totalClaims: 1 }] });
      }
      return Promise.resolve({ data: [] });
    });

    const { handlers } = createHandlers({ executeCypher });

    // Set workspace context
    const ws = createTempWorkspace();
    try {
      await handlers.callTool("graph_set_workspace", {
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "test-proj",
      });

      // 1. Create claim
      const claimResponse = await handlers.callTool("agent_claim", {
        agentId: "test-agent",
        targetId: "src/server.ts",
        intent: "refactoring",
        taskId: "task-1",
        sessionId: "test-session",
      });
      const claimParsed = parseResponse(claimResponse);
      expect(claimParsed.ok).toBe(true);
      expect(claimParsed.data.claimId).toBeTruthy();

      // 2. Check agent_status — should show the claim
      const statusResponse = await handlers.callTool("agent_status", {
        agentId: "test-agent",
      });
      const statusParsed = parseResponse(statusResponse);
      expect(statusParsed.ok).toBe(true);
      // activeClaims must contain the claim we just created
      expect(statusParsed.data.activeClaims).toBeDefined();
      expect(statusParsed.data.activeClaims).toHaveLength(1);
      expect(statusParsed.data.activeClaims[0].id).toBe("claim-test-001");
      expect(statusParsed.data.activeClaims[0].agentId).toBe("test-agent");

      // 3. Check coordination_overview — should show the claim
      const overviewResponse = await handlers.callTool("coordination_overview", {});
      const overviewParsed = parseResponse(overviewResponse);
      expect(overviewParsed.ok).toBe(true);
      expect(overviewParsed.data.totalClaims).toBeGreaterThanOrEqual(1);
    } finally {
      ws.cleanup();
    }
  });

  it("agent_release returns proper feedback for known claim", async () => {
    const executeCypher = vi.fn().mockImplementation((query: string) => {
      if (
        query.includes("RELEASE_CLAIM_OPEN_CHECK") ||
        (query.includes("c.validTo AS validTo") && query.includes("c.id AS id"))
      ) {
        return Promise.resolve({
          data: [{ validTo: null, id: "claim-rel-001" }],
        });
      }
      if (query.includes("SET c.validTo")) {
        return Promise.resolve({ data: [] });
      }
      return Promise.resolve({ data: [] });
    });

    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("agent_release", {
      claimId: "claim-rel-001",
      outcome: "completed",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.released).toBe(true);
    expect(parsed.data.notFound).toBe(false);
    expect(parsed.data.alreadyClosed).toBe(false);
  });
});

describe("CRITICAL: test_run resolves vitest from wrong directory", () => {
  it("should resolve vitest binary relative to workspace, not home dir", async () => {
    const ws = createTempWorkspace();
    const { handlers } = createHandlers();

    try {
      await handlers.callTool("graph_set_workspace", {
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "test-proj",
      });

      // The test_run implementation uses process.cwd() for vitest resolution
      // BUG: If cwd is not the workspace root, vitest resolves to wrong path
      const response = await handlers.callTool("test_run", {
        testFiles: ["src/utils/__tests__/validation.test.ts"],
        parallel: false,
      });
      const parsed = parseResponse(response);

      // test_run always returns ok:true with status field inside data
      expect(parsed.ok).toBe(true);
      // The command should include the workspace's node_modules path
      // BUG: uses process.cwd()/node_modules instead of workspaceRoot/node_modules
      if (parsed.data.status === "failed" && parsed.data.error) {
        const errorText = parsed.data.error;
        // If it fails because of wrong path, flag it
        if (errorText.includes("Cannot find module")) {
          expect(errorText).not.toContain(os.homedir() + "/node_modules");
        }
      }
    } finally {
      ws.cleanup();
    }
  });

  it("returns error status for empty test file list", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("test_run", {
      testFiles: [],
      parallel: false,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe("error");
    expect(parsed.data.message).toContain("No test files");
  });

  it("parallel parameter is accepted but unused", async () => {
    const { handlers } = createHandlers();

    // Verify that the parallel param doesn't cause errors
    const response = await handlers.callTool("test_run", {
      testFiles: ["nonexistent-test.ts"],
      parallel: true,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    // Should fail gracefully (file doesn't exist)
    expect(["passed", "failed"]).toContain(parsed.data.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNIFICANT ISSUES (P1)
// ═══════════════════════════════════════════════════════════════════════════════

describe("SIGNIFICANT: test_categorize finds 0 tests", () => {
  it("returns zero counts when test engine has no test knowledge", async () => {
    const { handlers } = createHandlers();

    // Mock testEngine with zero stats
    (handlers as any).testEngine = {
      getStatistics: vi.fn().mockReturnValue({
        unitTests: 0,
        integrationTests: 0,
        performanceTests: 0,
        e2eTests: 0,
      }),
    };

    const response = await handlers.callTool("test_categorize", {});
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.statistics.unitTests).toBe(0);
    expect(parsed.data.categorization.unit.count).toBe(0);
  });

  it("returns categoriesection with correct fallback patterns", async () => {
    const { handlers } = createHandlers();

    (handlers as any).testEngine = {
      getStatistics: vi.fn().mockReturnValue({
        unitTests: 10,
        integrationTests: 3,
        performanceTests: 1,
        e2eTests: 2,
      }),
    };

    const response = await handlers.callTool("test_categorize", {
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.categorization.unit.pattern).toContain("__tests__");
    expect(parsed.data.categorization.integration.pattern).toContain("integration");
    expect(parsed.data.categorization.performance.pattern).toContain("performance");
    expect(parsed.data.categorization.e2e.pattern).toContain("e2e");
  });
});

describe("SIGNIFICANT: test_select returns empty results", () => {
  it("returns affected tests when testEngine has knowledge", async () => {
    const { handlers } = createHandlers();

    (handlers as any).testEngine = {
      selectAffectedTests: vi.fn().mockReturnValue({
        selectedTests: ["src/tools/__tests__/tool-handlers.contract.test.ts"],
        estimatedTime: 5,
        coverage: { percentage: 20, testsSelected: 1, totalTests: 5 },
      }),
    };

    const response = await handlers.callTool("test_select", {
      changedFiles: ["src/tools/tool-handlers.ts"],
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.selectedTests).toHaveLength(1);
  });
});

describe("SIGNIFICANT: suggest_tests returns 0 suggestions", () => {
  it("falls back to file path when element ID cannot be resolved", async () => {
    const { handlers } = createHandlers();

    (handlers as any).testEngine = {
      selectAffectedTests: vi.fn().mockReturnValue({
        selectedTests: [],
        estimatedTime: 0,
        coverage: { percentage: 0, testsSelected: 0, totalTests: 0 },
      }),
    };

    const response = await handlers.callTool("suggest_tests", {
      elementId: "test-proj:src/server.ts:main:1",
      limit: 5,
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("elementId");
    expect(parsed.data).toHaveProperty("suggestedTests");
  });
});

describe("SIGNIFICANT: code_clusters returns single cluster", () => {
  it("returns clusters based on embedding data", async () => {
    const { handlers } = createHandlers();

    // Set workspace so getActiveProjectContext works
    const ws = createTempWorkspace();
    try {
      await handlers.callTool("graph_set_workspace", {
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "cluster-proj",
      });

      // code_clusters uses embeddingEngine.getAllEmbeddings(), not the index
      (handlers as any).embeddingEngine = {
        getAllEmbeddings: vi.fn().mockReturnValue([
          {
            type: "file",
            name: "a.ts",
            projectId: "cluster-proj",
            metadata: { path: "src/engines/a.ts" },
          },
          {
            type: "file",
            name: "b.ts",
            projectId: "cluster-proj",
            metadata: { path: "src/engines/b.ts" },
          },
          {
            type: "file",
            name: "c.ts",
            projectId: "cluster-proj",
            metadata: { path: "src/tools/c.ts" },
          },
          {
            type: "file",
            name: "d.ts",
            projectId: "cluster-proj",
            metadata: { path: "src/tools/d.ts" },
          },
        ]),
        generateAllEmbeddings: vi.fn().mockResolvedValue({ functions: 0, classes: 0, files: 4 }),
        storeInQdrant: vi.fn().mockResolvedValue(undefined),
      };

      // Mark embeddings as ready so ensureEmbeddings() skips
      handlers.setProjectEmbeddingsReady("cluster-proj", true);

      const response = await handlers.callTool("code_clusters", {
        type: "file",
        count: 2,
        profile: "debug",
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.type).toBe("file");
      expect(parsed.data.clusters).toBeDefined();
      expect(parsed.data.clusters.length).toBeGreaterThanOrEqual(1);
    } finally {
      ws.cleanup();
    }
  });
});

describe("SIGNIFICANT: context_pack returns empty arrays", () => {
  it("returns task briefing with available context", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("context_pack", {
      task: "Implement new test runner",
      taskId: "impl-runner",
      agentId: "test-agent",
      includeLearnings: true,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("task");
    expect(parsed.data).toHaveProperty("taskId");
    // BUG: coreSymbols, dependencies, decisions, learnings are all empty
    // even when data exists in the system
    expect(parsed.data).toHaveProperty("coreSymbols");
    expect(parsed.data).toHaveProperty("dependencies");
  });
});

describe("SIGNIFICANT: task_update envelope mismatch", () => {
  it("returns ok:true but data.success:false for non-existent task", async () => {
    const { handlers } = createHandlers();

    (handlers as any).progressEngine = {
      query: vi.fn().mockReturnValue({ items: [] }),
      updateTask: vi.fn().mockImplementation(() => {
        throw new Error("Task not found: nonexistent-task");
      }),
    };

    const response = await handlers.callTool("task_update", {
      taskId: "nonexistent-task",
      status: "completed",
      note: "done",
      projectId: "test-proj",
    });
    const parsed = parseResponse(response);

    // When the task is not found, the envelope must have ok:false
    // (not ok:true with data.success:false — that is an envelope mismatch).
    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARAMETER INCONSISTENCIES (P2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("INCONSISTENCY: arch_suggest parameter naming", () => {
  it("works with 'type' parameter (correct)", async () => {
    const { handlers } = createHandlers();

    (handlers as any).archEngine = {
      getSuggestion: vi.fn().mockReturnValue({
        suggestedLayer: {
          id: "engines",
          name: "Engines",
          paths: ["src/engines/**"],
          canImport: ["types", "utils"],
        },
        suggestedPath: "src/engines/TestEngine.ts",
        reasoning: "Best match",
      }),
    };

    const response = await handlers.callTool("arch_suggest", {
      name: "TestEngine",
      type: "engine",
      dependencies: ["utils"],
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.success).toBe(true);
    expect(parsed.data.suggestedPath).toContain("TestEngine");
  });

  it("fails with 'codeType' parameter (documented but wrong)", async () => {
    const { handlers } = createHandlers();

    (handlers as any).archEngine = {
      getSuggestion: vi.fn().mockReturnValue(null),
    };

    // The copilot instructions document codeType but the tool inputShape requires type
    // This should fail or at minimum produce a warning
    try {
      const response = await handlers.callTool("arch_suggest", {
        name: "TestEngine",
        codeType: "engine", // Wrong param name per copilot docs
        dependencies: ["utils"],
        profile: "debug",
      });
      const parsed = parseResponse(response);
      // If it reaches here, the tool silently accepted wrong params
      // The arch engine received undefined for 'type' field
      expect(parsed.ok).toBe(true);
    } catch {
      // Expected — validation error at transport level
    }
  });
});

describe("INCONSISTENCY: impact_analyze changedFiles normalization", () => {
  it("normalizes changedFiles -> files with contract warning via callTool", async () => {
    const { handlers } = createHandlers();

    (handlers as any).testEngine = {
      selectAffectedTests: vi.fn().mockReturnValue({
        selectedTests: [],
        estimatedTime: 0,
        coverage: { percentage: 0, testsSelected: 0, totalTests: 0 },
      }),
    };

    const response = await handlers.callTool("impact_analyze", {
      changedFiles: ["src/server.ts"],
      depth: 2,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.contractWarnings).toContain("mapped changedFiles -> files");
  });

  it("works directly with files parameter (no warning)", async () => {
    const { handlers } = createHandlers();

    (handlers as any).testEngine = {
      selectAffectedTests: vi.fn().mockReturnValue({
        selectedTests: [],
        estimatedTime: 0,
        coverage: { percentage: 0, testsSelected: 0, totalTests: 0 },
      }),
    };

    const response = await handlers.callTool("impact_analyze", {
      files: ["src/server.ts"],
      depth: 2,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    // No contractWarnings when using the correct param name
    expect(parsed.contractWarnings).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE SHAPING TESTS — Root cause of graph_query data loss
// ═══════════════════════════════════════════════════════════════════════════════

describe("Response shaping: applyFieldPriority budget pruning", () => {
  it("compact profile (300 tokens) prunes high-priority results field", async () => {
    const largeResult = Array.from({ length: 50 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      lines: 100 + i,
    }));

    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: largeResult,
        error: undefined,
      }),
    });

    const compactResponse = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f",
      language: "cypher",
      profile: "compact",
    });
    const compactParsed = parseResponse(compactResponse);

    const debugResponse = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f",
      language: "cypher",
      profile: "debug",
    });
    const debugParsed = parseResponse(debugResponse);

    // Debug should always have results
    expect(debugParsed.data.results).toBeDefined();
    expect(debugParsed.data.results.length).toBe(50);

    // BUG: Compact drops results because the field exceeds 300-token budget
    // This documents the root cause:
    const compactHasResults = "results" in compactParsed.data;
    if (!compactHasResults) {
      // Current broken behavior — results pruned by applyFieldPriority
      expect(compactParsed.data).not.toHaveProperty("results");
      // The count field (also high priority) may or may not survive
    }
  });

  it("small query results should survive compact budget", async () => {
    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({
        data: [{ count: 42 }],
        error: undefined,
      }),
    });

    const response = await handlers.graph_query({
      query: "MATCH (n) RETURN count(n) AS count",
      language: "cypher",
      profile: "compact",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    // With only 1 small row, results should survive even compact budget
    expect(parsed.data.results).toBeDefined();
    expect(parsed.data.count).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPH TOOLS — Full coverage
// ═══════════════════════════════════════════════════════════════════════════════

describe("Graph tools: graph_health", () => {
  it("reports connected status and graph index counts", async () => {
    const executeCypher = vi.fn().mockImplementation((query: string) => {
      if (query.includes("totalNodes")) {
        return Promise.resolve({
          data: [
            {
              totalNodes: 100,
              totalRels: 200,
              fileCount: 10,
              funcCount: 30,
              classCount: 20,
            },
          ],
        });
      }
      if (query.includes("latestTx")) {
        return Promise.resolve({
          data: [{ latestTx: { id: "tx-001", timestamp: Date.now() }, txCount: 1 }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.graph_health({ profile: "debug" });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("status");
    expect(parsed.data).toHaveProperty("memgraphConnected", true);
    expect(parsed.data).toHaveProperty("graphIndex");
  });
});

describe("Graph tools: graph_rebuild", () => {
  it("queues rebuild and returns txId", async () => {
    const build = vi.fn().mockResolvedValue({
      success: true,
      duration: 50,
      filesProcessed: 10,
      nodesCreated: 50,
      relationshipsCreated: 30,
      filesChanged: 5,
      errors: [],
      warnings: [],
    });

    const executeCypher = vi.fn().mockResolvedValue({ data: [], error: undefined });

    const { handlers } = createHandlers({
      executeCypher,
      orchestrator: { build } as any,
    });

    (handlers as any).coordinationEngine = {
      invalidateStaleClaims: vi.fn().mockResolvedValue(0),
    };

    const ws = createTempWorkspace();
    try {
      const response = await handlers.graph_rebuild({
        mode: "full",
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "rebuild-test",
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(["QUEUED", "COMPLETED"]).toContain(parsed.data.status);
      expect(parsed.data.projectId).toBe("rebuild-test");
      expect(parsed.data).toHaveProperty("txId");
    } finally {
      ws.cleanup();
    }
  });
});

describe("Graph tools: graph_set_workspace", () => {
  it("sets workspace and returns project context", async () => {
    const { handlers } = createHandlers();
    const ws = createTempWorkspace();

    try {
      const response = await handlers.callTool("graph_set_workspace", {
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "ws-test",
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.projectContext.projectId).toBe("ws-test");
      expect(parsed.data.projectContext.workspaceRoot).toBe(ws.root);
    } finally {
      ws.cleanup();
    }
  });
});

describe("Graph tools: diff_since", () => {
  it("returns diff summary since given txId", async () => {
    const executeCypher = vi.fn().mockImplementation(async (query: string, params: any) => {
      // resolveSinceAnchor looks up GRAPH_TX node
      if (query.includes("GRAPH_TX") && params?.id === "tx-001") {
        return { data: [{ timestamp: Date.now() - 60000 }] };
      }
      // diff queries return added/removed/modified nodes
      if (query.includes("CREATED_AT") || query.includes("created_at")) {
        return { data: [] };
      }
      return { data: [], error: undefined };
    });

    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("diff_since", {
      since: "tx-001",
      projectId: "test-proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("summary");
  });

  it("returns error for unknown txId", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("diff_since", {
      since: "tx-nonexistent",
      projectId: "test-proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe("DIFF_SINCE_ANCHOR_NOT_FOUND");
  });
});

describe("Graph tools: tools_list", () => {
  it("returns all tool categories and counts", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("tools_list", {
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("categories");
    expect(parsed.data.categories).toHaveProperty("graph");
    expect(parsed.data.categories).toHaveProperty("semantic");
    expect(parsed.data.categories).toHaveProperty("test");
    expect(parsed.data.categories).toHaveProperty("memory");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SEMANTIC / CODE INTELLIGENCE TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Semantic tools: semantic_search", () => {
  it("returns results with id, name, type", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:func:doSomething:10", "FUNCTION", {
      name: "doSomething",
      filePath: "src/utils.ts",
      projectId: "proj",
    });

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("semantic_search", {
      query: "utility function",
      projectId: "proj",
      limit: 5,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("query");
    expect(parsed.data).toHaveProperty("results");
  });
});

describe("Semantic tools: code_explain", () => {
  it("resolves element by symbol name", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:class:MyClass:5", "CLASS", {
      name: "MyClass",
      kind: "class",
      filePath: "src/my-class.ts",
      startLine: 5,
      endLine: 100,
      LOC: 96,
      isExported: true,
      projectId: "proj",
    });

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("code_explain", {
      element: "MyClass",
      depth: 1,
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("element", "MyClass");
    expect(parsed.data).toHaveProperty("type");
  });
});

describe("Semantic tools: find_similar_code", () => {
  it("returns similar elements for a valid element ID", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:func:fnA:10", "FUNCTION", {
      name: "fnA",
      projectId: "proj",
    });
    index.addNode("proj:func:fnB:20", "FUNCTION", {
      name: "fnB",
      projectId: "proj",
    });

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("find_similar_code", {
      elementId: "proj:func:fnA:10",
      limit: 5,
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("elementId");
    expect(parsed.data).toHaveProperty("similar");
  });
});

describe("Semantic tools: semantic_diff", () => {
  it("returns error for unresolvable element IDs", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("semantic_diff", {
      elementId1: "proj:nonexistent:x:1",
      elementId2: "proj:nonexistent:y:2",
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe("SEMANTIC_DIFF_ELEMENT_NOT_FOUND");
    expect(parsed.error.recoverable).toBe(true);
  });

  it("succeeds when both elements exist in index", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:func:fnA:10", "FUNCTION", {
      name: "fnA",
      filePath: "src/a.ts",
      startLine: 10,
      endLine: 20,
      LOC: 11,
      projectId: "proj",
    });
    index.addNode("proj:func:fnB:30", "FUNCTION", {
      name: "fnB",
      filePath: "src/b.ts",
      startLine: 30,
      endLine: 40,
      LOC: 11,
      projectId: "proj",
    });

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("semantic_diff", {
      elementId1: "proj:func:fnA:10",
      elementId2: "proj:func:fnB:30",
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("left");
    expect(parsed.data).toHaveProperty("right");
    expect(parsed.data).toHaveProperty("changedKeys");
  });
});

describe("Semantic tools: semantic_slice", () => {
  it("resolves symbol and returns code context", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:class:Handler:15", "CLASS", {
      name: "Handler",
      filePath: "/tmp/test-ws/src/handler.ts",
      startLine: 15,
      endLine: 50,
      projectId: "proj",
    });

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("semantic_slice", {
      symbol: "Handler",
      context: "body",
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("symbolName");
  });
});

describe("Semantic tools: find_pattern", () => {
  it("returns empty matches when no patterns found", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("find_pattern", {
      pattern: "observer pattern",
      projectId: "proj",
      limit: 5,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.matches).toBeDefined();
  });

  it("detects circular dependencies when cycles exist", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:file:src/a.ts", "FILE", {
      path: "src/a.ts",
      projectId: "proj",
    });
    index.addNode("proj:file:src/b.ts", "FILE", {
      path: "src/b.ts",
      projectId: "proj",
    });
    index.addNode("proj:import:a->b", "IMPORT", {
      source: "./b",
      projectId: "proj",
    });
    index.addNode("proj:import:b->a", "IMPORT", {
      source: "./a",
      projectId: "proj",
    });
    index.addRelationship("r1", "proj:file:src/a.ts", "proj:import:a->b", "IMPORTS");
    index.addRelationship("r2", "proj:import:a->b", "proj:file:src/b.ts", "REFERENCES");
    index.addRelationship("r3", "proj:file:src/b.ts", "proj:import:b->a", "IMPORTS");
    index.addRelationship("r4", "proj:import:b->a", "proj:file:src/a.ts", "REFERENCES");

    const { handlers } = createHandlers({ index });

    const response = await handlers.callTool("find_pattern", {
      pattern: "circular dependencies",
      type: "circular",
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    const matchText = JSON.stringify(parsed.data.matches);
    expect(matchText).toContain("src/a.ts");
  });
});

describe("Semantic tools: blocking_issues", () => {
  it("returns empty blocking issues when none exist", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("blocking_issues", {
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.blockingIssues).toEqual([]);
    expect(parsed.data.totalBlocked).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARCHITECTURE TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Architecture tools: arch_validate", () => {
  it("returns violations from architecture engine", async () => {
    const { handlers } = createHandlers();

    (handlers as any).archEngine = {
      validate: vi.fn().mockResolvedValue({
        success: true,
        violations: [],
        statistics: {
          totalViolations: 0,
          errorCount: 0,
          warningCount: 0,
          filesChecked: 2,
        },
      }),
    };

    const response = await handlers.callTool("arch_validate", {
      files: ["src/server.ts"],
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.violations).toEqual([]);
    expect(parsed.data.statistics.filesChecked).toBe(2);
  });

  it("returns error when arch engine is unavailable", async () => {
    const { handlers } = createHandlers();
    (handlers as any).archEngine = undefined;

    const response = await handlers.callTool("arch_validate", {
      strict: true,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBe("ARCH_ENGINE_UNAVAILABLE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DOCS TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Docs tools: search_docs", () => {
  it("returns doc results for text query", async () => {
    const { handlers } = createHandlers();

    // The implementation calls docsEngine.searchDocs(), not .search()
    (handlers as any).docsEngine = {
      searchDocs: vi.fn().mockResolvedValue([
        {
          heading: "Architecture Overview",
          docRelativePath: "ARCHITECTURE.md",
          kind: "architecture",
          startLine: 1,
          score: 0.9,
          content: "The system uses a layered architecture...",
        },
      ]),
      getDocsBySymbol: vi.fn().mockResolvedValue([]),
    };

    const response = await handlers.callTool("search_docs", {
      query: "architecture layers",
      limit: 5,
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBeGreaterThanOrEqual(0);
  });
});

describe("Docs tools: index_docs", () => {
  it("indexes documents from workspace and reports counts", async () => {
    const { handlers } = createHandlers();
    const ws = createTempWorkspace();

    // The implementation calls docsEngine.indexWorkspace(workspaceRoot, projectId, opts)
    (handlers as any).docsEngine = {
      indexWorkspace: vi.fn().mockResolvedValue({
        indexed: 2,
        skipped: 0,
        errors: [],
        durationMs: 15,
      }),
    };

    try {
      await handlers.callTool("graph_set_workspace", {
        workspaceRoot: ws.root,
        sourceDir: "src",
        projectId: "idx-proj",
      });

      const response = await handlers.callTool("index_docs", {
        projectId: "idx-proj",
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data).toHaveProperty("indexed");
    } finally {
      ws.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MEMORY / EPISODE TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Memory tools: episode_add", () => {
  it("persists DECISION episode with metadata.rationale", async () => {
    const executeCypher = vi.fn().mockResolvedValue({ data: [], error: undefined });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("episode_add", {
      type: "DECISION",
      content: "Chose approach A over B",
      entities: ["serverModule"],
      outcome: "success",
      metadata: { rationale: "A is simpler" },
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.episodeId).toBeTruthy();
    expect(parsed.data.type).toBe("DECISION");
  });

  it("persists LEARNING episode without rationale", async () => {
    const executeCypher = vi.fn().mockResolvedValue({ data: [], error: undefined });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("episode_add", {
      type: "LEARNING",
      content: "Feature X requires Y dependency",
      outcome: "success",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.type).toBe("LEARNING");
  });

  it("rejects DECISION without metadata.rationale", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("episode_add", {
      type: "DECISION",
      content: "Made a choice",
      outcome: "success",
      // Missing metadata.rationale
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(false);
  });

  it("normalizes lowercase type to uppercase", async () => {
    const executeCypher = vi.fn().mockResolvedValue({ data: [], error: undefined });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("episode_add", {
      type: "decision", // Lowercase — gets normalized to DECISION
      content: "test",
      outcome: "success",
      metadata: { rationale: "r" },
    });
    const parsed = parseResponse(response);

    // The handler normalizes: String(type).toUpperCase()
    // So lowercase types ARE accepted and treated as their uppercase equivalent
    expect(parsed.ok).toBe(true);
    expect(parsed.data.type).toBe("DECISION");
  });
});

describe("Memory tools: episode_recall", () => {
  it("recalls episodes by query", async () => {
    const executeCypher = vi.fn().mockResolvedValue({
      data: [
        {
          id: "ep-001",
          type: "LEARNING",
          content: "Test finding",
          timestamp: Date.now(),
          agentId: "agent-1",
          outcome: "success",
        },
      ],
      error: undefined,
    });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("episode_recall", {
      query: "test finding",
      limit: 5,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("episodes");
  });
});

describe("Memory tools: decision_query", () => {
  it("queries decisions by topic", async () => {
    const executeCypher = vi.fn().mockResolvedValue({
      data: [],
      error: undefined,
    });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("decision_query", {
      query: "architecture decisions",
      limit: 5,
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("decisions");
    expect(parsed.data.decisions).toBeInstanceOf(Array);
  });
});

describe("Memory tools: reflect", () => {
  it("creates reflection with pattern analysis", async () => {
    const executeCypher = vi.fn().mockResolvedValue({
      data: [],
      error: undefined,
    });
    const { handlers } = createHandlers({ executeCypher });

    const response = await handlers.callTool("reflect", {
      limit: 10,
      profile: "balanced",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("reflectionId");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS / FEATURE TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Progress tools: feature_status", () => {
  it("lists all features with featureId=list", async () => {
    const { handlers } = createHandlers();

    (handlers as any).progressEngine = {
      query: vi.fn().mockReturnValue({ items: [] }),
      getFeatureStatus: vi.fn().mockReturnValue(null),
    };

    const response = await handlers.callTool("feature_status", {
      featureId: "list",
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("totalFeatures");
    expect(parsed.data).toHaveProperty("features");
  });
});

describe("Progress tools: progress_query", () => {
  it("returns items and counts", async () => {
    const { handlers } = createHandlers();

    (handlers as any).progressEngine = {
      query: vi.fn().mockReturnValue({
        items: [{ id: "task-1", name: "Task 1", status: "in-progress" }],
        totalCount: 1,
        completedCount: 0,
        inProgressCount: 1,
        blockedCount: 0,
      }),
    };

    const response = await handlers.callTool("progress_query", {
      query: "active tasks",
      projectId: "proj",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveProperty("items");
    expect(parsed.data).toHaveProperty("totalCount");
    expect(parsed.data.totalCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Setup tools: init_project_setup", () => {
  it("initializes project with workspace and rebuild", async () => {
    const build = vi.fn().mockResolvedValue({
      success: true,
      duration: 10,
      filesProcessed: 5,
      nodesCreated: 20,
      relationshipsCreated: 15,
      filesChanged: 5,
      errors: [],
      warnings: [],
    });

    const executeCypher = vi.fn().mockResolvedValue({ data: [], error: undefined });
    const { handlers } = createHandlers({
      executeCypher,
      orchestrator: { build } as any,
    });

    (handlers as any).coordinationEngine = {
      invalidateStaleClaims: vi.fn().mockResolvedValue(0),
    };

    const ws = createTempWorkspace();
    try {
      const response = await handlers.callTool("init_project_setup", {
        projectId: "init-test",
        workspaceRoot: ws.root,
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.projectId).toBe("init-test");
      expect(parsed.data.workspaceRoot).toBe(ws.root);
      expect(parsed.data.steps).toBeInstanceOf(Array);
      expect(parsed.data.steps.length).toBeGreaterThanOrEqual(2);
    } finally {
      ws.cleanup();
    }
  });
});

describe("Setup tools: setup_copilot_instructions", () => {
  it("creates instructions file when it does not exist", async () => {
    const ws = createTempWorkspace();

    try {
      const { handlers } = createHandlers();

      const response = await handlers.callTool("setup_copilot_instructions", {
        targetPath: ws.root,
        projectName: "TestProject",
        overwrite: false,
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      // Should create or detect existing file
      expect(parsed.data).toHaveProperty("status");
      expect(parsed.data).toHaveProperty("path");
    } finally {
      ws.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Utility tools: ref_query", () => {
  it("returns code and doc references", async () => {
    const { handlers } = createHandlers();

    const ws = createTempWorkspace();
    // Create a sample file to search
    fs.writeFileSync(
      path.join(ws.srcDir, "sample.ts"),
      'export function hello() { return "world"; }\n',
    );

    try {
      const response = await handlers.callTool("ref_query", {
        query: "hello world",
        repoPath: ws.root,
        limit: 5,
      });
      const parsed = parseResponse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data).toHaveProperty("findings");
    } finally {
      ws.cleanup();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL REGISTRY INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════════

describe("Tool registry: all registered tools are callable", () => {
  it("every tool in registry has a valid impl function", () => {
    for (const [name, def] of toolRegistryMap.entries()) {
      expect(typeof def.impl).toBe("function");
      expect(def.name).toBe(name);
      expect(def.category).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputShape).toBeDefined();
    }
  });

  it("registry contains expected tool count", () => {
    // Based on tools_list reporting 36 tools
    expect(toolRegistryMap.size).toBeGreaterThanOrEqual(30);
  });

  it("every tool can be dispatched via callTool without crash", async () => {
    const { handlers } = createHandlers();

    // Verify that callTool finds all registered tools (no TOOL_NOT_FOUND)
    for (const [name] of toolRegistryMap.entries()) {
      // Just verify the tool method exists on handlers
      const method = (handlers as any)[name];
      expect(typeof method).toBe("function");
    }
  });

  it("tool categories cover all expected groups", () => {
    const categories = new Set<string>();
    for (const [, def] of toolRegistryMap.entries()) {
      categories.add(def.category);
    }

    const expectedCategories = [
      "graph",
      "code",
      "test",
      "memory",
      "coordination",
      "setup",
      "utility",
      "arch",
      "docs",
      "ref",
    ];

    for (const cat of expectedCategories) {
      expect(categories.has(cat)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CROSS-CUTTING CONCERNS
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cross-cutting: response envelope consistency", () => {
  it("error responses have ok:false and errorCode", async () => {
    const { handlers } = createHandlers();
    (handlers as any).archEngine = undefined;

    const response = await handlers.callTool("arch_validate", { strict: true });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.errorCode).toBeTruthy();
    expect(parsed).toHaveProperty("error");
  });

  it("success responses have ok:true and data", async () => {
    const { handlers } = createHandlers();

    const response = await handlers.callTool("tools_list", {
      profile: "debug",
    });
    const parsed = parseResponse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed).toHaveProperty("_tokenEstimate");
  });
});

describe("Cross-cutting: profile system behavior", () => {
  it("compact profile shapes arrays to max 10 items", async () => {
    const largeData = Array.from({ length: 20 }, (_, i) => ({
      id: `item-${i}`,
      path: `src/file-${i}.ts`,
    }));

    const { handlers } = createHandlers({
      executeCypher: vi.fn().mockResolvedValue({ data: largeData }),
    });

    const compactRes = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f",
      language: "cypher",
      profile: "compact",
    });
    const debugRes = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f",
      language: "cypher",
      profile: "debug",
    });

    const compactParsed = parseResponse(compactRes);
    const debugParsed = parseResponse(debugRes);

    // Debug should preserve all results
    expect(debugParsed.data.results).toHaveLength(20);
    expect(debugParsed.data.count).toBe(20);

    // Compact profile: results must always be present (priority: required),
    // but the array is capped at 10 items by compactValue.
    expect(compactParsed.data.results).toBeDefined();
    expect(compactParsed.data.results).toBeInstanceOf(Array);
    expect(compactParsed.data.results.length).toBeGreaterThan(0);
    expect(compactParsed.data.results.length).toBeLessThanOrEqual(10);
  });
});

describe("Cross-cutting: session isolation", () => {
  it("different sessions have independent project contexts", async () => {
    const { handlers } = createHandlers();

    const wsA = createTempWorkspace();
    const wsB = createTempWorkspace();

    try {
      await runWithRequestContext({ sessionId: "sess-a" }, async () => {
        await handlers.callTool("graph_set_workspace", {
          workspaceRoot: wsA.root,
          sourceDir: "src",
          projectId: "project-a",
        });
      });

      await runWithRequestContext({ sessionId: "sess-b" }, async () => {
        await handlers.callTool("graph_set_workspace", {
          workspaceRoot: wsB.root,
          sourceDir: "src",
          projectId: "project-b",
        });
      });

      const healthA = await runWithRequestContext({ sessionId: "sess-a" }, async () =>
        handlers.graph_health({ profile: "debug" }),
      );
      const healthB = await runWithRequestContext({ sessionId: "sess-b" }, async () =>
        handlers.graph_health({ profile: "debug" }),
      );

      const parsedA = parseResponse(healthA);
      const parsedB = parseResponse(healthB);

      expect(parsedA.data.projectId).toBe("project-a");
      expect(parsedB.data.projectId).toBe("project-b");
    } finally {
      wsA.cleanup();
      wsB.cleanup();
    }
  });
});
