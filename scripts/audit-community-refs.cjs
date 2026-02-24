#!/usr/bin/env node
/**
 * Audit: community membership types and REFERENCES root cause
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
    // What node types are in misc?
    await q(
      "MISC community membership by type",
      `
      MATCH (n)-[:BELONGS_TO]->(c:COMMUNITY {label: 'misc', projectId: '${PROJECT}'})
      RETURN labels(n)[0] AS nodeType, count(*) AS cnt
      ORDER BY cnt DESC
    `,
    );

    // REFERENCES: why they don't exist for lxRAG-MCP
    // Check if IMPORTs have 'source' ending in .js
    await q(
      "IMPORT source extensions breakdown",
      `
      MATCH (imp:IMPORT) WHERE imp.projectId = '${PROJECT}'
      RETURN
        sum(CASE WHEN imp.source ENDS WITH '.js' THEN 1 ELSE 0 END) AS jsExtension,
        sum(CASE WHEN imp.source ENDS WITH '.ts' THEN 1 ELSE 0 END) AS tsExtension,
        sum(CASE WHEN imp.source STARTS WITH '.' THEN 1 ELSE 0 END) AS relativeImports,
        sum(CASE WHEN NOT imp.source STARTS WITH '.' THEN 1 ELSE 0 END) AS externalImports
    `,
    );

    // IMPORT sources that are relative (should resolve)
    await q(
      "Relative IMPORT sources sample",
      `
      MATCH (imp:IMPORT) WHERE imp.projectId = '${PROJECT}'
        AND imp.source STARTS WITH '.'
      RETURN imp.source AS source, imp.id AS id
      ORDER BY source
      LIMIT 15
    `,
    );

    // Are there any FILE nodes with .js extension?
    await q(
      "FILE nodes .js vs .ts extension",
      `
      MATCH (f:FILE) WHERE f.projectId = '${PROJECT}'
      RETURN
        sum(CASE WHEN f.path ENDS WITH '.ts' THEN 1 ELSE 0 END) AS tsFiles,
        sum(CASE WHEN f.path ENDS WITH '.js' THEN 1 ELSE 0 END) AS jsFiles,
        sum(CASE WHEN f.path ENDS WITH '.md' THEN 1 ELSE 0 END) AS mdFiles
    `,
    );

    // IMPORTS that resolve vs don't
    await q(
      "IMPORTS with vs without REFERENCES",
      `
      MATCH (imp:IMPORT) WHERE imp.projectId = '${PROJECT}'
        AND imp.source STARTS WITH '.'
      OPTIONAL MATCH (imp)-[:REFERENCES]->(target)
      RETURN
        count(CASE WHEN target IS NOT NULL THEN 1 END) AS resolved,
        count(CASE WHEN target IS NULL THEN 1 END) AS unresolved
    `,
    );

    // Verify: what FILE node IDs are used?
    await q(
      "FILE node ID pattern",
      `
      MATCH (f:FILE) WHERE f.projectId = '${PROJECT}'
      RETURN f.id AS id, f.path AS path LIMIT 5
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
