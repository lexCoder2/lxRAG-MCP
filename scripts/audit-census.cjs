#!/usr/bin/env node
/**
 * Audit census script: collects node/relationship/structure data
 * for the lxRAG-MCP self-audit.
 */

const neo4j = require("neo4j-driver");

async function run() {
  const driver = neo4j.driver(
    "bolt://localhost:7687",
    neo4j.auth.basic("", ""),
  );
  const session = driver.session();

  const q = async (label, cypher, params = {}) => {
    console.log(`\n=== ${label} ===`);
    const r = await session.run(cypher, params);
    const rows = r.records.map((rec) => {
      const obj = {};
      rec.keys.forEach((k) => {
        const v = rec.get(k);
        obj[k] = typeof v?.toNumber === "function" ? v.toNumber() : v;
      });
      return obj;
    });
    console.log(JSON.stringify(rows, null, 2));
    return rows;
  };

  try {
    // 1. Node census by label
    await q(
      "NODE CENSUS",
      `
      MATCH (n) WHERE n.projectId IS NOT NULL
      RETURN labels(n)[0] AS label, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // 2. Relationship census by type
    await q(
      "REL CENSUS",
      `
      MATCH (a)-[r]->(b) WHERE a.projectId IS NOT NULL
      RETURN type(r) AS relType, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // 3. Projects indexed
    await q(
      "PROJECTS",
      `
      MATCH (f:File) WHERE f.projectId IS NOT NULL
      RETURN f.projectId AS projectId, count(f) AS fileCount
      ORDER BY fileCount DESC
      LIMIT 10
    `,
    );

    // 4. SECTION nodes with null/missing relativePath
    await q(
      "SECTION nodes missing relativePath",
      `
      MATCH (s:Section)
      WHERE s.projectId = 'lxRAG-MCP' AND s.relativePath IS NULL
      RETURN count(s) AS missingRelativePath
    `,
    );

    // 5. SECTION total
    await q(
      "SECTION total lxRAG-MCP",
      `
      MATCH (s:Section) WHERE s.projectId = 'lxRAG-MCP'
      RETURN count(s) AS total
    `,
    );

    // 6. FILE nodes (check for duplicate / relative paths)
    await q(
      "FILE sample lxRAG-MCP",
      `
      MATCH (f:File) WHERE f.projectId = 'lxRAG-MCP'
      RETURN f.path AS path
      ORDER BY path
      LIMIT 20
    `,
    );

    // 7. VIOLATION nodes present?
    await q(
      "VIOLATION nodes",
      `
      MATCH (v:Violation) WHERE v.projectId = 'lxRAG-MCP'
      RETURN count(v) AS total,
             count(DISTINCT v.file) AS distinctFiles
    `,
    );

    // 8. Community nodes
    await q(
      "COMMUNITY nodes",
      `
      MATCH (c:Community) WHERE c.projectId = 'lxRAG-MCP'
      RETURN c.label AS label, c.memberCount AS memberCount,
             c.size AS size
      ORDER BY c.memberCount DESC
      LIMIT 20
    `,
    );

    // 9. REFERENCES relationships (for F11)
    await q(
      "REFERENCES relationships",
      `
      MATCH (a)-[:REFERENCES]->(b)
      WHERE a.projectId = 'lxRAG-MCP'
      RETURN count(*) AS total
    `,
    );

    // 10. CALLS / IMPORTS relationship totals
    await q(
      "CALLS and IMPORTS",
      `
      MATCH (a)-[r:CALLS|IMPORTS]->(b)
      WHERE a.projectId = 'lxRAG-MCP'
      RETURN type(r) AS relType, count(*) AS cnt
    `,
    );

    // 11. Architecture layers in nodes
    await q(
      "LAYER values",
      `
      MATCH (n) WHERE n.projectId = 'lxRAG-MCP' AND n.layer IS NOT NULL
      RETURN n.layer AS layer, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // 12. Embedding coverage: nodes with embedding vs without
    await q(
      "EMBEDDING coverage",
      `
      MATCH (n) WHERE n.projectId = 'lxRAG-MCP'
        AND n:Function OR n:Class OR n:File
      RETURN
        count(CASE WHEN n.embedding IS NOT NULL THEN 1 END) AS withEmbedding,
        count(CASE WHEN n.embedding IS NULL THEN 1 END) AS withoutEmbedding
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
