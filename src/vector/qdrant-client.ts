import { logger } from "../utils/logger.js";
/**
 * Qdrant Vector Store Client
 * Interface to Qdrant for semantic search and embeddings
 */

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: Record<string, any>;
}

export interface SearchResult {
  id: string;
  score: number;
  payload: Record<string, any>;
}

export interface Collection {
  name: string;
  vectorSize: number;
  pointCount: number;
}

/**
 * Qdrant client for vector operations
 */
export class QdrantClient {
  private baseUrl: string;
  private connected = false;

  constructor(host = "localhost", port = 6333) {
    this.baseUrl = `http://${host}:${port}`;
  }

  /**
   * Connect to Qdrant
   */
  async connect(): Promise<void> {
    try {
      // Use root endpoint instead of /health (which doesn't exist)
      const response = await fetch(`${this.baseUrl}/`);
      if (response.ok) {
        this.connected = true;
        logger.error("[QdrantClient] Connected successfully");
      }
    } catch (error) {
      logger.warn("[QdrantClient] Connection failed (expected for MVP)", error);
      this.connected = false;
    }
  }

  /**
   * Create a collection
   */
  async createCollection(name: string, vectorSize: number): Promise<void> {
    if (!this.connected) {
      logger.warn("[QdrantClient] Not connected");
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/collections/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
        }),
      });

      if (response.ok) {
        logger.error(`[QdrantClient] Collection '${name}' created`);
      }
    } catch (error) {
      logger.error(`[QdrantClient] Failed to create collection: ${error}`);
    }
  }

  /**
   * Hash a string ID to a stable unsigned 32-bit integer for Qdrant.
   * Qdrant REST API only accepts unsigned integers or UUID v4 as point IDs.
   */
  private stringToUint32(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = (((h * 33) >>> 0) ^ s.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  /**
   * Upsert points into collection
   */
  async upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void> {
    if (!this.connected) {
      logger.warn("[QdrantClient] Not connected, skipping upsert");
      return;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/collections/${collectionName}/points?wait=true`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            points: points.map((p) => ({
              id: this.stringToUint32(p.id),
              vector: p.vector,
              // Store original string ID in payload so we can recover it
              payload: { ...p.payload, originalId: p.id },
            })),
          }),
        },
      );

      if (response.ok) {
        logger.error(`[QdrantClient] Upserted ${points.length} points to '${collectionName}'`);
      } else {
        const text = await response.text().catch(() => "(unreadable)");
        logger.error(`[QdrantClient] Upsert failed (${response.status}): ${text}`);
      }
    } catch (error) {
      logger.error(`[QdrantClient] Failed to upsert points: ${error}`);
    }
  }

  /**
   * Delete all points in a collection that match a payload filter.
   * Used to purge stale ghost points for a project before re-upserting.
   */
  async deleteByFilter(collectionName: string, projectId: string): Promise<void> {
    if (!this.connected) {
      logger.warn("[QdrantClient] Not connected, skipping deleteByFilter");
      return;
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/collections/${collectionName}/points/delete?wait=true`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: {
              must: [{ key: "projectId", match: { value: projectId } }],
            },
          }),
        },
      );

      if (response.ok) {
        logger.error(
          `[QdrantClient] Deleted stale points for project '${projectId}' from '${collectionName}'`,
        );
      } else {
        const text = await response.text().catch(() => "(unreadable)");
        logger.error(
          `[QdrantClient] deleteByFilter failed (${response.status}): ${text}`,
        );
      }
    } catch (error) {
      logger.error(`[QdrantClient] deleteByFilter error: ${error}`);
    }
  }

  /**
   * Search for similar vectors.
   * @param filter - Optional Qdrant payload filter (e.g. `{ must: [{ key: "projectId", match: { value: "a3f9" } }] }`)
   */
  async search(
    collectionName: string,
    vector: number[],
    limit = 10,
    filter?: object,
  ): Promise<SearchResult[]> {
    if (!this.connected) {
      logger.warn("[QdrantClient] Not connected");
      return [];
    }

    try {
      const response = await fetch(`${this.baseUrl}/collections/${collectionName}/points/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
          ...(filter ? { filter } : {}),
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        return (
          data.result?.map((item: any) => ({
            // Recover original string ID from payload (stored during upsert)
            id: String(item.payload?.originalId ?? item.id),
            score: item.score,
            payload: item.payload,
          })) || []
        );
      }
      return [];
    } catch (error) {
      logger.error(`[QdrantClient] Search failed: ${error}`);
      return [];
    }
  }

  /**
   * Delete collection
   */
  async deleteCollection(name: string): Promise<void> {
    if (!this.connected) return;

    try {
      await fetch(`${this.baseUrl}/collections/${name}`, { method: "DELETE" });
      logger.error(`[QdrantClient] Collection '${name}' deleted`);
    } catch (error) {
      logger.error(`[QdrantClient] Failed to delete collection: ${error}`);
    }
  }

  /**
   * Get collection info
   */
  async getCollection(name: string): Promise<Collection | null> {
    if (!this.connected) return null;

    try {
      const response = await fetch(`${this.baseUrl}/collections/${name}`);
      if (response.ok) {
        const data = (await response.json()) as any;
        return {
          name,
          vectorSize: data.result?.config?.params?.vectors?.size || 0,
          pointCount: data.result?.points_count || 0,
        };
      }
    } catch (error) {
      logger.error(`[QdrantClient] Failed to get collection: ${error}`);
    }
    return null;
  }

  /**
   * Count points in a collection filtered by projectId.
   * Uses Qdrant's /points/count endpoint with a payload filter.
   */
  async countByFilter(collectionName: string, projectId: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      const response = await fetch(
        `${this.baseUrl}/collections/${collectionName}/points/count`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filter: {
              must: [{ key: "projectId", match: { value: projectId } }],
            },
            exact: true,
          }),
        },
      );

      if (response.ok) {
        const data = (await response.json()) as any;
        return data.result?.count ?? 0;
      }
    } catch (error) {
      logger.error(`[QdrantClient] countByFilter failed: ${error}`);
    }
    return 0;
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

export default QdrantClient;
