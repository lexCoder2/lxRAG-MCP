/**
 * Architecture Validation Engine
 * Validates code against layer constraints and architectural rules
 */

import * as path from "path";
import * as fs from "fs";
import { globSync } from "glob";
import type { GraphIndexManager } from "../graph/index.js";
import type { MemgraphClient } from "../graph/client.js";
import type { CypherStatement } from "../graph/types.js";

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

  constructor(
    layers: LayerDefinition[],
    rules: ArchitectureRule[],
    _index: GraphIndexManager,
  ) {
    this.layers = new Map(layers.map((l) => [l.id, l]));
    this.rules = rules;
  }

  /**
   * Validate architecture of all files by scanning file system
   */
  async validate(files?: string[]): Promise<ValidationResult> {
    const violations: ValidationViolation[] = [];
    const projectRoot = process.cwd();

    // Get source files to validate
    let filesToCheck: string[];
    if (files && files.length > 0) {
      filesToCheck = files;
    } else {
      // Scan all TS/TSX files in src/
      filesToCheck = globSync("src/**/*.{ts,tsx}", {
        cwd: projectRoot,
        ignore: ["**/node_modules/**", "**/*.test.ts", "**/*.test.tsx"],
      });
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
          suggestion:
            "Update .lxrag/config.json with appropriate layer path pattern",
        });
        continue;
      }

      // Extract imports from file
      const imports = this.extractImportsFromFile(
        path.join(projectRoot, filePath),
      );

      for (const imp of imports) {
        // Skip external imports
        if (
          imp.startsWith("@") ||
          (imp.startsWith(".") === false && !imp.startsWith("src"))
        ) {
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
        if (
          layer.cannotImport &&
          this.isForbiddenImport(layer, importedLayer)
        ) {
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
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, ".");

    const regex = new RegExp(`^${patternRegex}$`);
    return regex.test(filePath);
  }

  /**
   * Extract import statements from a source file
   */
  private extractImportsFromFile(filePath: string): string[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const imports: Set<string> = new Set();

      // Match: import/export from 'path' or "path"
      const importRegex =
        /(?:import|export)\s+(?:[^"']*\s+)?from\s+['"]([^'"]+)['"]/g;
      let match;

      while ((match = importRegex.exec(content)) !== null) {
        imports.add(match[1]);
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
      // Relative import: resolve from importing file's directory
      const dir = path.dirname(fromPath);
      resolvedPath = path.resolve(dir, importPath);
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

    // Try different extensions
    const candidates = [
      relPath,
      `${relPath}.ts`,
      `${relPath}.tsx`,
      `${relPath}/index.ts`,
      `${relPath}/index.tsx`,
    ];

    for (const candidate of candidates) {
      const fullPath = path.join(projectRoot, candidate);
      if (fs.existsSync(fullPath)) {
        return candidate;
      }
    }

    // Return best guess if file doesn't exist yet
    return relPath.endsWith(".ts") || relPath.endsWith(".tsx")
      ? relPath
      : `${relPath}.ts`;
  }

  /**
   * Check if import from one layer to another is allowed
   */
  private isImportAllowed(
    fromLayer: LayerDefinition,
    toLayer: LayerDefinition,
  ): boolean {
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
  private isForbiddenImport(
    fromLayer: LayerDefinition,
    toLayer: LayerDefinition,
  ): boolean {
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
    const projectRoot = process.cwd();
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[][] = [];

    // Build import graph
    const importGraph = new Map<string, string[]>();
    const sourceFiles = globSync("src/**/*.{ts,tsx}", {
      cwd: projectRoot,
      ignore: ["**/node_modules/**", "**/*.test.ts", "**/*.test.tsx"],
    });

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
      if (visited.has(node)) return;

      // Check for cycle BEFORE adding to path
      const cycleStart = currentPath.indexOf(node);
      if (cycleStart >= 0) {
        cycles.push([...currentPath.slice(cycleStart), node]);
        return;
      }

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
          suggestion:
            "Break the circular dependency by moving code to a shared utility module",
        });
      }
    }

    return violations;
  }

  /**
   * Get suggestion for placing new code
   */
  getSuggestion(
    codeName: string,
    codeType: "component" | "hook" | "service" | "context" | "utility",
    dependencies: string[],
  ): {
    suggestedLayer: LayerDefinition;
    suggestedPath: string;
    reasoning: string;
  } | null {
    // Find layer that can satisfy all dependencies
    for (const layer of this.layers.values()) {
      let canImportAll = true;

      for (const dep of dependencies) {
        // Find which layer the dependency is in
        // For now, assume dependency is a module name we can look up
        const depLayer = this.layers.get(dep);
        if (depLayer && !this.isImportAllowed(layer, depLayer)) {
          canImportAll = false;
          break;
        }
      }

      if (canImportAll) {
        // Suggest first matching path pattern
        const suggestedPath = this.getSuggestedPath(layer, codeName, codeType);
        return {
          suggestedLayer: layer,
          suggestedPath,
          reasoning: `Layer '${layer.name}' can import from ${layer.canImport.join(", ")}`,
        };
      }
    }

    return null;
  }

  private getSuggestedPath(
    layer: LayerDefinition,
    codeName: string,
    codeType: string,
  ): string {
    // Use first path pattern and apply naming convention
    const basePattern = layer.paths[0];
    const basePath = basePattern.replace("/**", "");

    let fileName = codeName;
    if (codeType === "component") {
      fileName = codeName.endsWith(".tsx") ? codeName : `${codeName}.tsx`;
    } else if (codeType === "hook") {
      fileName = codeName.startsWith("use") ? codeName : `use${codeName}`;
      fileName = fileName.endsWith(".ts") ? fileName : `${fileName}.ts`;
    } else if (codeType === "service") {
      fileName = codeName.endsWith("Service.ts")
        ? codeName
        : `${codeName}Service.ts`;
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
    console.log(`\n📝 Writing ${violations.length} violations to Memgraph...`);

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
      // Create or update FILE node
      statements.push({
        query: `
          MERGE (f:FILE {path: $filePath})
          SET f.lastViolationCheck = timestamp()
        `,
        params: {
          filePath: violation.file,
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
            filePath: violation.file,
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
      console.error(`⚠️  ${errors.length} Cypher statements failed:`);
      errors.slice(0, 3).forEach((e) => console.error(`   - ${e.error}`));
    } else {
      console.log(
        `✅ Successfully wrote ${violations.length} violations to graph`,
      );
    }
  }

  /**
   * Reload engine state from updated graph index
   * Called when project context changes
   */
  reload(_index: GraphIndexManager, projectId?: string): void {
    console.log(`[ArchitectureEngine] Reloading architecture validation (projectId=${projectId})`);
    // ArchitectureEngine doesn't hold project-specific state in index
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
