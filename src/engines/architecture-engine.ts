/**
 * @file engines/architecture-engine
 * @description Validates source dependencies against configured architecture layers and rules.
 * @remarks Supports filesystem scanning and explicit file-list validation modes.
 */

import * as path from "path";
import * as fs from "fs";
import { globSync } from "glob";
import type { GraphIndexManager } from "../graph/index.js";
import type { MemgraphClient } from "../graph/client.js";
import type { CypherStatement } from "../graph/types.js";
import { logger } from "../utils/logger.js";

export interface LayerDefinition {
  id: string;
  name: string;
  paths: string[];
  canImport: string[];
  cannotImport?: string[];
  description: string;
}

export interface ArchitectureRule {
  id: string;
  severity: "error" | "warn";
  pattern: string;
  description: string;
}

export interface ValidationViolation {
  type: "layer-violation" | "rule-violation" | "unused" | "circular";
  severity: "error" | "warn";
  file: string;
  layer: string;
  message: string;
  suggestion?: string;
  lineNumber?: number;
}

export interface ValidationResult {
  success: boolean;
  violations: ValidationViolation[];
  statistics: {
    totalViolations: number;
    errorCount: number;
    warningCount: number;
    filesChecked: number;
  };
}

export class ArchitectureEngine {
  private layers: Map<string, LayerDefinition>;
  private rules: ArchitectureRule[];
  private workspaceRoot: string;
  /** Glob patterns used to discover source files (e.g. for validation/circular-dep scan). */
  private sourceGlobs: string[];
  /** Default file extension used when generating suggested paths. */
  private defaultExtension: string;

  constructor(
    layers: LayerDefinition[],
    rules: ArchitectureRule[],
    _index: GraphIndexManager,
    workspaceRoot?: string,
    options?: {
      /** Override the glob patterns used to scan source files. Defaults to ["src/**\/*.{ts,tsx}"]. */
      sourceGlobs?: string[];
      /** Default extension for generated file paths. Defaults to ".ts". */
      defaultExtension?: string;
    },
  ) {
    this.layers = new Map(layers.map((l) => [l.id, l]));
    this.rules = rules;
    this.workspaceRoot = workspaceRoot ?? process.cwd();
    this.sourceGlobs = options?.sourceGlobs ?? ["src/**/*.{ts,tsx}"];
    this.defaultExtension = options?.defaultExtension ?? ".ts";
  }

  /**
   * Validate architecture of all files by scanning file system
   */
  async validate(files?: string[]): Promise<ValidationResult> {
    const violations: ValidationViolation[] = [];
    const projectRoot = this.workspaceRoot;

    // Get source files to validate
    let filesToCheck: string[];
    if (files && files.length > 0) {
      filesToCheck = files;
    } else {
      // Scan source files using configured globs (language-agnostic)
      filesToCheck = this.sourceGlobs.flatMap((pattern) =>
        globSync(pattern, {
          cwd: projectRoot,
          ignore: [
            "**/node_modules/**",
            "**/*.test.*",
            "**/*.spec.*",
            "**/test_*.py",
            "**/*_test.go",
            "**/*_spec.rb",
          ],
        }),
      );
    }

    for (const filePath of filesToCheck) {
      const layer = this.determineLayer(filePath);

      if (!layer) {
        violations.push({
          type: "rule-violation",
          severity: "warn",
          file: filePath,
          layer: "unknown",
          message: `File not assigned to any layer: ${filePath}`,
          suggestion: "Update .lxdig/config.json with appropriate layer path pattern",
        });
        continue;
      }

      // Extract imports from file
      const imports = this.extractImportsFromFile(path.join(projectRoot, filePath));

      for (const imp of imports) {
        // Skip external imports
        if (imp.startsWith("@") || (imp.startsWith(".") === false && !imp.startsWith("src"))) {
          continue;
        }

        // Resolve imported file
        const importedPath = this.resolveImportPath(filePath, imp, projectRoot);
        if (!importedPath) continue;

        const importedLayer = this.determineLayer(importedPath);
        if (!importedLayer) continue;

        // Check if import is allowed
        if (!this.isImportAllowed(layer, importedLayer)) {
          violations.push({
            type: "layer-violation",
            severity: "error",
            file: filePath,
            layer: layer.id,
            message: `Layer '${layer.id}' cannot import from layer '${importedLayer.id}'`,
            suggestion: `Check your imports in ${filePath}. Layer rules: ${layer.id} can import ${layer.canImport.join(", ")}`,
          });
        }

        // Check forbidden imports
        if (layer.cannotImport && this.isForbiddenImport(layer, importedLayer)) {
          violations.push({
            type: "layer-violation",
            severity: "error",
            file: filePath,
            layer: layer.id,
            message: `Layer '${layer.id}' cannot import from layer '${importedLayer.id}' (explicitly forbidden)`,
            suggestion: `Remove import of ${importedPath} from ${filePath}`,
          });
        }
      }
    }

    // Check for circular dependencies
    const circularViolations = this.detectCircularDependencies();
    violations.push(...circularViolations);

    const errorCount = violations.filter((v) => v.severity === "error").length;
    const warningCount = violations.filter((v) => v.severity === "warn").length;

    return {
      success: errorCount === 0,
      violations,
      statistics: {
        totalViolations: violations.length,
        errorCount,
        warningCount,
        filesChecked: filesToCheck.length,
      },
    };
  }

  /**
   * Determine which layer a file belongs to
   */
  private determineLayer(filePath: string): LayerDefinition | null {
    for (const layer of this.layers.values()) {
      for (const pattern of layer.paths) {
        if (this.matchesPattern(filePath, pattern)) {
          return layer;
        }
      }
    }
    return null;
  }

  /**
   * Check if pattern matches file path
   */
  private matchesPattern(filePath: string, pattern: string): boolean {
    // Simple glob-like matching
    // Example: "src/components/**" matches "src/components/Button.tsx"
    // Example: "src/types/**" matches "src/types/building.types.ts"

    const patternRegex = pattern
      .replace(/\//g, "/")
      .replace(/\*\*/g, "__DOUBLE_STAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".")
      .replace(/__DOUBLE_STAR__/g, ".*");

    const regex = new RegExp(`^${patternRegex}$`);
    return regex.test(filePath);
  }

  /**
   * Extract import statements from a source file.
   * Dispatches to language-specific logic based on the file extension.
   * Supported: TypeScript/JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs),
   * Python (.py), Ruby (.rb), Go (.go).
   */
  private extractImportsFromFile(filePath: string): string[] {
    const ext = path.extname(filePath).toLowerCase();
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const imports: Set<string> = new Set();

      if (
        ext === ".ts" ||
        ext === ".tsx" ||
        ext === ".js" ||
        ext === ".jsx" ||
        ext === ".mjs" ||
        ext === ".cjs"
      ) {
        // ES module: import/export ... from '...'
        const importRegex = /(?:import|export)\s+(?:[^"']*\s+)?from\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          imports.add(match[1]);
        }
      } else if (ext === ".py") {
        // Python: from module.path import ... / import module.path
        const fromRegex = /^from\s+([\w.]+)\s+import\s+/gm;
        const importRegex = /^import\s+([\w.]+)/gm;
        let match;
        while ((match = fromRegex.exec(content)) !== null) {
          // Convert dotted module path to slash-separated path
          imports.add(match[1].replace(/\./g, "/"));
        }
        while ((match = importRegex.exec(content)) !== null) {
          imports.add(match[1].replace(/\./g, "/"));
        }
      } else if (ext === ".rb") {
        // Ruby: require 'path' / require_relative 'path'
        const reqRegex = /require(?:_relative)?\s+['"]([^'"]+)['"]/g;
        let match;
        while ((match = reqRegex.exec(content)) !== null) {
          imports.add(match[1]);
        }
      } else if (ext === ".go") {
        // Go: import "path" (single or block)
        const blockRegex = /import\s*\(([\s\S]*?)\)/g;
        const singleRegex = /import\s+"([^"]+)"/g;
        let match;
        while ((match = blockRegex.exec(content)) !== null) {
          const block = match[1];
          const lineRegex = /"([^"]+)"/g;
          let lineMatch;
          while ((lineMatch = lineRegex.exec(block)) !== null) {
            imports.add(lineMatch[1]);
          }
        }
        while ((match = singleRegex.exec(content)) !== null) {
          imports.add(match[1]);
        }
      }

      return Array.from(imports);
    } catch {
      return [];
    }
  }

  /**
   * Resolve import path to actual file (with .ts, .tsx, /index extensions)
   */
  private resolveImportPath(
    fromPath: string,
    importPath: string,
    projectRoot: string,
  ): string | null {
    let resolvedPath: string;

    if (importPath.startsWith(".")) {
      // Relative import: resolve from importing file's directory within projectRoot.
      // path.join(projectRoot, fromPath) gives an absolute base so that
      // path.resolve() anchors to projectRoot instead of process.cwd().
      const absoluteFromDir = path.dirname(path.join(projectRoot, fromPath));
      resolvedPath = path.resolve(absoluteFromDir, importPath);
    } else if (importPath.startsWith("src/")) {
      // Absolute src import
      resolvedPath = importPath;
    } else {
      // External import, skip
      return null;
    }

    // Normalize to project-relative path
    let relPath = path.relative(projectRoot, resolvedPath).replace(/\\/g, "/");
    if (!relPath.startsWith("src/")) {
      relPath = path.relative(projectRoot, resolvedPath).replace(/\\/g, "/");
    }

    // Try different extensions based on the source file's language
    const fromExt = path.extname(fromPath).toLowerCase();
    let candidates: string[];
    if (fromExt === ".py") {
      candidates = [relPath, `${relPath}.py`, `${relPath}/__init__.py`];
    } else if (fromExt === ".rb") {
      candidates = [relPath, `${relPath}.rb`];
    } else if (fromExt === ".go") {
      candidates = [relPath];
    } else {
      // JS/TS (default)
      candidates = [
        relPath,
        `${relPath}.ts`,
        `${relPath}.tsx`,
        `${relPath}/index.ts`,
        `${relPath}/index.tsx`,
      ];
    }

    for (const candidate of candidates) {
      const fullPath = path.join(projectRoot, candidate);
      if (fs.existsSync(fullPath)) {
        return candidate;
      }
    }

    // Return best guess if file doesn't exist yet (use source extension or configured default)
    const fromExt2 = path.extname(fromPath).toLowerCase();
    const bestExt = fromExt2 || this.defaultExtension;
    if (relPath.includes(".")) return relPath;
    return relPath.endsWith(bestExt) ? relPath : `${relPath}${bestExt}`;
  }

  /**
   * Check if import from one layer to another is allowed
   */
  private isImportAllowed(fromLayer: LayerDefinition, toLayer: LayerDefinition): boolean {
    // Can always import from same layer
    if (fromLayer.id === toLayer.id) {
      return true;
    }

    // Check canImport list
    if (fromLayer.canImport.includes("*")) {
      return true; // Can import anything
    }

    return fromLayer.canImport.includes(toLayer.id);
  }

  /**
   * Check if import is explicitly forbidden
   */
  private isForbiddenImport(fromLayer: LayerDefinition, toLayer: LayerDefinition): boolean {
    if (!fromLayer.cannotImport) {
      return false;
    }
    return fromLayer.cannotImport.includes(toLayer.id);
  }

  /**
   * Detect circular dependencies using DFS
   */
  private detectCircularDependencies(): ValidationViolation[] {
    const violations: ValidationViolation[] = [];
    const projectRoot = this.workspaceRoot;
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    // Build import graph
    const importGraph = new Map<string, string[]>();
    const sourceFiles = this.sourceGlobs.flatMap((pattern) =>
      globSync(pattern, {
        cwd: projectRoot,
        ignore: [
          "**/node_modules/**",
          "**/*.test.*",
          "**/*.spec.*",
          "**/test_*.py",
          "**/*_test.go",
          "**/*_spec.rb",
        ],
      }),
    );

    for (const file of sourceFiles) {
      const imports = this.extractImportsFromFile(path.join(projectRoot, file));
      const resolvedImports: string[] = [];

      for (const imp of imports) {
        if (imp.startsWith(".") || imp.startsWith("src/")) {
          const resolved = this.resolveImportPath(file, imp, projectRoot);
          if (resolved) {
            resolvedImports.push(resolved);
          }
        }
      }

      importGraph.set(file, resolvedImports);
    }

    // DFS to detect cycles
    const dfs = (node: string, currentPath: string[]): void => {
      // Check for cycle BEFORE adding to path
      const cycleStart = currentPath.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push([...currentPath.slice(cycleStart), node]);
        return;
      }

      if (visited.has(node)) return;

      visited.add(node);
      recursionStack.add(node);
      currentPath.push(node);

      const neighbors = importGraph.get(node) || [];
      for (const neighbor of neighbors) {
        dfs(neighbor, currentPath);
      }

      currentPath.pop();
      recursionStack.delete(node);
      visited.delete(node); // allow revisiting via different paths for cycle detection
    };

    // Run DFS from each unvisited node
    for (const file of sourceFiles) {
      if (!visited.has(file)) {
        dfs(file, []);
      }
    }

    // Report unique cycles (limit to first 10 to avoid spam)
    const reportedCycles = new Set<string>();
    for (const cycle of cycles) {
      if (reportedCycles.size >= 10) break;
      const cycleKey = cycle.join(" -> ");
      if (!reportedCycles.has(cycleKey)) {
        reportedCycles.add(cycleKey);
        violations.push({
          type: "circular",
          severity: "warn",
          file: cycle[0],
          layer: this.determineLayer(cycle[0])?.id || "unknown",
          message: `Circular dependency detected: ${cycle.slice(0, 3).join(" -> ")}...`,
          suggestion: "Break the circular dependency by moving code to a shared utility module",
        });
      }
    }

    return violations;
  }

  /**
   * Get suggestion for placing new code.
   *
   * Layer selection strategy:
   * 1. Filter to layers that can import from all dependency layer IDs.
   *    External package names (e.g. "react", "zustand") are not layer IDs and
   *    are skipped; they do not constrain layer selection.
   * 2. Among eligible layers, rank by affinity with codeType to pick the
   *    semantically best match (e.g. "service" → services/lib layer, not types).
   */
  getSuggestion(
    codeName: string,
    codeType: string,
    dependencies: string[],
  ): {
    suggestedLayer: LayerDefinition;
    suggestedPath: string;
    reasoning: string;
  } | null {
    // Only use deps that are recognized layer IDs; external packages are ignored
    const layerDeps = dependencies.filter((dep) => this.layers.has(dep));

    // Find all layers that can import from every required layer dependency
    const eligibleLayers: LayerDefinition[] = [];
    for (const layer of this.layers.values()) {
      let canImportAll = true;
      for (const dep of layerDeps) {
        const depLayer = this.layers.get(dep)!;
        if (!this.isImportAllowed(layer, depLayer)) {
          canImportAll = false;
          break;
        }
      }
      if (canImportAll) {
        eligibleLayers.push(layer);
      }
    }

    if (eligibleLayers.length === 0) {
      return null;
    }

    // Rank eligible layers by codeType affinity (higher-priority terms first)
    const affinityMap: Record<string, string[]> = {
      component: ["component", "ui", "view", "page", "widget", "presentation"],
      hook: ["hook", "custom"],
      service: ["service", "api", "engine", "lib", "utils"],
      context: ["context", "store", "state", "provider"],
      utility: ["util", "lib", "common", "shared", "helper"],
      engine: ["engine", "service", "lib"],
      class: ["engine", "service", "lib", "model"],
      module: ["lib", "util", "common", "shared"],
    };
    const affinityTerms: string[] = affinityMap[codeType] ?? [];

    let bestLayer = eligibleLayers[0];
    let bestScore = -1;
    for (const layer of eligibleLayers) {
      const layerIdLower = layer.id.toLowerCase();
      let score = 0;
      for (let i = 0; i < affinityTerms.length; i++) {
        if (layerIdLower.includes(affinityTerms[i])) {
          // Earlier terms carry higher weight
          score = affinityTerms.length - i;
          break;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestLayer = layer;
      }
    }

    const suggestedPath = this.getSuggestedPath(bestLayer, codeName, codeType);
    const importableFrom =
      bestLayer.canImport.length > 0
        ? bestLayer.canImport.join(", ")
        : "no other layers (foundational layer)";

    return {
      suggestedLayer: bestLayer,
      suggestedPath,
      reasoning: `Layer '${bestLayer.name}' best matches '${codeType}' and can import from: ${importableFrom}`,
    };
  }

  private getSuggestedPath(layer: LayerDefinition, codeName: string, codeType: string): string {
    // Use first path pattern and apply naming convention
    const basePattern = layer.paths[0];
    const basePath = basePattern.replace("/**", "").replace(/\/\*$/, "");

    let fileName: string;
    if (codeType === "component") {
      // Components typically use .tsx (React) — honour configured extension if it differs
      const compExt = this.defaultExtension === ".tsx" ? ".tsx" : `${this.defaultExtension}`;
      const hasExt = /\.[^/\\]+$/.test(codeName);
      fileName = hasExt ? codeName : `${codeName}${compExt}`;
    } else if (codeType === "hook") {
      fileName = codeName.startsWith("use") ? codeName : `use${codeName}`;
      const hasExt = /\.[^/\\]+$/.test(fileName);
      fileName = hasExt ? fileName : `${fileName}${this.defaultExtension}`;
    } else if (codeType === "service") {
      const hasExt = /\.[^/\\]+$/.test(codeName);
      if (hasExt) {
        fileName = codeName;
      } else if (codeName.endsWith("Service")) {
        fileName = `${codeName}${this.defaultExtension}`;
      } else {
        fileName = `${codeName}Service${this.defaultExtension}`;
      }
    } else {
      // Default: ensure configured extension
      const hasExt = /\.[^/\\]+$/.test(codeName);
      fileName = hasExt ? codeName : `${codeName}${this.defaultExtension}`;
    }

    return `${basePath}/${fileName}`;
  }

  /**
   * Write violations to Memgraph as VIOLATES_RULE relationships
   */
  async writeViolationsToMemgraph(
    client: MemgraphClient,
    violations: ValidationViolation[],
  ): Promise<void> {
    logger.error(`\n📝 Writing ${violations.length} violations to Memgraph...`);

    const statements: CypherStatement[] = [];

    // Create RULE nodes for each rule type
    for (const rule of this.rules) {
      statements.push({
        query: `
          MERGE (r:RULE {id: $ruleId})
          SET r.severity = $severity, r.pattern = $pattern, r.description = $description
        `,
        params: {
          ruleId: rule.id,
          severity: rule.severity,
          pattern: rule.pattern,
          description: rule.description,
        },
      });
    }

    // Create FILE nodes and VIOLATES_RULE relationships
    for (const violation of violations) {
      // Resolve to absolute path to match FILE nodes created by the graph builder
      const absoluteFilePath = path.isAbsolute(violation.file)
        ? violation.file
        : path.resolve(this.workspaceRoot, violation.file);

      // Create or update FILE node
      statements.push({
        query: `
          MERGE (f:FILE {path: $filePath})
          SET f.lastViolationCheck = timestamp()
        `,
        params: {
          filePath: absoluteFilePath,
        },
      });

      // Create VIOLATES_RULE relationship
      // Map violation type to rule ID for relationship
      const ruleId = this.mapViolationTypeToRuleId(violation.type);
      if (ruleId) {
        statements.push({
          query: `
            MATCH (f:FILE {path: $filePath})
            MERGE (r:RULE {id: $ruleId})
            MERGE (f)-[vr:VIOLATES_RULE]->(r)
            SET vr.severity = $severity, vr.message = $message, vr.timestamp = timestamp()
          `,
          params: {
            filePath: absoluteFilePath,
            ruleId: ruleId,
            severity: violation.severity,
            message: violation.message,
          },
        });
      }
    }

    // Execute all statements in batch
    const results = await client.executeBatch(statements);

    // Check for errors
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      logger.error(`⚠️  ${errors.length} Cypher statements failed:`);
      errors.slice(0, 3).forEach((e) => logger.error(`   - ${e.error}`));
    } else {
      logger.error(`✅ Successfully wrote ${violations.length} violations to graph`);
    }
  }

  /**
   * Reload engine state from updated graph index
   * Called when project context changes
   */
  reload(_index: GraphIndexManager, projectId?: string, workspaceRoot?: string): void {
    logger.error(`[ArchitectureEngine] Reloading architecture validation (projectId=${projectId})`);
    if (workspaceRoot) {
      this.workspaceRoot = workspaceRoot;
    }
    // ArchitectureEngine doesn't hold other project-specific state in index
    // so reload is mainly for consistency with other engines
  }

  /**
   * Map violation type to a rule ID
   */
  private mapViolationTypeToRuleId(type: string): string | null {
    switch (type) {
      case "layer-violation":
        return "no-forbidden-imports";
      case "circular":
        return "no-circular-dependencies";
      case "unused":
        return "no-unused-imports";
      case "rule-violation":
        return "layer-assignment";
      default:
        return null;
    }
  }
}

export default ArchitectureEngine;
