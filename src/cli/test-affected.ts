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
import { loadConfig } from "../config.js";
import TestEngine from "../engines/test-engine.js";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("🧪 Test Affected Selector");
    console.error("");
    console.error("Usage: npm run test:affected <files> [--run] [--depth=N]");
    console.error("");
    console.error("Options:");
    console.error("  --run         Run tests after selection (requires Vitest)");
    console.error("  --depth=N     Set transitive dependency depth (default: 1)");
    console.error("");
    console.error("Examples:");
    console.error("  npm run test:affected src/utils/units.ts");
    console.error("  npm run test:affected src/engine/calculations/\\*.ts --run");
    console.error("  npm run test:affected src/context/BuildingContext.tsx --depth=2 --run");
    process.exit(0);
  }

  const runTests = args.includes("--run");
  const depthArg = args.find((a) => a.startsWith("--depth="));
  const depth = depthArg ? parseInt(depthArg.split("=")[1]) : 1;

  // Filter out flag arguments
  const changedFiles = args.filter((a) => !a.startsWith("--run") && !a.startsWith("--depth="));

  console.error("🧪 Test Affected Selector");
  console.error(`📁 Changed files: ${changedFiles.length}`);
  console.error(`🔄 Dependency depth: ${depth}`);
  console.error(`▶️  Auto-run: ${runTests ? "YES" : "NO"}\n`);

  try {
    // Create in-memory graph index
    console.error("📊 Building test dependency map...");
    const index = new GraphIndexManager();
    const testEngine = new TestEngine(index);
    console.error("✅ Ready\n");

    // Select affected tests
    console.error("🔍 Analyzing dependencies...\n");
    const result = testEngine.selectAffectedTests(changedFiles, true, depth);

    // Display results
    if (result.selectedTests.length === 0) {
      console.error("ℹ️  No tests directly affected by these changes");
      console.error(
        "   (Possibly: new file, not imported by tests, or test dependencies not built)",
      );
      process.exit(0);
    }

    console.error(`✅ Selected ${result.selectedTests.length} test(s):`);
    console.error("");
    result.selectedTests.forEach((test) => {
      console.error(`   📄 ${test}`);
    });

    console.error("");
    console.error("📊 Statistics:");
    console.error(
      `   Coverage: ${result.coverage.percentage}% (${result.coverage.testsSelected}/${result.coverage.totalTests})`,
    );
    console.error(`   Category: ${result.category}`);
    console.error(
      `   Est. time: ${result.estimatedTime > 0 ? result.estimatedTime + "ms" : "unknown"}`,
    );
    console.error("");

    // Optionally run tests
    if (runTests) {
      console.error("\u25b6\ufe0f  Running selected tests...\n");
      try {
        const config = await loadConfig();
        const runner = config.testing?.testRunner;
        const testList = result.selectedTests.join(" ");

        let runCmd: string;
        if (runner) {
          // Explicit runner from .lxrag/config.json
          const runnerArgs = [...(runner.args ?? []), ...result.selectedTests].join(" ");
          runCmd = `${runner.command} ${runnerArgs}`;
        } else {
          // Auto-detect from test file extensions
          const hasPy = result.selectedTests.some((f) => f.endsWith(".py"));
          const hasRb = result.selectedTests.some((f) => f.endsWith(".rb"));
          const hasGo = result.selectedTests.some((f) => f.endsWith(".go"));
          if (hasPy) {
            runCmd = `pytest ${testList}`;
          } else if (hasRb) {
            runCmd = `bundle exec rspec ${testList}`;
          } else if (hasGo) {
            runCmd = `go test ${testList}`;
          } else {
            // Default: vitest (JS/TS)
            runCmd = `npx vitest run ${testList}`;
          }
        }

        console.error(`\u25b6\ufe0f  ${runCmd}`);
        execSync(runCmd, {
          cwd: process.cwd(),
          stdio: "inherit",
        });
        console.error("\n\u2705 Tests completed successfully");
        process.exit(0);
      } catch (_error) {
        console.error("\n\u274c Some tests failed");
        process.exit(1);
      }
    } else {
      console.error("💡 To run these tests, add --run flag:");
      console.error(`   npm run test:affected ${changedFiles.join(" ")} --run`);
      console.error("");
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
