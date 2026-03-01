import { describe, expect, it } from "vitest";
import * as path from "node:path";
import { GraphBuilder } from "../builder.js";
import type { ParsedFile } from "../builder.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = "/workspace";

function makeFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: "/workspace/src/components/App.tsx",
    filePath: "/workspace/src/components/App.tsx",
    relativePath: "src/components/App.tsx",
    language: "TypeScript",
    LOC: 50,
    hash: "abc123",
    functions: [],
    classes: [],
    variables: [],
    imports: [],
    exports: [],
    ...overrides,
  };
}

function makeImport(source: string): {
  id: string;
  source: string;
  specifiers: string[];
  startLine: number;
  summary: null;
} {
  return {
    id: `import-${source}`,
    source,
    specifiers: [],
    startLine: 1,
    summary: null,
  };
}

function builder(projectId = "test-proj", workspaceRoot = WORKSPACE) {
  return new GraphBuilder(projectId, workspaceRoot, "tx-001", 1700000000000);
}

// ─── T15 — FILE.path must always be absolute ──────────────────────────────────

describe("GraphBuilder — FILE path normalization (A1 regression)", () => {
  it("T15: import target FILE.path is absolute even when resolvedPath is relative", () => {
    const workspaceRoot = "/workspace";
    const b = builder("proj", workspaceRoot);

    // File A imports from B using a relative source reference
    // The import source will resolve to src/lib/utils.ts (relative)
    const fileA = makeFile({
      path: "/workspace/src/components/App.tsx",
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      imports: [
        // This resolves to src/lib/utils.ts (relative to workspaceRoot)
        makeImport("../lib/utils"),
      ],
    } as any);

    const { nodes, edges } = b.buildFromParsedFile(fileA);
    const stmts = [...nodes, ...edges];

    // Find all FILE node MERGE statements that set targetFile.path
    const filePathStmts = stmts.filter(
      (s) => s.query.includes("targetFile:FILE") && s.params.absoluteTargetPath !== undefined,
    );

    for (const stmt of filePathStmts) {
      const p = stmt.params.absoluteTargetPath as string;
      expect(path.isAbsolute(p), `Expected absolute path but got: ${p}`).toBe(true);
      expect(p).toContain(workspaceRoot);
    }
  });

  it("T15b: createFileNode FILE.path is always the absolute filePath", () => {
    const b = builder("proj", "/workspace");
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
    });

    const { nodes: nodes2, edges: edges2 } = b.buildFromParsedFile(fileA);
    const stmts = [...nodes2, ...edges2];

    // The canonical FILE node (from createFileNode) must have absolute path
    const fileNodeStmt = stmts.find(
      (s) => s.query.includes("MERGE (f:FILE") && s.query.includes("f.path = $path"),
    )!;
    expect(fileNodeStmt).toBeDefined();
    expect(path.isAbsolute(fileNodeStmt.params.path as string)).toBe(true);
    expect(fileNodeStmt.params.path).toBe("/workspace/src/components/App.tsx");
  });

  it("T16: FILE.id for nested file contains full relative path", () => {
    const b = builder("proj", "/workspace");
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      imports: [makeImport("../controls/ArchitectureControls")],
    });

    const { nodes: nodes3, edges: edges3 } = b.buildFromParsedFile(fileA);
    const stmts = [...nodes3, ...edges3];

    // Find the stub FILE node created for the import target
    const stubStmt = stmts.find(
      (s) =>
        s.query.includes("targetFile:FILE") &&
        String(s.params.targetId || "").includes("ArchitectureControls"),
    );

    if (stubStmt) {
      const targetId = String(stubStmt.params.targetId);
      // Must include the full relative path (not just the basename)
      expect(targetId).toMatch(/controls\/ArchitectureControls/);
      expect(targetId).not.toMatch(/^proj:file:ArchitectureControls/);
    }
  });

  it("relativePath property in stub FILE is the original relative path", () => {
    const b = builder("proj", "/workspace");
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      imports: [makeImport("../lib/utils")],
    });

    const { nodes: nodes4, edges: edges4 } = b.buildFromParsedFile(fileA);
    const stmts = [...nodes4, ...edges4];

    const stubStmt = stmts.find(
      (s) => s.query.includes("targetFile:FILE") && s.params.relativePath !== undefined,
    );

    if (stubStmt) {
      const rel = stubStmt.params.relativePath as string;
      // relativePath must be relative (not start with /)
      expect(path.isAbsolute(rel)).toBe(false);
      expect(rel).toContain("utils");
    }
  });

  it("absolute and relative paths are consistent: resolve(workspaceRoot, relativePath) == absolutePath", () => {
    const workspaceRoot = "/workspace";
    const b = builder("proj", workspaceRoot);
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      imports: [makeImport("../lib/helper")],
    });

    const { nodes: nodes5, edges: edges5 } = b.buildFromParsedFile(fileA);
    const stmts = [...nodes5, ...edges5];

    const stubStmt = stmts.find(
      (s) => s.query.includes("targetFile:FILE") && s.params.absoluteTargetPath !== undefined,
    );

    if (stubStmt) {
      const absPath = stubStmt.params.absoluteTargetPath as string;
      const relPath = stubStmt.params.relativePath as string;
      expect(absPath).toBe(path.resolve(workspaceRoot, relPath));
    }
  });
});

describe("GraphBuilder — symbol filePath metadata", () => {
  it("sets FUNCTION.filePath to the parent file absolute path", () => {
    const b = builder("proj", "/workspace");
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      functions: [
        {
          id: "fn:app:render",
          name: "renderApp",
          parameters: [],
          async: false,
          line: 10,
          kind: "function",
          startLine: 10,
          endLine: 14,
          LOC: 5,
          isExported: true,
        },
      ] as any,
    });

    const { nodes: fnNodes, edges: fnEdges } = b.buildFromParsedFile(fileA);
    const stmts = [...fnNodes, ...fnEdges];
    const functionStmt = stmts.find(
      (s) =>
        s.query.includes("MERGE (func:FUNCTION") && s.query.includes("func.filePath = $filePath"),
    );

    expect(functionStmt).toBeDefined();
    expect(functionStmt!.params.filePath).toBe("/workspace/src/components/App.tsx");
  });

  it("sets CLASS.filePath to the parent file absolute path", () => {
    const b = builder("proj", "/workspace");
    const fileA = makeFile({
      filePath: "/workspace/src/components/App.tsx",
      relativePath: "src/components/App.tsx",
      classes: [
        {
          id: "class:AppController",
          name: "AppController",
          methods: [],
          properties: [],
          line: 20,
          kind: "class",
          startLine: 20,
          endLine: 30,
          LOC: 11,
          isExported: true,
        },
      ] as any,
    });

    const { nodes: clsNodes, edges: clsEdges } = b.buildFromParsedFile(fileA);
    const stmts = [...clsNodes, ...clsEdges];
    const classStmt = stmts.find(
      (s) => s.query.includes("MERGE (cls:CLASS") && s.query.includes("cls.filePath = $filePath"),
    );

    expect(classStmt).toBeDefined();
    expect(classStmt!.params.filePath).toBe("/workspace/src/components/App.tsx");
  });
});

describe("GraphBuilder — two-phase BuildResult structure", () => {
  // Test 1: buildFromParsedFile returns { nodes, edges }
  it("returns BuildResult with nodes and edges arrays", () => {
    const b = builder("proj", "/workspace");
    const file = makeFile({
      functions: [
        {
          name: "fn1",
          parameters: [],
          async: false,
          line: 1,
          kind: "function",
          startLine: 1,
          endLine: 5,
          LOC: 5,
        },
      ],
      classes: [
        {
          id: "class:C1",
          name: "C1",
          methods: [],
          properties: [],
          line: 10,
          kind: "class",
          startLine: 10,
          endLine: 20,
          LOC: 11,
        },
      ],
    } as any);
    const result = b.buildFromParsedFile(file);
    expect(result).toHaveProperty("nodes");
    expect(result).toHaveProperty("edges");
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(Array.isArray(result.edges)).toBe(true);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.edges.length).toBeGreaterThan(0);
  });

  // Test 2: nodes array contains no MATCH-dependent relationship statements
  it("nodes array contains no MATCH-then-MERGE-edge patterns", () => {
    const b = builder("proj", "/workspace");
    const file = makeFile({
      functions: [
        {
          name: "fn1",
          parameters: [],
          async: false,
          line: 1,
          kind: "function",
          startLine: 1,
          endLine: 5,
          LOC: 5,
        },
      ],
      imports: [makeImport("./utils")],
    } as any);
    const { nodes } = b.buildFromParsedFile(file);
    for (const stmt of nodes) {
      // No node statement should contain "MATCH" followed by a relationship arrow
      const hasMatchEdge = /MATCH.*MERGE.*-\[.*\]->/.test(stmt.query);
      expect(
        hasMatchEdge,
        `Node statement should not have MATCH+edge pattern: ${stmt.query.trim().slice(0, 80)}`,
      ).toBe(false);
    }
  });

  // Test 3: edges array contains no bare MERGE-only node creation (except stubs in combined statements)
  it("edges array statements all involve relationships or property updates", () => {
    const b = builder("proj", "/workspace");
    const file = makeFile({
      functions: [
        {
          name: "fn1",
          parameters: [],
          async: false,
          line: 1,
          kind: "function",
          startLine: 1,
          endLine: 5,
          LOC: 5,
        },
      ],
      classes: [
        {
          id: "class:C1",
          name: "C1",
          methods: [],
          properties: [],
          line: 10,
          kind: "class",
          startLine: 10,
          endLine: 20,
          LOC: 11,
        },
      ],
      variables: [{ name: "v1", type: "string", startLine: 25, endLine: 25 }],
    } as any);
    const { edges } = b.buildFromParsedFile(file);
    for (const stmt of edges) {
      // Every edge statement must contain at least MATCH (depends on existing node)
      // or a relationship arrow pattern -[:REL]->
      const hasMatch = stmt.query.includes("MATCH");
      const hasRelArrow = /\-\[.*\]\->/.test(stmt.query);
      const hasSET = stmt.query.includes("SET");
      expect(
        hasMatch || hasRelArrow || hasSET,
        `Edge statement should involve MATCH, relationship, or SET: ${stmt.query.trim().slice(0, 80)}`,
      ).toBe(true);
    }
  });

  // Test 4: node + edge count equals total from backward-compat getter
  it("nodes.length + edges.length equals total statement count", () => {
    const b = builder("proj", "/workspace");
    const file = makeFile({
      functions: [
        {
          name: "fn1",
          parameters: [],
          async: false,
          line: 1,
          kind: "function",
          startLine: 1,
          endLine: 5,
          LOC: 5,
          isExported: true,
        },
      ],
      classes: [
        {
          id: "class:C1",
          name: "C1",
          methods: [],
          properties: [],
          line: 10,
          kind: "class",
          startLine: 10,
          endLine: 20,
          LOC: 11,
          extends: "Base",
          implements: ["Iface1"],
        },
      ],
      variables: [{ name: "v1", type: "string", startLine: 25, endLine: 25 }],
      imports: [makeImport("./utils")],
      exports: [{ name: "fn1", type: "function" }],
    } as any);
    const result = b.buildFromParsedFile(file);
    const totalFromResult = result.nodes.length + result.edges.length;
    // Verify it's a reasonable number (at least: 1 file + 1 func + 1 class + 1 var + 1 import + 1 export = 6 nodes minimum)
    expect(totalFromResult).toBeGreaterThanOrEqual(12);
    // The deprecated getter should return the same total
    expect((b as any).statements.length).toBe(totalFromResult);
  });
});
