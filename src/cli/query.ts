#!/usr/bin/env node

/**
 * Graph Query CLI
 * Execute Cypher queries against the code graph
 *
 * Usage:
 *   npm run graph:query "MATCH (f:FILE) RETURN count(f)"
 *   npm run graph:query "find all functions named create*"
 */

import MemgraphClient from "../graph/client.js";
import * as env from "../env.js";

async function main() {
  const args = process.argv.slice(2);
  const query = args.join(" ");

  if (!query) {
    console.error("❌ No query provided");
    console.error('Usage: npm run graph:query "MATCH (n) RETURN n LIMIT 5"');
    process.exit(1);
  }

  try {
    console.error("🔍 Executing query...\n");

    const memgraph = new MemgraphClient({
      host: env.MEMGRAPH_HOST,
      port: env.MEMGRAPH_PORT,
    });

    await memgraph.connect();

    const result = await memgraph.executeCypher(query);

    if (result.error) {
      console.error("❌ Query error:", result.error);
      process.exit(1);
    }

    // Display results
    if (result.data.length === 0) {
      console.error("📭 No results found");
    } else {
      console.error(`📊 Results (${result.data.length} rows):\n`);
      console.table(result.data);
    }

    await memgraph.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Query failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
