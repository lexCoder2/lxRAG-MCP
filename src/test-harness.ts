/**
 * Test Harness for Phase 1
 * Validates parser, builder, and orchestrator functionality
 */

import * as fs from "fs";
import * as path from "path";
import TypeScriptParser from "./parsers/typescript-parser.js";
import { GraphBuilder, ParsedFile } from "./graph/builder.js";

import GraphOrchestrator from "./graph/orchestrator.js";
async function testParser(): Promise<void> {
  console.log("\n=== Testing TypeScript Parser ===");

  const parser = new TypeScriptParser();
  const testFile = path.join(process.cwd(), "src/types/building.types.ts");

  if (!fs.existsSync(testFile)) {
    console.log(`[Test] Sample file not found: ${testFile}`);
    console.log("[Test] Skipping parser test (expected for Phase 1 setup)");
    return;
  }

  try {
    const parsed = parser.parseFile(testFile);
    console.log(`[Test] ✓ Parsed: ${parsed.relativePath}`);
    console.log(`[Test] ✓ LOC: ${parsed.LOC}`);
    console.log(`[Test] ✓ Functions: ${parsed.functions.length}`);
    console.log(`[Test] ✓ Classes: ${parsed.classes.length}`);
    console.log(`[Test] ✓ Imports: ${parsed.imports.length}`);
    console.log(`[Test] ✓ Exports: ${parsed.exports.length}`);

    if (parsed.functions.length > 0) {
      console.log(`[Test] Sample function: ${parsed.functions[0].name}`);
    }
    if (parsed.classes.length > 0) {
      console.log(`[Test] Sample class: ${parsed.classes[0].name}`);
    }
  } catch (error) {
    console.error(`[Test] ✗ Parser failed: ${error}`);
    throw error;
  }
}

async function testBuilder(): Promise<void> {
  console.log("\n=== Testing Graph Builder ===");

  const parser = new TypeScriptParser();
  const builder = new GraphBuilder();
  const testFile = path.join(process.cwd(), "src/types/building.types.ts");

  if (!fs.existsSync(testFile)) {
    console.log(`[Test] Sample file not found: ${testFile}`);
    console.log("[Test] Skipping builder test (expected for Phase 1 setup)");
    return;
  }

  try {
    const parsed = parser.parseFile(testFile) as unknown as ParsedFile;

    const statements = builder.buildFromParsedFile(parsed);
    console.log(`[Test] ✓ Generated ${statements.length} Cypher statements`);

    if (statements.length > 0) {
      const first = statements[0];
      console.log(`[Test] Sample statement (params):`, first.params);
    }
  } catch (error) {
    console.error(`[Test] ✗ Builder failed: ${error}`);
    throw error;
  }
}

async function testOrchestrator(): Promise<void> {
  console.log("\n=== Testing Graph Orchestrator ===");

  const orchestrator = new GraphOrchestrator(undefined, true);

  try {
    console.log("[Test] Building graph (incremental mode)...");
    const result = await orchestrator.build({
      mode: "incremental",
      verbose: true,
      sourceDir: "src",
      exclude: ["node_modules", "dist", ".next", ".code-graph"],
    });

    console.log("\n[Test] ✓ Build completed!");
    console.log(`[Test] Success: ${result.success}`);
    console.log(`[Test] Duration: ${result.duration}ms`);
    console.log(`[Test] Files processed: ${result.filesProcessed}`);
    console.log(`[Test] Nodes created: ${result.nodesCreated}`);
    console.log(`[Test] Relationships: ${result.relationshipsCreated}`);
    console.log(`[Test] Files changed: ${result.filesChanged}`);

    if (result.errors.length > 0) {
      console.log("[Test] Errors:");
      result.errors.forEach((e) => console.log(`  - ${e}`));
    }

    if (result.warnings.length > 0) {
      console.log("[Test] Warnings:");
      result.warnings.forEach((w) => console.log(`  - ${w}`));
    }

    // Export snapshot
    const snapshotPath = path.join(
      process.cwd(),
      ".code-graph/cache/graph.snapshot.json"
    );
    orchestrator.exportSnapshot(snapshotPath);
    console.log(`[Test] ✓ Snapshot saved to ${snapshotPath}`);
  } catch (error) {
    console.error(`[Test] ✗ Orchestrator failed: ${error}`);
    throw error;
  }
}

async function runAllTests(): Promise<void> {
  console.log("========================================");
  console.log("Phase 1: Code Graph MVP - Test Harness");
  console.log("========================================");

  try {
    await testParser();
    await testBuilder();
    await testOrchestrator();

    console.log("\n========================================");
    console.log("✓ All tests completed!");
    console.log("========================================");
    console.log("\nNext steps:");
    console.log("1. Verify node and relationship counts");
    console.log("2. Check .code-graph/cache/file-hashes.json for cached files");
    console.log('3. Run: npm run graph:query "MATCH (n) RETURN count(n)"');
    console.log(
      "4. Start Memgraph: docker-compose -f tools/docker/docker-compose.yml up -d"
    );
    console.log("5. Load graph: npm run graph:load");
  } catch (error) {
    console.error("\n✗ Test suite failed!");
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(console.error);
