#!/usr/bin/env node

/**
 * Graph Build CLI
 * Builds the code graph from a workspace's source files.
 *
 * Usage:
 *   npm run graph:build
 *   npm run graph:build -- --full
 *   npm run graph:build -- --verbose
 */

import * as path from "path";
import * as fs from "fs";
import { GraphOrchestrator } from "../graph/orchestrator.js";
import MemgraphClient from "../graph/client.js";
import * as env from "../env.js";

async function main() {
  const args = process.argv.slice(2);
  const isFullBuild = args.includes("--full");
  const isVerbose = args.includes("--verbose");
  const projectRoot = path.resolve(process.cwd());

  console.error("🔨 Code Graph Builder");
  console.error(`📁 Project root: ${projectRoot}`);
  console.error(`🔄 Build mode: ${isFullBuild ? "FULL" : "INCREMENTAL"}`);
  console.error("");

  try {
    // Initialize Memgraph client
    console.error("🔌 Connecting to Memgraph...");
    const memgraph = new MemgraphClient({
      host: env.MEMGRAPH_HOST,
      port: env.MEMGRAPH_PORT,
    });

    await memgraph.connect();
    console.error("✅ Connected to Memgraph\n");

    // Create orchestrator
    const orchestrator = new GraphOrchestrator(memgraph, isVerbose);

    // Build the graph
    console.error("📊 Building code graph...\n");
    const startTime = Date.now();

    const result = await orchestrator.build({
      mode: isFullBuild ? "full" : "incremental",
      verbose: isVerbose,
      sourceDir: path.join(projectRoot, "src"),
      exclude: [
        "node_modules/**",
        "dist/**",
        "build/**",
        ".lxrag/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/__tests__/**",
      ],
    });

    const duration = Date.now() - startTime;

    // Display results
    console.error("\n📈 Build Results:");
    console.error(`   ✅ Success: ${result.success}`);
    console.error(`   ⏱️  Duration: ${(duration / 1000).toFixed(2)}s`);
    console.error(`   📄 Files processed: ${result.filesProcessed}`);
    console.error(`   📍 Nodes created: ${result.nodesCreated}`);
    console.error(`   🔗 Relationships created: ${result.relationshipsCreated}`);
    if (result.filesChanged > 0) {
      console.error(`   🔄 Files changed: ${result.filesChanged}`);
    }

    if (result.errors.length > 0) {
      console.error(`\n❌ Errors (${result.errors.length}):`);
      result.errors.forEach((err) => console.error(`   - ${err}`));
    }

    if (result.warnings.length > 0) {
      console.error(`\n⚠️  Warnings (${result.warnings.length}):`);
      result.warnings.forEach((warn) => console.error(`   - ${warn}`));
    }

    // Save build metadata
    const codeGraphDir = path.join(projectRoot, ".lxrag");
    if (!fs.existsSync(codeGraphDir)) {
      fs.mkdirSync(codeGraphDir, { recursive: true });
    }

    const metadata = {
      timestamp: new Date().toISOString(),
      duration,
      mode: isFullBuild ? "full" : "incremental",
      success: result.success,
      filesProcessed: result.filesProcessed,
      nodesCreated: result.nodesCreated,
      relationshipsCreated: result.relationshipsCreated,
    };

    fs.writeFileSync(
      path.join(codeGraphDir, "build.log.json"),
      JSON.stringify(metadata, null, 2),
    );

    console.error("\n✨ Build complete!");
    console.error("   View graph at: http://localhost:3000 (Memgraph Lab)");
    console.error(
      '   Query graph: npm run graph:query "MATCH (f:FILE) RETURN count(f)"',
    );

    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
