/**
 * @file tools/handlers/core-graph-tools
 * @description Graph tool definitions — graph_query, graph_rebuild, graph_set_workspace, graph_health, diff_since.
 */

import * as fs from "fs";
import * as z from "zod";
import * as env from "../../env.js";
import { generateSecureId } from "../../utils/validation.js";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";
import { logger } from "../../utils/logger.js";

/**
 * Derives coarse label hints for global community search fallback queries.
 */
function deriveLabelHints(query: string): string[] {
  const raw = query.toLowerCase();
  const hints = ["tools", "engines", "graph", "parsers", "vector", "config"];
  return hints.filter((hint) => raw.includes(hint));
}

/**
 * Filters retrieval rows using temporal validity windows.
 */
function filterTemporalRows(
  ctx: HandlerBridge,
  rows: Array<{ nodeId?: string }>,
  asOfTs?: number | null,
): Array<{ nodeId?: string }> {
  if (asOfTs === null || asOfTs === undefined) {
    return rows;
  }

  return rows.filter((row) => {
    if (!row.nodeId) {
      return true;
    }

    const node = ctx.context.index.getNode(row.nodeId);
    const validFrom = Number(node?.properties?.validFrom);
    const validToRaw = node?.properties?.validTo;
    const validTo =
      validToRaw === null || validToRaw === undefined ? undefined : Number(validToRaw);

    if (!Number.isFinite(validFrom)) {
      return true;
    }

    return (
      validFrom <= asOfTs &&
      (!Number.isFinite(validTo) || (validTo !== undefined && validTo > asOfTs))
    );
  });
}

/**
 * Resolves global community candidates used by graph query hybrid/global modes.
 */
async function fetchGlobalCommunityRows(
  ctx: HandlerBridge,
  query: string,
  projectId: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const keywordHint = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .find((token) => token.length >= 4);

  const params: Record<string, unknown> = {
    projectId,
    limit,
    keywordHint: keywordHint || null,
    labels: deriveLabelHints(query),
  };

  const scoped = await ctx.context.memgraph.executeCypher(
    `MATCH (c:COMMUNITY {projectId: $projectId})
     WHERE ($keywordHint IS NOT NULL AND toLower(c.summary) CONTAINS $keywordHint)
        OR toLower(c.label) IN $labels
     RETURN c.id AS id, c.label AS label, c.summary AS summary, c.memberCount AS memberCount
     ORDER BY c.memberCount DESC
     LIMIT $limit`,
    params,
  );

  if (scoped.data.length > 0) {
    return scoped.data;
  }

  const fallback = await ctx.context.memgraph.executeCypher(
    `MATCH (c:COMMUNITY {projectId: $projectId})
     RETURN c.id AS id, c.label AS label, c.summary AS summary, c.memberCount AS memberCount
     ORDER BY c.memberCount DESC
     LIMIT $limit`,
    { projectId, limit },
  );

  return fallback.data;
}

/**
 * Canonical list of core tool definitions consumed by split category modules.
 */

export const coreGraphToolDefinitions: ToolDefinition[] = [
  {
    name: "graph_query",
    category: "graph",
    description: "Execute Cypher or natural language query against the code graph",
    inputShape: {
      query: z.string().describe("Cypher or natural language query"),
      language: z.enum(["cypher", "natural"]).default("natural").describe("Query language"),
      mode: z
        .enum(["local", "global", "hybrid"])
        .default("local")
        .describe("Query mode for natural language"),
      limit: z.number().default(100).describe("Result limit"),
      asOf: z
        .string()
        .optional()
        .describe("Optional ISO timestamp or epoch ms for temporal query mode"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        query,
        language = "natural",
        limit = 100,
        profile = "compact",
        asOf,
        mode = "local",
      } = args;

      const hybridRetriever = ctx.engines.hybrid as
        | {
            retrieve: (args: {
              query: string;
              projectId: string;
              limit: number;
              mode: "hybrid";
            }) => Promise<Array<{ nodeId?: string }>>;
          }
        | undefined;

      try {
        let result;
        const { projectId, workspaceRoot } = ctx.getActiveProjectContext();
        const asOfTs = ctx.toEpochMillis(asOf);
        const queryMode = mode === "global" || mode === "hybrid" ? mode : "local";

        if (language === "cypher") {
          const cypherQuery =
            asOfTs !== null ? ctx.applyTemporalFilterToCypher(query) : query;

          result =
            asOfTs !== null
              ? await ctx.context.memgraph.executeCypher(cypherQuery, {
                  asOfTs,
                })
              : await ctx.context.memgraph.executeCypher(cypherQuery);
        } else {
          if (queryMode === "global" || queryMode === "hybrid") {
            const globalRows = await fetchGlobalCommunityRows(ctx, query, projectId, limit);

            if (queryMode === "global") {
              result = { data: globalRows };
            } else {
              const localResults = await hybridRetriever!.retrieve({
                query,
                projectId,
                limit,
                mode: "hybrid",
              });
              const filteredLocal = filterTemporalRows(ctx, localResults, asOfTs);
              result = {
                data: [
                  {
                    section: "global",
                    communities: globalRows,
                  },
                  {
                    section: "local",
                    results: filteredLocal,
                  },
                ],
              };
            }
          } else {
            const localResults = await hybridRetriever!.retrieve({
              query,
              projectId,
              limit,
              mode: "hybrid",
            });
            const filteredLocal = filterTemporalRows(ctx, localResults, asOfTs);
            result = { data: filteredLocal };
          }
        }

        if (result.error) {
          return ctx.errorEnvelope(
            "GRAPH_QUERY_FAILED",
            result.error,
            true,
            "Try using language='cypher' with an explicit query.",
          );
        }

        const limited = result.data.slice(0, limit);
        return ctx.formatSuccess(
          {
            intent: language === "natural" ? ctx.classifyIntent(query) : "cypher",
            mode: queryMode,
            projectId,
            workspaceRoot,
            asOf: asOfTs,
            count: limited.length,
            results: limited,
          },
          profile,
          `Query returned ${limited.length} row(s).`,
          "graph_query",
        );
      } catch (error) {
        return ctx.errorEnvelope("GRAPH_QUERY_EXCEPTION", String(error), true);
      }
    },
  },
  {
    name: "graph_rebuild",
    category: "graph",
    description: "Rebuild code graph from source",
    inputShape: {
      mode: z.enum(["full", "incremental"]).default("incremental").describe("Build mode"),
      verbose: z.boolean().default(false).describe("Verbose output"),
      workspaceRoot: z.string().optional().describe("Workspace root path (absolute preferred)"),
      workspacePath: z.string().optional().describe("Alias for workspaceRoot"),
      sourceDir: z
        .string()
        .optional()
        .describe("Source directory path (absolute or relative to workspace root)"),
      projectId: z.string().optional().describe("Project namespace for graph isolation"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
      indexDocs: z
        .boolean()
        .default(true)
        .describe(
          "Index markdown documentation files (READMEs, ADRs) during rebuild (default: true). Set false to skip docs indexing.",
        ),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { mode = "incremental", verbose = false, profile = "compact", indexDocs = true } = args;

      const orchestrator = ctx.engines.orchestrator as
        | {
            build: (args: Record<string, unknown>) => Promise<{
              success: boolean;
              duration: number;
              filesProcessed: number;
              nodesCreated: number;
              relationshipsCreated: number;
              filesChanged: number;
              warnings: string[];
              errors: string[];
            }>;
          }
        | undefined;

      const coordinationEngine = ctx.engines.coordination as
        | {
            invalidateStaleClaims: (projectId: string) => Promise<number>;
          }
        | undefined;

      const embeddingEngine = ctx.engines.embedding as
        | {
            generateAllEmbeddings: () => Promise<{
              functions: number;
              classes: number;
              files: number;
            }>;
            storeInQdrant: () => Promise<void>;
          }
        | undefined;

      const communityDetector = ctx.engines.community as
        | {
            run: (projectId: string) => Promise<{
              mode: string;
              communities: number;
              members: number;
            }>;
          }
        | undefined;

      const hybridRetriever = ctx.engines.hybrid as
        | {
            ensureBM25Index: () => Promise<{ created?: boolean; error?: string } | undefined>;
          }
        | undefined;

      try {
        if (!orchestrator) {
          return ctx.errorEnvelope(
            "GRAPH_ORCHESTRATOR_UNAVAILABLE",
            "Graph orchestrator not initialized",
            true,
          );
        }

        let resolvedContext = ctx.resolveProjectContext(args || {});
        const adapted = ctx.adaptWorkspaceForRuntime(resolvedContext);
        const explicitWorkspaceProvided =
          typeof args?.workspaceRoot === "string" && args.workspaceRoot.trim().length > 0;

        if (
          adapted.usedFallback &&
          explicitWorkspaceProvided &&
          !ctx.runtimePathFallbackAllowed()
        ) {
          return ctx.errorEnvelope(
            "WORKSPACE_PATH_SANDBOXED",
            `Requested workspaceRoot is not accessible from this runtime: ${resolvedContext.workspaceRoot}`,
            true,
            "Mount the target project into the container (e.g. LXRAG_TARGET_WORKSPACE) and restart docker-compose, or set LXRAG_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
          );
        }

        resolvedContext = adapted.context;
        ctx.setActiveProjectContext(resolvedContext);
        const { workspaceRoot, sourceDir, projectId } = resolvedContext;
        const txTimestamp = Date.now();
        const txId = generateSecureId("tx", 4);

        if (ctx.context.memgraph.isConnected()) {
          await ctx.context.memgraph.executeCypher(
            `CREATE (tx:GRAPH_TX {id: $id, projectId: $projectId, type: $type, timestamp: $timestamp, mode: $mode, sourceDir: $sourceDir})`,
            {
              id: txId,
              projectId,
              type: mode === "full" ? "full_rebuild" : "incremental_rebuild",
              timestamp: txTimestamp,
              mode,
              sourceDir,
            },
          );
        }

        if (!fs.existsSync(workspaceRoot)) {
          return ctx.errorEnvelope(
            "WORKSPACE_NOT_FOUND",
            `Workspace root does not exist: ${workspaceRoot}`,
            true,
            "Call graph_set_workspace first with a valid path.",
          );
        }

        if (!fs.existsSync(sourceDir)) {
          return ctx.errorEnvelope(
            "SOURCE_DIR_NOT_FOUND",
            `Source directory does not exist: ${sourceDir}`,
            true,
            "Provide sourceDir in graph_rebuild or graph_set_workspace.",
          );
        }

        const postBuild = async (result: {
          success: boolean;
          duration: number;
          filesProcessed: number;
          nodesCreated: number;
          relationshipsCreated: number;
          filesChanged: number;
          warnings: string[];
          errors: string[];
        }) => {
          logger.error(
            `[graph_rebuild] ${mode} build completed in ${result.duration}ms (${result.filesProcessed} files, ${result.nodesCreated} nodes, ${result.errors.length} errors, ${result.warnings.length} warnings) for project ${projectId}`,
          );

          const invalidated = await coordinationEngine!.invalidateStaleClaims(projectId);
          if (invalidated > 0) {
            logger.error(
              `[coordination] Invalidated ${invalidated} stale claim(s) post-rebuild for project ${projectId}`,
            );
          }

          if (mode === "incremental") {
            ctx.setProjectEmbeddingsReady(projectId, false);
            logger.error(
              `[Phase2a] Embeddings flag reset for incremental rebuild of project ${projectId}`,
            );
          } else if (mode === "full") {
            try {
              const generated = await embeddingEngine?.generateAllEmbeddings();
              if (generated && generated.functions + generated.classes + generated.files > 0) {
                await embeddingEngine?.storeInQdrant();
                ctx.setProjectEmbeddingsReady(projectId, true);
                logger.error(
                  `[Phase2b] Embeddings auto-generated for full rebuild: ${generated.functions} functions, ${generated.classes} classes, ${generated.files} files for project ${projectId}`,
                );
              }
            } catch (embeddingError) {
              logger.error(
                `[Phase2b] Embedding generation failed during full rebuild for project ${projectId}:`,
                embeddingError,
              );
            }

            const communityRun = await communityDetector!.run(projectId);
            logger.error(
              `[community] ${communityRun.mode}: ${communityRun.communities} communities across ${communityRun.members} member node(s) for project ${projectId}`,
            );
          }

          const bm25Result = await hybridRetriever?.ensureBM25Index();
          if (bm25Result?.created) {
            logger.error(`[bm25] Created text_search symbol_index for project ${projectId}`);
          } else if (bm25Result?.error) {
            logger.error(`[bm25] symbol_index unavailable: ${bm25Result.error}`);
          }

          return result;
        };

        const buildPromise = orchestrator
          .build({
            mode,
            verbose,
            workspaceRoot,
            projectId,
            sourceDir,
            txId,
            txTimestamp,
            indexDocs,
            exclude: ["node_modules", "dist", ".next", ".lxrag", "coverage", ".git"],
          })
          .then(postBuild)
          .catch((err) => {
            const context = `mode=${mode}, projectId=${projectId}`;
            ctx.recordBuildError(projectId, err, context);

            const errorMsg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : "";
            logger.error(
              `[Phase4.5] Background build failed for project ${projectId} (${mode}): ${errorMsg}`,
            );
            if (stack) {
              logger.error(`[Phase4.5] Stack trace: ${stack.substring(0, 500)}`);
            }

            throw err;
          });

        const thresholdMs = Math.max(1000, env.LXRAG_SYNC_REBUILD_THRESHOLD_MS);

        const raceResult = await Promise.race([
          buildPromise.then((result) => ({
            status: "completed" as const,
            result,
          })),
          new Promise<{ status: "queued" }>((resolve) =>
            setTimeout(() => resolve({ status: "queued" }), thresholdMs),
          ),
        ]);

        ctx.lastGraphRebuildAt = new Date().toISOString();
        ctx.lastGraphRebuildMode = mode;

        if (raceResult.status === "completed") {
          return ctx.formatSuccess(
            {
              success: raceResult.result.success,
              status: "COMPLETED",
              mode,
              verbose,
              sourceDir,
              workspaceRoot,
              projectId,
              txId,
              txTimestamp,
              durationMs: raceResult.result.duration,
              filesProcessed: raceResult.result.filesProcessed,
              nodesCreated: raceResult.result.nodesCreated,
              relationshipsCreated: raceResult.result.relationshipsCreated,
              filesChanged: raceResult.result.filesChanged,
              warnings: raceResult.result.warnings,
              errors: raceResult.result.errors,
              runtimePathFallback: adapted.usedFallback,
              runtimePathFallbackReason: adapted.fallbackReason || null,
              message: `Graph rebuild ${mode} mode completed in ${raceResult.result.duration}ms.`,
            },
            profile,
            `Graph rebuild completed in ${raceResult.result.duration}ms for project ${projectId}.`,
            "graph_rebuild",
          );
        }

        buildPromise.catch(() => {
          // Background errors are already captured above.
        });

        return ctx.formatSuccess(
          {
            success: true,
            status: "QUEUED",
            mode,
            verbose,
            sourceDir,
            workspaceRoot,
            projectId,
            txId,
            txTimestamp,
            syncThresholdMs: thresholdMs,
            pollIntervalMs: 2000,
            completionCriteria: {
              driftDetected: false,
              embeddingsGeneratedGreaterThan: 0,
            },
            runtimePathFallback: adapted.usedFallback,
            runtimePathFallbackReason: adapted.fallbackReason || null,
            message: `Graph rebuild ${mode} mode initiated. Processing ${mode === "full" ? "all" : "changed"} files in background...`,
            note: "Use graph_health to poll until cache.driftDetected=false and embeddings.generated>0.",
          },
          profile,
          `Graph rebuild queued in ${mode} mode for project ${projectId}.`,
          "graph_rebuild",
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "GRAPH_REBUILD_FAILED",
          `Graph rebuild failed to start: ${String(error)}`,
          true,
        );
      }
    },
  },
  {
    name: "graph_set_workspace",
    category: "graph",
    description: "Set active workspace/project context for subsequent graph tools",
    inputShape: {
      workspaceRoot: z.string().optional().describe("Workspace root path (absolute preferred)"),
      workspacePath: z.string().optional().describe("Alias for workspaceRoot"),
      sourceDir: z
        .string()
        .optional()
        .describe("Source directory path (absolute or relative to workspace root)"),
      projectId: z.string().optional().describe("Project namespace for graph isolation"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { profile = "compact" } = args || {};

      try {
        let nextContext = ctx.resolveProjectContext(args || {});
        const adapted = ctx.adaptWorkspaceForRuntime(nextContext);
        const explicitWorkspaceProvided =
          typeof args?.workspaceRoot === "string" && args.workspaceRoot.trim().length > 0;

        if (
          adapted.usedFallback &&
          explicitWorkspaceProvided &&
          !ctx.runtimePathFallbackAllowed()
        ) {
          return ctx.errorEnvelope(
            "WORKSPACE_PATH_SANDBOXED",
            `Requested workspaceRoot is not accessible from this runtime: ${nextContext.workspaceRoot}`,
            true,
            "Mount the target project into the container (e.g. LXRAG_TARGET_WORKSPACE) and restart docker-compose, or set LXRAG_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
          );
        }

        nextContext = adapted.context;

        if (!fs.existsSync(nextContext.workspaceRoot)) {
          return ctx.errorEnvelope(
            "WORKSPACE_NOT_FOUND",
            `Workspace root does not exist: ${nextContext.workspaceRoot}`,
            true,
            "Pass an existing absolute path as workspaceRoot (or workspacePath).",
          );
        }

        if (!fs.existsSync(nextContext.sourceDir)) {
          return ctx.errorEnvelope(
            "SOURCE_DIR_NOT_FOUND",
            `Source directory does not exist: ${nextContext.sourceDir}`,
            true,
            "Pass sourceDir explicitly if your source folder is not <workspaceRoot>/src.",
          );
        }

        ctx.setActiveProjectContext(nextContext);
        await ctx.startActiveWatcher(nextContext);

        const watcher = ctx.getActiveWatcher();

        return ctx.formatSuccess(
          {
            success: true,
            projectContext: ctx.getActiveProjectContext(),
            watcherEnabled: ctx.watcherEnabledForRuntime(),
            watcherState: watcher?.state || "not_started",
            pendingChanges: watcher?.pendingChanges ?? 0,
            runtimePathFallback: adapted.usedFallback,
            runtimePathFallbackReason: adapted.fallbackReason || null,
            message: "Workspace context updated. Subsequent graph tools will use this project.",
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "SET_WORKSPACE_FAILED",
          String(error),
          true,
          "Retry with workspaceRoot and sourceDir values.",
        );
      }
    },
  },
  {
    name: "graph_health",
    category: "graph",
    description: "Report graph/index/vector health and freshness status",
    inputShape: {
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const profile = args?.profile || "compact";

      const hybridRetriever = ctx.engines.hybrid as
        | {
            bm25IndexKnownToExist?: boolean;
            bm25Mode?: string;
          }
        | undefined;

      try {
        const { workspaceRoot, sourceDir, projectId } = ctx.getActiveProjectContext();

        const healthStatsResult = await ctx.context.memgraph.executeCypher(
          `MATCH (n {projectId: $projectId})
           WITH count(n) AS totalNodes
           MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
           WITH totalNodes, count(r) AS totalRels
           MATCH (f:FILE {projectId: $projectId})
           WITH totalNodes, totalRels, count(f) AS fileCount
           MATCH (fc:FUNCTION {projectId: $projectId})
           WITH totalNodes, totalRels, fileCount, count(fc) AS funcCount
           MATCH (c:CLASS {projectId: $projectId})
           WITH totalNodes, totalRels, fileCount, funcCount, count(c) AS classCount
           MATCH (imp:IMPORT {projectId: $projectId})
           RETURN totalNodes, totalRels, fileCount, funcCount, classCount, count(imp) AS importCount`,
          { projectId },
        );

        const stats = healthStatsResult.data?.[0] || {};
        const memgraphNodeCount = ctx.toSafeNumber(stats.totalNodes) ?? 0;
        const memgraphRelCount = ctx.toSafeNumber(stats.totalRels) ?? 0;
        const memgraphFileCount = ctx.toSafeNumber(stats.fileCount) ?? 0;
        const memgraphFuncCount = ctx.toSafeNumber(stats.funcCount) ?? 0;
        const memgraphClassCount = ctx.toSafeNumber(stats.classCount) ?? 0;
        const memgraphImportCount = ctx.toSafeNumber(stats.importCount) ?? 0;
        const memgraphIndexableCount =
          memgraphFileCount + memgraphFuncCount + memgraphClassCount + memgraphImportCount;

        const indexStats = ctx.context.index.getStatistics();
        const indexFileCount = ctx.context.index.getNodesByType("FILE").length;
        const indexFuncCount = ctx.context.index.getNodesByType("FUNCTION").length;
        const indexClassCount = ctx.context.index.getNodesByType("CLASS").length;
        const indexedSymbols = indexFileCount + indexFuncCount + indexClassCount;

        let embeddingCount = 0;
        if (ctx.engines.qdrant?.isConnected?.()) {
          try {
            const [fnColl, clsColl, fileColl] = await Promise.all([
              ctx.engines.qdrant.getCollection("functions"),
              ctx.engines.qdrant.getCollection("classes"),
              ctx.engines.qdrant.getCollection("files"),
            ]);
            embeddingCount =
              (fnColl?.pointCount ?? 0) + (clsColl?.pointCount ?? 0) + (fileColl?.pointCount ?? 0);
          } catch {
            // Fall back to in-memory count below.
          }
        }
        if (embeddingCount === 0) {
          embeddingCount =
            (ctx.engines.embedding
              ?.getAllEmbeddings()
              .filter((e: any) => e.projectId === projectId).length as number) || 0;
        }
        const embeddingCoverage =
          memgraphFuncCount + memgraphClassCount + memgraphFileCount > 0
            ? Number(
                (
                  embeddingCount /
                  (memgraphFuncCount + memgraphClassCount + memgraphFileCount)
                ).toFixed(3),
              )
            : 0;

        const indexDrift = Math.abs(indexStats.totalNodes - memgraphIndexableCount) > 3;
        const embeddingDrift = embeddingCount < indexedSymbols;

        const txMetadataResult = await ctx.context.memgraph.executeCypher(
          `MATCH (tx:GRAPH_TX {projectId: $projectId})
           WITH tx ORDER BY tx.timestamp DESC
           WITH collect({id: tx.id, timestamp: tx.timestamp})[0] AS latestTx, count(*) AS txCount
           RETURN latestTx, txCount`,
          { projectId },
        );
        const txMetadata = (txMetadataResult.data?.[0] || {}) as Record<string, unknown>;
        const latestTxRow = (txMetadata.latestTx || {}) as Record<string, unknown>;
        const txCountRow = {
          txCount: ctx.toSafeNumber(txMetadata.txCount) ?? 0,
        };
        const watcher = ctx.getActiveWatcher();

        const recommendations: string[] = [];
        if (indexDrift) {
          recommendations.push(
            "Index is out of sync with Memgraph - run graph_rebuild to synchronize",
          );
        }
        if (embeddingDrift && ctx.isProjectEmbeddingsReady(projectId)) {
          recommendations.push(
            "Some entities don't have embeddings - run semantic_search or graph_rebuild to generate them",
          );
        }

        return ctx.formatSuccess(
          {
            status: indexDrift ? "drift_detected" : "ok",
            projectId,
            workspaceRoot,
            sourceDir,
            memgraphConnected: ctx.context.memgraph.isConnected(),
            qdrantConnected: ctx.engines.qdrant?.isConnected() || false,
            graphIndex: {
              totalNodes: memgraphNodeCount,
              totalRelationships: memgraphRelCount,
              indexedFiles: memgraphFileCount,
              indexedFunctions: memgraphFuncCount,
              indexedClasses: memgraphClassCount,
            },
            indexHealth: {
              driftDetected: indexDrift,
              memgraphNodes: memgraphNodeCount,
              memgraphIndexableNodes: memgraphIndexableCount,
              cachedNodes: indexStats.totalNodes,
              memgraphRels: memgraphRelCount,
              cachedRels: indexStats.totalRelationships,
              recommendation: indexDrift
                ? "Index out of sync - run graph_rebuild to refresh"
                : "Index synchronized",
            },
            embeddings: {
              ready: ctx.isProjectEmbeddingsReady(projectId),
              generated: embeddingCount,
              coverage: embeddingCoverage,
              driftDetected: embeddingDrift,
              recommendation:
                embeddingCount === 0 &&
                memgraphFuncCount + memgraphClassCount + memgraphFileCount > 0
                  ? "No embeddings generated — run graph_rebuild (full mode) to enable semantic search"
                  : embeddingDrift
                    ? "Embeddings incomplete - run semantic_search or rebuild to regenerate"
                    : "Embeddings complete",
            },
            retrieval: {
              bm25IndexExists: hybridRetriever?.bm25IndexKnownToExist ?? false,
              mode: hybridRetriever?.bm25Mode ?? "not_initialized",
            },
            summarizer: {
              configured: !!env.LXRAG_SUMMARIZER_URL,
              endpoint: env.LXRAG_SUMMARIZER_URL ? "[configured]" : null,
            },
            rebuild: {
              lastRequestedAt: ctx.lastGraphRebuildAt || null,
              lastMode: ctx.lastGraphRebuildMode || null,
              latestTxId: latestTxRow.id ?? null,
              latestTxTimestamp:
                ctx.toSafeNumber(latestTxRow.timestamp) ?? latestTxRow.timestamp ?? null,
              txCount: txCountRow.txCount ?? 0,
              recentErrors: ctx.getRecentBuildErrors(projectId, 3),
            },
            freshness: {
              staleFileEstimate: null,
              note: "Use graph_rebuild incremental to refresh changed files.",
            },
            pendingChanges: watcher?.pendingChanges ?? 0,
            watcherState: watcher?.state || "not_started",
            recommendations,
          },
          profile,
          indexDrift ? "Graph drift detected - see recommendations" : "Graph health is OK.",
          "graph_health",
        );
      } catch (error) {
        return ctx.errorEnvelope("GRAPH_HEALTH_FAILED", String(error), true);
      }
    },
  },
  {
    name: "diff_since",
    category: "utility",
    description: "Summarize temporal graph changes since txId, timestamp, git commit, or agentId",
    inputShape: {
      since: z.string().describe("Anchor value: txId, ISO timestamp, git commit SHA, or agentId"),
      projectId: z
        .string()
        .optional()
        .describe("Optional project override (defaults to active context)"),
      types: z
        .array(z.enum(["FILE", "FUNCTION", "CLASS"]))
        .optional()
        .describe("Optional node types to include"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { since, types = ["FILE", "FUNCTION", "CLASS"], profile = "compact" } = args || {};

      if (!since || typeof since !== "string") {
        return ctx.errorEnvelope(
          "DIFF_SINCE_INVALID_INPUT",
          "Field 'since' is required and must be a string.",
          true,
          "Provide txId, ISO timestamp, git commit SHA, or agentId.",
        );
      }

      try {
        const active = ctx.getActiveProjectContext();
        const projectId =
          typeof args?.projectId === "string" && args.projectId.trim().length > 0
            ? args.projectId
            : active.projectId;

        const normalizedTypes = Array.isArray(types)
          ? types
              .map((item) => String(item).toUpperCase())
              .filter((item) => ["FILE", "FUNCTION", "CLASS"].includes(item))
          : ["FILE", "FUNCTION", "CLASS"];

        if (!normalizedTypes.length) {
          return ctx.errorEnvelope(
            "DIFF_SINCE_INVALID_TYPES",
            "Field 'types' must include at least one of FILE, FUNCTION, CLASS.",
            true,
          );
        }

        const anchor = await ctx.resolveSinceAnchor(since, projectId);
        if (!anchor) {
          return ctx.errorEnvelope(
            "DIFF_SINCE_ANCHOR_NOT_FOUND",
            `Unable to resolve 'since' anchor: ${since}`,
            true,
            "Use a known txId, ISO timestamp, git commit SHA, or agentId with recorded GRAPH_TX entries.",
          );
        }

        const txResult = await ctx.context.memgraph.executeCypher(
          `MATCH (tx:GRAPH_TX {projectId: $projectId})
           WHERE tx.timestamp >= $sinceTs
           RETURN tx.id AS id
           ORDER BY tx.timestamp ASC`,
          { projectId, sinceTs: anchor.sinceTs },
        );
        const txIds = (txResult.data || []).map((row: Record<string, unknown>) => String(row.id || "")).filter(Boolean);

        const addedResult = await ctx.context.memgraph.executeCypher(
          `MATCH (n)
           WHERE n.projectId = $projectId
             AND labels(n)[0] IN $types
             AND n.validFrom IS NOT NULL
             AND n.validFrom >= $sinceTs
           RETURN labels(n)[0] AS type,
                  n.id AS scip_id,
                  coalesce(n.path, n.relativePath, '') AS path,
                  n.name AS symbolName,
                  n.validFrom AS validFrom,
                  n.validTo AS validTo
           ORDER BY n.validFrom DESC
           LIMIT 500`,
          { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
        );

        const removedResult = await ctx.context.memgraph.executeCypher(
          `MATCH (n)
           WHERE n.projectId = $projectId
             AND labels(n)[0] IN $types
             AND n.validTo IS NOT NULL
             AND n.validTo >= $sinceTs
           RETURN labels(n)[0] AS type,
                  n.id AS scip_id,
                  coalesce(n.path, n.relativePath, '') AS path,
                  n.name AS symbolName,
                  n.validFrom AS validFrom,
                  n.validTo AS validTo
           ORDER BY n.validTo DESC
           LIMIT 500`,
          { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
        );

        const modifiedResult = await ctx.context.memgraph.executeCypher(
          `MATCH (newer)
           WHERE newer.projectId = $projectId
             AND labels(newer)[0] IN $types
             AND newer.validFrom IS NOT NULL
             AND newer.validFrom >= $sinceTs
           MATCH (older)
           WHERE older.projectId = $projectId
             AND labels(older)[0] IN $types
             AND older.id = newer.id
             AND older.validTo IS NOT NULL
             AND older.validTo >= $sinceTs
           RETURN DISTINCT labels(newer)[0] AS type,
                  newer.id AS scip_id,
                  coalesce(newer.path, newer.relativePath, '') AS path,
                  newer.name AS symbolName,
                  newer.validFrom AS validFrom,
                  newer.validTo AS validTo
           ORDER BY validFrom DESC
           LIMIT 500`,
          { projectId, sinceTs: anchor.sinceTs, types: normalizedTypes },
        );

        const mapDelta = (rows: any[]) =>
          (rows || []).map((row) => ({
            scip_id: String(row.scip_id || ""),
            type: String(row.type || "UNKNOWN"),
            path: String(row.path || ""),
            symbolName: row.symbolName ? String(row.symbolName) : undefined,
            validFrom: ctx.toSafeNumber(row.validFrom),
            validTo: ctx.toSafeNumber(row.validTo) ?? undefined,
          }));

        const added = mapDelta(addedResult.data || []);
        const removed = mapDelta(removedResult.data || []);
        const modified = mapDelta(modifiedResult.data || []);

        const summary = `${added.length} added, ${removed.length} removed, ${modified.length} modified since ${anchor.anchorValue}.`;

        return ctx.formatSuccess(
          {
            summary,
            projectId,
            since: {
              input: since,
              resolvedMode: anchor.mode,
              resolvedTimestamp: anchor.sinceTs,
            },
            added,
            removed,
            modified,
            txIds,
          },
          profile,
          summary,
          "diff_since",
        );
      } catch (error) {
        return ctx.errorEnvelope("DIFF_SINCE_FAILED", String(error), true);
      }
    },
  },
];
