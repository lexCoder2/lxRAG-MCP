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

export async function runPPR(
  opts: PPROptions,
  client: MemgraphClient,
): Promise<PPRResult[]> {
  const seedIds = [...new Set((opts.seedIds || []).filter(Boolean))];
  if (!seedIds.length) {
    return [];
  }

  const maxResults = Math.max(1, Math.min(opts.maxResults || 50, 500));
  const damping = Number.isFinite(opts.damping) ? Number(opts.damping) : 0.85;
  const iterations = Math.max(1, Math.min(opts.iterations || 20, 100));
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
    if (!fromId || !toId) {
      continue;
    }

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

    if (!outgoing.has(fromId)) {
      outgoing.set(fromId, []);
    }
    outgoing.get(fromId)!.push({ to: toId, weight });
  }

  for (const seed of seedIds) {
    if (!nodeMeta.has(seed)) {
      nodeMeta.set(seed, {
        type: "UNKNOWN",
        filePath: "",
        name: seed,
      });
    }
  }

  const nodeList = [...nodes];
  const nodeCount = nodeList.length || 1;
  const personalization = new Map<string, number>();
  const seedWeight = 1 / seedIds.length;
  for (const nodeId of nodeList) {
    personalization.set(nodeId, seedIds.includes(nodeId) ? seedWeight : 0);
  }

  let rank = new Map<string, number>();
  const uniform = 1 / nodeCount;
  for (const nodeId of nodeList) {
    rank.set(nodeId, uniform);
  }

  const incoming = new Map<string, Array<{ from: string; weight: number }>>();
  for (const [from, edges] of outgoing.entries()) {
    for (const edge of edges) {
      if (!incoming.has(edge.to)) {
        incoming.set(edge.to, []);
      }
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
        const sumWeights = fromOutgoing.reduce((sum, item) => sum + item.weight, 0);
        if (sumWeights > 0) {
          propagated += (fromRank * edge.weight) / sumWeights;
        }
      }

      const p = personalization.get(nodeId) || 0;
      const score = (1 - damping) * p + damping * propagated;
      next.set(nodeId, score);
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
      } as PPRResult;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
