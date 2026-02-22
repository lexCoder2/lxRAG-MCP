#!/usr/bin/env node

/**
 * Clean up Memgraph - delete all nodes and relationships
 */

const neo4j = require("neo4j-driver");

async function cleanupGraph() {
  const driver = neo4j.driver(
    "bolt://localhost:7687",
    neo4j.auth.basic("", ""),
  );

  try {
    const session = driver.session();

    console.log("🧹 Cleaning Memgraph...");

    // Delete all nodes (which cascades to delete all relationships)
    const result = await session.run("MATCH (n) DETACH DELETE n");

    console.log(
      `✅ Cleaned! Deleted ${result.summary.counters.updates().nodesDeleted} nodes`,
    );

    // Verify it's empty
    const verify = await session.run("MATCH (n) RETURN count(n) as count");
    const count = verify.records[0].get("count").toNumber();

    if (count === 0) {
      console.log("✅ Graph is now empty and ready for fresh indexing");
    } else {
      console.warn(`⚠️  Warning: ${count} nodes still exist`);
    }

    await session.close();
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await driver.close();
  }
}

cleanupGraph();
