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

    const stmts = b.buildFromParsedFile(fileA);

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

    const stmts = b.buildFromParsedFile(fileA);

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

    const stmts = b.buildFromParsedFile(fileA);

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

    const stmts = b.buildFromParsedFile(fileA);

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

    const stmts = b.buildFromParsedFile(fileA);

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

    const stmts = b.buildFromParsedFile(fileA);
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

    const stmts = b.buildFromParsedFile(fileA);
    const classStmt = stmts.find(
      (s) => s.query.includes("MERGE (cls:CLASS") && s.query.includes("cls.filePath = $filePath"),
    );

    expect(classStmt).toBeDefined();
    expect(classStmt!.params.filePath).toBe("/workspace/src/components/App.tsx");
  });
});
