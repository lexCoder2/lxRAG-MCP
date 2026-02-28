import { describe, expect, it } from "vitest";
import GraphIndexManager from "../../graph/index.js";
import TestEngine from "../test-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a GraphIndexManager pre-populated with two test suites:
 *  - a unit test at `src/utils/__tests__/units.test.ts`
 *  - an integration test at `src/services/__tests__/svc.integration.test.ts`
 *
 * Both suites have one TEST_CASE each.  The unit test case directly depends on
 * `src/utils/units.ts` which in turn imports `src/utils/helpers.ts`.
 */
function buildPopulatedIndex(): GraphIndexManager {
  const index = new GraphIndexManager();

  // --- source files ---------------------------------------------------------
  index.addNode("file:units", "FILE", { path: "src/utils/units.ts" });
  index.addNode("file:helpers", "FILE", { path: "src/utils/helpers.ts" });
  index.addNode("file:svc", "FILE", { path: "src/services/svc.ts" });

  // --- test suites ----------------------------------------------------------
  index.addNode("suite:unit", "TEST_SUITE", {
    path: "src/utils/__tests__/units.test.ts",
    avgDuration: 100,
    lastStatus: "pass",
  });
  index.addNode("suite:int", "TEST_SUITE", {
    path: "src/services/__tests__/svc.integration.test.ts",
    avgDuration: 500,
    lastStatus: "unknown",
  });

  // --- test cases -----------------------------------------------------------
  index.addNode("case:unit-1", "TEST_CASE", {
    path: "src/utils/__tests__/units.test.ts",
    name: "should work",
  });
  index.addNode("case:int-1", "TEST_CASE", {
    path: "src/services/__tests__/svc.integration.test.ts",
    name: "should integrate",
  });

  // --- TESTS relationships --------------------------------------------------
  // unit test → directly tests units.ts
  index.addRelationship("rel:case-unit-tests-units", "case:unit-1", "file:units", "TESTS");
  // integration test → directly tests svc.ts
  index.addRelationship("rel:case-int-tests-svc", "case:int-1", "file:svc", "TESTS");

  // --- IMPORTS relationships ------------------------------------------------
  // units.ts imports helpers.ts  → indirect dependency for the unit test
  index.addNode("import:helpers", "IMPORT", { source: "src/utils/helpers.ts" });
  index.addRelationship("rel:units-imports-helpers", "file:units", "import:helpers", "IMPORTS");

  return index;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TestEngine", () => {
  describe("getStatistics()", () => {
    it("returns all-zero stats for an empty index", () => {
      const engine = new TestEngine(new GraphIndexManager());
      expect(engine.getStatistics()).toEqual({
        totalTests: 0,
        unitTests: 0,
        integrationTests: 0,
        performanceTests: 0,
        e2eTests: 0,
        averageDuration: 0,
      });
    });

    it("counts categories correctly from graph data", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const stats = engine.getStatistics();

      expect(stats.totalTests).toBe(2);
      expect(stats.unitTests).toBe(1);
      expect(stats.integrationTests).toBe(1);
      expect(stats.performanceTests).toBe(0);
      expect(stats.e2eTests).toBe(0);
      // average: (100 + 500) / 2 = 300
      expect(stats.averageDuration).toBe(300);
    });

    it("classifies performance tests", () => {
      const index = new GraphIndexManager();
      index.addNode("suite:bench", "TEST_SUITE", {
        path: "benchmarks/process_benchmark.test.ts",
        avgDuration: 2000,
      });
      const engine = new TestEngine(index);
      const stats = engine.getStatistics();
      expect(stats.performanceTests).toBe(1);
      expect(stats.unitTests).toBe(0);
    });

    it("classifies e2e tests", () => {
      const index = new GraphIndexManager();
      index.addNode("suite:e2e", "TEST_SUITE", {
        path: "tests/e2e/auth.test.ts",
        avgDuration: 5000,
      });
      const engine = new TestEngine(index);
      const stats = engine.getStatistics();
      expect(stats.e2eTests).toBe(1);
      expect(stats.unitTests).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe("selectAffectedTests()", () => {
    it("returns empty result when no tests depend on the changed files", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/unrelated/file.ts"]);

      expect(result.selectedTests).toHaveLength(0);
      expect(result.coverage.totalTests).toBe(2);
    });

    it("selects the unit test when its direct dependency changes", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/utils/units.ts"]);

      expect(result.selectedTests).toContain("src/utils/__tests__/units.test.ts");
      expect(result.affectedSources).toContain("src/utils/units.ts");
    });

    it("selects the integration test when its direct dependency changes", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/services/svc.ts"]);

      expect(result.selectedTests).toContain(
        "src/services/__tests__/svc.integration.test.ts",
      );
    });

    it("normalises leading ./ in changed file paths", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["./src/utils/units.ts"]);

      expect(result.selectedTests).toContain("src/utils/__tests__/units.test.ts");
    });

    it("excludes integration tests when includeIntegration=false", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      // Both tests depend on their own file; change both source files
      const result = engine.selectAffectedTests(
        ["src/utils/units.ts", "src/services/svc.ts"],
        false,
      );

      expect(result.selectedTests).toContain("src/utils/__tests__/units.test.ts");
      expect(result.selectedTests).not.toContain(
        "src/services/__tests__/svc.integration.test.ts",
      );
    });

    it("returns an empty selection (and falls back to related tests) when index is empty", () => {
      const engine = new TestEngine(new GraphIndexManager());
      const result = engine.selectAffectedTests(["src/anything.ts"]);

      // No tests exist in the index so selectedTests must be empty
      expect(result.selectedTests).toHaveLength(0);
      expect(result.coverage.totalTests).toBe(0);
    });

    it("computes category as unit when only unit tests selected", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/utils/units.ts"]);
      expect(result.category).toBe("unit");
    });

    it("computes category as integration when only integration tests selected", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/services/svc.ts"]);
      expect(result.category).toBe("integration");
    });

    it("computes category as mixed when both unit and integration tests selected", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests([
        "src/utils/units.ts",
        "src/services/svc.ts",
      ]);
      expect(result.category).toBe("mixed");
    });

    it("computes estimated time from suite durations", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests([
        "src/utils/units.ts",
        "src/services/svc.ts",
      ]);
      // unit=100 + integration=500
      expect(result.estimatedTime).toBe(600);
    });

    it("coverage percentage is proportional to total tests", () => {
      const engine = new TestEngine(buildPopulatedIndex());
      const result = engine.selectAffectedTests(["src/utils/units.ts"]);
      // 1 of 2 tests → 50%
      expect(result.coverage.percentage).toBe(50);
      expect(result.coverage.testsSelected).toBe(1);
      expect(result.coverage.totalTests).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe("findRelatedTests() via fallback path", () => {
    it("uses mirror path to find tests when no direct dependency matches", () => {
      const index = new GraphIndexManager();
      // Register a test suite at the mirror location of a source file
      index.addNode("suite:widget", "TEST_SUITE", {
        path: "src/utils/__tests__/widget.test.ts",
        avgDuration: 50,
        lastStatus: "pass",
      });

      const engine = new TestEngine(index);
      // No graph relationship — engine must infer the test via getMirrorTestPath
      const result = engine.selectAffectedTests(["src/utils/widget.ts"]);
      expect(result.selectedTests).toContain("src/utils/__tests__/widget.test.ts");
    });
  });

  // -------------------------------------------------------------------------
  describe("reload()", () => {
    it("rebuilds testMap from the new index", () => {
      const originalIndex = buildPopulatedIndex();
      const engine = new TestEngine(originalIndex);
      expect(engine.getStatistics().totalTests).toBe(2);

      // Replace with a smaller index
      const smallIndex = new GraphIndexManager();
      smallIndex.addNode("suite:tiny", "TEST_SUITE", {
        path: "src/__tests__/tiny.test.ts",
        avgDuration: 10,
      });
      engine.reload(smallIndex);

      expect(engine.getStatistics().totalTests).toBe(1);
    });

    it("accepts an optional projectId without failing", () => {
      const engine = new TestEngine(new GraphIndexManager());
      expect(() => engine.reload(new GraphIndexManager(), "my-project")).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe("categorizeTest() — path-based classification", () => {
    const CASES: Array<{ path: string; expected: string }> = [
      {
        path: "src/utils/__tests__/parser.test.ts",
        expected: "unit",
      },
      {
        path: "src/services/__tests__/auth.integration.test.ts",
        expected: "integration",
      },
      {
        path: "tests/integration/db.test.ts",
        expected: "integration",
      },
      {
        path: "benchmarks/algo_benchmark.test.ts",
        expected: "performance",
      },
      {
        path: "src/utils/__tests__/sort_bench_test.ts",
        expected: "performance",
      },
      {
        path: "tests/e2e/signup.test.ts",
        expected: "e2e",
      },
      {
        path: "tests/end_to_end/checkout.test.ts",
        expected: "e2e",
      },
    ];

    for (const { path: testPath, expected } of CASES) {
      it(`classifies "${testPath}" as "${expected}"`, () => {
        const index = new GraphIndexManager();
        index.addNode(`suite:${expected}`, "TEST_SUITE", {
          path: testPath,
          avgDuration: 0,
        });
        const engine = new TestEngine(index);
        const meta = engine
          .getStatistics();

        if (expected === "unit") expect(meta.unitTests).toBe(1);
        if (expected === "integration") expect(meta.integrationTests).toBe(1);
        if (expected === "performance") expect(meta.performanceTests).toBe(1);
        if (expected === "e2e") expect(meta.e2eTests).toBe(1);
      });
    }
  });
});
