/**
 * @file engines/test-engine
 * @description Selects and categorizes tests based on dependency impact analysis.
 * @remarks Used by tool handlers to drive targeted and risk-aware test execution.
 */

import * as path from "path";
import type { GraphIndexManager } from "../graph/index.js";

export interface TestMetadata {
  path: string;
  category: "unit" | "integration" | "performance" | "e2e";
  duration: number;
  status: "pass" | "fail" | "unknown";
}

export interface TestDependencyMap {
  [testFile: string]: {
    directDependencies: string[];
    indirectDependencies: string[];
    affectedByFiles: string[];
  };
}

export interface TestSelectionResult {
  selectedTests: string[];
  affectedSources: string[];
  estimatedTime: number;
  category: "unit" | "integration" | "mixed";
  coverage: {
    percentage: number;
    testsSelected: number;
    totalTests: number;
  };
}

export class TestEngine {
  private index: GraphIndexManager;
  private testMap: Map<string, TestMetadata>;
  private dependencyMap: TestDependencyMap;

  constructor(index: GraphIndexManager) {
    this.index = index;
    this.testMap = new Map();
    this.dependencyMap = {};
    this.buildTestDependencies();
  }

  /**
   * Build test dependency map from graph
   */
  private buildTestDependencies(): void {
    const testSuites = this.index.getNodesByType("TEST_SUITE");

    for (const suite of testSuites) {
      const testPath = suite.properties.path;
      const direct: string[] = [];
      const indirect: string[] = [];
      let affectedBy: string[] = [];

      // Find all test cases in this suite
      const testCases = this.index
        .getNodesByType("TEST_CASE")
        .filter((tc) => tc.properties.path === testPath);

      // Find what this test suite TESTS
      for (const testCase of testCases) {
        const testsRels = this.index
          .getRelationshipsFrom(testCase.id)
          .filter((r) => r.type === "TESTS");

        for (const rel of testsRels) {
          const testedElement = this.index.getNode(rel.to);
          if (!testedElement) continue;

          // Add as direct dependency
          if (testedElement.properties.path) {
            direct.push(testedElement.properties.path);
          }

          // Find indirect dependencies (what the tested element imports)
          const importRels = this.index
            .getRelationshipsFrom(rel.to)
            .filter((r) => r.type === "IMPORTS");
          for (const importRel of importRels) {
            const imported = this.index.getNode(importRel.to);
            if (imported && imported.properties.source) {
              indirect.push(imported.properties.source);
            }
          }
        }
      }

      // Find which source files import this test
      // (for reverse dependency tracking)
      const nodes = this.index.getNodesByType("FILE").filter((n) => {
        const rels = this.index
          .getRelationshipsFrom(n.id)
          .filter((r) => r.type === "IMPORTS");
        return rels.some((r) => {
          const imp = this.index.getNode(r.to);
          return imp && imp.properties.source === testPath;
        });
      });

      affectedBy = nodes.map((n) => n.properties.path).filter(Boolean);

      this.dependencyMap[testPath] = {
        directDependencies: Array.from(new Set(direct)),
        indirectDependencies: Array.from(new Set(indirect)),
        affectedByFiles: affectedBy,
      };

      // Store metadata
      const category = this.categorizeTest(testPath);
      this.testMap.set(testPath, {
        path: testPath,
        category,
        duration: suite.properties.avgDuration || 0,
        status: suite.properties.lastStatus || "unknown",
      });
    }
  }

  /**
   * Categorize test based on path and patterns
   */
  private categorizeTest(
    testPath: string
  ): "unit" | "integration" | "performance" | "e2e" {
    if (testPath.includes(".integration.test.")) return "integration";
    if (testPath.includes(".performance.test.")) return "performance";
    if (testPath.includes("/e2e/")) return "e2e";
    return "unit";
  }

  /**
   * Select tests affected by changed files
   */
  selectAffectedTests(
    changedFiles: string[],
    includeIntegration = true,
    depth = 1
  ): TestSelectionResult {
    const selected = new Set<string>();
    const affectedSources = new Set<string>();

    // Normalize changed file paths
    const normalizedChanges = changedFiles.map((f) => this.normalizePath(f));

    // For each changed file, find tests that depend on it
    for (const changedFile of normalizedChanges) {
      for (const [testPath, deps] of Object.entries(this.dependencyMap)) {
        const testMeta = this.testMap.get(testPath);
        if (!testMeta) continue;

        // Skip non-selected test categories
        if (!includeIntegration && testMeta.category === "integration")
          continue;

        // Check direct dependencies
        if (deps.directDependencies.includes(changedFile)) {
          selected.add(testPath);
          affectedSources.add(changedFile);
          continue;
        }

        // Check indirect dependencies (up to depth)
        if (
          depth > 1 &&
          this.isIndirectlyDependentOn(changedFile, testPath, depth - 1)
        ) {
          selected.add(testPath);
          affectedSources.add(changedFile);
          continue;
        }
      }
    }

    // If no tests directly depend on changed file, include related tests
    // (e.g., if a utility changed, run tests that use that utility)
    if (selected.size === 0) {
      for (const changedFile of normalizedChanges) {
        const relatedTests = this.findRelatedTests(changedFile);
        relatedTests.forEach((t) => selected.add(t));
      }
    }

    // Calculate coverage percentage
    const totalTests = this.testMap.size;
    const selectedCount = selected.size;
    const coverage = totalTests > 0 ? (selectedCount / totalTests) * 100 : 0;

    // Estimate total time
    let estimatedTime = 0;
    selected.forEach((test) => {
      const meta = this.testMap.get(test);
      if (meta) estimatedTime += meta.duration;
    });

    return {
      selectedTests: Array.from(selected).sort(),
      affectedSources: Array.from(affectedSources),
      estimatedTime,
      category: this.determineCategory(selected),
      coverage: {
        percentage: Math.round(coverage * 100) / 100,
        testsSelected: selectedCount,
        totalTests,
      },
    };
  }

  /**
   * Find tests that are indirectly affected (via transitive dependencies)
   */
  private isIndirectlyDependentOn(
    changedFile: string,
    testPath: string,
    remainingDepth: number
  ): boolean {
    const deps = this.dependencyMap[testPath];
    if (!deps) return false;

    // Check if any direct dependency imports the changed file
    for (const direct of deps.directDependencies) {
      if (direct === changedFile) return true;

      // Recursively check if this direct dependency has indirect dependencies
      // that eventually lead to the changed file
      if (remainingDepth > 0 && this.transitiveImportSearch(changedFile, direct, remainingDepth)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search for transitive imports (what a file imports and what those imports import)
   */
  private transitiveImportSearch(
    changedFile: string,
    fromFile: string,
    remainingDepth: number
  ): boolean {
    // Look for tests that import fromFile and check if they import changedFile
    for (const [testPath, deps] of Object.entries(this.dependencyMap)) {
      // If this test imports fromFile
      if (
        deps.directDependencies.includes(fromFile) ||
        deps.indirectDependencies.includes(fromFile)
      ) {
        // Check if this test also imports changedFile
        if (
          deps.directDependencies.includes(changedFile) ||
          deps.indirectDependencies.includes(changedFile)
        ) {
          return true;
        }

        // Recursively check deeper if we have remaining depth
        if (remainingDepth > 1) {
          if (this.transitiveImportSearch(changedFile, testPath, remainingDepth - 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Find tests related to a file
   */
  private findRelatedTests(filePath: string): string[] {
    const related: string[] = [];

    // Find test file that mirrors this source file
    // e.g., src/utils/units.ts → src/utils/__tests__/units.test.ts
    const mirrorTestPath = this.getMirrorTestPath(filePath);
    if (this.testMap.has(mirrorTestPath)) {
      related.push(mirrorTestPath);
    }

    // Find tests in same folder
    const folder = path.dirname(filePath);
    for (const [testPath] of this.testMap) {
      if (testPath.includes(folder) && testPath.includes(".test.")) {
        related.push(testPath);
      }
    }

    return Array.from(new Set(related));
  }

  /**
   * Get mirror test path for a source file
   */
  private getMirrorTestPath(sourcePath: string): string {
    // Convert: src/utils/units.ts → src/utils/__tests__/units.test.ts
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    return `${dir}/__tests__/${base}.test.ts`;
  }

  /**
   * Determine overall test category
   */
  private determineCategory(
    testPaths: Set<string>
  ): "unit" | "integration" | "mixed" {
    let hasUnit = false;
    let hasIntegration = false;
    let hasPerformance = false;

    for (const testPath of testPaths) {
      const meta = this.testMap.get(testPath);
      if (!meta) continue;

      if (meta.category === "unit") hasUnit = true;
      if (meta.category === "integration") hasIntegration = true;
      if (meta.category === "performance") hasPerformance = true;
    }

    if (
      (hasUnit || hasIntegration || hasPerformance) &&
      (hasUnit ? 1 : 0) + (hasIntegration ? 1 : 0) + (hasPerformance ? 1 : 0) >
        1
    ) {
      return "mixed";
    }

    return hasIntegration ? "integration" : "unit";
  }

  /**
   * Normalize file path
   */
  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  /**
   * Reload engine state from updated graph index
   * Called when project context changes to refresh test data
   */
  reload(index: GraphIndexManager, projectId?: string): void {
    console.error(`[TestEngine] Reloading tests (projectId=${projectId})`);

    this.index = index;
    this.testMap.clear();
    this.dependencyMap = {};
    this.buildTestDependencies();

    const testCount = this.testMap.size;
    console.error(`[TestEngine] Reloaded ${testCount} test suites`);
  }

  /**
   * Get test statistics
   */
  getStatistics(): {
    totalTests: number;
    unitTests: number;
    integrationTests: number;
    performanceTests: number;
    e2eTests: number;
    averageDuration: number;
  } {
    let unitCount = 0;
    let integrationCount = 0;
    let performanceCount = 0;
    let e2eCount = 0;
    let totalDuration = 0;

    for (const meta of this.testMap.values()) {
      switch (meta.category) {
        case "unit":
          unitCount++;
          break;
        case "integration":
          integrationCount++;
          break;
        case "performance":
          performanceCount++;
          break;
        case "e2e":
          e2eCount++;
          break;
      }
      totalDuration += meta.duration;
    }

    return {
      totalTests: this.testMap.size,
      unitTests: unitCount,
      integrationTests: integrationCount,
      performanceTests: performanceCount,
      e2eTests: e2eCount,
      averageDuration:
        this.testMap.size > 0 ? totalDuration / this.testMap.size : 0,
    };
  }
}

export default TestEngine;
