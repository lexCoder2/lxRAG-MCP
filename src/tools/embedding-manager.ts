/**
 * EmbeddingManager
 * Single responsibility: track per-project embedding readiness and orchestrate
 * the generate → store pipeline for Qdrant vector storage.
 * Extracted from ToolHandlerBase (SRP / SOLID refactor).
 */
import type EmbeddingEngine from "../vector/embedding-engine.js";
import { logger } from "../utils/logger";

export class EmbeddingManager {
  private projectEmbeddingsReady = new Map<string, boolean>();

  isReady(projectId: string): boolean {
    return this.projectEmbeddingsReady.get(projectId) ?? false;
  }

  setReady(projectId: string, value: boolean): void {
    this.projectEmbeddingsReady.set(projectId, value);
  }

  clear(projectId: string): void {
    this.projectEmbeddingsReady.delete(projectId);
  }

  async ensureEmbeddings(
    projectId: string,
    embeddingEngine?: EmbeddingEngine,
  ): Promise<void> {
    logger.error(
      `[ensureEmbeddings] projectId=${projectId} embeddingEngineReady=${!!embeddingEngine} alreadyReady=${this.isReady(projectId)}`,
    );

    if (this.isReady(projectId) || !embeddingEngine) {
      logger.error(
        `[ensureEmbeddings] SKIP — embeddingEngine=${!!embeddingEngine} alreadyReady=${this.isReady(projectId)}`,
      );
      return;
    }

    try {
      const generated = await embeddingEngine.generateAllEmbeddings();
      if (generated.functions + generated.classes + generated.files === 0) {
        throw new Error("No indexed symbols found. Run graph_rebuild first.");
      }

      try {
        await embeddingEngine.storeInQdrant(projectId);
      } catch (qdrantError) {
        const errorMsg = qdrantError instanceof Error ? qdrantError.message : String(qdrantError);
        logger.error(
          `[Phase4.5] Qdrant storage failed for project ${projectId}: ${errorMsg}`,
        );
        logger.warn(
          `[Phase4.5] Continuing without Qdrant - semantic search may be unavailable for project ${projectId}`,
        );
      }

      this.setReady(projectId, true);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[Phase4.5] Embedding generation failed for project ${projectId}: ${errorMsg}`,
      );
      throw error;
    }
  }
}
