/**
 * Embedding Engine
 * Generates vector embeddings for code elements
 */

import type { GraphIndexManager } from '../graph/index.js';
import type QdrantClient from './qdrant-client.js';
import type { VectorPoint } from './qdrant-client.js';
import { extractProjectIdFromScopedId } from '../utils/validation.js';

export interface CodeEmbedding {
  id: string;
  type: 'function' | 'class' | 'file';
  name: string;
  vector: number[];
  text: string;
  projectId?: string;
  metadata: {
    path?: string;
    lines?: number;
    imports?: string[];
    exports?: string[];
  };
}

/**
 * Simple embedding generation (MVP)
 * In production, use OpenAI API, Hugging Face, or local model
 */
export class EmbeddingEngine {
  private index: GraphIndexManager;
  private qdrant: QdrantClient;
  private embeddings: Map<string, CodeEmbedding>;

  constructor(index: GraphIndexManager, qdrant: QdrantClient) {
    this.index = index;
    this.qdrant = qdrant;
    this.embeddings = new Map();
  }

  /**
   * Generate embeddings for all code elements
   */
  async generateAllEmbeddings(): Promise<{ functions: number; classes: number; files: number }> {
    console.error('[EmbeddingEngine] Starting embedding generation...');

    let functionCount = 0;
    let classCount = 0;
    let fileCount = 0;

    // Generate embeddings for functions
    const functions = this.index.getNodesByType('FUNCTION');
    for (const func of functions) {
      const embedding = this.generateEmbedding('function', func.id, func.properties);
      this.embeddings.set(embedding.id, embedding);
      functionCount++;
    }

    // Generate embeddings for classes
    const classes = this.index.getNodesByType('CLASS');
    for (const cls of classes) {
      const embedding = this.generateEmbedding('class', cls.id, cls.properties);
      this.embeddings.set(embedding.id, embedding);
      classCount++;
    }

    // Generate embeddings for files
    const files = this.index.getNodesByType('FILE');
    for (const file of files) {
      const embedding = this.generateEmbedding('file', file.id, file.properties);
      this.embeddings.set(embedding.id, embedding);
      fileCount++;
    }

    console.error('[EmbeddingEngine] Generated embeddings:');
    console.error(`  Functions: ${functionCount}`);
    console.error(`  Classes: ${classCount}`);
    console.error(`  Files: ${fileCount}`);

    return { functions: functionCount, classes: classCount, files: fileCount };
  }

  /**
   * Generate embedding for a single element
   */
  private generateEmbedding(
    type: 'function' | 'class' | 'file',
    id: string,
    properties: Record<string, any>,
  ): CodeEmbedding {
    // MVP: Simple text-based embedding
    // In production: Use sentence-transformers or OpenAI embeddings

    const text = this.propertiesToText(properties);
    const vector = this.textToVector(text);

    // Phase 4.2: Extract projectId from scoped ID safely (format: projectId:type:name)
    const projectId = extractProjectIdFromScopedId(id, undefined);

    return {
      id,
      type,
      name: properties.name || properties.path || id,
      vector,
      text,
      projectId,
      metadata: {
        path: properties.path,
        lines: properties.LOC,
        imports: properties.imports,
        exports: properties.exports,
      },
    };
  }

  /**
   * Convert properties to text for embedding
   */
  private propertiesToText(props: Record<string, any>): string {
    const parts: string[] = [];

    if (props.name) parts.push(props.name);
    if (props.description) parts.push(props.description);
    if (props.kind) parts.push(`kind:${props.kind}`);
    if (props.parameters) parts.push(`params:${props.parameters.join(',')}`);
    if (props.extends) parts.push(`extends:${props.extends}`);
    if (props.implements) parts.push(`implements:${props.implements.join(',')}`);
    if (props.path) parts.push(`path:${props.path}`);

    return parts.join(' ');
  }

  /**
   * Convert text to vector (simple hash-based for MVP)
   * In production: use sentence-transformers or OpenAI API
   */
  private textToVector(text: string, dim = 128): number[] {
    const vector: number[] = new Array(dim).fill(0);

    // Simple deterministic hashing for MVP
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const index = (i + charCode) % dim;
      vector[index] += Math.sin(charCode * i) * 0.1;
    }

    // Normalize
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    return magnitude > 0 ? vector.map((v) => v / magnitude) : vector;
  }

  /**
   * Store embeddings in Qdrant
   */
  async storeInQdrant(): Promise<void> {
    if (!this.qdrant.isConnected()) {
      console.warn('[EmbeddingEngine] Qdrant not connected, skipping storage');
      return;
    }

    // Create collections
    await this.qdrant.createCollection('functions', 128);
    await this.qdrant.createCollection('classes', 128);
    await this.qdrant.createCollection('files', 128);

    // Separate embeddings by type
    const functionEmbeddings: VectorPoint[] = [];
    const classEmbeddings: VectorPoint[] = [];
    const fileEmbeddings: VectorPoint[] = [];

    for (const embedding of this.embeddings.values()) {
      const point: VectorPoint = {
        id: embedding.id,
        vector: embedding.vector,
        payload: {
          name: embedding.name,
          text: embedding.text,
          projectId: embedding.projectId,
          metadata: embedding.metadata,
        },
      };

      if (embedding.type === 'function') functionEmbeddings.push(point);
      else if (embedding.type === 'class') classEmbeddings.push(point);
      else if (embedding.type === 'file') fileEmbeddings.push(point);
    }

    // Upsert to Qdrant
    if (functionEmbeddings.length > 0) {
      await this.qdrant.upsertPoints('functions', functionEmbeddings);
    }
    if (classEmbeddings.length > 0) {
      await this.qdrant.upsertPoints('classes', classEmbeddings);
    }
    if (fileEmbeddings.length > 0) {
      await this.qdrant.upsertPoints('files', fileEmbeddings);
    }

    console.error('[EmbeddingEngine] Embeddings stored in Qdrant');
  }

  /**
   * Search for similar code
   * @param query - Search query text
   * @param type - Entity type to search (function, class, or file)
   * @param limit - Maximum number of results
   * @param projectId - Optional project ID to scope search results
   */
  async findSimilar(
    query: string,
    type: 'function' | 'class' | 'file' = 'function',
    limit = 5,
    projectId?: string,
  ): Promise<CodeEmbedding[]> {
    const queryVector = this.textToVector(query);

    if (this.qdrant.isConnected()) {
      const results = await this.qdrant.search(`${type}s`, queryVector, limit * 2);
      return results
        .map((result) => {
          const embedding = this.embeddings.get(result.id);
          return embedding;
        })
        .filter((e) => {
          if (!e) return false;
          if (projectId && e.projectId !== projectId) return false;
          return true;
        })
        .slice(0, limit) as CodeEmbedding[];
    }

    const candidates = Array.from(this.embeddings.values()).filter((entry) => {
      if (entry.type !== type) return false;
      if (projectId && entry.projectId !== projectId) return false;
      return true;
    });

    return candidates
      .map((candidate) => ({
        candidate,
        score: this.cosineSimilarity(queryVector, candidate.vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => row.candidate);
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    let dot = 0;
    let leftMagnitude = 0;
    let rightMagnitude = 0;

    const size = Math.min(left.length, right.length);
    for (let i = 0; i < size; i += 1) {
      dot += left[i] * right[i];
      leftMagnitude += left[i] * left[i];
      rightMagnitude += right[i] * right[i];
    }

    if (leftMagnitude === 0 || rightMagnitude === 0) {
      return 0;
    }

    return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
  }

  /**
   * Get all embeddings
   */
  getAllEmbeddings(): CodeEmbedding[] {
    return Array.from(this.embeddings.values());
  }

  /**
   * Export embeddings as JSON
   */
  export(): string {
    const data = Array.from(this.embeddings.values()).map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      text: e.text,
      metadata: e.metadata,
      vectorSize: e.vector.length,
      // Don't export actual vectors (too verbose)
    }));

    return JSON.stringify(data, null, 2);
  }
}

export default EmbeddingEngine;
