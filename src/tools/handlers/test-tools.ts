/**
 * Test Intelligence Tools
 * Phase 5 Step 5: Extract test-related tools
 *
 * Tools:
 * - test_select: select affected tests for changed files
 * - test_categorize: categorize tests by type
 * - impact_analyze: analyze blast radius of changes
 * - test_run: execute tests with vitest
 *
 * These tools delegate to TestEngine and use execWithTimeout for execution.
 */

import { execWithTimeout } from "../../utils/exec-utils.js";

/**
 * Minimal context interface required by test tools
 */
interface TestToolContext {
  testEngine?: any; // TestEngine
  execWithTimeout?: typeof execWithTimeout;
  /** MemgraphClient — used by impact_analyze for graph traversal */
  context?: {
    memgraph?: any;
    index?: any;
  };
  getActiveProjectContext?(): { projectId: string; workspaceRoot: string };
  errorEnvelope(
    code: string,
    reason: string,
    recoverable?: boolean,
    hint?: string
  ): string;
  formatSuccess(
    data: unknown,
    profile?: string,
    summary?: string,
    toolName?: string
  ): string;
}

/**
 * Resolve which source files directly import the given changed files by
 * traversing IMPORTS → REFERENCES edges in Memgraph.
 *
 * Falls back to the in-memory index if Memgraph is not connected.
 * Returns at most 50 paths, sorted alphabetically.
 */
async function resolveDirectImpact(
  ctx: TestToolContext,
  changedFiles: string[],
): Promise<string[]> {
  const memgraph = ctx.context?.memgraph;

  // Try Memgraph graph traversal first (most accurate, uses persisted graph)
  if (memgraph?.isConnected?.()) {
    try {
      const projectId = ctx.getActiveProjectContext?.()?.projectId ?? "";

      // Normalize input: accept both relative and absolute paths as search keys
      const result = await memgraph.executeCypher(
        `MATCH (changed:FILE)
         WHERE changed.projectId = $projectId
           AND (changed.relativePath IN $changedPaths
                OR changed.path IN $changedPaths
                OR any(cp IN $changedPaths WHERE changed.relativePath = cp
                                              OR changed.path = cp
                                              OR changed.relativePath ENDS WITH cp
                                              OR changed.path ENDS WITH cp))
         WITH collect(DISTINCT changed) AS changedFiles
         UNWIND changedFiles AS changed
         MATCH (changed)<-[:REFERENCES]-(imp:IMPORT)<-[:IMPORTS]-(importer:FILE)
         WHERE importer.projectId = $projectId
           AND importer.id <> changed.id
         RETURN DISTINCT
           coalesce(importer.relativePath, importer.path) AS path
         ORDER BY path
         LIMIT 50`,
        { projectId, changedPaths: changedFiles },
      );

      const paths: string[] = result.data
        .map((row: any) => String(row.path ?? ""))
        .filter(Boolean);

      if (paths.length > 0) {
        return paths;
      }
    } catch {
      // Fall through to index-based fallback
    }
  }

  // Fallback: traverse in-memory index (less accurate, no projectId scoping)
  const index = ctx.context?.index;
  if (!index?.getRelationshipsTo) {
    return [];
  }

  const importers = new Set<string>();
  try {
    const fileNodes: any[] = index.getNodesByType("FILE") ?? [];

    for (const changed of changedFiles) {
      // Find FILE node whose relativePath or path matches the changed file
      const targetNode = fileNodes.find(
        (n: any) =>
          n.properties?.relativePath === changed ||
          n.properties?.path === changed ||
          n.properties?.relativePath?.endsWith(changed) ||
          n.properties?.path?.endsWith(changed),
      );
      if (!targetNode) continue;

      // incoming REFERENCES edges → IMPORT nodes
      const refsToTarget: any[] = index.getRelationshipsTo(targetNode.id) ?? [];
      for (const ref of refsToTarget) {
        if (ref.type !== "REFERENCES") continue;
        // incoming IMPORTS edges → source FILE nodes
        const importsToImp: any[] = index.getRelationshipsTo(ref.from) ?? [];
        for (const imp of importsToImp) {
          if (imp.type !== "IMPORTS") continue;
          const sourceNode = index.getNode(imp.from);
          if (!sourceNode) continue;
          const p =
            sourceNode.properties?.relativePath ||
            sourceNode.properties?.path ||
            sourceNode.id;
          if (p && p !== changed) importers.add(p);
        }
      }
    }
  } catch {
    // best-effort
  }

  return Array.from(importers).sort().slice(0, 50);
}

/**
 * Create test intelligence tools
 * @param ctx - Context object providing testEngine and formatting methods
 */
export function createTestTools(ctx: TestToolContext) {
  return {
    /**
     * Select affected tests for changed files
     */
    async test_select(args: any): Promise<string> {
      const {
        changedFiles,
        includeIntegration = true,
        profile = "compact",
      } = args;

      try {
        const result = ctx.testEngine!.selectAffectedTests(
          changedFiles,
          includeIntegration
        );

        return ctx.formatSuccess(result, profile);
      } catch (error) {
        return ctx.errorEnvelope("TEST_SELECT_FAILED", String(error), true);
      }
    },

    /**
     * Categorize tests by type
     */
    async test_categorize(args: any): Promise<string> {
      const { testFiles = [], profile = "compact" } = args;

      try {
        console.log(`[Test] Categorizing ${testFiles.length} test files...`);
        const stats = ctx.testEngine!.getStatistics();

        return ctx.formatSuccess(
          {
            statistics: stats,
            categorization: {
              unit: {
                count: stats.unitTests,
                pattern: "**/__tests__/**/*.test.ts",
                timeout: 5000,
              },
              integration: {
                count: stats.integrationTests,
                pattern: "**/__tests__/**/*.integration.test.ts",
                timeout: 15000,
              },
              performance: {
                count: stats.performanceTests,
                pattern: "**/*.performance.test.ts",
                timeout: 30000,
              },
              e2e: {
                count: stats.e2eTests,
                pattern: "**/e2e/**/*.test.ts",
                timeout: 60000,
              },
            },
          },
          profile
        );
      } catch (error) {
        return ctx.errorEnvelope("TEST_CATEGORIZE_FAILED", String(error), true);
      }
    },

    /**
     * Analyze blast radius of changes.
     *
     * directImpact is derived from graph traversal (IMPORTS/REFERENCES edges)
     * to find source files that directly depend on the changed files, rather
     * than from test selection alone.
     */
    async impact_analyze(args: any): Promise<string> {
      const profile = args?.profile || "compact";
      const depth = typeof args?.depth === "number" ? args.depth : 2;
      const changedFiles: string[] = Array.isArray(args?.files)
        ? args.files
        : Array.isArray(args?.changedFiles)
          ? args.changedFiles
          : [];

      if (!changedFiles.length) {
        return ctx.formatSuccess(
          {
            changedFiles: [],
            analysis: {
              directImpact: [],
              estimatedTestTime: 0,
              coverage: {
                percentage: 0,
                testsSelected: 0,
                totalTests: 0,
              },
              blastRadius: {
                testsAffected: 0,
                percentage: 0,
                recommendation: "Provide at least one changed file",
              },
            },
            warning: "No changed files were provided",
          },
          profile
        );
      }

      try {
        const result = ctx.testEngine!.selectAffectedTests(
          changedFiles,
          true,
          depth
        );

        // Compute directImpact via graph traversal to find source files that
        // directly import the changed files, independent of test selection.
        const directImpact = await resolveDirectImpact(ctx, changedFiles);

        return ctx.formatSuccess(
          {
            changedFiles,
            analysis: {
              directImpact,
              estimatedTestTime: result.estimatedTime,
              coverage: result.coverage,
              blastRadius: {
                testsAffected: result.selectedTests.length,
                percentage: result.coverage.percentage,
                recommendation:
                  result.coverage.percentage > 50
                    ? "Run full suite"
                    : "Run affected tests",
              },
            },
          },
          profile
        );
      } catch (error) {
        return ctx.errorEnvelope("IMPACT_ANALYZE_FAILED", String(error), true);
      }
    },

    /**
     * Execute tests using vitest
     */
    async test_run(args: any): Promise<string> {
      const { testFiles = [], parallel = true, profile = "compact" } = args;

      try {
        if (!testFiles || testFiles.length === 0) {
          return ctx.formatSuccess(
            {
              status: "error",
              message: "No test files specified",
              executed: 0,
              passed: 0,
              failed: 0,
            },
            profile
          );
        }

        // Build vitest command (Phase 3.5 - actual execution)
        const cmd = [
          "npx vitest run",
          parallel
            ? "--reporter=verbose"
            : "--reporter=verbose --no-coverage",
          ...testFiles,
        ].join(" ");

        console.log(`[ToolHandlers] Executing: ${cmd}`);

        // Execute vitest with timeout and output limits
        try {
          const output = execWithTimeout(cmd, {
            cwd: process.cwd(),
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });

          return ctx.formatSuccess(
            {
              status: "passed",
              message: "All tests passed",
              output: output.substring(0, 1000), // First 1000 chars
              testsRun: testFiles.length,
            },
            profile
          );
        } catch (execError: any) {
          // Tests failed but command executed
          return ctx.formatSuccess(
            {
              status: "failed",
              message: "Some tests failed",
              error: execError.message.substring(0, 500),
              output: execError.stdout?.toString().substring(0, 500) || "",
              testsRun: testFiles.length,
            },
            profile
          );
        }
      } catch (error) {
        return ctx.errorEnvelope(
          "TEST_RUN_FAILED",
          `Test execution failed: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    },
  };
}
