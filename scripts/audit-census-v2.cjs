#!/usr/bin/env node
/**
 * Audit census with correct uppercase labels for Memgraph.
 */

const neo4j = require("neo4j-driver");
const PROJECT = "lxRAG-MCP";

async function run() {
  const driver = neo4j.driver(
    "bolt://localhost:7687",
    neo4j.auth.basic("", ""),
  );
  const session = driver.session();

  const q = async (label, cypher) => {
    console.log(`\n=== ${label} ===`);
    try {
      const r = await session.run(cypher);
      const rows = r.records.map((rec) => {
        const obj = {};
        rec.keys.forEach((k) => {
          const v = rec.get(k);
          obj[k] =
            v && typeof v.toNumber === "function"
              ? v.toNumber()
              : v && typeof v.toInt === "function"
                ? v.toInt()
                : v;
        });
        return obj;
      });
      console.log(JSON.stringify(rows, null, 2));
      return rows;
    } catch (e) {
      console.log(`[QUERY ERROR] ${e.message}`);
      return [];
    }
  };

  try {
    // 1. Node census by label
    await q(
      "NODE CENSUS (lxRAG-MCP)",
      `
      MATCH (n) WHERE n.projectId = '${PROJECT}'
      RETURN labels(n)[0] AS label, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // 2. Relationship census
    await q(
      "REL CENSUS (lxRAG-MCP)",
      `
      MATCH (a)-[r]->(b) WHERE a.projectId = '${PROJECT}'
      RETURN type(r) AS relType, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // 3. FILE node paths sample
    await q(
      "FILE paths sample",
      `
      MATCH (f:FILE) WHERE f.projectId = '${PROJECT}'
      RETURN f.path AS path ORDER BY path LIMIT 15
    `,
    );

    // 4. SECTION missing relativePath
    await q(
      "SECTION missing relativePath",
      `
      MATCH (s:SECTION) WHERE s.projectId = '${PROJECT}' AND s.relativePath IS NULL
      RETURN count(s) AS missing
    `,
    );

    // 5. SECTION total + sample
    await q(
      "SECTION total",
      `
      MATCH (s:SECTION) WHERE s.projectId = '${PROJECT}'
      RETURN count(s) AS total
    `,
    );

    await q(
      "SECTION sample",
      `
      MATCH (s:SECTION) WHERE s.projectId = '${PROJECT}'
      RETURN s.title AS title, s.relativePath AS relPath, s.workspaceRoot AS wr
      LIMIT 5
    `,
    );

    // 6. VIOLATION nodes
    await q(
      "VIOLATION nodes",
      `
      MATCH (v:VIOLATION) WHERE v.projectId = '${PROJECT}'
      RETURN count(v) AS total, count(DISTINCT v.file) AS distinctFiles
    `,
    );

    // 7. COMMUNITY labels
    await q(
      "COMMUNITY nodes",
      `
      MATCH (c:COMMUNITY) WHERE c.projectId = '${PROJECT}'
      RETURN c.label AS label, c.memberCount AS memberCount, c.size AS size
      ORDER BY c.memberCount DESC LIMIT 10
    `,
    );

    // 8. REFERENCES relationships
    await q(
      "REFERENCES rels",
      `
      MATCH (a)-[:REFERENCES]->(b)
      WHERE a.projectId = '${PROJECT}'
      RETURN count(*) AS total
    `,
    );

    // 9. Embeddings
    await q(
      "EMBEDDINGS coverage",
      `
      MATCH (n:FUNCTION) WHERE n.projectId = '${PROJECT}'
      RETURN
        sum(CASE WHEN n.embedding IS NOT NULL THEN 1 ELSE 0 END) AS withEmb,
        sum(CASE WHEN n.embedding IS NULL THEN 1 ELSE 0 END) AS withoutEmb
    `,
    );

    // 10. Layer values
    await q(
      "LAYER values",
      `
      MATCH (n) WHERE n.projectId = '${PROJECT}' AND n.layer IS NOT NULL
      RETURN n.layer AS layer, count(*) AS cnt ORDER BY cnt DESC
    `,
    );

    // 11. Architecture config stored in graph?
    await q(
      "GRAPH_TX latest",
      `
      MATCH (tx:GRAPH_TX) WHERE tx.projectId = '${PROJECT}'
      RETURN tx.txId AS txId, tx.mode AS mode, tx.timestamp AS ts, tx.status AS status
      ORDER BY tx.timestamp DESC LIMIT 5
    `,
    );

    // 12. Class nodes sample (check workspaceRoot)
    await q(
      "CLASS sample",
      `
      MATCH (c:CLASS) WHERE c.projectId = '${PROJECT}'
      RETURN c.name AS name, c.path AS path, c.layer AS layer LIMIT 10
    `,
    );

    // 13. Duplicate FILE nodes (relative vs absolute path check)
    await q(
      "FILE duplicate path check",
      `
      MATCH (f:FILE) WHERE f.projectId = '${PROJECT}'
      RETURN
        sum(CASE WHEN f.path STARTS WITH '/' THEN 1 ELSE 0 END) AS absolutePaths,
        sum(CASE WHEN NOT f.path STARTS WITH '/' THEN 1 ELSE 0 END) AS relativePaths
    `,
    );
  } catch (err) {
    console.error("FATAL:", err.message);
  } finally {
    await session.close();
    await driver.close();
  }
}

run();
