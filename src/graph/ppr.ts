/**
 * @file graph/ppr
 * @description Personalized PageRank scoring utilities for graph-based relevance ranking.
 * @remarks Used by context-pack style retrieval pipelines to prioritize connected symbols.
 */

import type MemgraphClient from "./client.js";

export interface PPROptions {
  seedIds: string[];
  edgeWeights?: Record<string, number>;
  damping?: number;
  iterations?: number;
  maxResults?: number;
  projectId: string;
}

export interface PPRResult {
  nodeId: string;
  score: number;
  type: string;
  filePath: string;
  name: string;
  pprMode?: "mage_pagerank" | "js_ppr";
}

const DEFAULT_EDGE_WEIGHTS: Record<string, number> = {
  CALLS: 0.9,
  IMPORTS: 0.7,
  CONTAINS: 0.5,
  TESTS: 0.4,
  DEFINED_IN: 0.6,
  INVOLVES: 0.3,
  APPLIES_TO: 0.4,
};

/**
 * PPR via MAGE pagerank + Cypher seed expansion.
 *
 * Strategy:
 *  1. Fetch Memgraph-native pagerank prestige scores via CALL pagerank.get()
 *  2. Expand seed nodes up to 3 hops via Cypher — no full edge download
 *  3. score = prestige*(1-damping) + proximity_boost*damping
 *
 * Falls back to JS power-iteration when MAGE is unavailable or graph is empty.
 */
export async function runPPR(opts: PPROptions, client: MemgraphClient): Promise<PPRResult[]> {
  const seedIds = [...new Set((opts.seedIds || []).filter(Boolean))];
  if (!seedIds.length) return [];

  const maxResults = Math.max(1, Math.min(opts.maxResults || 50, 500));
  const damping = Number.isFinite(opts.damping) ? Number(opts.damping) : 0.85;
  const iterations = Math.max(1, Math.min(opts.iterations || 20, 100));

  const mageResult = await tryMagePPR(opts, client, seedIds, maxResults, damping);
  if (mageResult) return mageResult;

  return runJsPPR(opts, client, seedIds, maxResults, damping, iterations);
}

// ---------------------------------------------------------------------------
// MAGE path
// ---------------------------------------------------------------------------
async function tryMagePPR(
  opts: PPROptions,
  client: MemgraphClient,
  seedIds: string[],
  maxResults: number,
  damping: number,
): Promise<PPRResult[] | null> {
  try {
    // 1. Global pagerank on the project subgraph (Memgraph-native, scales to 1M+ nodes)
    const pagerankRes = await client.executeCypher(
      `CALL pagerank.get()
       YIELD node, rank
       WHERE node.projectId = $projectId
         AND (node:FILE OR node:FUNCTION OR node:CLASS)
       RETURN toString(node.id) AS nodeId,
              toFloat(rank) AS rank,
              labels(node)[0] AS type,
              coalesce(node.path, node.filePath, '') AS filePath,
              coalesce(node.name, node.id) AS name`,
      { projectId: opts.projectId },
    );

    if (pagerankRes.error || !Array.isArray(pagerankRes.data) || pagerankRes.data.length === 0) {
      return null;
    }

    const prestige = new Map<string, number>();
    const nodeMeta = new Map<string, { type: string; filePath: string; name: string }>();
    for (const row of pagerankRes.data) {
      const id = String(row.nodeId || "");
      if (!id) continue;
      prestige.set(id, Number(row.rank || 0));
      nodeMeta.set(id, {
        type: String(row.type || "UNKNOWN"),
        filePath: String(row.filePath || ""),
        name: String(row.name || id),
      });
    }

    // 2. Seed proximity via variable-length Cypher path (1–3 hops)
    const proximityRes = await client.executeCypher(
      `UNWIND $seedIds AS seedId
       MATCH (seed {id: seedId, projectId: $projectId})
       MATCH p = (seed)-[*1..3]-(neighbor)
       WHERE neighbor.projectId = $projectId
         AND (neighbor:FILE OR neighbor:FUNCTION OR neighbor:CLASS)
       RETURN DISTINCT toString(neighbor.id) AS nodeId,
                        min(length(p)) AS hops`,
      { seedIds, projectId: opts.projectId },
    );

    // hop → proximity score: 1=1.0, 2=0.6, 3=0.3
    const hopScore: Record<number, number> = { 1: 1.0, 2: 0.6, 3: 0.3 };
    const proximity = new Map<string, number>();
    for (const sid of seedIds) proximity.set(sid, 2.0); // seeds get highest boost
    for (const row of proximityRes.data || []) {
      const id = String(row.nodeId || "");
      if (!id) continue;
      const current = proximity.get(id) ?? 0;
      const h = Number(row.hops || 3);
      proximity.set(id, Math.max(current, hopScore[h] ?? 0.1));
    }

    // 3. Combine: final = prestige*(1−damping) + proximity*damping
    const scores: PPRResult[] = [];
    const allIds = new Set([...prestige.keys(), ...proximity.keys()]);
    for (const nodeId of allIds) {
      const p = prestige.get(nodeId) ?? 0;
      const prox = proximity.get(nodeId) ?? 0;
      const score = p * (1 - damping) + prox * damping;
      const meta = nodeMeta.get(nodeId);
      scores.push({
        nodeId,
        score: Number(score.toFixed(6)),
        type: meta?.type ?? "UNKNOWN",
        filePath: meta?.filePath ?? "",
        name: meta?.name ?? nodeId,
        pprMode: "mage_pagerank",
      });
    }

    return scores.sort((a, b) => b.score - a.score).slice(0, maxResults);
  } catch {
    // MAGE not available — fall through
    return null;
  }
}

// ---------------------------------------------------------------------------
// JS power-iteration fallback (original, preserved for compatibility)
// ---------------------------------------------------------------------------
async function runJsPPR(
  opts: PPROptions,
  client: MemgraphClient,
  seedIds: string[],
  maxResults: number,
  damping: number,
  iterations: number,
): Promise<PPRResult[]> {
  const edgeWeights = { ...DEFAULT_EDGE_WEIGHTS, ...(opts.edgeWeights || {}) };

  const edgeResult = await client.executeCypher(
    `MATCH (a)-[r]->(b)
     WHERE a.projectId = $projectId AND b.projectId = $projectId
     RETURN a.id AS fromId,
            b.id AS toId,
            labels(a)[0] AS fromType,
            labels(b)[0] AS toType,
            type(r) AS relType,
            coalesce(a.path, a.filePath, '') AS fromPath,
            coalesce(b.path, b.filePath, '') AS toPath,
            coalesce(a.name, a.id) AS fromName,
            coalesce(b.name, b.id) AS toName
     LIMIT 20000`,
    { projectId: opts.projectId },
  );

  const nodes = new Set<string>(seedIds);
  const nodeMeta = new Map<string, { type: string; filePath: string; name: string }>();
  const outgoing = new Map<string, Array<{ to: string; weight: number }>>();

  for (const row of edgeResult.data || []) {
    const fromId = String(row.fromId || "");
    const toId = String(row.toId || "");
    if (!fromId || !toId) continue;

    const relType = String(row.relType || "");
    const weight = Number(edgeWeights[relType] || 0.2);

    nodes.add(fromId);
    nodes.add(toId);

    if (!nodeMeta.has(fromId)) {
      nodeMeta.set(fromId, {
        type: String(row.fromType || "UNKNOWN"),
        filePath: String(row.fromPath || ""),
        name: String(row.fromName || fromId),
      });
    }
    if (!nodeMeta.has(toId)) {
      nodeMeta.set(toId, {
        type: String(row.toType || "UNKNOWN"),
        filePath: String(row.toPath || ""),
        name: String(row.toName || toId),
      });
    }

    if (!outgoing.has(fromId)) outgoing.set(fromId, []);
    outgoing.get(fromId)!.push({ to: toId, weight });
  }

  for (const seed of seedIds) {
    if (!nodeMeta.has(seed)) {
      nodeMeta.set(seed, { type: "UNKNOWN", filePath: "", name: seed });
    }
  }

  const nodeList = [...nodes];
  const nodeCount = nodeList.length || 1;
  const seedWeight = 1 / seedIds.length;
  const personalization = new Map<string, number>();
  for (const nodeId of nodeList) {
    personalization.set(nodeId, seedIds.includes(nodeId) ? seedWeight : 0);
  }

  let rank = new Map<string, number>();
  const uniform = 1 / nodeCount;
  for (const nodeId of nodeList) rank.set(nodeId, uniform);

  const incoming = new Map<string, Array<{ from: string; weight: number }>>();
  for (const [from, edges] of outgoing.entries()) {
    for (const edge of edges) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to)!.push({ from, weight: edge.weight });
    }
  }

  for (let i = 0; i < iterations; i += 1) {
    const next = new Map<string, number>();
    for (const nodeId of nodeList) {
      const inEdges = incoming.get(nodeId) || [];
      let propagated = 0;
      for (const edge of inEdges) {
        const fromRank = rank.get(edge.from) || 0;
        const fromOutgoing = outgoing.get(edge.from) || [];
        const sumWeights = fromOutgoing.reduce((s, item) => s + item.weight, 0);
        if (sumWeights > 0) propagated += (fromRank * edge.weight) / sumWeights;
      }
      const p = personalization.get(nodeId) || 0;
      next.set(nodeId, (1 - damping) * p + damping * propagated);
    }
    rank = next;
  }

  return nodeList
    .map((nodeId) => {
      const meta = nodeMeta.get(nodeId) || {
        type: "UNKNOWN",
        filePath: "",
        name: nodeId,
      };
      return {
        nodeId,
        score: Number((rank.get(nodeId) || 0).toFixed(6)),
        type: meta.type,
        filePath: meta.filePath,
        name: meta.name,
        pprMode: "js_ppr" as const,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
