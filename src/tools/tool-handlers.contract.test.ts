import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import GraphIndexManager from "../graph/index.js";
import { ToolHandlers } from "./tool-handlers.js";
import { runWithRequestContext } from "../request-context.js";

describe("ToolHandlers contract normalization", () => {
  it("normalizes impact_analyze input from files", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: ["src/foo.test.ts"],
      estimatedTime: 12,
      coverage: { percentage: 25, testsSelected: 1, totalTests: 4 },
    });

    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.impact_analyze({
      files: ["src/foo.ts"],
      depth: 2,
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.changedFiles).toEqual(["src/foo.ts"]);
    expect(selectAffectedTests).toHaveBeenCalledWith(["src/foo.ts"], true, 2);
  });

  it("normalizes impact_analyze input from changedFiles", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: ["src/bar.test.ts"],
      estimatedTime: 8,
      coverage: { percentage: 10, testsSelected: 1, totalTests: 10 },
    });

    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.impact_analyze({
      changedFiles: ["src/bar.ts"],
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.changedFiles).toEqual(["src/bar.ts"]);
    expect(selectAffectedTests).toHaveBeenCalledWith(["src/bar.ts"], true, 2);
  });

  it("maps progress_query active status to in-progress", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const query = vi.fn().mockReturnValue({ items: [] });
    (handlers as any).progressEngine = { query };

    const response = await handlers.progress_query({
      query: "active work",
      status: "active",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(query).toHaveBeenCalledWith("task", { status: "in-progress" });
  });

  it("applies normalization via centralized callTool dispatch", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: ["src/baz.test.ts"],
      estimatedTime: 5,
      coverage: { percentage: 5, testsSelected: 1, totalTests: 20 },
    });

    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.callTool("impact_analyze", {
      changedFiles: ["src/baz.ts"],
      depth: 2,
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.contractWarnings).toContain("mapped changedFiles -> files");
    expect(selectAffectedTests).toHaveBeenCalledWith(["src/baz.ts"], true, 2);
  });

  it("maps workspacePath to workspaceRoot during graph_rebuild normalization", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const normalizeResult = handlers.normalizeForDispatch("graph_rebuild", {
      workspacePath: "/tmp/project-a",
    });

    expect(normalizeResult.normalized.workspaceRoot).toBe("/tmp/project-a");
    expect(normalizeResult.normalized.workspacePath).toBeUndefined();
    expect(normalizeResult.warnings).toContain(
      "mapped workspacePath -> workspaceRoot",
    );
  });

  it("updates active project context through graph_set_workspace", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graph-ws-"));
    const tempSrc = path.join(tempRoot, "src");
    fs.mkdirSync(tempSrc);

    const response = await handlers.callTool("graph_set_workspace", {
      workspacePath: tempRoot,
      sourceDir: "src",
      projectId: "temp-project",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.contractWarnings).toContain(
      "mapped workspacePath -> workspaceRoot",
    );
    expect(parsed.data.projectContext.workspaceRoot).toBe(tempRoot);
    expect(parsed.data.projectContext.sourceDir).toBe(tempSrc);
    expect(parsed.data.projectContext.projectId).toBe("temp-project");

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("fails fast for sandboxed workspace paths by default", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const fallbackRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "graph-mounted-"),
    );
    const fallbackSrc = path.join(fallbackRoot, "src");
    fs.mkdirSync(fallbackSrc);

    const previousRoot = process.env.CODE_GRAPH_WORKSPACE_ROOT;
    const previousAllow = process.env.CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK;

    process.env.CODE_GRAPH_WORKSPACE_ROOT = fallbackRoot;
    delete process.env.CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK;

    try {
      const response = await handlers.callTool("graph_set_workspace", {
        workspaceRoot: "/definitely/not/mounted/project",
        sourceDir: "src",
      });

      const parsed = JSON.parse(response);

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("WORKSPACE_PATH_SANDBOXED");
    } finally {
      if (previousRoot === undefined) {
        delete process.env.CODE_GRAPH_WORKSPACE_ROOT;
      } else {
        process.env.CODE_GRAPH_WORKSPACE_ROOT = previousRoot;
      }

      if (previousAllow === undefined) {
        delete process.env.CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK;
      } else {
        process.env.CODE_GRAPH_ALLOW_RUNTIME_PATH_FALLBACK = previousAllow;
      }

      fs.rmSync(fallbackRoot, { recursive: true, force: true });
    }
  });

  it("isolates workspace context by MCP session", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      } as any,
      config: {},
    });

    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "graph-session-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "graph-session-b-"));
    fs.mkdirSync(path.join(rootA, "src"));
    fs.mkdirSync(path.join(rootB, "src"));

    try {
      await runWithRequestContext({ sessionId: "session-a" }, async () => {
        await handlers.callTool("graph_set_workspace", {
          workspaceRoot: rootA,
          sourceDir: "src",
          projectId: "project-a",
        });
      });

      await runWithRequestContext({ sessionId: "session-b" }, async () => {
        await handlers.callTool("graph_set_workspace", {
          workspaceRoot: rootB,
          sourceDir: "src",
          projectId: "project-b",
        });
      });

      const healthA = await runWithRequestContext(
        { sessionId: "session-a" },
        async () => handlers.graph_health({ profile: "debug" }),
      );
      const healthB = await runWithRequestContext(
        { sessionId: "session-b" },
        async () => handlers.graph_health({ profile: "debug" }),
      );

      const parsedA = JSON.parse(healthA);
      const parsedB = JSON.parse(healthB);

      if (!parsedA.ok || !parsedB.ok) {
        throw new Error(
          `Unexpected graph_health failure: A=${healthA} B=${healthB}`,
        );
      }

      expect(parsedA.ok).toBe(true);
      expect(parsedB.ok).toBe(true);
      expect(parsedA.data.projectId).toBe("project-a");
      expect(parsedB.data.projectId).toBe("project-b");
      expect(parsedA.data.workspaceRoot).toBe(rootA);
      expect(parsedB.data.workspaceRoot).toBe(rootB);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("handles BigInt metrics in graph_health without type errors", async () => {
    const index = new GraphIndexManager();
    const executeCypher = vi.fn().mockImplementation((query: string) => {
      if (query.includes("RETURN totalNodes")) {
        return Promise.resolve({
          data: [
            {
              totalNodes: 12n,
              totalRels: 21n,
              fileCount: 3n,
              funcCount: 7n,
              classCount: 2n,
            },
          ],
          error: undefined,
        });
      }

      if (query.includes("RETURN latestTx, txCount")) {
        return Promise.resolve({
          data: [
            {
              latestTx: { id: "tx-bigint", timestamp: 1735689600000n },
              txCount: 9n,
            },
          ],
          error: undefined,
        });
      }

      return Promise.resolve({ data: [], error: undefined });
    });

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        loadProjectGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [] }),
      } as any,
      config: {},
    });

    const response = await handlers.graph_health({ profile: "debug" });
    const parsed = JSON.parse(response);

    if (!parsed.ok) {
      throw new Error(`Expected graph_health to succeed, got: ${response}`);
    }

    expect(parsed.ok).toBe(true);
    expect(parsed.data.graphIndex.totalNodes).toBe(12);
    expect(parsed.data.graphIndex.totalRelationships).toBe(21);
    expect(parsed.data.rebuild.txCount).toBe(9);
    expect(parsed.data.rebuild.latestTxTimestamp).toBe(1735689600000);
    expect(executeCypher).toHaveBeenCalledTimes(2);
  });
});

describe("ToolHandlers regressions", () => {
  it("find_pattern circular detects a file cycle", async () => {
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

    index.addRelationship(
      "rel1",
      "proj:file:src/a.ts",
      "proj:import:a->b",
      "IMPORTS",
    );
    index.addRelationship(
      "rel2",
      "proj:import:a->b",
      "proj:file:src/b.ts",
      "REFERENCES",
    );
    index.addRelationship(
      "rel3",
      "proj:file:src/b.ts",
      "proj:import:b->a",
      "IMPORTS",
    );
    index.addRelationship(
      "rel4",
      "proj:import:b->a",
      "proj:file:src/a.ts",
      "REFERENCES",
    );

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.find_pattern({
      pattern: "circular dependencies",
      type: "circular",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    const cycleText = JSON.stringify(parsed.data.matches);
    expect(cycleText).toContain("src/a.ts");
    expect(cycleText).toContain("src/b.ts");
    expect(cycleText).not.toContain("not-implemented");
  });

  it("feature_status supports list mode and fuzzy ID resolution", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const mockFeatureStatus = {
      feature: {
        id: "proj:feature:alpha",
        name: "alpha",
        status: "in-progress",
      },
      tasks: [],
      implementingCode: { files: [], functions: 0, classes: 0 },
      testCoverage: { testSuites: 0, testCases: 0 },
      blockingIssues: [],
      progressPercentage: 0,
    };

    (handlers as any).progressEngine = {
      query: vi.fn().mockReturnValue({
        items: [
          { id: "proj:feature:alpha", name: "alpha", status: "in-progress" },
          { id: "proj:feature:beta", name: "beta", status: "pending" },
        ],
      }),
      getFeatureStatus: vi.fn().mockImplementation((id: string) => {
        if (id === "proj:feature:alpha") {
          return mockFeatureStatus;
        }
        return null;
      }),
    };

    const listResponse = await handlers.feature_status({
      featureId: "list",
      profile: "debug",
    });
    const listParsed = JSON.parse(listResponse);

    expect(listParsed.ok).toBe(true);
    expect(listParsed.data.totalFeatures).toBe(2);

    const fuzzyResponse = await handlers.feature_status({
      featureId: "alpha",
      profile: "debug",
    });
    const fuzzyParsed = JSON.parse(fuzzyResponse);

    expect(fuzzyParsed.ok).toBe(true);
    expect(fuzzyParsed.data.resolvedFeatureId).toBe("proj:feature:alpha");
    expect(fuzzyParsed.data.feature.id).toBe("proj:feature:alpha");
  });

  it("suggest_tests accepts direct file path when element ID is unresolved", async () => {
    const index = new GraphIndexManager();
    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: ["src/tools/tool-handlers.contract.test.ts"],
      estimatedTime: 3,
      coverage: { percentage: 15, testsSelected: 1, totalTests: 7 },
    });
    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.suggest_tests({
      elementId: "src/tools/tool-handlers.ts",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.file).toBe("src/tools/tool-handlers.ts");
    expect(selectAffectedTests).toHaveBeenCalledWith(
      ["src/tools/tool-handlers.ts"],
      true,
      2,
    );
  });
});

describe("ToolHandlers P0 integration", () => {
  it("queues graph_rebuild with resolved workspace context", async () => {
    const index = new GraphIndexManager();
    const executeCypher = vi
      .fn()
      .mockResolvedValue({ data: [], error: undefined });
    const build = vi.fn().mockResolvedValue({ success: true });

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        loadProjectGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [] }),
      } as any,
      config: {},
      orchestrator: {
        build,
      } as any,
    });

    (handlers as any).coordinationEngine = {
      invalidateStaleClaims: vi.fn().mockResolvedValue(0),
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "graph-rebuild-"));
    const tempSrc = path.join(tempRoot, "src");
    fs.mkdirSync(tempSrc);

    try {
      const response = await handlers.graph_rebuild({
        mode: "incremental",
        workspaceRoot: tempRoot,
        sourceDir: "src",
        projectId: "proj-integration",
      });
      const parsed = JSON.parse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.status).toBe("QUEUED");
      expect(parsed.data.projectId).toBe("proj-integration");
      expect(parsed.data.workspaceRoot).toBe(tempRoot);
      expect(parsed.data.sourceDir).toBe(tempSrc);

      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "incremental",
          workspaceRoot: tempRoot,
          sourceDir: tempSrc,
          projectId: "proj-integration",
        }),
      );

      expect(executeCypher).toHaveBeenCalledWith(
        expect.stringContaining("CREATE (tx:GRAPH_TX"),
        expect.objectContaining({ projectId: "proj-integration" }),
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("applies temporal filtering params for cypher graph_query", async () => {
    const index = new GraphIndexManager();
    const executeCypher = vi.fn().mockResolvedValue({
      data: [{ path: "src/index.ts" }],
      error: undefined,
    });

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        loadProjectGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [] }),
      } as any,
      config: {},
    });

    const response = await handlers.graph_query({
      query: "MATCH (f:FILE) RETURN f.path AS path LIMIT 1",
      language: "cypher",
      asOf: "1735689600000",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(executeCypher).toHaveBeenCalledTimes(1);
    const [cypher, params] = executeCypher.mock.calls[0];
    expect(String(cypher)).toContain("$asOfTs");
    expect(params).toEqual(expect.objectContaining({ asOfTs: 1735689600000 }));
  });

  it("uses session-scoped projectId for natural graph_query", async () => {
    const index = new GraphIndexManager();
    const retrieve = vi.fn().mockResolvedValue([]);

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        loadProjectGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [] }),
      } as any,
      config: {},
    });

    (handlers as any).hybridRetriever = { retrieve };

    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "graph-query-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "graph-query-b-"));
    fs.mkdirSync(path.join(rootA, "src"));
    fs.mkdirSync(path.join(rootB, "src"));

    try {
      await runWithRequestContext({ sessionId: "session-a" }, async () => {
        await handlers.graph_set_workspace({
          workspaceRoot: rootA,
          sourceDir: "src",
          projectId: "project-a",
        });
      });

      await runWithRequestContext({ sessionId: "session-b" }, async () => {
        await handlers.graph_set_workspace({
          workspaceRoot: rootB,
          sourceDir: "src",
          projectId: "project-b",
        });
      });

      await runWithRequestContext({ sessionId: "session-a" }, async () => {
        const raw = await handlers.graph_query({
          query: "find engine files",
          language: "natural",
          mode: "local",
        });
        const parsed = JSON.parse(raw);
        expect(parsed.ok).toBe(true);
      });

      await runWithRequestContext({ sessionId: "session-b" }, async () => {
        const raw = await handlers.graph_query({
          query: "find engine files",
          language: "natural",
          mode: "local",
        });
        const parsed = JSON.parse(raw);
        expect(parsed.ok).toBe(true);
      });

      expect(retrieve).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ projectId: "project-a", mode: "hybrid" }),
      );
      expect(retrieve).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ projectId: "project-b", mode: "hybrid" }),
      );
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("returns global and local sections in hybrid graph_query mode", async () => {
    const index = new GraphIndexManager();
    const executeCypher = vi.fn().mockResolvedValue({
      data: [
        {
          id: "community-1",
          label: "engines",
          summary: "engine cluster",
          memberCount: 5,
        },
      ],
      error: undefined,
    });
    const retrieve = vi
      .fn()
      .mockResolvedValue([{ nodeId: "node-1", score: 0.8 }]);

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
        loadProjectGraph: vi
          .fn()
          .mockResolvedValue({ nodes: [], relationships: [] }),
      } as any,
      config: {},
    });

    (handlers as any).hybridRetriever = { retrieve };

    const response = await handlers.graph_query({
      query: "find engine hotspots",
      language: "natural",
      mode: "hybrid",
      limit: 10,
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(2);
    expect(parsed.data.results[0].section).toBe("global");
    expect(parsed.data.results[1].section).toBe("local");
  });
});

describe("ToolHandlers architecture and test contracts", () => {
  it("arch_validate returns unavailable error when arch engine is missing", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    (handlers as any).archEngine = undefined;
    const response = await handlers.callTool("arch_validate", { strict: true });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ARCH_ENGINE_UNAVAILABLE");
  });

  it("arch_validate returns strict severity and truncates violations list", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const violations = Array.from({ length: 25 }).map((_, idx) => ({
      type: "layer-violation",
      severity: "error",
      file: `src/f${idx}.ts`,
      layer: "feature",
      message: `violation-${idx}`,
    }));

    (handlers as any).archEngine = {
      validate: vi.fn().mockResolvedValue({
        success: false,
        violations,
        statistics: {
          totalViolations: 25,
          errorCount: 25,
          warningCount: 0,
          filesChecked: 25,
        },
      }),
    };

    const response = await handlers.callTool("arch_validate", {
      strict: true,
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.severity).toBe("error");
    expect(parsed.data.violations).toHaveLength(20);
  });

  it("arch_suggest returns no-suggestion payload when engine returns null", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    (handlers as any).archEngine = {
      getSuggestion: vi.fn().mockReturnValue(null),
    };

    const response = await handlers.callTool("arch_suggest", {
      name: "Thing",
      type: "service",
      dependencies: ["unknown-layer"],
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.success).toBe(false);
    expect(String(parsed.data.reason)).toContain("unknown-layer");
  });

  it("test_select returns selected tests and includeIntegration defaults", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: ["src/a.test.ts"],
      estimatedTime: 4,
      coverage: { percentage: 20, testsSelected: 1, totalTests: 5 },
    });
    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.callTool("test_select", {
      changedFiles: ["src/a.ts"],
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(selectAffectedTests).toHaveBeenCalledWith(["src/a.ts"], true);
    expect(parsed.data.selectedTests).toEqual(["src/a.test.ts"]);
  });

  it("impact_analyze returns warning payload when changed files are missing", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("impact_analyze", {
      depth: 2,
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.changedFiles).toEqual([]);
    expect(parsed.data.warning).toContain("No changed files");
  });

  // T22 — impact_analyze must return non-empty directImpact when graph has
  // IMPORTS edges pointing to the changed file (F6 / A1 regression).
  it("T22: impact_analyze directImpact uses graph traversal via IMPORTS edges", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        isConnected: vi.fn().mockReturnValue(true),
        executeCypher: vi.fn().mockResolvedValue({
          data: [
            { path: "src/store/graphStore.ts" },
            { path: "src/hooks/useGraphController.ts" },
          ],
        }),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const selectAffectedTests = vi.fn().mockReturnValue({
      selectedTests: [],
      estimatedTime: 0,
      coverage: { percentage: 0, testsSelected: 0, totalTests: 0 },
    });
    (handlers as any).testEngine = { selectAffectedTests };

    const response = await handlers.callTool("impact_analyze", {
      files: ["src/graph/client.ts"],
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    // directImpact must reflect graph traversal results, not just test files
    expect(parsed.data.analysis.directImpact).toContain(
      "src/store/graphStore.ts",
    );
    expect(parsed.data.analysis.directImpact).toContain(
      "src/hooks/useGraphController.ts",
    );
  });
});

describe("ToolHandlers coordination and memory contracts", () => {
  it("episode_add validates required fields", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("episode_add", {
      type: "OBSERVATION",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("EPISODE_ADD_INVALID_INPUT");
  });

  it("episode_add persists normalized payload through episode engine", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const add = vi.fn().mockResolvedValue("ep-123");
    (handlers as any).episodeEngine = { add };

    const response = await handlers.callTool("episode_add", {
      type: "observation",
      content: "something happened",
      entities: ["src/a.ts"],
      profile: "debug",
      agentId: "agent-x",
      sessionId: "session-x",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.episodeId).toBe("ep-123");
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "OBSERVATION",
        content: "something happened",
        entities: ["src/a.ts"],
        agentId: "agent-x",
        sessionId: "session-x",
      }),
      expect.any(String),
    );
  });

  it("agent_claim validates required fields", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("agent_claim", {
      targetId: "task:1",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AGENT_CLAIM_INVALID_INPUT");
  });

  it("agent_claim and coordination_overview return engine data", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const claim = vi.fn().mockResolvedValue({
      status: "CREATED",
      claimId: "claim-1",
      conflicts: [],
    });
    const overview = vi.fn().mockResolvedValue({
      activeClaims: [{ id: "claim-1" }],
      staleClaims: [],
      conflicts: [],
    });
    (handlers as any).coordinationEngine = { claim, overview };

    const claimResponse = await handlers.callTool("agent_claim", {
      targetId: "task:1",
      intent: "work-on-task",
      claimType: "task",
      profile: "debug",
      agentId: "agent-y",
      sessionId: "session-y",
    });
    const claimParsed = JSON.parse(claimResponse);

    expect(claimParsed.ok).toBe(true);
    expect(claimParsed.data.status).toBe("CREATED");
    expect(claimParsed.data.claimId).toBe("claim-1");

    const overviewResponse = await handlers.callTool("coordination_overview", {
      profile: "debug",
    });
    const overviewParsed = JSON.parse(overviewResponse);

    expect(overviewParsed.ok).toBe(true);
    expect(overviewParsed.data.activeClaims).toHaveLength(1);
  });
});

describe("ToolHandlers explanation and test execution contracts", () => {
  it("code_explain resolves file and function elements", async () => {
    const index = new GraphIndexManager();
    index.addNode("proj:file:src/math.ts", "FILE", {
      path: "src/math.ts",
      projectId: "proj",
    });
    index.addNode("proj:fn:add", "FUNCTION", {
      name: "add",
      path: "src/math.ts",
      projectId: "proj",
    });
    index.addRelationship(
      "contains-1",
      "proj:file:src/math.ts",
      "proj:fn:add",
      "CONTAINS",
    );

    const handlers = new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const byFile = JSON.parse(
      await handlers.callTool("code_explain", {
        element: "src/math.ts",
        profile: "debug",
      }),
    );
    expect(byFile.ok).toBe(true);
    expect(byFile.data.type).toBe("FILE");
    expect(byFile.data.element).toBe("src/math.ts");

    const byFunction = JSON.parse(
      await handlers.callTool("code_explain", {
        element: "add",
        profile: "debug",
      }),
    );
    expect(byFunction.ok).toBe(true);
    expect(byFunction.data.type).toBe("FUNCTION");
    expect(byFunction.data.element).toBe("add");
  });

  it("code_explain returns structured not-found error", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("code_explain", {
      element: "missing-element",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ELEMENT_NOT_FOUND");
  });

  it("test_categorize returns statistics and category shape", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const getStatistics = vi.fn().mockReturnValue({
      totalTests: 12,
      unitTests: 7,
      integrationTests: 3,
      performanceTests: 1,
      e2eTests: 1,
    });
    (handlers as any).testEngine = { getStatistics };

    const response = await handlers.callTool("test_categorize", {
      testFiles: ["src/a.test.ts"],
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.statistics.totalTests).toBe(12);
    expect(parsed.data.categorization.unit.count).toBe(7);
    expect(parsed.data.categorization.integration.count).toBe(3);
    expect(getStatistics).toHaveBeenCalledTimes(1);
  });

  it("test_run returns graceful error payload when no test files are provided", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("test_run", {
      testFiles: [],
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.status).toBe("error");
    expect(parsed.data.executed).toBe(0);
    expect(parsed.data.message).toContain("No test files specified");
  });
});

describe("ToolHandlers semantic and temporal contracts", () => {
  it("semantic_search returns mapped similar results", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });

    const findSimilar = vi.fn().mockResolvedValue([
      {
        id: "proj:fn:parse",
        name: "parseInput",
        type: "function",
        metadata: { path: "src/parsers/input.ts" },
      },
    ]);

    (handlers as any).embeddingEngine = { findSimilar };
    (handlers as any).setProjectEmbeddingsReady(
      (handlers as any).getActiveProjectContext().projectId,
      true,
    );

    const response = await handlers.callTool("semantic_search", {
      query: "parse input",
      type: "function",
      limit: 3,
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.results[0]).toEqual(
      expect.objectContaining({
        id: "proj:fn:parse",
        name: "parseInput",
        type: "function",
        path: "src/parsers/input.ts",
      }),
    );
    expect(findSimilar).toHaveBeenCalledWith(
      "parse input",
      "function",
      3,
      expect.any(String),
    );
  });

  it("semantic_slice returns code and symbol metadata for resolved symbol", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });

    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "semantic-slice-"),
    );
    const srcDir = path.join(workspaceRoot, "src");
    fs.mkdirSync(srcDir);
    const filePath = path.join(srcDir, "sample.ts");
    fs.writeFileSync(
      filePath,
      [
        "export function doWork(input: string): string {",
        "  const normalized = input.trim();",
        "  return normalized.toUpperCase();",
        "}",
      ].join("\n"),
      "utf-8",
    );

    try {
      (handlers as any).setActiveProjectContext({
        workspaceRoot,
        sourceDir: srcDir,
        projectId: "proj-semantic",
      });

      const index = (handlers as any).context.index as GraphIndexManager;
      index.addNode("proj:file:src/sample.ts", "FILE", {
        path: "src/sample.ts",
        projectId: "proj-semantic",
      });
      index.addNode("proj:fn:doWork", "FUNCTION", {
        name: "doWork",
        path: "src/sample.ts",
        startLine: 1,
        endLine: 4,
        projectId: "proj-semantic",
      });
      index.addRelationship(
        "contains-sem-1",
        "proj:file:src/sample.ts",
        "proj:fn:doWork",
        "CONTAINS",
      );

      const response = await handlers.callTool("semantic_slice", {
        symbol: "doWork",
        context: "body",
        profile: "debug",
      });
      const parsed = JSON.parse(response);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.symbolName).toBe("doWork");
      expect(parsed.data.file).toBe("src/sample.ts");
      expect(parsed.data.code).toContain("doWork");
      expect(parsed.data.startLine).toBe(1);
      expect(parsed.data.endLine).toBe(4);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("context_pack validates required task input", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("context_pack", {
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONTEXT_PACK_INVALID_INPUT");
  });

  it("diff_since returns normalized added/removed/modified payload", async () => {
    const executeCypher = vi.fn().mockImplementation((query: string) => {
      if (
        query.includes("MATCH (tx:GRAPH_TX") &&
        query.includes("RETURN tx.id AS id")
      ) {
        return Promise.resolve({
          data: [{ id: "tx-1" }, { id: "tx-2" }],
          error: undefined,
        });
      }

      if (query.includes("n.validFrom IS NOT NULL")) {
        return Promise.resolve({
          data: [
            {
              type: "FUNCTION",
              scip_id: "proj:fn:new",
              path: "src/new.ts",
              symbolName: "newFn",
              validFrom: "1735689601000",
              validTo: null,
            },
          ],
          error: undefined,
        });
      }

      if (query.includes("n.validTo IS NOT NULL")) {
        return Promise.resolve({
          data: [
            {
              type: "CLASS",
              scip_id: "proj:class:old",
              path: "src/old.ts",
              symbolName: "OldClass",
              validFrom: "1735600000000",
              validTo: "1735689602000",
            },
          ],
          error: undefined,
        });
      }

      if (query.includes("MATCH (newer)")) {
        return Promise.resolve({
          data: [
            {
              type: "FILE",
              scip_id: "proj:file:src/changed.ts",
              path: "src/changed.ts",
              symbolName: null,
              validFrom: "1735689603000",
              validTo: null,
            },
          ],
          error: undefined,
        });
      }

      return Promise.resolve({ data: [], error: undefined });
    });

    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("diff_since", {
      since: "1735689600000",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.since.resolvedMode).toBe("timestamp");
    expect(parsed.data.txIds).toEqual(["tx-1", "tx-2"]);
    expect(parsed.data.added).toHaveLength(1);
    expect(parsed.data.removed).toHaveLength(1);
    expect(parsed.data.modified).toHaveLength(1);
    expect(parsed.data.summary).toContain("1 added, 1 removed, 1 modified");
  });
});

describe("ToolHandlers coordination and setup breadth contracts", () => {
  it("episode_recall validates required query", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("episode_recall", {
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("EPISODE_RECALL_INVALID_INPUT");
  });

  it("episode_recall, decision_query, and reflect return engine data", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    (handlers as any).episodeEngine = {
      recall: vi.fn().mockResolvedValue([
        {
          id: "ep-1",
          type: "OBSERVATION",
          content: "observed",
          timestamp: 1735689600000,
        },
      ]),
      decisionQuery: vi.fn().mockResolvedValue([
        {
          id: "ep-dec-1",
          type: "DECISION",
          content: "decision",
          timestamp: 1735689601000,
        },
      ]),
      reflect: vi.fn().mockResolvedValue({
        reflectionId: "rf-1",
        learningsCreated: 2,
      }),
    };

    const recall = JSON.parse(
      await handlers.callTool("episode_recall", {
        query: "recent failures",
        profile: "debug",
      }),
    );
    expect(recall.ok).toBe(true);
    expect(recall.data.count).toBe(1);

    const decision = JSON.parse(
      await handlers.callTool("decision_query", {
        query: "why parser fallback",
        profile: "debug",
      }),
    );
    expect(decision.ok).toBe(true);
    expect(decision.data.count).toBe(1);

    const reflect = JSON.parse(
      await handlers.callTool("reflect", {
        taskId: "task-1",
        profile: "debug",
      }),
    );
    expect(reflect.ok).toBe(true);
    expect(reflect.data.learningsCreated).toBe(2);
  });

  it("agent_status validates required agentId and returns status payload", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    // When agentId is omitted, agent_status now returns fleet overview (not an error)
    const overview = vi.fn().mockResolvedValue({
      activeClaims: [],
      staleClaims: [],
      conflicts: [],
      summary: { totalClaims: 0, activeAgents: 0 },
      totalClaims: 0,
    });
    const status = vi.fn().mockResolvedValue({
      activeClaims: [{ id: "claim-1" }],
      recentEpisodes: [],
      currentTask: undefined,
    });
    (handlers as any).coordinationEngine = { overview, status };

    const listAll = JSON.parse(
      await handlers.callTool("agent_status", { profile: "debug" }),
    );
    expect(listAll.ok).toBe(true);
    expect(listAll.data.mode).toBe("overview");

    const valid = JSON.parse(
      await handlers.callTool("agent_status", {
        agentId: "agent-z",
        profile: "debug",
      }),
    );
    expect(valid.ok).toBe(true);
    expect(valid.data.activeClaims).toHaveLength(1);
  });

  it("init_project_setup validates workspaceRoot requirement", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("init_project_setup", {
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INIT_MISSING_WORKSPACE");
  });

  it("setup_copilot_instructions validates target path and supports dryRun", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const missing = JSON.parse(
      await handlers.callTool("setup_copilot_instructions", {
        targetPath: "/definitely/not/here",
        profile: "debug",
      }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.error.code).toBe("COPILOT_INSTR_TARGET_NOT_FOUND");

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-instr-"));
    try {
      const dryRun = JSON.parse(
        await handlers.callTool("setup_copilot_instructions", {
          targetPath: tempRoot,
          dryRun: true,
          profile: "debug",
        }),
      );

      expect(dryRun.ok).toBe(true);
      expect(dryRun.data.dryRun).toBe(true);
      expect(String(dryRun.data.targetPath)).toContain(
        ".github/copilot-instructions.md",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ref_query validates repoPath input", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const response = await handlers.callTool("ref_query", {
      query: "architecture",
      profile: "debug",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("REF_REPO_MISSING");
  });
});

describe("ToolHandlers deeper integration contracts", () => {
  it("agent_claim surfaces conflict status and agent_release completes release flow", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const claim = vi.fn().mockResolvedValue({
      status: "CONFLICT",
      claimId: "claim-2",
      conflicts: [{ claimId: "claim-1", targetId: "task:1" }],
    });
    const release = vi.fn().mockResolvedValue(undefined);
    (handlers as any).coordinationEngine = { claim, release };

    const claimResponse = JSON.parse(
      await handlers.callTool("agent_claim", {
        targetId: "task:1",
        intent: "work",
        claimType: "task",
        profile: "debug",
      }),
    );

    expect(claimResponse.ok).toBe(true);
    expect(claimResponse.data.status).toBe("CONFLICT");
    expect(claimResponse.data.conflicts).toHaveLength(1);

    const releaseResponse = JSON.parse(
      await handlers.callTool("agent_release", {
        claimId: "claim-2",
        outcome: "partial",
        profile: "debug",
      }),
    );

    expect(releaseResponse.ok).toBe(true);
    expect(releaseResponse.data.released).toBe(true);
    expect(release).toHaveBeenCalledWith("claim-2", "partial");
  });

  it("episode_add enforces DECISION metadata and persists valid decision episodes", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
      } as any,
      config: {},
    });

    const invalid = JSON.parse(
      await handlers.callTool("episode_add", {
        type: "DECISION",
        content: "Chose parser strategy",
        outcome: "success",
        profile: "debug",
      }),
    );

    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe("EPISODE_ADD_INVALID_METADATA");

    const add = vi.fn().mockResolvedValue("ep-dec-2");
    (handlers as any).episodeEngine = { add };

    const valid = JSON.parse(
      await handlers.callTool("episode_add", {
        type: "DECISION",
        content: "Chose parser strategy",
        outcome: "success",
        metadata: { rationale: "stability over speed" },
        profile: "debug",
      }),
    );

    expect(valid.ok).toBe(true);
    expect(valid.data.episodeId).toBe("ep-dec-2");
    expect(add).toHaveBeenCalled();
  });

  it("setup_copilot_instructions writes file on non-dry run", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-write-"));
    fs.mkdirSync(path.join(tempRoot, "src"));
    fs.writeFileSync(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp-proj", scripts: { test: "vitest" } }),
      "utf-8",
    );

    try {
      const response = JSON.parse(
        await handlers.callTool("setup_copilot_instructions", {
          targetPath: tempRoot,
          profile: "debug",
        }),
      );

      expect(response.ok).toBe(true);
      expect(response.data.status).toBe("created");
      expect(
        fs.existsSync(
          path.join(tempRoot, ".github", "copilot-instructions.md"),
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("init_project_setup runs happy path and returns step statuses", async () => {
    const build = vi.fn().mockResolvedValue({ success: true });
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi
          .fn()
          .mockResolvedValue({ data: [], error: undefined }),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
      orchestrator: { build } as any,
    });

    (handlers as any).coordinationEngine = {
      invalidateStaleClaims: vi.fn().mockResolvedValue(0),
    };

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "init-setup-"));
    fs.mkdirSync(path.join(tempRoot, "src"));

    try {
      const response = JSON.parse(
        await handlers.callTool("init_project_setup", {
          workspaceRoot: tempRoot,
          sourceDir: "src",
          withDocs: false,
          profile: "debug",
        }),
      );

      expect(response.ok).toBe(true);
      expect(
        response.data.steps.some(
          (s: any) => s.step === "graph_set_workspace" && s.status === "ok",
        ),
      ).toBe(true);
      expect(
        response.data.steps.some((s: any) => s.step === "graph_rebuild"),
      ).toBe(true);
      expect(build).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("ref_query returns findings in all mode for a local reference repo", async () => {
    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher: vi.fn(),
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });

    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ref-repo-"));
    fs.mkdirSync(path.join(repoRoot, "src"));
    fs.writeFileSync(
      path.join(repoRoot, "README.md"),
      "# Architecture\n\nThis module explains parser architecture and conventions.",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(repoRoot, "src", "parser.ts"),
      "export function parseThing(input: string) { return input.trim(); }",
      "utf-8",
    );

    try {
      const response = JSON.parse(
        await handlers.callTool("ref_query", {
          repoPath: repoRoot,
          query: "parser architecture",
          mode: "all",
          limit: 10,
          profile: "debug",
        }),
      );

      expect(response.ok).toBe(true);
      expect(response.data.resultCount).toBeGreaterThan(0);
      expect(Array.isArray(response.data.findings)).toBe(true);
      expect(
        response.data.findings.some(
          (f: any) =>
            f.type === "doc" || f.type === "code" || f.type === "structure",
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("ToolHandlers watcher callback integration", () => {
  it("forwards changedFiles to incremental rebuild and records tx when memgraph is connected", async () => {
    const build = vi.fn().mockResolvedValue({ success: true });
    const executeCypher = vi
      .fn()
      .mockResolvedValue({ data: [], error: undefined });

    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(true),
      } as any,
      config: {},
      orchestrator: { build } as any,
    });

    (handlers as any).setProjectEmbeddingsReady("proj-watch", true);

    await (handlers as any).runWatcherIncrementalRebuild({
      workspaceRoot: "/tmp/workspace",
      sourceDir: "/tmp/workspace/src",
      projectId: "proj-watch",
      changedFiles: ["/tmp/workspace/src/a.ts", "/tmp/workspace/src/b.ts"],
    });

    expect(executeCypher).toHaveBeenCalledWith(
      expect.stringContaining("CREATE (tx:GRAPH_TX"),
      expect.objectContaining({
        projectId: "proj-watch",
        mode: "incremental",
        sourceDir: "/tmp/workspace/src",
      }),
    );

    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        workspaceRoot: "/tmp/workspace",
        sourceDir: "/tmp/workspace/src",
        projectId: "proj-watch",
        changedFiles: ["/tmp/workspace/src/a.ts", "/tmp/workspace/src/b.ts"],
      }),
    );

    expect((handlers as any).isProjectEmbeddingsReady("proj-watch")).toBe(false);
    expect((handlers as any).lastGraphRebuildMode).toBe("incremental");
  });

  it("skips tx write when memgraph is disconnected and still rebuilds incrementally", async () => {
    const build = vi.fn().mockResolvedValue({ success: true });
    const executeCypher = vi
      .fn()
      .mockResolvedValue({ data: [], error: undefined });

    const handlers = new ToolHandlers({
      index: new GraphIndexManager(),
      memgraph: {
        executeCypher,
        queryNaturalLanguage: vi.fn(),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
      orchestrator: { build } as any,
    });

    await (handlers as any).runWatcherIncrementalRebuild({
      workspaceRoot: "/tmp/workspace",
      sourceDir: "/tmp/workspace/src",
      projectId: "proj-watch-offline",
      changedFiles: ["/tmp/workspace/src/c.ts"],
    });

    expect(executeCypher).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "incremental",
        projectId: "proj-watch-offline",
        changedFiles: ["/tmp/workspace/src/c.ts"],
      }),
    );
  });
});

// ─── Schema consistency regression tests (A4 / A5) ───────────────────────────

describe("Schema consistency — A4/A5 regressions", () => {
  function makeHandlers() {
    const index = new GraphIndexManager();
    return new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn().mockResolvedValue({ data: [] }),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });
  }

  // T20 — progress_query must accept a profile parameter without schema error
  it("progress_query accepts profile parameter (A4)", async () => {
    const handlers = makeHandlers();
    const mockQuery = vi.fn().mockResolvedValue({ features: [], tasks: [] });
    (handlers as any).progressEngine = { query: mockQuery };

    const response = await handlers.progress_query({
      query: "all tasks",
      status: "all",
      profile: "compact",
    });

    // Must not return a schema validation error
    const parsed = JSON.parse(response);
    expect(parsed.ok).not.toBe(false);
    expect(parsed.error?.code).not.toBe("SCHEMA_VALIDATION_FAILED");
  });

  // T21 — agent_status must work without agentId (list-all use case)
  it("agent_status works without agentId (A5)", async () => {
    const handlers = makeHandlers();
    const mockOverview = vi.fn().mockResolvedValue({
      activeClaims: [],
      staleClaims: [],
      conflicts: [],
      summary: { totalClaims: 0, activeAgents: 0 },
      totalClaims: 0,
    });
    (handlers as any).coordinationEngine = { overview: mockOverview };

    const response = await handlers.agent_status({});

    // Must not return a validation error about missing agentId
    const parsed = JSON.parse(response);
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeUndefined();
    // Should return fleet overview data with mode field
    expect(parsed.data?.mode).toBe("overview");
  });
});

// ─── Medium-priority regressions N6 / N8 / N9 ────────────────────────────────

describe("Medium-priority bug regressions (N6/N8/N9)", () => {
  function makeHandlers() {
    const index = new GraphIndexManager();
    return new ToolHandlers({
      index,
      memgraph: {
        executeCypher: vi.fn().mockResolvedValue({ data: [] }),
        isConnected: vi.fn().mockReturnValue(false),
      } as any,
      config: {},
    });
  }

  // N6 — blocking_issues type param broken ternary
  it("N6: blocking_issues forwards type param to progressEngine (not always 'all')", async () => {
    const handlers = makeHandlers();
    const getBlockingIssues = vi.fn().mockReturnValue([]);
    (handlers as any).progressEngine = { getBlockingIssues };

    await handlers.blocking_issues({ type: "critical", context: "some context" });

    // type 'critical' must be forwarded, not silently overridden to 'all'
    expect(getBlockingIssues).toHaveBeenCalledWith("critical");
  });

  it("N6b: blocking_issues defaults to 'all' when type is not provided", async () => {
    const handlers = makeHandlers();
    const getBlockingIssues = vi.fn().mockReturnValue([]);
    (handlers as any).progressEngine = { getBlockingIssues };

    await handlers.blocking_issues({ context: "some context" });

    expect(getBlockingIssues).toHaveBeenCalledWith("all");
  });

  // N8 — task_update DECISION episode missing rationale
  it("N8: task_update adds rationale to DECISION episode metadata on completion", async () => {
    const handlers = makeHandlers();

    const updateTask = vi.fn().mockReturnValue({ id: "task-1", status: "completed" });
    const persistTaskUpdate = vi.fn().mockResolvedValue(true);
    (handlers as any).progressEngine = { updateTask, persistTaskUpdate };

    const addEpisode = vi.fn().mockResolvedValue("ep-123");
    const reflect = vi.fn().mockResolvedValue({ reflectionId: "ref-1", learningsCreated: 0 });
    (handlers as any).episodeEngine = { add: addEpisode, reflect };

    const onTaskCompleted = vi.fn().mockResolvedValue(undefined);
    (handlers as any).coordinationEngine = { onTaskCompleted };

    await handlers.task_update({
      taskId: "task-1",
      status: "completed",
      notes: "All done",
    });

    // The DECISION episode must be added with metadata.rationale
    const decisionCall = addEpisode.mock.calls.find(
      (call: any[]) => call[0]?.type === "DECISION",
    );
    expect(decisionCall).toBeDefined();
    const episodeArg = decisionCall![0];
    expect(episodeArg.metadata?.rationale).toBeDefined();
    expect(typeof episodeArg.metadata.rationale).toBe("string");
    expect(episodeArg.metadata.rationale.length).toBeGreaterThan(0);
  });

  // N9 — code_explain dependents always empty
  it("N9: code_explain populates dependents from incoming relationships", async () => {
    const handlers = makeHandlers();

    // Populate in-memory index with a FILE and a dependent FUNCTION
    const targetFileId = "file:src/graph/client.ts";
    const dependentFnId = "function:useClient";

    (handlers as any).context.index.addNode(targetFileId, "FILE", {
      path: "/ws/src/graph/client.ts",
      relativePath: "src/graph/client.ts",
      name: "client.ts",
    });
    (handlers as any).context.index.addNode(dependentFnId, "FUNCTION", {
      name: "useClient",
    });
    // dependentFn -[:CALLS]-> targetFile (incoming relationship to targetFile)
    // addRelationship signature: (id, from, to, type)
    (handlers as any).context.index.addRelationship("rel-1", dependentFnId, targetFileId, "CALLS");

    const response = await handlers.code_explain({
      element: "src/graph/client.ts",
      depth: 2,
      profile: "compact",
    });
    const parsed = JSON.parse(response);

    expect(parsed.ok).toBe(true);
    // dependents must be populated from incoming relationships
    expect(
      parsed.data.dependents.length,
      "dependents should not be empty when incoming rels exist",
    ).toBeGreaterThan(0);
    const sourceNames = parsed.data.dependents.map((d: any) => d.source);
    expect(sourceNames).toContain("useClient");
  });
});
