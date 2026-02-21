#!/usr/bin/env node

/**
 * Test Affected CLI
 * Selects and optionally runs tests affected by changed files
 *
 * Usage:
 *   npm run test:affected src/engine/calculations/columns.ts
 *   npm run test:affected src/utils/units.ts --run
 *   npm run test:affected src/engine/**\/*.ts --depth=2
 */

import { execSync } from "child_process";
import GraphIndexManager from "../graph/index.js";
import { loadConfig as _loadConfig } from "../config.js";
import TestEngine from "../engines/test-engine.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("🧪 Test Affected Selector");
    console.log("");
    console.log("Usage: npm run test:affected <files> [--run] [--depth=N]");
    console.log("");
    console.log("Options:");
    console.log("  --run         Run tests after selection (requires Vitest)");
    console.log("  --depth=N     Set transitive dependency depth (default: 1)");
    console.log("");
    console.log("Examples:");
    console.log("  npm run test:affected src/utils/units.ts");
    console.log("  npm run test:affected src/engine/calculations/\\*.ts --run");
    console.log(
      "  npm run test:affected src/context/BuildingContext.tsx --depth=2 --run"
    );
    process.exit(0);
  }

  const runTests = args.includes("--run");
  const depthArg = args.find((a) => a.startsWith("--depth="));
  const depth = depthArg ? parseInt(depthArg.split("=")[1]) : 1;

  // Filter out flag arguments
  const changedFiles = args.filter(
    (a) => !a.startsWith("--run") && !a.startsWith("--depth=")
  );

  console.log("🧪 Test Affected Selector");
  console.log(`📁 Changed files: ${changedFiles.length}`);
  console.log(`🔄 Dependency depth: ${depth}`);
  console.log(`▶️  Auto-run: ${runTests ? "YES" : "NO"}\n`);

  try {
    // Create in-memory graph index
    console.log("📊 Building test dependency map...");
    const index = new GraphIndexManager();
    const testEngine = new TestEngine(index);
    console.log("✅ Ready\n");

    // Select affected tests
    console.log("🔍 Analyzing dependencies...\n");
    const result = testEngine.selectAffectedTests(changedFiles, true, depth);

    // Display results
    if (result.selectedTests.length === 0) {
      console.log("ℹ️  No tests directly affected by these changes");
      console.log(
        "   (Possibly: new file, not imported by tests, or test dependencies not built)"
      );
      process.exit(0);
    }

    console.log(`✅ Selected ${result.selectedTests.length} test(s):`);
    console.log("");
    result.selectedTests.forEach((test) => {
      console.log(`   📄 ${test}`);
    });

    console.log("");
    console.log("📊 Statistics:");
    console.log(`   Coverage: ${result.coverage.percentage}% (${result.coverage.testsSelected}/${result.coverage.totalTests})`);
    console.log(`   Category: ${result.category}`);
    console.log(
      `   Est. time: ${result.estimatedTime > 0 ? result.estimatedTime + "ms" : "unknown"}`
    );
    console.log("");

    // Optionally run tests
    if (runTests) {
      console.log("▶️  Running selected tests...\n");
      try {
        const testList = result.selectedTests.join(" ");
        execSync(`npx vitest run ${testList}`, {
          cwd: process.cwd(),
          stdio: "inherit",
        });
        console.log("\n✅ Tests completed successfully");
        process.exit(0);
      } catch (error) {
        console.error("\n❌ Some tests failed");
        process.exit(1);
      }
    } else {
      console.log("💡 To run these tests, add --run flag:");
      console.log(`   npm run test:affected ${changedFiles.join(" ")} --run`);
      console.log("");
      process.exit(0);
    }
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
