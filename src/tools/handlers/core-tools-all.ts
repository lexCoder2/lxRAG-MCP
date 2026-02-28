/**
 * @file tools/handlers/core-tools-all
 * @description Canonical definitions for core graph, code, utility, and setup tools.
 * @remarks Split modules consume this file to compose category-specific registries.
 */

import * as fs from "fs";
import * as path from "path";
import * as z from "zod";
import * as env from "../../env.js";
import { generateSecureId } from "../../utils/validation.js";
import type { HandlerBridge, ToolDefinition } from "../types.js";

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
): Promise<any[]> {
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
export const coreToolDefinitionsAll: ToolDefinition[] = [
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
            asOfTs !== null ? (ctx as any).applyTemporalFilterToCypher(query) : query;

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
            intent: language === "natural" ? (ctx as any).classifyIntent(query) : "cypher",
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
    name: "code_explain",
    category: "code",
    description: "Explain code element with dependency context",
    inputShape: {
      element: z.string().describe("File path, class or function name"),
      depth: z.number().min(1).max(3).default(2).describe("Analysis depth"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const { element, depth = 2, profile = "compact" } = args;

      try {
        const files = ctx.context.index.getNodesByType("FILE");
        const funcs = ctx.context.index.getNodesByType("FUNCTION");
        const classes = ctx.context.index.getNodesByType("CLASS");

        const targetNode =
          files.find((n: any) => n.properties.path?.includes(element)) ||
          funcs.find((n: any) => n.properties.name === element) ||
          classes.find((n: any) => n.properties.name === element);

        if (!targetNode) {
          return ctx.errorEnvelope(
            "ELEMENT_NOT_FOUND",
            `Element not found: ${element}`,
            true,
            "Provide a file path, class name, or function name present in the index.",
          );
        }

        const explanation: any = {
          element: targetNode.properties.name || targetNode.properties.path,
          type: targetNode.type,
          properties: targetNode.properties,
          dependencies: [] as any[],
          dependents: [] as any[],
        };

        const outgoing = ctx.context.index.getRelationshipsFrom(targetNode.id);
        for (const rel of outgoing.slice(0, depth * 10)) {
          const target = ctx.context.index.getNode(rel.to);
          if (target) {
            explanation.dependencies.push({
              type: rel.type,
              target: target.properties.name || target.properties.path || target.id,
            });
          }
        }

        const incoming = ctx.context.index.getRelationshipsTo(targetNode.id);
        for (const rel of incoming.slice(0, depth * 10)) {
          const source = ctx.context.index.getNode(rel.from);
          if (source) {
            explanation.dependents.push({
              type: rel.type,
              source: source.properties.name || source.properties.path || source.id,
            });
          }
        }

        return ctx.formatSuccess(explanation, profile);
      } catch (error) {
        return ctx.errorEnvelope("CODE_EXPLAIN_FAILED", String(error), true);
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
        const adapted = (ctx as any).adaptWorkspaceForRuntime(resolvedContext);
        const explicitWorkspaceProvided =
          typeof args?.workspaceRoot === "string" && args.workspaceRoot.trim().length > 0;

        if (
          adapted.usedFallback &&
          explicitWorkspaceProvided &&
          !(ctx as any).runtimePathFallbackAllowed()
        ) {
          return ctx.errorEnvelope(
            "WORKSPACE_PATH_SANDBOXED",
            `Requested workspaceRoot is not accessible from this runtime: ${resolvedContext.workspaceRoot}`,
            true,
            "Mount the target project into the container (e.g. LXRAG_TARGET_WORKSPACE) and restart docker-compose, or set LXRAG_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
          );
        }

        resolvedContext = adapted.context;
        (ctx as any).setActiveProjectContext(resolvedContext);
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
          console.error(
            `[graph_rebuild] ${mode} build completed in ${result.duration}ms (${result.filesProcessed} files, ${result.nodesCreated} nodes, ${result.errors.length} errors, ${result.warnings.length} warnings) for project ${projectId}`,
          );

          const invalidated = await coordinationEngine!.invalidateStaleClaims(projectId);
          if (invalidated > 0) {
            console.error(
              `[coordination] Invalidated ${invalidated} stale claim(s) post-rebuild for project ${projectId}`,
            );
          }

          if (mode === "incremental") {
            (ctx as any).setProjectEmbeddingsReady(projectId, false);
            console.error(
              `[Phase2a] Embeddings flag reset for incremental rebuild of project ${projectId}`,
            );
          } else if (mode === "full") {
            try {
              const generated = await embeddingEngine?.generateAllEmbeddings();
              if (generated && generated.functions + generated.classes + generated.files > 0) {
                await embeddingEngine?.storeInQdrant();
                (ctx as any).setProjectEmbeddingsReady(projectId, true);
                console.error(
                  `[Phase2b] Embeddings auto-generated for full rebuild: ${generated.functions} functions, ${generated.classes} classes, ${generated.files} files for project ${projectId}`,
                );
              }
            } catch (embeddingError) {
              console.error(
                `[Phase2b] Embedding generation failed during full rebuild for project ${projectId}:`,
                embeddingError,
              );
            }

            const communityRun = await communityDetector!.run(projectId);
            console.error(
              `[community] ${communityRun.mode}: ${communityRun.communities} communities across ${communityRun.members} member node(s) for project ${projectId}`,
            );
          }

          const bm25Result = await hybridRetriever?.ensureBM25Index();
          if (bm25Result?.created) {
            console.error(`[bm25] Created text_search symbol_index for project ${projectId}`);
          } else if (bm25Result?.error) {
            console.error(`[bm25] symbol_index unavailable: ${bm25Result.error}`);
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
            exclude: ["node_modules", "dist", ".next", ".lxrag", "__tests__", "coverage", ".git"],
          })
          .then(postBuild)
          .catch((err) => {
            const context = `mode=${mode}, projectId=${projectId}`;
            (ctx as any).recordBuildError(projectId, err, context);

            const errorMsg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : "";
            console.error(
              `[Phase4.5] Background build failed for project ${projectId} (${mode}): ${errorMsg}`,
            );
            if (stack) {
              console.error(`[Phase4.5] Stack trace: ${stack.substring(0, 500)}`);
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

        (ctx as any).lastGraphRebuildAt = new Date().toISOString();
        (ctx as any).lastGraphRebuildMode = mode;

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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const { profile = "compact" } = args || {};

      try {
        let nextContext = ctx.resolveProjectContext(args || {});
        const adapted = (ctx as any).adaptWorkspaceForRuntime(nextContext);
        const explicitWorkspaceProvided =
          typeof args?.workspaceRoot === "string" && args.workspaceRoot.trim().length > 0;

        if (
          adapted.usedFallback &&
          explicitWorkspaceProvided &&
          !(ctx as any).runtimePathFallbackAllowed()
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

        (ctx as any).setActiveProjectContext(nextContext);
        await (ctx as any).startActiveWatcher(nextContext);

        const watcher = (ctx as any).getActiveWatcher();

        return ctx.formatSuccess(
          {
            success: true,
            projectContext: ctx.getActiveProjectContext(),
            watcherEnabled: (ctx as any).watcherEnabledForRuntime(),
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
        const memgraphNodeCount = (ctx as any).toSafeNumber(stats.totalNodes) ?? 0;
        const memgraphRelCount = (ctx as any).toSafeNumber(stats.totalRels) ?? 0;
        const memgraphFileCount = (ctx as any).toSafeNumber(stats.fileCount) ?? 0;
        const memgraphFuncCount = (ctx as any).toSafeNumber(stats.funcCount) ?? 0;
        const memgraphClassCount = (ctx as any).toSafeNumber(stats.classCount) ?? 0;
        const memgraphImportCount = (ctx as any).toSafeNumber(stats.importCount) ?? 0;
        const memgraphIndexableCount =
          memgraphFileCount + memgraphFuncCount + memgraphClassCount + memgraphImportCount;

        const indexStats = ctx.context.index.getStatistics();
        const indexFileCount = ctx.context.index.getNodesByType("FILE").length;
        const indexFuncCount = ctx.context.index.getNodesByType("FUNCTION").length;
        const indexClassCount = ctx.context.index.getNodesByType("CLASS").length;
        const indexedSymbols = indexFileCount + indexFuncCount + indexClassCount;

        let embeddingCount = 0;
        if ((ctx.engines.qdrant as any)?.isConnected?.()) {
          try {
            const [fnColl, clsColl, fileColl] = await Promise.all([
              (ctx.engines.qdrant as any).getCollection("functions"),
              (ctx.engines.qdrant as any).getCollection("classes"),
              (ctx.engines.qdrant as any).getCollection("files"),
            ]);
            embeddingCount =
              (fnColl?.pointCount ?? 0) + (clsColl?.pointCount ?? 0) + (fileColl?.pointCount ?? 0);
          } catch {
            // Fall back to in-memory count below.
          }
        }
        if (embeddingCount === 0) {
          embeddingCount =
            ((ctx.engines.embedding as any)
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
        const txMetadata = txMetadataResult.data?.[0] || {};
        const latestTxRow = txMetadata.latestTx || {};
        const txCountRow = {
          txCount: (ctx as any).toSafeNumber(txMetadata.txCount) ?? 0,
        };
        const watcher = (ctx as any).getActiveWatcher();

        const recommendations: string[] = [];
        if (indexDrift) {
          recommendations.push(
            "Index is out of sync with Memgraph - run graph_rebuild to synchronize",
          );
        }
        if (embeddingDrift && (ctx as any).isProjectEmbeddingsReady(projectId)) {
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
            qdrantConnected: (ctx.engines.qdrant as any)?.isConnected() || false,
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
              ready: (ctx as any).isProjectEmbeddingsReady(projectId),
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
              lastRequestedAt: (ctx as any).lastGraphRebuildAt || null,
              lastMode: (ctx as any).lastGraphRebuildMode || null,
              latestTxId: (latestTxRow as any).id ?? null,
              latestTxTimestamp:
                (ctx as any).toSafeNumber((latestTxRow as any).timestamp) ?? (latestTxRow as any).timestamp ?? null,
              txCount: txCountRow.txCount ?? 0,
              recentErrors: (ctx as any).getRecentBuildErrors(projectId, 3),
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
    name: "tools_list",
    category: "utility",
    description:
      "List all MCP tools and their availability in the current session, grouped by category",
    inputShape: {
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const profile = args?.profile ?? "compact";

      const KNOWN_CATEGORIES: Record<string, string[]> = {
        graph: [
          "graph_set_workspace",
          "graph_rebuild",
          "graph_query",
          "graph_health",
          "tools_list",
          "ref_query",
        ],
        architecture: ["arch_validate", "arch_suggest"],
        semantic: [
          "semantic_search",
          "find_similar_code",
          "code_explain",
          "semantic_slice",
          "semantic_diff",
          "code_clusters",
          "find_pattern",
          "blocking_issues",
        ],
        docs: ["index_docs", "search_docs"],
        test: ["test_select", "test_categorize", "test_run", "suggest_tests", "impact_analyze"],
        memory: ["episode_add", "episode_recall", "decision_query", "reflect", "context_pack"],
        progress: ["progress_query", "task_update", "feature_status"],
        coordination: [
          "agent_claim",
          "agent_release",
          "coordination_overview",
          "contract_validate",
          "diff_since",
        ],
      };

      const result: Record<string, { available: string[]; unavailable: string[] }> = {};

      for (const [category, tools] of Object.entries(KNOWN_CATEGORIES)) {
        const available: string[] = [];
        const unavailable: string[] = [];
        for (const toolName of tools) {
          const bound = (ctx as any)[toolName];
          if (typeof bound === "function") {
            available.push(toolName);
          } else {
            unavailable.push(toolName);
          }
        }
        result[category] = { available, unavailable };
      }

      const totalAvailable = Object.values(result).reduce(
        (sum, cat) => sum + cat.available.length,
        0,
      );
      const totalUnavailable = Object.values(result).reduce(
        (sum, cat) => sum + cat.unavailable.length,
        0,
      );

      return ctx.formatSuccess(
        {
          summary: `${totalAvailable} tools available, ${totalUnavailable} unavailable in this session`,
          categories: result,
          note: "Unavailable tools may require missing configuration, a running engine, or a different server entrypoint.",
        },
        profile,
      );
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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

        const anchor = await (ctx as any).resolveSinceAnchor(since, projectId);
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
        const txIds = (txResult.data || []).map((row: any) => String(row.id || "")).filter(Boolean);

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
            validFrom: (ctx as any).toSafeNumber(row.validFrom),
            validTo: (ctx as any).toSafeNumber(row.validTo) ?? undefined,
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
  {
    name: "contract_validate",
    category: "utility",
    description: "Normalize and validate tool argument contracts before execution",
    inputShape: {
      tool: z.string().describe("Target tool name"),
      arguments: z.record(z.string(), z.any()).optional().describe("Raw arguments to normalize"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const { tool, arguments: inputArgs = {}, profile = "compact" } = args || {};

      if (!tool || typeof tool !== "string") {
        return ctx.errorEnvelope(
          "CONTRACT_VALIDATE_INVALID_INPUT",
          "Field 'tool' is required and must be a string",
          true,
        );
      }

      try {
        // Step 1: normalise field aliases (e.g. changedFiles → files)
        const { normalized, warnings: normWarnings } = ctx.normalizeForDispatch(tool, inputArgs);

        // Step 2: validate normalised args against the tool's Zod schema
        const validation = ctx.validateToolArgs(tool, normalized);

        return ctx.formatSuccess(
          {
            tool,
            input: inputArgs,
            normalized,
            valid: validation.valid,
            errors: validation.errors,
            missingRequired: validation.missingRequired,
            extraFields: validation.extraFields,
            warnings: [...normWarnings, ...validation.warnings],
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("CONTRACT_VALIDATE_FAILED", String(error), true);
      }
    },
  },
  {
    name: "find_pattern",
    category: "code",
    description: "Find architectural patterns or violations in code",
    inputShape: {
      pattern: z.string().describe("Pattern to search for"),
      type: z
        .enum(["pattern", "violation", "unused", "circular"])
        .default("pattern")
        .describe("Pattern type"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const { pattern, type = "pattern", profile = "compact" } = args;

      const archEngine = ctx.engines.arch as
        | {
            validate: () => Promise<{ violations: unknown[] }>;
          }
        | undefined;

      try {
        const results: any = {
          pattern,
          type,
          matches: [] as any[],
        };

        if (type === "violation") {
          if (!archEngine) {
            return "Architecture engine not initialized";
          }
          const result = await archEngine.validate();
          results.matches = result.violations.slice(0, 10);
        } else if (type === "unused") {
          const files = ctx.context.index.getNodesByType("FILE");
          for (const file of files) {
            const rels = ctx.context.index.getRelationshipsFrom(file.id);
            if (rels.length === 0) {
              results.matches.push({
                path: file.properties.path,
                reason: "No incoming or outgoing relationships",
              });
            }
          }
        } else if (type === "circular") {
          const { projectId } = ctx.getActiveProjectContext();
          const allFiles = ctx.context.index.getNodesByType("FILE");
          let files = allFiles.filter((node: any) => {
            const nodeProjectId = String(node.properties.projectId || "");
            if (!projectId) return true;
            if (!nodeProjectId) {
              if (node.id.startsWith(`${projectId}:`)) {
                return true;
              }
              return true;
            }
            return nodeProjectId === projectId;
          });

          if (!files.length) {
            files = allFiles;
          }

          const fileIds = new Set(files.map((f: any) => f.id));
          const adjacency = new Map<string, Set<string>>();

          for (const file of files) {
            const targets = new Set<string>();
            const importRels = ctx.context.index
              .getRelationshipsFrom(file.id)
              .filter((rel: any) => rel.type === "IMPORTS");

            for (const importRel of importRels) {
              const directTarget = ctx.context.index.getNode(importRel.to);
              if (
                directTarget?.type === "FILE" &&
                fileIds.has(directTarget.id) &&
                directTarget.id !== file.id
              ) {
                targets.add(directTarget.id);
              }

              const refs = ctx.context.index
                .getRelationshipsFrom(importRel.to)
                .filter((rel: any) => rel.type === "REFERENCES");
              for (const ref of refs) {
                const targetFile = ctx.context.index.getNode(ref.to);
                if (
                  targetFile?.type === "FILE" &&
                  fileIds.has(targetFile.id) &&
                  targetFile.id !== file.id
                ) {
                  targets.add(targetFile.id);
                }
              }
            }

            adjacency.set(file.id, targets);
          }

          const cycles: string[][] = [];
          const seenCycles = new Set<string>();
          const tempVisited = new Set<string>();
          const permVisited = new Set<string>();
          const stack: string[] = [];

          const canonicalizeCycle = (cycle: string[]): string => {
            const normalized = cycle.slice(0, -1);
            if (!normalized.length) return "";
            let best = normalized;
            for (let i = 1; i < normalized.length; i++) {
              const rotated = [...normalized.slice(i), ...normalized.slice(0, i)];
              if (rotated.join("|") < best.join("|")) {
                best = rotated;
              }
            }
            return best.join("|");
          };

          const visit = (nodeId: string): void => {
            if (permVisited.has(nodeId)) return;
            tempVisited.add(nodeId);
            stack.push(nodeId);

            const neighbors = adjacency.get(nodeId) || new Set<string>();
            for (const nextId of neighbors) {
              if (!tempVisited.has(nextId) && !permVisited.has(nextId)) {
                visit(nextId);
                continue;
              }

              if (tempVisited.has(nextId)) {
                const start = stack.indexOf(nextId);
                if (start >= 0) {
                  const cycle = [...stack.slice(start), nextId];
                  const key = canonicalizeCycle(cycle);
                  if (key && !seenCycles.has(key)) {
                    seenCycles.add(key);
                    cycles.push(cycle);
                  }
                }
              }
            }

            stack.pop();
            tempVisited.delete(nodeId);
            permVisited.add(nodeId);
          };

          for (const file of files) {
            if (!permVisited.has(file.id)) {
              visit(file.id);
            }
          }

          results.matches = cycles.slice(0, 20).map((cycle) => ({
            cycle: cycle.map((id) => {
              const node = ctx.context.index.getNode(id);
              return String(node?.properties.path || id);
            }),
            length: Math.max(1, cycle.length - 1),
          }));

          if (!results.matches.length && !files.length && ctx.context.memgraph.isConnected()) {
            const { projectId: pid } = ctx.getActiveProjectContext();
            const cypherCycles = await ctx.context.memgraph.executeCypher(
              `MATCH (a:FILE)-[:IMPORTS]->(:IMPORT)-[:REFERENCES]->(b:FILE)
                     -[:IMPORTS]->(:IMPORT)-[:REFERENCES]->(a)
               WHERE a.projectId = $projectId
                 AND b.projectId = $projectId
                 AND id(a) < id(b)
               RETURN coalesce(a.relativePath, a.path, a.id) AS fileA,
                      coalesce(b.relativePath, b.path, b.id) AS fileB
               LIMIT 20`,
              { projectId: pid },
            );
            if (cypherCycles.data?.length) {
              results.matches = cypherCycles.data.map((row: any) => ({
                cycle: [String(row.fileA), String(row.fileB), String(row.fileA)],
                length: 2,
                source: "cypher",
              }));
            }
          }

          if (!results.matches.length) {
            results.matches.push({
              status: "none-found",
              note: files.length
                ? "No circular dependencies detected in FILE import graph"
                : "In-memory index is empty — run graph_rebuild then retry for full DFS analysis",
            });
          }
        } else {
          if (ctx.context.memgraph.isConnected()) {
            const { projectId } = ctx.getActiveProjectContext();
            const searchResult = await ctx.context.memgraph.executeCypher(
              `MATCH (n)
               WHERE n.projectId = $projectId
                 AND (n:FUNCTION OR n:CLASS OR n:FILE)
                 AND (
                   toLower(coalesce(n.name, '')) CONTAINS toLower($pattern)
                   OR toLower(coalesce(n.path, '')) CONTAINS toLower($pattern)
                 )
               RETURN labels(n)[0] AS type,
                      coalesce(n.name, n.path, n.id) AS name,
                      coalesce(n.relativePath, n.path, '') AS location
               LIMIT 20`,
              { projectId, pattern: String(pattern || "") },
            );
            results.matches = (searchResult.data || []).map((row: any) => ({
              type: String(row.type || ""),
              name: String(row.name || ""),
              location: String(row.location || ""),
            }));
          } else {
            const allNodes = [
              ...ctx.context.index.getNodesByType("FUNCTION"),
              ...ctx.context.index.getNodesByType("CLASS"),
              ...ctx.context.index.getNodesByType("FILE"),
            ];
            const lp = String(pattern || "").toLowerCase();
            results.matches = allNodes
              .filter((n: any) => {
                const name = String(n.properties.name || n.properties.path || n.id);
                return name.toLowerCase().includes(lp);
              })
              .slice(0, 20)
              .map((n: any) => ({
                type: n.type,
                name: String(n.properties.name || n.properties.path || n.id),
                location: String(n.properties.relativePath || n.properties.path || ""),
              }));
          }
        }

        return ctx.formatSuccess(results, profile);
      } catch (error) {
        return ctx.errorEnvelope("PATTERN_SEARCH_FAILED", String(error), true);
      }
    },
  },
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
    description: "Find code similar to a given function or class",
    inputShape: {
      elementId: z.string().describe("Code element ID"),
      threshold: z.number().default(0.7).describe("Similarity threshold (0-1)"),
      limit: z.number().default(10).describe("Result limit"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
    description: "Find clusters of related code",
    inputShape: {
      type: z.enum(["function", "class", "file"]).describe("Code type to cluster"),
      count: z.number().default(5).describe("Number of clusters"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
    description: "Find semantic differences between code elements",
    inputShape: {
      elementId1: z.string().describe("First code element ID"),
      elementId2: z.string().describe("Second code element ID"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
    description: "Suggest tests for a code element based on semantics",
    inputShape: {
      elementId: z.string().describe("Code element ID"),
      limit: z.number().default(5).describe("Number of suggestions"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const impl = (ctx as any).core_context_pack_impl;
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
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const impl = (ctx as any).core_semantic_slice_impl;
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
  {
    name: "init_project_setup",
    category: "setup",
    description:
      "One-shot project initialization: sets workspace context, triggers graph rebuild, and generates .github/copilot-instructions.md if not present. Use this as the first step when onboarding a new project or starting a fresh session.",
    inputShape: {
      workspaceRoot: z.string().describe("Absolute path to the project root to initialize"),
      sourceDir: z
        .string()
        .optional()
        .describe("Source directory relative to workspaceRoot (default: src)"),
      projectId: z
        .string()
        .optional()
        .describe("Project identifier (default: basename of workspaceRoot)"),
      rebuildMode: z
        .enum(["incremental", "full"])
        .default("incremental")
        .describe("incremental = changed files only; full = rebuild entire graph"),
      withDocs: z.boolean().default(true).describe("Also index markdown docs during rebuild"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const {
        workspaceRoot,
        sourceDir,
        projectId,
        rebuildMode = "incremental",
        withDocs = true,
        profile = "compact",
      } = args ?? {};

      if (!workspaceRoot || typeof workspaceRoot !== "string") {
        return ctx.errorEnvelope(
          "INIT_MISSING_WORKSPACE",
          "workspaceRoot is required",
          false,
          "Provide the absolute path to the project you want to initialize.",
        );
      }

      const resolvedRoot = path.resolve(workspaceRoot);
      if (!fs.existsSync(resolvedRoot)) {
        return ctx.errorEnvelope(
          "INIT_WORKSPACE_NOT_FOUND",
          `Workspace path does not exist: ${resolvedRoot}`,
          false,
          "Ensure the project is accessible from this machine/container.",
        );
      }

      const steps: Array<{ step: string; status: string; detail?: string }> = [];

      try {
        const setArgs: any = { workspaceRoot: resolvedRoot, profile };
        if (sourceDir) setArgs.sourceDir = sourceDir;
        if (projectId) setArgs.projectId = projectId;

        let setResult: string;
        try {
          setResult = await ctx.callTool("graph_set_workspace", setArgs);
          const setJson = JSON.parse(setResult);
          if (setJson?.error) {
            steps.push({
              step: "graph_set_workspace",
              status: "failed",
              detail: setJson.error,
            });
            return ctx.formatSuccess(
              { steps, abortedAt: "graph_set_workspace" },
              profile,
              "Initialization aborted at workspace setup",
              "init_project_setup",
            );
          }
          const setCtx = setJson?.data?.projectContext ?? setJson?.data ?? {};
          steps.push({
            step: "graph_set_workspace",
            status: "ok",
            detail: `projectId=${setCtx.projectId ?? "?"}, sourceDir=${setCtx.sourceDir ?? "?"}`,
          });
        } catch (err) {
          steps.push({
            step: "graph_set_workspace",
            status: "failed",
            detail: String(err),
          });
          return ctx.formatSuccess(
            { steps, abortedAt: "graph_set_workspace" },
            profile,
            "Initialization aborted at workspace setup",
            "init_project_setup",
          );
        }

        const rebuildArgs: any = {
          workspaceRoot: resolvedRoot,
          mode: rebuildMode,
          indexDocs: withDocs,
          profile,
        };
        if (sourceDir) rebuildArgs.sourceDir = sourceDir;
        if (projectId) rebuildArgs.projectId = projectId;

        try {
          const rebuildResult = await ctx.callTool("graph_rebuild", rebuildArgs);
          const rebuildJson = JSON.parse(rebuildResult);
          if (rebuildJson?.error) {
            steps.push({
              step: "graph_rebuild",
              status: "failed",
              detail: rebuildJson.error,
            });
          } else {
            steps.push({
              step: "graph_rebuild",
              status: "queued",
              detail: `mode=${rebuildMode}, indexDocs=${withDocs}`,
            });
          }
        } catch (err) {
          steps.push({
            step: "graph_rebuild",
            status: "failed",
            detail: String(err),
          });
        }

        const copilotPath = path.join(resolvedRoot, ".github", "copilot-instructions.md");
        if (!fs.existsSync(copilotPath)) {
          try {
            await ctx.callTool("setup_copilot_instructions", {
              targetPath: resolvedRoot,
              dryRun: false,
              overwrite: false,
              profile: "compact",
            });
            steps.push({
              step: "setup_copilot_instructions",
              status: "created",
              detail: ".github/copilot-instructions.md",
            });
          } catch (err) {
            steps.push({
              step: "setup_copilot_instructions",
              status: "skipped",
              detail: String(err),
            });
          }
        } else {
          steps.push({
            step: "setup_copilot_instructions",
            status: "exists",
            detail: "File already present — skipped",
          });
        }

        const projCtx = ctx.resolveProjectContext({
          workspaceRoot: resolvedRoot,
          ...(sourceDir ? { sourceDir } : {}),
          ...(projectId ? { projectId } : {}),
        });

        return ctx.formatSuccess(
          {
            projectId: projCtx.projectId,
            workspaceRoot: projCtx.workspaceRoot,
            sourceDir: projCtx.sourceDir,
            steps,
            nextAction:
              "Call graph_health to confirm the rebuild completed, then graph_query to start exploring.",
          },
          profile,
          `Project ${projCtx.projectId} initialized — graph rebuild queued`,
          "init_project_setup",
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "INIT_PROJECT_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  },
  {
    name: "setup_copilot_instructions",
    category: "setup",
    description:
      "Analyze a repository and generate a tailored .github/copilot-instructions.md file with tech-stack detection, key commands, required session flow, and tool-usage guidance. Makes it immediately efficient to work with the repo via Copilot or any AI assistant.",
    inputShape: {
      targetPath: z
        .string()
        .optional()
        .describe("Absolute path to the target repository (defaults to the active workspace)"),
      projectName: z.string().optional().describe("Override the detected project name"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Return the generated content without writing the file"),
      overwrite: z.boolean().default(false).describe("Replace an existing copilot-instructions.md"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(args: any, ctx: HandlerBridge): Promise<string> {
      const {
        targetPath,
        projectName: forceProjectName,
        dryRun = false,
        overwrite = false,
        profile = "compact",
      } = args ?? {};

      let resolvedTarget: string;
      if (targetPath && typeof targetPath === "string") {
        resolvedTarget = path.resolve(targetPath);
      } else {
        const active = ctx.resolveProjectContext({});
        resolvedTarget = active.workspaceRoot;
      }

      if (!fs.existsSync(resolvedTarget)) {
        return ctx.errorEnvelope(
          "COPILOT_INSTR_TARGET_NOT_FOUND",
          `Target path does not exist: ${resolvedTarget}`,
          false,
          "Provide an accessible absolute path via targetPath parameter.",
        );
      }

      const destFile = path.join(resolvedTarget, ".github", "copilot-instructions.md");
      if (fs.existsSync(destFile) && !overwrite && !dryRun) {
        return ctx.formatSuccess(
          {
            status: "already_exists",
            path: destFile,
            hint: "Pass overwrite=true to replace it.",
          },
          profile,
          ".github/copilot-instructions.md already exists — skipped",
          "setup_copilot_instructions",
        );
      }

      try {
        const repoName = forceProjectName || path.basename(resolvedTarget);
        const pkgPath = path.join(resolvedTarget, "package.json");
        const pkgJson: any = fs.existsSync(pkgPath)
          ? JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
          : null;

        const name = forceProjectName || pkgJson?.name || repoName;
        const description = pkgJson?.description || "";
        const deps: Record<string, string> = {
          ...(pkgJson?.dependencies ?? {}),
          ...(pkgJson?.devDependencies ?? {}),
        };

        const stack: string[] = [];
        const isTypeScript =
          fs.existsSync(path.join(resolvedTarget, "tsconfig.json")) || !!deps["typescript"];
        const isNode = !!pkgJson || fs.existsSync(path.join(resolvedTarget, "package.json"));
        const isPython =
          fs.existsSync(path.join(resolvedTarget, "pyproject.toml")) ||
          fs.existsSync(path.join(resolvedTarget, "setup.py")) ||
          fs.existsSync(path.join(resolvedTarget, "requirements.txt"));
        const isGo = fs.existsSync(path.join(resolvedTarget, "go.mod"));
        const isRust = fs.existsSync(path.join(resolvedTarget, "Cargo.toml"));
        const isJava =
          fs.existsSync(path.join(resolvedTarget, "pom.xml")) ||
          fs.existsSync(path.join(resolvedTarget, "build.gradle"));
        const isReact = !!deps["react"];
        const isNextJs = !!deps["next"];
        const isDocker =
          fs.existsSync(path.join(resolvedTarget, "Dockerfile")) ||
          fs.existsSync(path.join(resolvedTarget, "docker-compose.yml"));

        if (isTypeScript) stack.push("TypeScript");
        else if (isNode) stack.push("JavaScript / Node.js");
        if (isPython) stack.push("Python");
        if (isGo) stack.push("Go");
        if (isRust) stack.push("Rust");
        if (isJava) stack.push("Java");
        if (isNextJs) stack.push("Next.js");
        else if (isReact) stack.push("React");
        if (isDocker) stack.push("Docker");

        const scripts = pkgJson?.scripts
          ? Object.entries(pkgJson.scripts)
              .slice(0, 10)
              .map(([k, v]) => `- \`${k}\`: \`${v}\``)
              .join("\n")
          : "";

        const candidateSrcDirs = ["src", "lib", "app", "packages", "source"];
        const srcDir =
          candidateSrcDirs.find((d) => fs.existsSync(path.join(resolvedTarget, d))) ?? "src";

        const srcPath = path.join(resolvedTarget, srcDir);
        let subDirs: string[] = [];
        if (fs.existsSync(srcPath)) {
          try {
            subDirs = fs
              .readdirSync(srcPath, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .slice(0, 10);
          } catch {
            // ignore
          }
        }

        const isMcpServer =
          !!deps["@modelcontextprotocol/sdk"] ||
          fs.existsSync(path.join(resolvedTarget, "src", "mcp-server.ts")) ||
          fs.existsSync(path.join(resolvedTarget, "src", "server.ts"));

        const lines: string[] = [`# Copilot Instructions for ${name}`, ""];
        if (description) {
          lines.push(description, "");
        }

        lines.push("## Primary Goal", "");
        lines.push(
          "Understand the codebase before making changes. Use graph-backed tools first for code intelligence, then fall back to file reads only when needed.",
          "",
        );

        if (stack.length > 0) {
          lines.push("## Runtime Truths", "");
          lines.push(`- **Stack**: ${stack.join(", ")}`);
          lines.push(`- **Source root**: \`${srcDir}/\``);
          if (subDirs.length > 0) {
            lines.push(
              `- **Key directories**: ${subDirs.map((d) => `\`${srcDir}/${d}\``).join(", ")}`,
            );
          }
        }
        if (scripts) {
          lines.push("", "## Available Commands", "", scripts);
        }

        if (isMcpServer) {
          lines.push(
            "",
            "## Required Session Flow",
            "",
            "**One-shot (recommended):**",
            "```",
            'init_project_setup({ projectId: "my-proj", workspaceRoot: "/abs/path" })',
            "```",
            "",
            "**Manual:**",
            "1. `graph_set_workspace({ projectId, workspaceRoot })` — anchor the session",
            '2. `graph_rebuild({ projectId, mode: "full", workspaceRoot })` — capture `txId` from response',
            '3. `graph_health({ profile: "balanced" })` — verify nodes > 0',
            '4. `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) LIMIT 8", projectId })` — confirm data',
            "",
            "**HTTP transport only:** capture `mcp-session-id` from `initialize` response and include on every request.",
          );
        } else {
          lines.push(
            "",
            "## Required Session Flow",
            "",
            "1. Call `init_project_setup({ projectId, workspaceRoot })` — sets context, triggers graph rebuild, writes copilot instructions.",
            '2. Validate with `graph_health({ profile: "balanced" })`',
            '3. Explore with `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) DESC LIMIT 10" })`',
          );
        }

        lines.push(
          "",
          "## Tool Decision Guide",
          "",
          "| Goal | First choice | Fallback |",
          "|---|---|---|",
          "| Count/list nodes | `graph_query` (Cypher) | `graph_health` |",
          "| Understand a symbol | `code_explain` (symbol name) | `semantic_slice` |",
          "| Find related code | `find_similar_code` | `semantic_search` |",
          "| Check arch violations | `arch_validate` | `blocking_issues` |",
          "| Place new code | `arch_suggest` | — |",
          "| Docs lookup | `search_docs` → `index_docs` if empty | file read |",
          "| Tests after change | `test_select` → `test_run` | `suggest_tests` |",
          "| Track decisions | `episode_add` (DECISION) | — |",
          "| Release agent lock | `agent_release` with `claimId` | — |",
        );

        lines.push(
          "",
          "## Correct Tool Signatures (verified)",
          "",
          "```jsonc",
          `// graph — capture txId from graph_rebuild response for diff_since`,
          `graph_rebuild({ "projectId": "proj", "mode": "full" })  // → { txId }`,
          `diff_since({ "since": "<txId | ISO-8601>" })            // NOT git refs like HEAD~3`,
          "",
          `// semantic`,
          `code_explain({ "element": "SymbolName", "depth": 2 })   // symbol name, NOT qualified ID`,
          `semantic_diff({ "elementId1": "...", "elementId2": "..." })  // NOT elementA/elementB`,
          `semantic_slice({ "symbol": "MyClass" })                 // NOT entryPoint`,
          "",
          `// clustering`,
          `code_clusters({ "type": "file" })  // type: "function"|"class"|"file"  NOT granularity`,
          `arch_suggest({ "name": "NewEngine", "codeType": "engine" })  // NOT codeName`,
          "",
          `// memory — DECISION requires metadata.rationale, type is uppercase`,
          `episode_add({ "type": "DECISION", "content": "...", "outcome": "success",`,
          `             "metadata": { "rationale": "because..." } })`,
          `episode_add({ "type": "LEARNING", "content": "..." })`,
          `decision_query({ "query": "..." })   // NOT topic`,
          `progress_query({ "query": "..." })   // query is required, NOT status`,
          "",
          `// coordination — capture claimId from agent_claim for release`,
          `agent_claim({ "agentId": "a1", "targetId": "src/file.ts", "intent": "..." })  // NOT target`,
          `agent_release({ "claimId": "claim-xxx" })   // NOT agentId/taskId`,
          `context_pack({ "task": "Description..." }) // task string is REQUIRED`,
          "",
          `// tests — suggest_tests needs fully-qualified element ID`,
          `suggest_tests({ "elementId": "proj:file.ts:symbolName:line" })`,
          "```",
        );

        lines.push(
          "",
          "## Common Pitfalls",
          "",
          "| Wrong | Correct |",
          "|---|---|",
          '| `code_explain({ elementId: ... })` | `code_explain({ element: "SymbolName" })` |',
          "| `semantic_diff({ elementA, elementB })` | `semantic_diff({ elementId1, elementId2 })` |",
          '| `code_clusters({ granularity: "module" })` | `code_clusters({ type: "file" })` |',
          '| `arch_suggest({ codeName: "X" })` | `arch_suggest({ name: "X" })` |',
          '| `episode_add({ type: "decision" })` | `episode_add({ type: "DECISION" })` (uppercase) |',
          '| DECISION without `metadata.rationale` | always include `metadata: { rationale: "..." }` |',
          '| `decision_query({ topic: "X" })` | `decision_query({ query: "X" })` |',
          '| `agent_claim({ target: "f.ts" })` | `agent_claim({ targetId: "f.ts" })` |',
          '| `agent_release({ agentId, taskId })` | `agent_release({ claimId: "claim-xxx" })` |',
        );

        lines.push(
          "",
          "## Copilot Skills — Usage Patterns",
          "",
          "### Explore unfamiliar codebase",
          "```",
          "1. init_project_setup({ projectId, workspaceRoot })",
          '2. graph_query("MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 10")',
          '3. code_explain({ element: "MainEntryPoint" })',
          "```",
          "",
          "### Safe refactor + test impact",
          "```",
          '1. impact_analyze({ changedFiles: ["src/x.ts"] })',
          '2. test_select({ changedFiles: ["src/x.ts"] })',
          '3. arch_validate({ files: ["src/x.ts"] })',
          "4. test_run({ testFiles: [...from test_select...] })",
          '5. episode_add({ type: "DECISION", content: "...", metadata: { rationale: "..." } })',
          "```",
          "",
          "### Multi-agent safe edit",
          "```",
          '1. agent_claim({ agentId, targetId: "src/file.ts", intent: "..." })  → save claimId',
          "2. ... make changes ...",
          '3. agent_release({ claimId, outcome: "done" })',
          "```",
          "",
          "### Docs cold start",
          "```",
          '1. search_docs({ query: "topic" })           — if count=0:',
          '2. index_docs({ paths: ["/abs/README.md"] })',
          '3. search_docs({ query: "topic" })           — now returns results',
          "```",
        );

        lines.push(
          "",
          "## Source of Truth",
          "",
          "`README.md`, `QUICK_START.md`, `ARCHITECTURE.md`.",
        );

        const content = lines.join("\n") + "\n";

        if (dryRun) {
          return ctx.formatSuccess(
            {
              dryRun: true,
              targetPath: destFile,
              content,
            },
            profile,
            "Dry run — copilot-instructions.md content generated (not written)",
            "setup_copilot_instructions",
          );
        }

        const githubDir = path.join(resolvedTarget, ".github");
        if (!fs.existsSync(githubDir)) {
          fs.mkdirSync(githubDir, { recursive: true });
        }
        fs.writeFileSync(destFile, content, "utf-8");

        return ctx.formatSuccess(
          {
            status: "created",
            path: destFile,
            projectName: name,
            stackDetected: stack,
            overwritten: overwrite && fs.existsSync(destFile),
          },
          profile,
          `Copilot instructions written to ${path.relative(resolvedTarget, destFile)}`,
          "setup_copilot_instructions",
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "SETUP_COPILOT_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  },
];
