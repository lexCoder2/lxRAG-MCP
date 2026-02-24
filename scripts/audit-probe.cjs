#!/usr/bin/env node
/**
 * Check what projectId values actually exist in Memgraph.
 */

const neo4j = require("neo4j-driver");

async function run() {
  const driver = neo4j.driver(
    "bolt://localhost:7687",
    neo4j.auth.basic("", ""),
  );
  const session = driver.session();

  const q = async (label, cypher) => {
    console.log(`\n=== ${label} ===`);
    const r = await session.run(cypher);
    const rows = r.records.map((rec) => {
      const obj = {};
      rec.keys.forEach((k) => {
        const v = rec.get(k);
        obj[k] = typeof v?.toNumber === "function" ? v.toNumber() : v;
      });
      return obj;
    });
    console.log(JSON.stringify(rows, null, 2));
  };

  try {
    await q(
      "DISTINCT projectId values",
      `
      MATCH (n) WHERE n.projectId IS NOT NULL
      RETURN DISTINCT n.projectId AS projectId, count(*) AS cnt
      ORDER BY cnt DESC
      LIMIT 20
    `,
    );

    await q(
      "Sample node with properties",
      `
      MATCH (n:File) RETURN n LIMIT 3
    `,
    );

    await q(
      "Sample FILE path values",
      `
      MATCH (n:File) RETURN n.path AS path, n.projectId AS pid LIMIT 10
    `,
    );

    await q(
      "Total nodes no filter",
      `
      MATCH (n) RETURN count(n) AS total
    `,
    );

    await q(
      "Community nodes no filter",
      `
      MATCH (c:Community) RETURN c LIMIT 5
    `,
    );

    await q(
      "File nodes with workspaceRoot",
      `
      MATCH (n:File) RETURN n.workspaceRoot AS wr, count(*) AS cnt
      ORDER BY cnt DESC LIMIT 5
    `,
    );
  } catch (err) {
    console.error("ERROR:", err.message);
  } finally {
    await session.close();
    await driver.close();
  }
}

run();
