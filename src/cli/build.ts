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
import { logger } from "../utils/logger.js";

async function main() {
  const args = process.argv.slice(2);
  const isFullBuild = args.includes("--full");
  const isVerbose = args.includes("--verbose");
  const projectRoot = path.resolve(process.cwd());

  logger.error("🔨 Code Graph Builder");
  logger.error(`📁 Project root: ${projectRoot}`);
  logger.error(`🔄 Build mode: ${isFullBuild ? "FULL" : "INCREMENTAL"}`);
  logger.error("");

  try {
    // Initialize Memgraph client
    logger.error("🔌 Connecting to Memgraph...");
    const memgraph = new MemgraphClient({
      host: env.MEMGRAPH_HOST,
      port: env.MEMGRAPH_PORT,
    });

    await memgraph.connect();
    logger.error("✅ Connected to Memgraph\n");

    // Create orchestrator
    const orchestrator = new GraphOrchestrator(memgraph, isVerbose);

    // Build the graph
    logger.error("📊 Building code graph...\n");
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
    logger.error("\n📈 Build Results:");
    logger.error(`   ✅ Success: ${result.success}`);
    logger.error(`   ⏱️  Duration: ${(duration / 1000).toFixed(2)}s`);
    logger.error(`   📄 Files processed: ${result.filesProcessed}`);
    logger.error(`   📍 Nodes created: ${result.nodesCreated}`);
    logger.error(`   🔗 Relationships created: ${result.relationshipsCreated}`);
    if (result.filesChanged > 0) {
      logger.error(`   🔄 Files changed: ${result.filesChanged}`);
    }

    if (result.errors.length > 0) {
      logger.error(`\n❌ Errors (${result.errors.length}):`);
      result.errors.forEach((err) => logger.error(`   - ${err}`));
    }

    if (result.warnings.length > 0) {
      logger.error(`\n⚠️  Warnings (${result.warnings.length}):`);
      result.warnings.forEach((warn) => logger.error(`   - ${warn}`));
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

    fs.writeFileSync(path.join(codeGraphDir, "build.log.json"), JSON.stringify(metadata, null, 2));

    logger.error("\n✨ Build complete!");
    logger.error("   View graph at: http://localhost:3000 (Memgraph Lab)");
    logger.error('   Query graph: npm run graph:query "MATCH (f:FILE) RETURN count(f)"');

    // Exit with appropriate code
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    logger.error("❌ Build failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
