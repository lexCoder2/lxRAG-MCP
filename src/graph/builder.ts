// Local type definitions (avoid importing from typescript-parser which has dependencies)
export interface ParsedFile {
  path: string;
  filePath: string;
  relativePath?: string;
  language?: string;
  LOC?: number;
  hash?: string;
  summary?: string;
  imports: Array<{ source: string; specifiers: string[]; summary?: string }>;
  exports: Array<{ name: string; type: string }>;
  functions: FunctionNode[];
  classes: ClassNode[];
  variables?: any[];
  testSuites?: Array<{
    id: string;
    name: string;
    type: "describe" | "test" | "it";
    startLine: number;
    endLine?: number;
    category?: "unit" | "integration" | "performance" | "e2e";
    filePath?: string;
  }>;
}

interface FunctionNode {
  name: string;
  parameters: Array<{ name: string; type?: string }>;
  returnType?: string;
  async: boolean;
  line: number;
  id?: string;
  kind?: string;
  startLine?: number;
  endLine?: number;
  LOC?: number;
  isExported?: boolean;
  summary?: string;
}

interface ClassNode {
  id: string;
  name: string;
  methods: Array<{ name: string; parameters: any[]; returnType?: string }>;
  properties: Array<{ name: string; type?: string }>;
  line: number;
  implements?: string[];
  kind?: string;
  startLine?: number;
  endLine?: number;
  LOC?: number;
  extends?: string;
  isExported?: boolean;
  summary?: string;
}

import * as path from "path";
import { existsSync } from "fs";

export interface CypherStatement {
  query: string;
  params: Record<string, any>;
}

export class GraphBuilder {
  private statements: CypherStatement[] = [];
  private processedNodes = new Set<string>();
  private projectId: string;
  private workspaceRoot: string;
  private txId: string;
  private txTimestamp: number;

  constructor(
    projectId?: string,
    workspaceRoot?: string,
    txId?: string,
    txTimestamp?: number,
  ) {
    this.workspaceRoot =
      workspaceRoot || process.env.CODE_GRAPH_WORKSPACE_ROOT || process.cwd();
    this.projectId =
      projectId ||
      process.env.CODE_GRAPH_PROJECT_ID ||
      path.basename(this.workspaceRoot);
    this.txId = txId || process.env.CODE_GRAPH_TX_ID || `tx-${Date.now()}`;
    this.txTimestamp = txTimestamp || Date.now();
  }

  private scopedId(rawId: string): string {
    return `${this.projectId}:${rawId}`;
  }

  private fileNodeId(parsedFile: ParsedFile): string {
    const relativePath =
      parsedFile.relativePath ||
      path.relative(this.workspaceRoot, parsedFile.filePath);
    return this.scopedId(`file:${relativePath}`);
  }

  private fileNodeIdFromRelative(relativePath: string): string {
    return this.scopedId(`file:${relativePath}`);
  }

  private folderNodeId(folderPath: string): string {
    return this.scopedId(`folder:${folderPath}`);
  }

  buildFromParsedFile(parsedFile: ParsedFile): CypherStatement[] {
    this.statements = [];
    this.processedNodes.clear();

    // Create FILE node
    this.createFileNode(parsedFile);

    // Create FUNCTION nodes and relationships
    parsedFile.functions.forEach((fn) =>
      this.createFunctionNode(fn, parsedFile),
    );

    // Create CLASS nodes and relationships
    parsedFile.classes.forEach((cls) => this.createClassNode(cls, parsedFile));

    // Create VARIABLE nodes
    parsedFile.variables?.forEach((variable) =>
      this.createVariableNode(variable, parsedFile),
    );

    // Create IMPORT nodes and relationships
    parsedFile.imports?.forEach((imp) =>
      this.createImportNode(imp, parsedFile),
    );

    // Create EXPORT nodes
    parsedFile.exports?.forEach((exp) =>
      this.createExportNode(exp, parsedFile),
    );

    // Create TEST_SUITE nodes (if this is a test file)
    this.buildTestNodes(parsedFile);

    return this.statements;
  }

  private createFileNode(parsedFile: ParsedFile): void {
    const relativePath =
      parsedFile.relativePath ||
      path.relative(this.workspaceRoot, parsedFile.filePath);
    const nodeId = this.fileNodeId(parsedFile);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    const statement: CypherStatement = {
      query: `
        MERGE (f:FILE {id: $id})
        SET f.name = $name,
            f.path = $path,
            f.language = $language,
            f.LOC = $LOC,
          f.summary = $summary,
            f.hash = $hash,
            f.relativePath = $relativePath,
            f.projectId = $projectId,
          f.validFrom = $validFrom,
          f.validTo = $validTo,
          f.createdAt = $createdAt,
          f.txId = $txId,
            f.lastModified = datetime()
      `,
      params: {
        id: nodeId,
        path: parsedFile.filePath,
        name: path.basename(parsedFile.filePath),
        language: parsedFile.language || "TypeScript",
        LOC: parsedFile.LOC || 0,
        summary: parsedFile.summary || null,
        hash: parsedFile.hash || "",
        relativePath: relativePath,
        projectId: this.projectId,
        validFrom: this.txTimestamp,
        validTo: null,
        createdAt: this.txTimestamp,
        txId: this.txId,
      },
    };
    this.statements.push(statement);

    // Create folder hierarchy
    const folderPath = path.dirname(parsedFile.filePath);
    this.createFolderHierarchy(folderPath);

    // Connect FILE to FOLDER
    this.statements.push({
      query: `
        MATCH (f:FILE {id: $fileId})
        MERGE (folder:FOLDER {id: $folderId})
        SET folder.path = $folderPath,
            folder.projectId = $projectId
        MERGE (folder)-[:CONTAINS]->(f)
      `,
      params: {
        fileId: nodeId,
        folderId: this.folderNodeId(folderPath),
        folderPath,
        projectId: this.projectId,
      },
    });
  }

  private createFolderHierarchy(folderPath: string): void {
    const nodeId = this.folderNodeId(folderPath);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (folder:FOLDER {id: $id})
        SET folder.name = $name,
            folder.path = $path,
            folder.projectId = $projectId
      `,
      params: {
        id: nodeId,
        path: folderPath,
        name: path.basename(folderPath),
        projectId: this.projectId,
      },
    });

    const parentPath = path.dirname(folderPath);
    if (parentPath !== folderPath) {
      this.createFolderHierarchy(parentPath);

      // Connect parent to child
      this.statements.push({
        query: `
          MATCH (parent:FOLDER {id: $parentId})
          MATCH (child:FOLDER {id: $childId})
          MERGE (parent)-[:CONTAINS]->(child)
        `,
        params: {
          parentId: this.folderNodeId(parentPath),
          childId: this.folderNodeId(folderPath),
        },
      });
    }
  }

  private createFunctionNode(fn: FunctionNode, parsedFile: ParsedFile): void {
    const nodeId = this.scopedId(
      fn.id || `func:${parsedFile.relativePath}:${fn.name}:${fn.line}`,
    );
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (func:FUNCTION {id: $id})
        SET func.name = $name,
            func.kind = $kind,
            func.startLine = $startLine,
            func.endLine = $endLine,
            func.LOC = $LOC,
          func.summary = $summary,
            func.parameters = $parameters,
          func.validFrom = $validFrom,
          func.validTo = $validTo,
          func.createdAt = $createdAt,
          func.txId = $txId,
            func.projectId = $projectId
      `,
      params: {
        id: nodeId,
        name: fn.name,
        kind: fn.kind || "function",
        startLine: fn.startLine || fn.line || 0,
        endLine: fn.endLine || fn.line || 0,
        LOC: fn.LOC || 1,
        summary: fn.summary || null,
        // Memgraph only supports lists of primitives as properties; serialize objects to JSON string
        parameters: JSON.stringify(fn.parameters),
        validFrom: this.txTimestamp,
        validTo: null,
        createdAt: this.txTimestamp,
        txId: this.txId,
        projectId: this.projectId,
      },
    });

    // Connect function to file
    this.statements.push({
      query: `
        MATCH (func:FUNCTION {id: $funcId})
        MATCH (f:FILE {id: $fileId})
        MERGE (f)-[:CONTAINS]->(func)
      `,
      params: {
        funcId: nodeId,
        fileId: this.fileNodeId(parsedFile),
      },
    });

    // Tag as exported if applicable
    if (fn.isExported) {
      this.statements.push({
        query: `
          MATCH (func:FUNCTION {id: $id})
          SET func.isExported = true
        `,
        params: { id: nodeId },
      });
    }
  }

  private createClassNode(cls: ClassNode, parsedFile: ParsedFile): void {
    const nodeId = this.scopedId(cls.id);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (cls:CLASS {id: $id})
        SET cls.name = $name,
            cls.kind = $kind,
            cls.startLine = $startLine,
            cls.endLine = $endLine,
            cls.LOC = $LOC,
          cls.summary = $summary,
          cls.validFrom = $validFrom,
          cls.validTo = $validTo,
          cls.createdAt = $createdAt,
          cls.txId = $txId,
            cls.projectId = $projectId
      `,
      params: {
        id: nodeId,
        name: cls.name,
        kind: cls.kind || "class",
        startLine: cls.startLine || cls.line,
        endLine: cls.endLine || cls.line,
        LOC: cls.LOC || 1,
        summary: cls.summary || null,
        validFrom: this.txTimestamp,
        validTo: null,
        createdAt: this.txTimestamp,
        txId: this.txId,
        projectId: this.projectId,
      },
    });

    // Connect class to file
    this.statements.push({
      query: `
        MATCH (cls:CLASS {id: $classId})
        MATCH (f:FILE {id: $fileId})
        MERGE (f)-[:CONTAINS]->(cls)
      `,
      params: {
        classId: nodeId,
        fileId: this.fileNodeId(parsedFile),
      },
    });

    // Handle inheritance
    if (cls.extends) {
      this.statements.push({
        query: `
          MATCH (cls:CLASS {id: $classId})
          MERGE (parent:CLASS {id: $parentId})
          SET parent.name = $parentName,
              parent.projectId = $projectId
          MERGE (cls)-[:EXTENDS]->(parent)
        `,
        params: {
          classId: nodeId,
          parentId: this.scopedId(`class:${cls.extends.split("<")[0].trim()}`),
          parentName: cls.extends.split("<")[0].trim(),
          projectId: this.projectId,
        },
      });
    }

    // Handle implementations
    if (cls.implements) {
      cls.implements.forEach((impl) => {
        this.statements.push({
          query: `
            MATCH (cls:CLASS {id: $classId})
            MERGE (iface:CLASS {id: $ifaceId})
            SET iface.name = $implName,
                iface.projectId = $projectId
            MERGE (cls)-[:IMPLEMENTS]->(iface)
          `,
          params: {
            classId: nodeId,
            ifaceId: this.scopedId(`class:${impl.trim()}`),
            implName: impl.trim(),
            projectId: this.projectId,
          },
        });
      });
    }

    if (cls.isExported) {
      this.statements.push({
        query: `
          MATCH (cls:CLASS {id: $id})
          SET cls.isExported = true
        `,
        params: { id: nodeId },
      });
    }
  }

  private createVariableNode(variable: any, parsedFile: ParsedFile): void {
    const nodeId = this.scopedId(variable.id);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (var:VARIABLE {id: $id})
        SET var.name = $name,
            var.kind = $kind,
            var.startLine = $startLine,
            var.type = $type,
            var.projectId = $projectId
      `,
      params: {
        id: nodeId,
        name: variable.name,
        kind: variable.kind,
        startLine: variable.startLine,
        type: variable.type || null,
        projectId: this.projectId,
      },
    });

    // Connect to file
    this.statements.push({
      query: `
        MATCH (var:VARIABLE {id: $varId})
        MATCH (f:FILE {id: $fileId})
        MERGE (f)-[:CONTAINS]->(var)
      `,
      params: {
        varId: nodeId,
        fileId: this.fileNodeId(parsedFile),
      },
    });
  }

  private createImportNode(imp: any, parsedFile: ParsedFile): void {
    const nodeId = this.scopedId(imp.id);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (imp:IMPORT {id: $id})
        SET imp.source = $source,
            imp.specifiers = $specifiers,
            imp.startLine = $startLine,
          imp.summary = $summary,
          imp.validFrom = $validFrom,
          imp.validTo = $validTo,
          imp.createdAt = $createdAt,
          imp.txId = $txId,
            imp.projectId = $projectId
      `,
      params: {
        id: nodeId,
        source: imp.source,
        specifiers: imp.specifiers,
        startLine: imp.startLine,
        summary: imp.summary || null,
        validFrom: this.txTimestamp,
        validTo: null,
        createdAt: this.txTimestamp,
        txId: this.txId,
        projectId: this.projectId,
      },
    });

    // Connect to file
    this.statements.push({
      query: `
        MATCH (imp:IMPORT {id: $impId})
        MATCH (f:FILE {id: $fileId})
        MERGE (f)-[:IMPORTS]->(imp)
      `,
      params: {
        impId: nodeId,
        fileId: this.fileNodeId(parsedFile),
      },
    });

    // Try to resolve the imported module
    const resolvedPath = this.resolveImportPath(
      imp.source,
      path.dirname(parsedFile.filePath),
    );
    if (resolvedPath) {
      this.statements.push({
        query: `
          MATCH (imp:IMPORT {id: $impId})
          MERGE (targetFile:FILE {id: $targetId})
          SET targetFile.path = $targetPath,
              targetFile.relativePath = $targetPath,
              targetFile.projectId = $projectId
          MERGE (imp)-[:REFERENCES]->(targetFile)
        `,
        params: {
          impId: nodeId,
          targetId: this.fileNodeIdFromRelative(resolvedPath),
          targetPath: resolvedPath,
          projectId: this.projectId,
        },
      });
    }
  }

  private createExportNode(exp: any, parsedFile: ParsedFile): void {
    const nodeId = this.scopedId(exp.id);
    if (this.processedNodes.has(nodeId)) return;
    this.processedNodes.add(nodeId);

    this.statements.push({
      query: `
        MERGE (exp:EXPORT {id: $id})
        SET exp.name = $name,
            exp.isDefault = $isDefault,
            exp.startLine = $startLine,
            exp.projectId = $projectId
      `,
      params: {
        id: nodeId,
        name: exp.name,
        isDefault: exp.isDefault,
        startLine: exp.startLine,
        projectId: this.projectId,
      },
    });

    // Connect to file
    this.statements.push({
      query: `
        MATCH (exp:EXPORT {id: $expId})
        MATCH (f:FILE {id: $fileId})
        MERGE (f)-[:EXPORTS]->(exp)
      `,
      params: {
        expId: nodeId,
        fileId: this.fileNodeId(parsedFile),
      },
    });
  }

  private buildTestNodes(parsedFile: ParsedFile): void {
    const testSuites = parsedFile.testSuites || [];
    if (testSuites.length === 0) return;

    const relativePath =
      parsedFile.relativePath ||
      path.relative(this.workspaceRoot, parsedFile.filePath);

    // Create TEST_SUITE nodes
    testSuites.forEach((suite) => {
      const nodeId = this.scopedId(`test_suite:${suite.id}`);
      if (this.processedNodes.has(nodeId)) return;
      this.processedNodes.add(nodeId);

      // Create TEST_SUITE node
      this.statements.push({
        query: `
          MERGE (ts:TEST_SUITE {id: $id})
          SET ts.name = $name,
              ts.type = $type,
              ts.category = $category,
              ts.startLine = $startLine,
              ts.endLine = $endLine,
              ts.filePath = $filePath,
              ts.projectId = $projectId
        `,
        params: {
          id: nodeId,
          name: suite.name,
          type: suite.type,
          category: suite.category || "unit",
          startLine: suite.startLine,
          endLine: suite.endLine || suite.startLine,
          filePath: relativePath,
          projectId: this.projectId,
        },
      });

      // Create FILE -[:CONTAINS]-> TEST_SUITE relationship
      this.statements.push({
        query: `
          MATCH (f:FILE {id: $fileId})
          MATCH (ts:TEST_SUITE {id: $testSuiteId})
          MERGE (f)-[:CONTAINS]->(ts)
        `,
        params: {
          fileId: this.fileNodeId(parsedFile),
          testSuiteId: nodeId,
        },
      });
    });
  }

  private resolveImportPath(source: string, fromDir: string): string | null {
    if (!source.startsWith(".")) return null; // skip node_modules / bare specifiers
    const base = path.resolve(fromDir, source);
    const candidates = [
      base + ".ts",
      base + ".tsx",
      path.join(base, "index.ts"),
      path.join(base, "index.tsx"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return path.relative(this.workspaceRoot, candidate).replace(/\\/g, "/");
      }
    }
    return null;
  }
}

export default GraphBuilder;
