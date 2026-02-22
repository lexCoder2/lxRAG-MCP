/**
 * Docs Engine
 * Orchestrates markdown file discovery, parsing, and graph indexing.
 * Supports incremental updates (hash-based), vector embedding, and search.
 */

import type { MemgraphClient } from "../graph/client.js";
import type { QdrantClient, VectorPoint } from "../vector/qdrant-client.js";
import { DocsBuilder } from "../graph/docs-builder.js";
import { DocsParser, findMarkdownFiles } from "../parsers/docs-parser.js";
import type { ParsedDoc } from "../parsers/docs-parser.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DocsIndexOptions {
  /** Skip files whose stored hash matches current file hash (default: true) */
  incremental?: boolean;
  /** If true, also embed section content into Qdrant (default: false) */
  withEmbeddings?: boolean;
  txId?: string;
}

export interface DocsIndexResult {
  indexed: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
  durationMs: number;
}

export interface DocsSearchOptions {
  limit?: number;
}

export interface DocsSearchResult {
  sectionId: string;
  heading: string;
  docRelativePath: string;
  kind: string;
  content: string;
  score: number;
  startLine: number;
}

export interface DocsEngineOptions {
  qdrant?: QdrantClient;
  /** Override parser (useful in tests) */
  parser?: DocsParser;
  /** Override builder factory (useful in tests) */
  buildCypher?: (
    doc: ParsedDoc,
    projectId: string,
    txId: string,
  ) => ReturnType<DocsBuilder["buildFromParsedDoc"]>;
}

export const DOCS_COLLECTION = "document_sections";
export const DOCS_VECTOR_SIZE = 384; // MiniLM-L6 dimension

// ─── DocsEngine ───────────────────────────────────────────────────────────────

export class DocsEngine {
  private readonly memgraph: MemgraphClient;
  private readonly qdrant?: QdrantClient;
  private readonly parser: DocsParser;
  private readonly buildCypher: (
    doc: ParsedDoc,
    projectId: string,
    txId: string,
  ) => ReturnType<DocsBuilder["buildFromParsedDoc"]>;

  constructor(memgraph: MemgraphClient, opts: DocsEngineOptions = {}) {
    this.memgraph = memgraph;
    this.qdrant = opts.qdrant;
    this.parser = opts.parser ?? new DocsParser();
    this.buildCypher =
      opts.buildCypher ??
      ((doc, projectId, txId) => {
        const builder = new DocsBuilder(projectId, undefined, txId, Date.now());
        return builder.buildFromParsedDoc(doc);
      });
  }

  // ── Indexing ─────────────────────────────────────────────────────────────────

  /**
   * Discover all markdown files under workspaceRoot, parse them, and upsert
   * DOCUMENT + SECTION nodes into the graph.  Skips files whose hash has not
   * changed since the last run (incremental mode, default: on).
   */
  async indexWorkspace(
    workspaceRoot: string,
    projectId: string,
    opts: DocsIndexOptions = {},
  ): Promise<DocsIndexResult> {
    const t0 = Date.now();
    const incremental = opts.incremental ?? true;
    // Phase 3.2: Enable doc embeddings by default
    const withEmbeddings = opts.withEmbeddings ?? true;
    const txId = opts.txId ?? `doc-tx-${Date.now()}`;

    const files = findMarkdownFiles(workspaceRoot);
    const result: DocsIndexResult = {
      indexed: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };

    // Fetch existing hashes in bulk for incremental check
    const existingHashes = incremental
      ? await this.fetchExistingHashes(projectId)
      : new Map<string, string>();

    for (const filePath of files) {
      try {
        const doc = this.parser.parseFile(filePath, workspaceRoot);

        // Incremental: skip when hash unchanged
        if (incremental && existingHashes.get(doc.relativePath) === doc.hash) {
          result.skipped++;
          continue;
        }

        // Write graph nodes
        const stmts = this.buildCypher(doc, projectId, txId);
        const results = await this.memgraph.executeBatch(stmts);
        const firstError = results.find((r) => r.error);
        if (firstError) {
          result.errors.push({
            file: filePath,
            error: `Memgraph error: ${firstError.error}`,
          });
          continue;
        }

        // Phase 3.2: Embed sections into Qdrant
        if (withEmbeddings && this.qdrant?.isConnected()) {
          try {
            await this.embedDoc(doc, projectId);
            console.log(
              `[Phase3.2] Generated embeddings for documentation: ${doc.relativePath}`,
            );
          } catch (embeddingError) {
            console.error(
              `[Phase3.2] Failed to embed documentation ${doc.relativePath}:`,
              embeddingError,
            );
            // Continue even if embeddings fail
          }
        }

        result.indexed++;
      } catch (err) {
        result.errors.push({
          file: filePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.durationMs = Date.now() - t0;
    return result;
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search SECTION nodes by text content.
   * Uses a Memgraph CONTAINS fallback (text_search integration added in
   * hybrid-retriever Step 9 is a separate enhancement).
   */
  async searchDocs(
    query: string,
    projectId: string,
    opts: DocsSearchOptions = {},
  ): Promise<DocsSearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 50);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return [];

    // Try native text_search first (if SECTION index exists)
    const nativeResults = await this.nativeSearch(query, projectId, limit);
    if (nativeResults !== null) return nativeResults;

    // Fallback: Cypher CONTAINS scan (works without BM25 index)
    return this.fallbackSearch(terms, projectId, limit);
  }

  /**
   * Find SECTION nodes that have a DOC_DESCRIBES edge pointing at a named
   * FUNCTION, CLASS, or FILE node.
   */
  async getDocsBySymbol(
    symbolName: string,
    projectId: string,
    opts: DocsSearchOptions = {},
  ): Promise<DocsSearchResult[]> {
    const limit = Math.min(opts.limit ?? 10, 50);
    const res = await this.memgraph.executeCypher(
      `
MATCH (s:SECTION { projectId: $projectId })-[r:DOC_DESCRIBES]->(target { projectId: $projectId, name: $name })
MATCH (s)-[:SECTION_OF]->(d:DOCUMENT { projectId: $projectId })
RETURN s.id AS sectionId,
       s.heading AS heading,
       d.relativePath AS relativePath,
       d.kind AS kind,
       s.content AS content,
       s.startLine AS startLine,
       r.strength AS score
ORDER BY score DESC
LIMIT $limit
      `,
      { projectId, name: symbolName, limit },
    );

    if (res.error || !res.data.length) return [];
    return res.data.map((row: Record<string, unknown>) =>
      this.rowToResult(row),
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async fetchExistingHashes(
    projectId: string,
  ): Promise<Map<string, string>> {
    const res = await this.memgraph.executeCypher(
      `MATCH (d:DOCUMENT { projectId: $projectId })
       RETURN d.relativePath AS relativePath, d.hash AS hash`,
      { projectId },
    );
    const map = new Map<string, string>();
    if (!res.error) {
      for (const row of res.data as Array<{
        relativePath: unknown;
        hash: unknown;
      }>) {
        if (
          typeof row.relativePath === "string" &&
          typeof row.hash === "string"
        ) {
          map.set(row.relativePath, row.hash);
        }
      }
    }
    return map;
  }

  private async nativeSearch(
    query: string,
    projectId: string,
    limit: number,
  ): Promise<DocsSearchResult[] | null> {
    if (!this.memgraph) return null;
    try {
      const res = await this.memgraph.executeCypher(
        `
CALL text_search.search('docs_index', $query) YIELD node, score
WHERE coalesce(node.projectId, '') = $projectId
MATCH (node)-[:SECTION_OF]->(d:DOCUMENT { projectId: $projectId })
RETURN node.id AS sectionId,
       node.heading AS heading,
       d.relativePath AS relativePath,
       d.kind AS kind,
       node.content AS content,
       node.startLine AS startLine,
       score
ORDER BY score DESC
LIMIT $limit
        `,
        { query, projectId, limit },
      );
      if (res.error || res.data.length === 0) return null;
      return res.data.map((row: Record<string, unknown>) =>
        this.rowToResult(row),
      );
    } catch {
      return null;
    }
  }

  private async fallbackSearch(
    terms: string[],
    projectId: string,
    limit: number,
  ): Promise<DocsSearchResult[]> {
    // Build a simple WHERE clause that checks heading and content
    const whereClauses = terms.map(
      (_, i) =>
        `(toLower(s.heading) CONTAINS $term${i} OR toLower(s.content) CONTAINS $term${i})`,
    );
    const params: Record<string, unknown> = { projectId, limit };
    terms.forEach((t, i) => {
      params[`term${i}`] = t;
    });

    const res = await this.memgraph.executeCypher(
      `
MATCH (s:SECTION { projectId: $projectId })-[:SECTION_OF]->(d:DOCUMENT { projectId: $projectId })
WHERE ${whereClauses.join(" AND ")}
RETURN s.id AS sectionId,
       s.heading AS heading,
       d.relativePath AS relativePath,
       d.kind AS kind,
       s.content AS content,
       s.startLine AS startLine,
       1.0 AS score
ORDER BY s.heading
LIMIT $limit
      `,
      params,
    );

    if (res.error || !res.data.length) return [];
    return res.data.map((row: Record<string, unknown>) =>
      this.rowToResult(row),
    );
  }

  private rowToResult(row: Record<string, unknown>): DocsSearchResult {
    return {
      sectionId: String(row.sectionId ?? ""),
      heading: String(row.heading ?? ""),
      docRelativePath: String(row.relativePath ?? ""),
      kind: String(row.kind ?? ""),
      content: String(row.content ?? "").slice(0, 500),
      score: Number(row.score ?? 0),
      startLine: Number(row.startLine ?? 0),
    };
  }

  // ── Vector embedding ─────────────────────────────────────────────────────────

  private async embedDoc(doc: ParsedDoc, projectId: string): Promise<void> {
    if (!this.qdrant) return;
    const points: VectorPoint[] = doc.sections
      .filter((s) => s.wordCount > 0)
      .map((s) => ({
        // Qdrant requires string or UUID ids
        id: String(this.hashToUint(doc.relativePath + ":" + s.index)),
        vector: this.tfidfVector(s.heading + " " + s.content),
        payload: {
          projectId,
          relativePath: doc.relativePath,
          kind: doc.kind,
          heading: s.heading,
          startLine: s.startLine,
          sectionIndex: s.index,
        },
      }));

    await this.qdrant.upsertPoints(DOCS_COLLECTION, points);
  }

  /**
   * Deterministic mapping of a string to a 31-bit positive integer for use
   * as a Qdrant point id.
   */
  private hashToUint(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 1; // strip sign bit
  }

  /**
   * Minimal term-frequency vector for a text string.
   * Produces a sparse-like float32 array of length DOCS_VECTOR_SIZE.
   * Replace with a real embedding model for production use.
   */
  private tfidfVector(text: string): number[] {
    const vec = new Float32Array(DOCS_VECTOR_SIZE);
    const tokens = text.toLowerCase().match(/\w+/g) ?? [];
    for (const tok of tokens) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) {
        h = ((h << 5) - h + tok.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(h) % DOCS_VECTOR_SIZE;
      vec[idx] = Math.min(vec[idx] + 1, 10);
    }
    // L2 normalise
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return Array.from(vec).map((v) => v / norm);
  }
}
