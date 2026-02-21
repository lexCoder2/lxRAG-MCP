#!/usr/bin/env node

/**
 * Graph Query CLI
 * Execute Cypher queries against the code graph
 *
 * Usage:
 *   npm run graph:query "MATCH (f:FILE) RETURN count(f)"
 *   npm run graph:query "find all functions named create*"
 */

import MemgraphClient from '../graph/client.js';

async function main() {
  const args = process.argv.slice(2);
  const query = args.join(' ');

  if (!query) {
    console.error('❌ No query provided');
    console.error('Usage: npm run graph:query "MATCH (n) RETURN n LIMIT 5"');
    process.exit(1);
  }

  try {
    console.log('🔍 Executing query...\n');

    const memgraph = new MemgraphClient({
      host: process.env.MEMGRAPH_HOST || 'localhost',
      port: parseInt(process.env.MEMGRAPH_PORT || '7687'),
    });

    await memgraph.connect();

    const result = await memgraph.executeCypher(query);

    if (result.error) {
      console.error('❌ Query error:', result.error);
      process.exit(1);
    }

    // Display results
    if (result.data.length === 0) {
      console.log('📭 No results found');
    } else {
      console.log(`📊 Results (${result.data.length} rows):\n`);
      console.table(result.data);
    }

    await memgraph.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Query failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
