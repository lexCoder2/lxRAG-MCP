import { createHash } from "crypto";
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
   * Convert a stable string ID to a deterministic UUID (v4-compatible format).
   * Uses SHA-256 so two different inputs never produce the same UUID, unlike
   * the previous 32-bit DJB2 hash which had ~0.3% collision probability at
   * 5k symbols.
   * Qdrant REST API accepts UUID v4 strings as point IDs natively.
   */
  private stableUuid(s: string): string {
    const hex = createHash("sha256").update(s).digest("hex");
    const b = parseInt(hex[16], 16);
    const variant = ["8", "9", "a", "b"][b % 4];
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-");
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
              id: this.stableUuid(p.id),
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
        logger.error(`[QdrantClient] deleteByFilter failed (${response.status}): ${text}`);
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
      const response = await fetch(`${this.baseUrl}/collections/${collectionName}/points/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter: {
            must: [{ key: "projectId", match: { value: projectId } }],
          },
          exact: true,
        }),
      });

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
