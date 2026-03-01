/**
 * @file tools/handlers/core-semantic-tools
 * @description Semantic/code-intelligence tool definitions — semantic_search, find_similar_code, code_clusters, semantic_diff, suggest_tests, context_pack, semantic_slice.
 */

import * as z from "zod";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";

export const coreSemanticToolDefinitions: ToolDefinition[] = [
  {
    name: "semantic_search",
    category: "code",
    description: "Search code semantically using vector similarity",
    inputShape: {
      query: z.string().describe("Search query"),
      type: z.enum(["function", "class", "file"]).optional().describe("Code type to search"),
      limit: z.number().default(5).describe("Result limit"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { query, type = "function", limit = 5, profile = "compact" } = args;

      const embeddingEngine = ctx.engines.embedding as
        | {
            findSimilar: (
              query: string,
              type: string,
              limit: number,
              projectId: string,
            ) => Promise<
              Array<{
                id: string;
                name: string;
                type: string;
                metadata: { path?: string };
              }>
            >;
          }
        | undefined;

      try {
        await ctx.ensureEmbeddings();
        const { projectId } = ctx.getActiveProjectContext();
        const results = await embeddingEngine!.findSimilar(query, type, limit, projectId);

        return ctx.formatSuccess(
          {
            query,
            type,
            count: results.length,
            results: results.map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              path: item.metadata.path,
            })),
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("SEMANTIC_SEARCH_FAILED", String(error), true);
      }
    },
  },
  {
    name: "find_similar_code",
    category: "code",
    description:
      "Find code elements similar to a given function or class by vector similarity. Requires elementId — use the id field returned by graph_query or code_explain (not a symbol name or natural language string). Optionally set threshold (0–1, default 0.7) and limit. Returns similar elements with names and file paths.",
    inputShape: {
      elementId: z.string().describe("Code element ID"),
      threshold: z.number().default(0.7).describe("Similarity threshold (0-1)"),
      limit: z.number().default(10).describe("Result limit"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { elementId, threshold = 0.7, limit = 10, profile = "compact" } = args;

      const embeddingEngine = ctx.engines.embedding as
        | {
            findSimilar: (
              query: string,
              type: string,
              limit: number,
              projectId: string,
            ) => Promise<
              Array<{
                id: string;
                name: string;
                type: string;
                metadata: { path?: string };
              }>
            >;
          }
        | undefined;

      try {
        await ctx.ensureEmbeddings();
        const { projectId } = ctx.getActiveProjectContext();
        const results = await embeddingEngine!.findSimilar(elementId, "function", limit, projectId);
        const filtered = results.slice(0, limit);

        return ctx.formatSuccess(
          {
            elementId,
            threshold,
            count: filtered.length,
            similar: filtered.map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              path: item.metadata.path,
            })),
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("FIND_SIMILAR_CODE_FAILED", String(error), true);
      }
    },
  },
  {
    name: "code_clusters",
    category: "code",
    description:
      "Cluster code elements by directory proximity and vector similarity. Requires type (function | class | file). Returns clusters with member counts and samples — useful for understanding module boundaries and finding groups of related code. Depends on Qdrant embeddings.",
    inputShape: {
      type: z.enum(["function", "class", "file"]).describe("Code type to cluster"),
      count: z.number().default(5).describe("Number of clusters"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { type, count = 5, profile = "compact" } = args;

      const embeddingEngine = ctx.engines.embedding as
        | {
            getAllEmbeddings: () => Array<{
              type: string;
              projectId: string;
              name: string;
              metadata: { path?: string };
            }>;
          }
        | undefined;

      try {
        await ctx.ensureEmbeddings();
        const { projectId } = ctx.getActiveProjectContext();
        const embeddings = embeddingEngine!
          .getAllEmbeddings()
          .filter((item) => item.type === type && item.projectId === projectId)
          .slice(0, 200);

        const clusters: Record<string, string[]> = {};
        for (const item of embeddings) {
          const itemPath = item.metadata.path || "unknown";
          const key = itemPath.split("/").slice(0, 2).join("/") || "root";
          if (!clusters[key]) {
            clusters[key] = [];
          }
          clusters[key].push(item.name);
        }

        const clusterRows = Object.entries(clusters)
          .map(([clusterId, names]) => ({
            clusterId,
            size: names.length,
            sample: names.slice(0, 5),
          }))
          .sort((a, b) => b.size - a.size)
          .slice(0, count);

        return ctx.formatSuccess(
          { type, count: clusterRows.length, clusters: clusterRows },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("CODE_CLUSTERS_FAILED", String(error), true);
      }
    },
  },
  {
    name: "semantic_diff",
    category: "code",
    description:
      "Compare graph-stored metadata properties between two code elements. Requires elementId1 and elementId2 — use the id fields from graph_query or code_explain results (not symbol names). Returns changed property keys and left/right-only properties. Note: compares graph metadata, not source-code semantics or embedding similarity.",
    inputShape: {
      elementId1: z.string().describe("First code element ID"),
      elementId2: z.string().describe("Second code element ID"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { elementId1, elementId2, profile = "compact" } = args;

      try {
        const left = ctx.resolveElement(elementId1);
        const right = ctx.resolveElement(elementId2);

        if (!left || !right) {
          return ctx.errorEnvelope(
            "SEMANTIC_DIFF_ELEMENT_NOT_FOUND",
            `Could not resolve one or both elements: ${elementId1}, ${elementId2}`,
            true,
          );
        }

        const leftProps = left.properties || {};
        const rightProps = right.properties || {};
        const leftKeys = new Set(Object.keys(leftProps));
        const rightKeys = new Set(Object.keys(rightProps));
        const commonKeys = [...leftKeys].filter((key) => rightKeys.has(key));

        const changedKeys = commonKeys.filter(
          (key) => JSON.stringify(leftProps[key]) !== JSON.stringify(rightProps[key]),
        );

        return ctx.formatSuccess(
          {
            left: left.properties.name || left.properties.path || left.id,
            right: right.properties.name || right.properties.path || right.id,
            leftType: left.type,
            rightType: right.type,
            changedKeys,
            leftOnlyKeys: [...leftKeys].filter((key) => !rightKeys.has(key)),
            rightOnlyKeys: [...rightKeys].filter((key) => !leftKeys.has(key)),
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("SEMANTIC_DIFF_FAILED", String(error), true);
      }
    },
  },
  {
    name: "suggest_tests",
    category: "test",
    description:
      "Suggest test cases for a code element. Requires elementId — use the id field returned by graph_query or code_explain (not a symbol name). Returns suggested test names, types, and coverage gaps based on the element's structure and similar existing tests.",
    inputShape: {
      elementId: z.string().describe("Code element ID"),
      limit: z.number().default(5).describe("Number of suggestions"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { elementId, limit = 5, profile = "compact" } = args;

      const testEngine = ctx.engines.test as
        | {
            selectAffectedTests: (
              changedFiles: string[],
              includeIntegration?: boolean,
              depth?: number,
            ) => {
              selectedTests: string[];
              estimatedTime: number;
              coverage: unknown;
            };
          }
        | undefined;

      try {
        const resolved = ctx.resolveElement(elementId);
        const candidatePath =
          resolved?.properties.path ||
          resolved?.properties.filePath ||
          resolved?.properties.relativePath ||
          (typeof elementId === "string" && elementId.includes("/") ? elementId : undefined);

        if (!candidatePath) {
          return ctx.errorEnvelope(
            "SUGGEST_TESTS_ELEMENT_NOT_FOUND",
            `Unable to resolve file path for element: ${elementId}`,
            true,
          );
        }

        const selection = testEngine!.selectAffectedTests([candidatePath], true, 2);
        const suggested = selection.selectedTests.slice(0, limit);

        return ctx.formatSuccess(
          {
            elementId,
            file: candidatePath,
            suggestedTests: suggested,
            estimatedTime: selection.estimatedTime,
            coverage: selection.coverage,
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("SUGGEST_TESTS_FAILED", String(error), true);
      }
    },
  },
  {
    name: "context_pack",
    category: "coordination",
    description:
      "Build a single-call task briefing using PPR-ranked retrieval across code, decisions, learnings, and blockers",
    inputShape: {
      task: z.string().describe("Task description"),
      taskId: z.string().optional().describe("Optional task id"),
      agentId: z.string().optional().describe("Agent identifier"),
      includeDecisions: z.boolean().default(true).describe("Include decision episodes"),
      includeEpisodes: z.boolean().default(true).describe("Include recent episodes"),
      includeLearnings: z.boolean().default(true).describe("Include learnings"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const impl = ctx.core_context_pack_impl;
      if (typeof impl !== "function") {
        return ctx.errorEnvelope(
          "TOOL_NOT_IMPLEMENTED",
          "context_pack implementation is unavailable",
          true,
        );
      }
      return impl.call(ctx, args);
    },
  },
  {
    name: "semantic_slice",
    category: "code",
    description: "Return relevant exact source lines with optional dependency and memory context",
    inputShape: {
      file: z.string().optional().describe("Relative or absolute source file path"),
      symbol: z.string().optional().describe("Symbol id/name (e.g. ToolHandlers.callTool)"),
      query: z.string().optional().describe("Natural-language fallback query"),
      context: z
        .enum(["signature", "body", "with-deps", "full"])
        .default("body")
        .describe("Slice detail mode"),
      pprScore: z.number().optional().describe("Optional PPR score from context_pack pipeline"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const impl = ctx.core_semantic_slice_impl;
      if (typeof impl !== "function") {
        return ctx.errorEnvelope(
          "TOOL_NOT_IMPLEMENTED",
          "semantic_slice implementation is unavailable",
          true,
        );
      }
      return impl.call(ctx, args);
    },
  },
];
