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
});
