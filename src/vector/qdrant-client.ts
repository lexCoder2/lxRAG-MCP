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
        console.error("[QdrantClient] Connected successfully");
      }
    } catch (error) {
      console.warn(
        "[QdrantClient] Connection failed (expected for MVP)",
        error
      );
      this.connected = false;
    }
  }

  /**
   * Create a collection
   */
  async createCollection(name: string, vectorSize: number): Promise<void> {
    if (!this.connected) {
      console.warn("[QdrantClient] Not connected");
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
        console.error(`[QdrantClient] Collection '${name}' created`);
      }
    } catch (error) {
      console.error(`[QdrantClient] Failed to create collection: ${error}`);
    }
  }

  /**
   * Upsert points into collection
   */
  async upsertPoints(
    collectionName: string,
    points: VectorPoint[]
  ): Promise<void> {
    if (!this.connected) {
      console.warn("[QdrantClient] Not connected, skipping upsert");
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
              id: p.id,
              vector: p.vector,
              payload: p.payload,
            })),
          }),
        }
      );

      if (response.ok) {
        console.error(
          `[QdrantClient] Upserted ${points.length} points to '${collectionName}'`
        );
      }
    } catch (error) {
      console.error(`[QdrantClient] Failed to upsert points: ${error}`);
    }
  }

  /**
   * Search for similar vectors
   */
  async search(
    collectionName: string,
    vector: number[],
    limit = 10
  ): Promise<SearchResult[]> {
    if (!this.connected) {
      console.warn("[QdrantClient] Not connected");
      return [];
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/collections/${collectionName}/points/search`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vector,
            limit,
            with_payload: true,
          }),
        }
      );

      if (response.ok) {
        const data = (await response.json()) as any;
        return (
          data.result?.map((item: any) => ({
            id: item.id,
            score: item.score,
            payload: item.payload,
          })) || []
        );
      }
      return [];
    } catch (error) {
      console.error(`[QdrantClient] Search failed: ${error}`);
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
      console.error(`[QdrantClient] Collection '${name}' deleted`);
    } catch (error) {
      console.error(`[QdrantClient] Failed to delete collection: ${error}`);
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
      console.error(`[QdrantClient] Failed to get collection: ${error}`);
    }
    return null;
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.connected;
  }
}

export default QdrantClient;
