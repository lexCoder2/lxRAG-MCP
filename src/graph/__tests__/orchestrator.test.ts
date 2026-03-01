import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it, vi } from "vitest";
import { GraphOrchestrator } from "../orchestrator.js";
import GraphIndexManager from "../index.js";

describe("GraphOrchestrator", () => {
  it("normalizes incremental changed files and ignores unsupported extensions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-build-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, "a.ts"), "export function alpha(): number { return 1; }\n");
    fs.writeFileSync(path.join(srcDir, "note.txt"), "not a source file\n");

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(false),
      executeBatch: vi.fn().mockResolvedValue([]),
    } as any;

    const orchestrator = new GraphOrchestrator(memgraph, false);

    const result = await orchestrator.build({
      mode: "incremental",
      workspaceRoot: root,
      sourceDir: "src",
      projectId: "proj-a",
      changedFiles: ["src/a.ts", "src/note.txt"],
    });

    expect(result.success).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.filesProcessed).toBe(1);
    expect(memgraph.executeBatch).not.toHaveBeenCalled();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("dedupes changed files and ignores out-of-workspace paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-scope-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    const inWorkspace = path.join(srcDir, "a.ts");
    fs.writeFileSync(inWorkspace, "export const value = 1;\n");

    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-outside-"));
    const outsideFile = path.join(outsideRoot, "outside.ts");
    fs.writeFileSync(outsideFile, "export const outside = 1;\n");

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(false),
      executeBatch: vi.fn().mockResolvedValue([]),
    } as any;

    const orchestrator = new GraphOrchestrator(memgraph, false);

    const result = await orchestrator.build({
      mode: "incremental",
      workspaceRoot: root,
      sourceDir: "src",
      projectId: "proj-a",
      changedFiles: ["src/a.ts", "src/a.ts", outsideFile],
    });

    expect(result.success).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.filesProcessed).toBe(1);

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  // T17 — graph_health drift false-positive after rebuild (A2 regression)
  // When sharedIndex is passed to GraphOrchestrator, build() must sync the
  // internal index to sharedIndex so that graph_health sees cachedNodes > 0.
  it("syncs internal index to sharedIndex after build (T17 / A2 regression)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-sync-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, "app.ts"),
      "export function main(): void { console.log('hello'); }\n",
    );

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(false),
      executeBatch: vi.fn().mockResolvedValue([]),
    } as any;

    const sharedIndex = new GraphIndexManager();
    expect(sharedIndex.getStatistics().totalNodes).toBe(0);

    const orchestrator = new GraphOrchestrator(memgraph, false, sharedIndex);

    const result = await orchestrator.build({
      mode: "full",
      workspaceRoot: root,
      sourceDir: "src",
      projectId: "proj-sync",
    });

    expect(result.success).toBe(true);

    // After build, sharedIndex must have been populated (not zero)
    const stats = sharedIndex.getStatistics();
    expect(
      stats.totalNodes,
      "sharedIndex.totalNodes must be > 0 after build — if 0, drift will always be reported",
    ).toBeGreaterThan(0);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("GraphOrchestrator — two-phase execution", () => {
  it("executeBatch is called twice — nodes first, then edges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-2phase-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "hello.ts"),
      'export function hello(): string { return "hi"; }\n',
    );

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(true),
      executeBatch: vi.fn().mockResolvedValue([]),
      executeCypher: vi.fn().mockResolvedValue({ records: [] }),
      beginBulkMode: vi.fn(),
      endBulkMode: vi.fn(),
    } as any;

    const orchestrator = new GraphOrchestrator(memgraph, false);
    await orchestrator.build({
      mode: "full",
      workspaceRoot: root,
      sourceDir: "src",
      projectId: "2ph1",
    });

    expect(memgraph.executeBatch).toHaveBeenCalledTimes(2);

    // First call — nodes only (no relationship arrows)
    const nodesArg: Array<{ query: string }> = memgraph.executeBatch.mock.calls[0][0];
    for (const stmt of nodesArg) {
      expect(stmt.query).not.toMatch(/-\[.*\]->/);
    }

    // Second call — edges (all have MATCH or relationship arrows)
    const edgesArg: Array<{ query: string }> = memgraph.executeBatch.mock.calls[1][0];
    for (const stmt of edgesArg) {
      expect(stmt.query).toMatch(/MATCH|(-\[.*\]->)/);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("beginBulkMode/endBulkMode wrap both execution phases", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-bulk-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "hello.ts"),
      'export function hello(): string { return "hi"; }\n',
    );

    const callOrder: string[] = [];

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(true),
      executeBatch: vi.fn().mockImplementation(async () => {
        callOrder.push(callOrder.filter((c) => c.startsWith("batch")).length === 0 ? "batch1" : "batch2");
        return [];
      }),
      executeCypher: vi.fn().mockResolvedValue({ records: [] }),
      beginBulkMode: vi.fn().mockImplementation(() => {
        callOrder.push("begin");
      }),
      endBulkMode: vi.fn().mockImplementation(() => {
        callOrder.push("end");
      }),
    } as any;

    const orchestrator = new GraphOrchestrator(memgraph, false);
    await orchestrator.build({
      mode: "full",
      workspaceRoot: root,
      sourceDir: "src",
      projectId: "2ph2",
    });

    expect(callOrder).toEqual(["begin", "batch1", "batch2", "end"]);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("endBulkMode is called even if executeBatch throws", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-throw-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "hello.ts"),
      'export function hello(): string { return "hi"; }\n',
    );

    const memgraph = {
      isConnected: vi.fn().mockReturnValue(true),
      executeBatch: vi.fn().mockRejectedValue(new Error("batch boom")),
      executeCypher: vi.fn().mockResolvedValue({ records: [] }),
      beginBulkMode: vi.fn(),
      endBulkMode: vi.fn(),
    } as any;

    const orchestrator = new GraphOrchestrator(memgraph, false);

    try {
      await orchestrator.build({
        mode: "full",
        workspaceRoot: root,
        sourceDir: "src",
        projectId: "2ph3",
      });
    } catch {
      // expected — executeBatch throws
    }

    expect(memgraph.endBulkMode).toHaveBeenCalledTimes(1);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
