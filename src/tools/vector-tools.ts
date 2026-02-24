/**
 * Vector Search Tools
 * Semantic code search capabilities
 */

import type EmbeddingEngine from "../vector/embedding-engine.js";
import type { GraphIndexManager } from "../graph/index.js";

export interface SemanticSearchResult {
  id: string;
  name: string;
  type: "function" | "class" | "file";
  similarity: number;
  path?: string;
  description?: string;
}

/**
 * Vector search tools for semantic code analysis
 */
export class VectorTools {
  constructor(
    private embeddingEngine: EmbeddingEngine | null,
    private index: GraphIndexManager
  ) {}

  /**
   * Find similar code to a query
   */
  async code_search_semantic(args: any): Promise<string> {
    if (!this.embeddingEngine) {
      return JSON.stringify({
        error: "Embedding engine not initialized",
        suggestion: "Run graph:build with embeddings enabled",
      });
    }

    const { query, type = "function", limit = 5 } = args;

    try {
      const results = await this.embeddingEngine.findSimilar(
        query,
        type,
        limit
      );

      const formatted = results.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        path: r.metadata.path,
        relevance: "high",
      }));

      return JSON.stringify(
        {
          query,
          type,
          results: formatted,
          count: formatted.length,
          note: "Results ranked by semantic similarity",
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify({ error: `Search failed: ${error}` });
    }
  }

  /**
   * Find duplicate or similar implementations
   */
  async code_find_duplicates(args: any): Promise<string> {
    if (!this.embeddingEngine) {
      return JSON.stringify({
        error: "Embedding engine not initialized",
      });
    }

    const { name, type = "function" } = args;

    try {
      const similar = await this.embeddingEngine.findSimilar(name, type, 10);

      const grouped: Record<string, any[]> = {};
      for (const result of similar) {
        const group = result.metadata.path?.split("/")[1] || "other";
        if (!grouped[group]) grouped[group] = [];
        grouped[group].push({
          name: result.name,
          path: result.metadata.path,
          type: result.type,
        });
      }

      return JSON.stringify(
        {
          query: name,
          searchType: type,
          duplicatesByArea: grouped,
          totalFound: similar.length,
          recommendation:
            similar.length > 3
              ? "Consider refactoring to shared utility"
              : "No significant duplicates",
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify({ error: `Duplicate search failed: ${error}` });
    }
  }

  /**
   * Find code by semantic meaning
   */
  async code_search_meaning(args: any): Promise<string> {
    if (!this.embeddingEngine) {
      return JSON.stringify({
        error: "Embedding engine not initialized",
      });
    }

    const { meaning, limit = 10 } = args;

    try {
      // Search across all types
      const functionResults = await this.embeddingEngine.findSimilar(
        meaning,
        "function",
        Math.ceil(limit / 3)
      );
      const classResults = await this.embeddingEngine.findSimilar(
        meaning,
        "class",
        Math.ceil(limit / 3)
      );
      const fileResults = await this.embeddingEngine.findSimilar(
        meaning,
        "file",
        Math.ceil(limit / 3)
      );

      const allResults = [
        ...functionResults,
        ...classResults,
        ...fileResults,
      ].slice(0, limit);

      return JSON.stringify(
        {
          query: meaning,
          results: allResults.map((r) => ({
            name: r.name,
            type: r.type,
            path: r.metadata.path,
            description: `${r.type} matching: ${meaning}`,
          })),
          count: allResults.length,
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify({ error: `Semantic search failed: ${error}` });
    }
  }

  /**
   * Suggest refactoring opportunities based on similarity
   */
  async code_suggest_refactor(args: any): Promise<string> {
    if (!this.embeddingEngine) {
      return JSON.stringify({
        error: "Embedding engine not initialized",
      });
    }

    const { element, type = "function" } = args;

    try {
      const similar = await this.embeddingEngine.findSimilar(element, type, 5);

      if (similar.length < 2) {
        return JSON.stringify({
          element,
          status: "unique",
          suggestion: "No similar code found - this is a unique implementation",
        });
      }

      const suggestions: string[] = [];
      if (similar.length >= 3) {
        suggestions.push(
          `Found ${similar.length} similar implementations - consider extracting common logic`
        );
        suggestions.push("Create a shared utility or service class");
        suggestions.push("Document the pattern for team consistency");
      }

      return JSON.stringify(
        {
          element,
          type,
          similarCount: similar.length,
          similar: similar.map((s) => ({
            name: s.name,
            path: s.metadata.path,
          })),
          suggestions,
          priority: similar.length >= 3 ? "high" : "medium",
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify({ error: `Refactor suggestion failed: ${error}` });
    }
  }

  /**
   * Hybrid search combining graph and vector queries
   */
  async code_hybrid_search(args: any): Promise<string> {
    const { query, type = "function" } = args;

    try {
      // Vector search (semantic)
      let vectorResults: any[] = [];
      if (this.embeddingEngine) {
        const embedResults = await this.embeddingEngine.findSimilar(
          query,
          type,
          5
        );
        vectorResults = embedResults.map((r) => ({
          id: r.id,
          name: r.name,
          source: "vector",
          score: 0.8,
        }));
      }

      // Graph search (structural)
      const graphResults: any[] = [];
      if (type === "function") {
        const nodes = this.index.getNodesByType("FUNCTION");
        nodes
          .filter(
            (n) =>
              n.properties.name?.includes(query) || n.properties.name === query
          )
          .slice(0, 5)
          .forEach((n) => {
            graphResults.push({
              id: n.id,
              name: n.properties.name,
              source: "graph",
              score: 1.0, // Exact match
            });
          });
      }

      // Combine and rank
      const combined = [...graphResults, ...vectorResults];
      const ranked = combined
        .reduce((acc, item) => {
          const existing = acc.find((a: any) => a.id === item.id);
          if (existing) {
            existing.combinedScore = Math.max(
              existing.combinedScore,
              item.score
            );
            existing.sources.push(item.source);
          } else {
            acc.push({
              ...item,
              combinedScore: item.score,
              sources: [item.source],
            });
          }
          return acc;
        }, [] as any[])
        .sort((a: any, b: any) => b.combinedScore - a.combinedScore)
        .slice(0, 10);

      return JSON.stringify(
        {
          query,
          type,
          results: ranked,
          totalFound: ranked.length,
          method: "hybrid (graph + vector)",
        },
        null,
        2
      );
    } catch (error) {
      return JSON.stringify({ error: `Hybrid search failed: ${error}` });
    }
  }
}

export default VectorTools;
