#!/usr/bin/env node
/**
 * Deep audit: check IMPORT node details and why REFERENCES may be missing.
 */
const neo4j = require("neo4j-driver");
const PROJECT = "lxDIG-MCP";

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
    // Check IMPORT node details
    await q(
      "IMPORT sample",
      `
      MATCH (imp:IMPORT) WHERE imp.projectId = '${PROJECT}'
      RETURN imp.source AS source, imp.id AS id LIMIT 10
    `,
    );

    // All REFERENCES across entire graph (not just project)
    await q(
      "REFERENCES total all projects",
      `
      MATCH (a)-[:REFERENCES]->(b) RETURN count(*) AS total
    `,
    );

    // IMPORTS in lxDIG-MCP that have a REFERENCES rel
    await q(
      "IMPORTs with REFERENCES",
      `
      MATCH (imp:IMPORT)-[:REFERENCES]->(f:FILE)
      WHERE imp.projectId = '${PROJECT}'
      RETURN count(imp) AS cnt
    `,
    );

    // Graph_TX node properties in detail
    await q(
      "GRAPH_TX full properties",
      `
      MATCH (tx:GRAPH_TX) WHERE tx.projectId = '${PROJECT}'
      RETURN tx LIMIT 3
    `,
    );

    // COMMUNITY: what nodes are in the 'misc' community
    await q(
      "MISC community members sample",
      `
      MATCH (c:COMMUNITY {label: 'misc', projectId: '${PROJECT}'})-[:CONTAINS]->(n)
      RETURN labels(n)[0] AS label, n.name AS name, n.path AS path
      LIMIT 20
    `,
    );

    // How many community memberships via BELONGS_TO
    await q(
      "BELONGS_TO with community labels",
      `
      MATCH (n)-[:BELONGS_TO]->(c:COMMUNITY)
      WHERE c.projectId = '${PROJECT}'
      RETURN c.label AS community, count(n) AS memberCount
      ORDER BY memberCount DESC
      LIMIT 15
    `,
    );

    // Check SECTION.title population
    await q(
      "SECTION with title",
      `
      MATCH (s:SECTION) WHERE s.projectId = '${PROJECT}' AND s.title IS NOT NULL
      RETURN count(s) AS withTitle
    `,
    );

    // DOCUMENT details
    await q(
      "DOCUMENT sample",
      `
      MATCH (d:DOCUMENT) WHERE d.projectId = '${PROJECT}'
      RETURN d.path AS path, d.workspaceRoot AS wr, d.relativePath AS relPath
      LIMIT 5
    `,
    );

    // FUNCTION has path?
    await q(
      "FUNCTION with path",
      `
      MATCH (f:FUNCTION) WHERE f.projectId = '${PROJECT}'
      RETURN f.name AS name, f.path AS path LIMIT 5
    `,
    );

    // Check for in-memory fallback nodes (cachedNodes=448)
    // What's in lexDIG-visual?
    await q(
      "lexDIG-visual node census",
      `
      MATCH (n) WHERE n.projectId = 'lexDIG-visual'
      RETURN labels(n)[0] AS label, count(*) AS cnt ORDER BY cnt DESC
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
