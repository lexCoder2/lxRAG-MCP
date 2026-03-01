/**
 * EpisodeValidator
 * Single responsibility: validate episode payloads and infer entity hints for
 * episode creation via semantic search.
 * Extracted from ToolHandlerBase (SRP / SOLID refactor).
 */
import type EmbeddingEngine from "../vector/embedding-engine.js";
import { logger } from "../utils/logger";

export class EpisodeValidator {
  validateEpisodeInput(args: {
    type: string;
    outcome?: unknown;
    entities?: string[];
    metadata?: Record<string, unknown>;
  }): string | null {
    const type = String(args.type || "").toUpperCase();
    const entities = Array.isArray(args.entities) ? args.entities : [];
    const metadata = args.metadata || {};
    logger.error(
      `[validateEpisodeInput] type=${type} outcome=${String(args.outcome ?? "")} entities=${entities.length} metadataKeys=${Object.keys(metadata).join(",") || "none"}`,
    );

    if (type === "DECISION") {
      const outcome = String(args.outcome || "").toLowerCase();
      if (!outcome || !["success", "failure", "partial"].includes(outcome)) {
        return "DECISION episodes require outcome: success | failure | partial.";
      }
      if (typeof metadata.rationale !== "string" && typeof metadata.reason !== "string") {
        return "DECISION episodes require metadata.rationale (or metadata.reason).";
      }
    }

    if (type === "EDIT") {
      if (!entities.length) {
        return "EDIT episodes require at least one entity reference.";
      }
    }

    if (type === "TEST_RESULT") {
      const outcome = String(args.outcome || "").toLowerCase();
      if (!outcome || !["success", "failure", "partial"].includes(outcome)) {
        return "TEST_RESULT episodes require outcome: success | failure | partial.";
      }
      if (typeof metadata.testName !== "string" && typeof metadata.testFile !== "string") {
        return "TEST_RESULT episodes require metadata.testName or metadata.testFile.";
      }
    }

    if (type === "ERROR") {
      if (typeof metadata.errorCode !== "string" && typeof metadata.stack !== "string") {
        return "ERROR episodes require metadata.errorCode or metadata.stack.";
      }
    }

    return null;
  }

  async inferEntityHints(
    query: string,
    limit: number,
    embeddingEngine: EmbeddingEngine | undefined,
    projectId: string,
    ensureEmbeddings: () => Promise<void>,
  ): Promise<string[]> {
    if (!embeddingEngine || !query.trim()) return [];

    try {
      await ensureEmbeddings();
      const topK = Math.max(1, Math.min(limit, 10));
      const [functions, classes, files] = await Promise.all([
        embeddingEngine.findSimilar(query, "function", topK, projectId),
        embeddingEngine.findSimilar(query, "class", topK, projectId),
        embeddingEngine.findSimilar(query, "file", topK, projectId),
      ]);

      return [...functions, ...classes, ...files]
        .map((item) => String(item.id || ""))
        .filter(Boolean)
        .slice(0, topK * 2);
    } catch {
      return [];
    }
  }
}
