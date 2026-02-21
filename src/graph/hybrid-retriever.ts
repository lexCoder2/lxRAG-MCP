import type { GraphIndexManager, GraphNode } from "./index.js";
import type EmbeddingEngine from "../vector/embedding-engine.js";

export interface RetrievalOptions {
  query: string;
  projectId: string;
  limit?: number;
  types?: string[];
  mode?: "vector" | "bm25" | "graph" | "hybrid";
  rrfK?: number;
}

interface RankedNode {
  nodeId: string;
  score: number;
  source: "vector" | "bm25" | "graph";
}

export interface RetrievalResult {
  nodeId: string;
  name: string;
  filePath: string;
  type: string;
  rrfScore: number;
  scores: { vector?: number; bm25?: number; graph?: number };
}

export class HybridRetriever {
  constructor(
    private index: GraphIndexManager,
    private embeddingEngine?: EmbeddingEngine,
  ) {}

  async retrieve(opts: RetrievalOptions): Promise<RetrievalResult[]> {
    const mode = opts.mode || "hybrid";
    const limit = Math.max(1, Math.min(opts.limit || 10, 100));
    const rrfK = opts.rrfK || 60;

    const vectorList =
      mode === "vector" || mode === "hybrid"
        ? await this.vectorSearch(opts.query, { ...opts, limit })
        : [];
    const bm25List =
      mode === "bm25" || mode === "hybrid"
        ? await this.bm25Search(opts.query, { ...opts, limit })
        : [];

    const seedIds = [...vectorList, ...bm25List]
      .map((item) => item.nodeId)
      .filter(Boolean)
      .slice(0, limit);

    const graphList =
      mode === "graph" || mode === "hybrid"
        ? await this.graphExpansion(seedIds, { ...opts, limit })
        : [];

    const fused = this.fusionRRF([vectorList, bm25List, graphList], rrfK);
    const projectScoped = this.filterByProject(fused, opts.projectId);
    const filtered = this.filterByType(projectScoped, opts.types);

    return filtered.slice(0, limit);
  }

  private async vectorSearch(
    query: string,
    opts: RetrievalOptions,
  ): Promise<RankedNode[]> {
    const limit = Math.max(1, Math.min(opts.limit || 10, 100));
    const rows: RankedNode[] = [];

    if (this.embeddingEngine) {
      try {
        const [functions, classes, files] = await Promise.all([
          this.embeddingEngine.findSimilar(query, "function", limit),
          this.embeddingEngine.findSimilar(query, "class", limit),
          this.embeddingEngine.findSimilar(query, "file", limit),
        ]);

        const merged = [...functions, ...classes, ...files];
        merged.forEach((entry, index) => {
          rows.push({
            nodeId: entry.id,
            score: 1 / (index + 1),
            source: "vector",
          });
        });
      } catch {
        // Fall through to lexical fallback
      }
    }

    if (rows.length > 0) {
      return rows.slice(0, limit);
    }

    return this.lexicalFallback(query, opts.projectId, "vector", limit);
  }

  private async bm25Search(
    query: string,
    opts: RetrievalOptions,
  ): Promise<RankedNode[]> {
    const limit = Math.max(1, Math.min(opts.limit || 10, 100));

    return this.lexicalFallback(query, opts.projectId, "bm25", limit);
  }

  private async graphExpansion(
    seedIds: string[],
    opts: RetrievalOptions,
  ): Promise<RankedNode[]> {
    const limit = Math.max(1, Math.min(opts.limit || 10, 100));
    if (!seedIds.length) {
      return [];
    }

    const weight: Record<string, number> = {
      CALLS: 0.9,
      IMPORTS: 0.7,
      CONTAINS: 0.5,
      TESTS: 0.4,
      INVOLVES: 0.3,
      APPLIES_TO: 0.4,
    };

    const scores = new Map<string, number>();

    for (const seedId of seedIds) {
      const outgoing = this.index.getRelationshipsFrom(seedId);
      const incoming = this.index.getRelationshipsTo(seedId);

      for (const rel of [...outgoing, ...incoming]) {
        const nodeId = rel.from === seedId ? rel.to : rel.from;
        const boost = weight[rel.type] || 0.2;
        scores.set(nodeId, (scores.get(nodeId) || 0) + boost);
      }
    }

    if (!scores.size) {
      return [];
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([nodeId, score]) => ({
        nodeId,
        score,
        source: "graph",
      }));
  }

  private fusionRRF(lists: RankedNode[][], k: number): RetrievalResult[] {
    const scores = new Map<string, number>();
    const sourceScores = new Map<
      string,
      { vector?: number; bm25?: number; graph?: number }
    >();

    lists.forEach((list) => {
      list.forEach((node, idx) => {
        const rank = idx + 1;
        const inc = 1 / (k + rank);
        scores.set(node.nodeId, (scores.get(node.nodeId) || 0) + inc);

        const existing = sourceScores.get(node.nodeId) || {};
        existing[node.source] = node.score;
        sourceScores.set(node.nodeId, existing);
      });
    });

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([nodeId, rrfScore]) => {
        const meta = this.nodeMeta(nodeId);
        return {
          nodeId,
          name: meta.name,
          filePath: meta.filePath,
          type: meta.type,
          rrfScore: Number(rrfScore.toFixed(6)),
          scores: sourceScores.get(nodeId) || {},
        };
      });
  }

  private lexicalFallback(
    query: string,
    projectId: string,
    source: "vector" | "bm25",
    limit: number,
  ): RankedNode[] {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 2);

    const nodes = [
      ...this.index.getNodesByType("FUNCTION"),
      ...this.index.getNodesByType("CLASS"),
      ...this.index.getNodesByType("FILE"),
    ];

    return nodes
      .filter(
        (node) =>
          String(node.properties.projectId || "") === String(projectId),
      )
      .map((node) => ({
        nodeId: node.id,
        score: this.scoreNode(node, tokens),
        source,
      }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private scoreNode(node: GraphNode, tokens: string[]): number {
    const haystack = `${node.id} ${node.properties.name || ""} ${node.properties.path || ""} ${node.properties.summary || ""}`.toLowerCase();
    return tokens.reduce(
      (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
      0,
    );
  }

  private nodeMeta(nodeId: string): {
    name: string;
    filePath: string;
    type: string;
  } {
    const node = this.index.getNode(nodeId);
    if (!node) {
      return {
        name: nodeId,
        filePath: "",
        type: "UNKNOWN",
      };
    }

    return {
      name: String(node.properties.name || node.properties.path || node.id),
      filePath: String(node.properties.path || node.properties.filePath || ""),
      type: String(node.type || "UNKNOWN"),
    };
  }

  private filterByType(
    results: RetrievalResult[],
    types?: string[],
  ): RetrievalResult[] {
    if (!types?.length) {
      return results;
    }

    const allowed = new Set(types.map((item) => item.toUpperCase()));
    return results.filter((row) => allowed.has(row.type.toUpperCase()));
  }

  private filterByProject(
    results: RetrievalResult[],
    projectId: string,
  ): RetrievalResult[] {
    return results.filter((row) => {
      const node = this.index.getNode(row.nodeId);
      return String(node?.properties?.projectId || "") === String(projectId);
    });
  }
}

export default HybridRetriever;
