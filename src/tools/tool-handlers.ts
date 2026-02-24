/**
 * Tool Handlers - Concrete Tool Implementations
 * Phase 5: Long file decomposition - refactored to extend ToolHandlerBase
 *
 * This file contains all tool implementations and delegates infrastructure to the base class.
 */

import * as fs from "fs";
import * as path from "path";
import * as env from "../env.js";
import { generateSecureId } from "../utils/validation.js";
import type { GraphNode } from "../graph/index.js";
import type { EpisodeType } from "../engines/episode-engine.js";
import type { ClaimType } from "../engines/coordination-engine.js";
import { runPPR } from "../graph/ppr.js";
import type { WatcherState } from "../graph/watcher.js";
import type { ResponseProfile } from "../response/budget.js";
import { estimateTokens, makeBudget } from "../response/budget.js";
import { ToolHandlerBase, type ToolContext } from "./tool-handler-base.js";
import { createRefTools } from "./handlers/ref-tools.js";
import { createArchTools } from "./handlers/arch-tools.js";
import { createDocsTools } from "./handlers/docs-tools.js";
import { createTestTools } from "./handlers/test-tools.js";

// Re-export base types for external consumers
export type { ToolContext, ProjectContext } from "./tool-handler-base.js";

/**
 * Main tool handler class that implements all MCP tools
 * Extends ToolHandlerBase which provides shared state, session management, and helpers
 *
 * This class remains the public API for tool invocation:
 * - callTool(toolName, args): central dispatch
 * - cleanupSession(sessionId): session cleanup
 * - cleanupAllSessions(): bulk cleanup
 * - normalizeForDispatch(toolName, args): input normalization for backward compatibility
 */
export class ToolHandlers extends ToolHandlerBase {
  constructor(context: ToolContext) {
    super(context);
    // Initialize domain-specific tool handlers (Phase 5)
    this.initializeRefTools();
    this.initializeArchTools();
    this.initializeDocsTools();
    this.initializeTestTools();
  }

  /**
   * Initialize ref_query tools from dedicated module
   */
  private initializeRefTools(): void {
    const refTools = createRefTools(this as any);
    (this as any).ref_query = refTools.ref_query.bind(this);
  }

  /**
   * Initialize architecture validation tools from dedicated module
   */
  private initializeArchTools(): void {
    const archTools = createArchTools(this as any);
    (this as any).arch_validate = archTools.arch_validate.bind(this);
    (this as any).arch_suggest = archTools.arch_suggest.bind(this);
  }

  /**
   * Initialize documentation tools from dedicated module
   */
  private initializeDocsTools(): void {
    const docsTools = createDocsTools(this as any);
    (this as any).index_docs = docsTools.index_docs.bind(this);
    (this as any).search_docs = docsTools.search_docs.bind(this);
  }

  /**
   * Initialize test intelligence tools from dedicated module
   */
  private initializeTestTools(): void {
    const testTools = createTestTools(this as any);
    (this as any).test_select = testTools.test_select.bind(this);
    (this as any).test_categorize = testTools.test_categorize.bind(this);
    (this as any).impact_analyze = testTools.impact_analyze.bind(this);
    (this as any).test_run = testTools.test_run.bind(this);
  }

  async graph_query(args: any): Promise<string> {
    const {
      query,
      language = "natural",
      limit = 100,
      profile = "compact",
      asOf,
      mode = "local",
    } = args;

    try {
      let result;
      const { projectId, workspaceRoot } = this.getActiveProjectContext();
      const asOfTs = this.toEpochMillis(asOf);
      const queryMode = mode === "global" || mode === "hybrid" ? mode : "local";

      if (language === "cypher") {
        const cypherQuery =
          asOfTs !== null ? this.applyTemporalFilterToCypher(query) : query;

        result =
          asOfTs !== null
            ? await this.context.memgraph.executeCypher(cypherQuery, {
                asOfTs,
              })
            : await this.context.memgraph.executeCypher(cypherQuery);
      } else {
        if (queryMode === "global" || queryMode === "hybrid") {
          const globalRows = await this.fetchGlobalCommunityRows(
            query,
            projectId,
            limit,
          );

          if (queryMode === "global") {
            result = { data: globalRows };
          } else {
            const localResults = await this.hybridRetriever!.retrieve({
              query,
              projectId,
              limit,
              mode: "hybrid",
            });
            const filteredLocal = this.filterTemporalResults(
              localResults,
              asOfTs,
            );
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
          const localResults = await this.hybridRetriever!.retrieve({
            query,
            projectId,
            limit,
            mode: "hybrid",
          });
          const filteredLocal = this.filterTemporalResults(
            localResults,
            asOfTs,
          );
          result = { data: filteredLocal };
        }
      }

      if (result.error) {
        return this.errorEnvelope(
          "GRAPH_QUERY_FAILED",
          result.error,
          true,
          "Try using language='cypher' with an explicit query.",
        );
      }

      const limited = result.data.slice(0, limit);
      return this.formatSuccess(
        {
          intent:
            language === "natural" ? this.classifyIntent(query) : "cypher",
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
      return this.errorEnvelope("GRAPH_QUERY_EXCEPTION", String(error), true);
    }
  }

  private filterTemporalResults(
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

      const node = this.context.index.getNode(row.nodeId);
      const validFrom = Number(node?.properties?.validFrom);
      const validToRaw = node?.properties?.validTo;
      const validTo =
        validToRaw === null || validToRaw === undefined
          ? undefined
          : Number(validToRaw);

      if (!Number.isFinite(validFrom)) {
        return true;
      }

      return (
        validFrom <= asOfTs &&
        (!Number.isFinite(validTo) ||
          (validTo !== undefined && validTo > asOfTs))
      );
    });
  }

  private async fetchGlobalCommunityRows(
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
      labels: this.deriveLabelHints(query),
    };

    const scoped = await this.context.memgraph.executeCypher(
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

    const fallback = await this.context.memgraph.executeCypher(
      `MATCH (c:COMMUNITY {projectId: $projectId})
       RETURN c.id AS id, c.label AS label, c.summary AS summary, c.memberCount AS memberCount
       ORDER BY c.memberCount DESC
       LIMIT $limit`,
      { projectId, limit },
    );

    return fallback.data;
  }

  private deriveLabelHints(query: string): string[] {
    const raw = query.toLowerCase();
    const hints = ["tools", "engines", "graph", "parsers", "vector", "config"];
    return hints.filter((hint) => raw.includes(hint));
  }

  async code_explain(args: any): Promise<string> {
    const { element, depth = 2, profile = "compact" } = args;

    try {
      // Find the element in the graph
      const files = this.context.index.getNodesByType("FILE");
      const funcs = this.context.index.getNodesByType("FUNCTION");
      const classes = this.context.index.getNodesByType("CLASS");

      let targetNode =
        files.find((n) => n.properties.path?.includes(element)) ||
        funcs.find((n) => n.properties.name === element) ||
        classes.find((n) => n.properties.name === element);

      if (!targetNode) {
        return this.errorEnvelope(
          "ELEMENT_NOT_FOUND",
          `Element not found: ${element}`,
          true,
          "Provide a file path, class name, or function name present in the index.",
        );
      }

      // Gather context
      const explanation: any = {
        element: targetNode.properties.name || targetNode.properties.path,
        type: targetNode.type,
        properties: targetNode.properties,
        dependencies: [] as any[],
        dependents: [] as any[],
      };

      // Outgoing relationships → dependencies (nodes this element depends on)
      const outgoing = this.context.index.getRelationshipsFrom(targetNode.id);
      for (const rel of outgoing.slice(0, depth * 10)) {
        const target = this.context.index.getNode(rel.to);
        if (target) {
          explanation.dependencies.push({
            type: rel.type,
            target:
              target.properties.name || target.properties.path || target.id,
          });
        }
      }

      // Incoming relationships → dependents (nodes that depend on this element)
      const incoming = this.context.index.getRelationshipsTo(targetNode.id);
      for (const rel of incoming.slice(0, depth * 10)) {
        const source = this.context.index.getNode(rel.from);
        if (source) {
          explanation.dependents.push({
            type: rel.type,
            source:
              source.properties.name || source.properties.path || source.id,
          });
        }
      }

      return this.formatSuccess(explanation, profile);
    } catch (error) {
      return this.errorEnvelope("CODE_EXPLAIN_FAILED", String(error), true);
    }
  }

  async find_pattern(args: any): Promise<string> {
    const { pattern, type = "pattern", profile = "compact" } = args;

    try {
      const results: any = {
        pattern,
        type,
        matches: [] as any[],
      };

      if (type === "violation") {
        if (!this.archEngine) {
          return "Architecture engine not initialized";
        }
        const result = await this.archEngine.validate();
        results.matches = result.violations.slice(0, 10);
      } else if (type === "unused") {
        // Find files with no relationships
        const files = this.context.index.getNodesByType("FILE");
        for (const file of files) {
          const rels = this.context.index.getRelationshipsFrom(file.id);
          if (rels.length === 0) {
            results.matches.push({
              path: file.properties.path,
              reason: "No incoming or outgoing relationships",
            });
          }
        }
      } else if (type === "circular") {
        const { projectId } = this.getActiveProjectContext();
        const allFiles = this.context.index.getNodesByType("FILE");
        let files = allFiles.filter((node) => {
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

        const fileIds = new Set(files.map((f) => f.id));
        const adjacency = new Map<string, Set<string>>();

        for (const file of files) {
          const targets = new Set<string>();
          const importRels = this.context.index
            .getRelationshipsFrom(file.id)
            .filter((rel) => rel.type === "IMPORTS");

          for (const importRel of importRels) {
            const directTarget = this.context.index.getNode(importRel.to);
            if (
              directTarget?.type === "FILE" &&
              fileIds.has(directTarget.id) &&
              directTarget.id !== file.id
            ) {
              targets.add(directTarget.id);
            }

            const refs = this.context.index
              .getRelationshipsFrom(importRel.to)
              .filter((rel) => rel.type === "REFERENCES");
            for (const ref of refs) {
              const targetFile = this.context.index.getNode(ref.to);
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
            const node = this.context.index.getNode(id);
            return String(node?.properties.path || id);
          }),
          length: Math.max(1, cycle.length - 1),
        }));

        if (!results.matches.length && !files.length && this.context.memgraph.isConnected()) {
          // In-memory index is empty (no rebuild yet): fall back to Cypher-based cycle detection.
          // Detects simple 2-hop import cycles: A imports B and B imports A.
          const { projectId: pid } = this.getActiveProjectContext();
          const cypherCycles = await this.context.memgraph.executeCypher(
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
        // Generic pattern search against node names and file paths using Memgraph
        if (this.context.memgraph.isConnected()) {
          const { projectId } = this.getActiveProjectContext();
          const searchResult = await this.context.memgraph.executeCypher(
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
          // In-memory fallback
          const allNodes = [
            ...this.context.index.getNodesByType("FUNCTION"),
            ...this.context.index.getNodesByType("CLASS"),
            ...this.context.index.getNodesByType("FILE"),
          ];
          const lp = String(pattern || "").toLowerCase();
          results.matches = allNodes
            .filter((n) => {
              const name = String(n.properties.name || n.properties.path || n.id);
              return name.toLowerCase().includes(lp);
            })
            .slice(0, 20)
            .map((n) => ({
              type: n.type,
              name: String(n.properties.name || n.properties.path || n.id),
              location: String(n.properties.relativePath || n.properties.path || ""),
            }));
        }
      }

      return this.formatSuccess(results, profile);
    } catch (error) {
      return this.errorEnvelope("PATTERN_SEARCH_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // ARCHITECTURE TOOLS (2)
  // ============================================================================
  // PROGRESS TRACKING TOOLS (4)
  // ============================================================================

  async progress_query(args: any): Promise<string> {
    const profile = args?.profile || "compact";
    const status = args?.status || args?.filter?.status;
    const queryText = String(args?.query || args?.type || "task").toLowerCase();
    const type: "feature" | "task" = queryText.includes("feature")
      ? "feature"
      : "task";

    const normalizedStatus =
      status === "active"
        ? "in-progress"
        : status === "all"
          ? undefined
          : status;

    const filter = {
      ...(args?.filter || {}),
      ...(normalizedStatus ? { status: normalizedStatus } : {}),
    };

    try {
      const result = this.progressEngine!.query(type, filter);

      return this.formatSuccess(result, profile);
    } catch (error) {
      return this.errorEnvelope("PROGRESS_QUERY_FAILED", String(error), true);
    }
  }

  async task_update(args: any): Promise<string> {
    const {
      taskId,
      status,
      assignee,
      dueDate,
      notes,
      profile = "compact",
    } = args;

    try {
      const updated = this.progressEngine!.updateTask(taskId, {
        status,
        assignee,
        dueDate,
      });

      if (!updated) {
        return this.formatSuccess(
          { success: false, error: `Task not found: ${taskId}` },
          profile,
        );
      }

      // Gap fix: Persist task update to Memgraph (Phase 2d compliance)
      if (status || assignee || dueDate) {
        const persistedSuccessfully =
          await this.progressEngine!.persistTaskUpdate(taskId, {
            status,
            assignee,
            dueDate,
          });
        if (!persistedSuccessfully) {
          console.warn(
            `[task_update] Failed to persist task update to Memgraph for ${taskId}`,
          );
        }
      }

      const postActions: Record<string, unknown> = {};
      if (String(status || "").toLowerCase() === "completed") {
        const sessionId = this.getCurrentSessionId() || "session-unknown";
        const runtimeAgentId = String(
          assignee || args?.agentId || env.LXRAG_AGENT_ID,
        );
        const { projectId } = this.getActiveProjectContext();

        try {
          await this.coordinationEngine!.onTaskCompleted(
            String(taskId),
            runtimeAgentId,
            projectId,
          );
          postActions.claimsReleased = true;
        } catch (error) {
          postActions.claimsReleased = false;
          postActions.claimReleaseError = String(error);
        }

        try {
          const reflection = await this.episodeEngine!.reflect({
            taskId: String(taskId),
            agentId: runtimeAgentId,
            projectId,
            limit: 20,
          });
          postActions.reflection = {
            reflectionId: reflection.reflectionId,
            learningsCreated: reflection.learningsCreated,
          };
        } catch (error) {
          postActions.reflectionError = String(error);
        }

        try {
          const decisionEpisodeId = await this.episodeEngine!.add(
            {
              type: "DECISION",
              content:
                `Task ${taskId} marked completed. ${notes ? `Notes: ${String(notes)}` : ""}`.trim(),
              taskId: String(taskId),
              outcome: "success",
              agentId: runtimeAgentId,
              sessionId,
              metadata: {
                source: "task_update",
                status: String(status),
                rationale: `Task ${taskId} transitioned to status '${status}' via task_update.${notes ? ` Notes: ${String(notes)}` : ""}`,
              },
            },
            projectId,
          );
          postActions.decisionEpisodeId = decisionEpisodeId;
        } catch (error) {
          postActions.decisionEpisodeError = String(error);
        }
      }

      return this.formatSuccess(
        { success: true, task: updated, notes, postActions },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("TASK_UPDATE_FAILED", String(error), true);
    }
  }

  async feature_status(args: any): Promise<string> {
    const { featureId, profile = "compact" } = args;

    try {
      const allFeatures = this.progressEngine!.query("feature").items as Array<{
        id: string;
        name?: string;
        status?: string;
      }>;

      const requested = String(featureId || "").trim();
      if (
        !requested ||
        requested === "*" ||
        requested.toLowerCase() === "list"
      ) {
        return this.formatSuccess(
          {
            success: true,
            totalFeatures: allFeatures.length,
            features: allFeatures.slice(0, 100).map((feature) => ({
              id: feature.id,
              name: feature.name || "",
              status: feature.status || "unknown",
            })),
          },
          profile,
        );
      }

      let resolvedFeatureId = requested;
      let status = this.progressEngine!.getFeatureStatus(resolvedFeatureId);

      if (!status) {
        const lowered = requested.toLowerCase();
        const matched = allFeatures.find((feature) => {
          const name = String(feature.name || "").toLowerCase();
          return (
            feature.id === requested ||
            feature.id.endsWith(`:${requested}`) ||
            feature.id.toLowerCase().endsWith(`:${lowered}`) ||
            name === lowered
          );
        });

        if (matched) {
          resolvedFeatureId = matched.id;
          status = this.progressEngine!.getFeatureStatus(resolvedFeatureId);
        }
      }

      if (!status) {
        return this.formatSuccess(
          {
            success: false,
            error: `Feature not found: ${featureId}`,
            availableFeatureIds: allFeatures
              .map((feature) => feature.id)
              .slice(0, 50),
            hint: "Use feature_status with featureId='list' to inspect available IDs",
          },
          profile,
        );
      }

      return this.formatSuccess(
        {
          ...status,
          resolvedFeatureId,
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("FEATURE_STATUS_FAILED", String(error), true);
    }
  }

  async blocking_issues(args: any): Promise<string> {
    const type = args?.type ?? "all";
    const profile = args?.profile || "compact";

    try {
      const issues = this.progressEngine!.getBlockingIssues(type);

      return this.formatSuccess(
        {
          type,
          blockingIssues: issues.slice(0, 20),
          totalBlocked: issues.length,
          recommendation:
            issues.length > 0
              ? `Address ${issues.length} blocking issue(s)`
              : "No blocking issues",
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("BLOCKING_ISSUES_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // UTILITY TOOLS (2)
  // ============================================================================

  async graph_set_workspace(args: any): Promise<string> {
    const { profile = "compact" } = args || {};

    try {
      let nextContext = this.resolveProjectContext(args || {});
      const adapted = this.adaptWorkspaceForRuntime(nextContext);
      const explicitWorkspaceProvided =
        typeof args?.workspaceRoot === "string" &&
        args.workspaceRoot.trim().length > 0;

      if (
        adapted.usedFallback &&
        explicitWorkspaceProvided &&
        !this.runtimePathFallbackAllowed()
      ) {
        return this.errorEnvelope(
          "WORKSPACE_PATH_SANDBOXED",
          `Requested workspaceRoot is not accessible from this runtime: ${nextContext.workspaceRoot}`,
          true,
          "Mount the target project into the container (e.g. LXRAG_TARGET_WORKSPACE) and restart docker-compose, or set LXRAG_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
        );
      }

      nextContext = adapted.context;

      if (!fs.existsSync(nextContext.workspaceRoot)) {
        return this.errorEnvelope(
          "WORKSPACE_NOT_FOUND",
          `Workspace root does not exist: ${nextContext.workspaceRoot}`,
          true,
          "Pass an existing absolute path as workspaceRoot (or workspacePath).",
        );
      }

      if (!fs.existsSync(nextContext.sourceDir)) {
        return this.errorEnvelope(
          "SOURCE_DIR_NOT_FOUND",
          `Source directory does not exist: ${nextContext.sourceDir}`,
          true,
          "Pass sourceDir explicitly if your source folder is not <workspaceRoot>/src.",
        );
      }

      this.setActiveProjectContext(nextContext);
      await this.startActiveWatcher(nextContext);

      const watcher = this.getActiveWatcher();

      return this.formatSuccess(
        {
          success: true,
          projectContext: this.getActiveProjectContext(),
          watcherEnabled: this.watcherEnabledForRuntime(),
          watcherState: (watcher?.state || "not_started") as
            | WatcherState
            | "not_started",
          pendingChanges: watcher?.pendingChanges ?? 0,
          runtimePathFallback: adapted.usedFallback,
          runtimePathFallbackReason: adapted.fallbackReason || null,
          message:
            "Workspace context updated. Subsequent graph tools will use this project.",
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope(
        "SET_WORKSPACE_FAILED",
        String(error),
        true,
        "Retry with workspaceRoot and sourceDir values.",
      );
    }
  }

  async graph_rebuild(args: any): Promise<string> {
    const {
      mode = "incremental",
      verbose = false,
      profile = "compact",
      indexDocs = true,
    } = args;

    try {
      if (!this.orchestrator) {
        return this.errorEnvelope(
          "GRAPH_ORCHESTRATOR_UNAVAILABLE",
          "Graph orchestrator not initialized",
          true,
        );
      }

      let resolvedContext = this.resolveProjectContext(args || {});
      const adapted = this.adaptWorkspaceForRuntime(resolvedContext);
      const explicitWorkspaceProvided =
        typeof args?.workspaceRoot === "string" &&
        args.workspaceRoot.trim().length > 0;

      if (
        adapted.usedFallback &&
        explicitWorkspaceProvided &&
        !this.runtimePathFallbackAllowed()
      ) {
        return this.errorEnvelope(
          "WORKSPACE_PATH_SANDBOXED",
          `Requested workspaceRoot is not accessible from this runtime: ${resolvedContext.workspaceRoot}`,
          true,
          "Mount the target project into the container (e.g. LXRAG_TARGET_WORKSPACE) and restart docker-compose, or set LXRAG_ALLOW_RUNTIME_PATH_FALLBACK=true to force fallback to mounted workspace.",
        );
      }

      resolvedContext = adapted.context;
      this.setActiveProjectContext(resolvedContext);
      const { workspaceRoot, sourceDir, projectId } = resolvedContext;
      const txTimestamp = Date.now();
      // Phase 4.2: Use crypto-secure random ID generation
      const txId = generateSecureId("tx", 4);

      if (this.context.memgraph.isConnected()) {
        await this.context.memgraph.executeCypher(
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
        return this.errorEnvelope(
          "WORKSPACE_NOT_FOUND",
          `Workspace root does not exist: ${workspaceRoot}`,
          true,
          "Call graph_set_workspace first with a valid path.",
        );
      }

      if (!fs.existsSync(sourceDir)) {
        return this.errorEnvelope(
          "SOURCE_DIR_NOT_FOUND",
          `Source directory does not exist: ${sourceDir}`,
          true,
          "Provide sourceDir in graph_rebuild or graph_set_workspace.",
        );
      }

      // Start the build process WITHOUT waiting for it to complete
      // This prevents the MCP tool from blocking/timing out
      // Fire and forget - the build happens in background
      this.orchestrator
        .build({
          mode,
          verbose,
          workspaceRoot,
          projectId,
          sourceDir,
          txId,
          txTimestamp,
          indexDocs,
          exclude: [
            "node_modules",
            "dist",
            ".next",
            ".lxrag",
            "__tests__",
            "coverage",
            ".git",
          ],
        })
        .then(async () => {
          const invalidated =
            await this.coordinationEngine!.invalidateStaleClaims(projectId);
          if (invalidated > 0) {
            console.error(
              `[coordination] Invalidated ${invalidated} stale claim(s) post-rebuild for project ${projectId}`,
            );
          }

          if (mode === "incremental") {
            // Phase 2a & 4.3: Reset embeddings for incremental builds (per-project to prevent race conditions)
            // This ensures embeddings are regenerated for changed code on next semantic query
            this.setProjectEmbeddingsReady(projectId, false);
            console.log(
              `[Phase2a] Embeddings flag reset for incremental rebuild of project ${projectId}`,
            );
          } else if (mode === "full") {
            // Phase 2b: Auto-generate embeddings during full rebuild
            // Make embeddings available immediately after full rebuild completes
            try {
              const generated =
                await this.embeddingEngine?.generateAllEmbeddings();
              if (
                generated &&
                generated.functions + generated.classes + generated.files > 0
              ) {
                await this.embeddingEngine?.storeInQdrant();
                // Phase 4.3: Mark embeddings ready per-project
                this.setProjectEmbeddingsReady(projectId, true);
                console.log(
                  `[Phase2b] Embeddings auto-generated for full rebuild: ${generated.functions} functions, ${generated.classes} classes, ${generated.files} files for project ${projectId}`,
                );
              }
            } catch (embeddingError) {
              console.error(
                `[Phase2b] Embedding generation failed during full rebuild for project ${projectId}:`,
                embeddingError,
              );
              // Continue even if embeddings fail - not a critical error
            }

            const communityRun = await this.communityDetector!.run(projectId);
            console.error(
              `[community] ${communityRun.mode}: ${communityRun.communities} communities across ${communityRun.members} member node(s) for project ${projectId}`,
            );
          }

          // Ensure BM25 index exists after every rebuild (full or incremental).
          // Memgraph may have been restarted, losing the in-memory text index.
          const bm25Result = await this.hybridRetriever?.ensureBM25Index();
          if (bm25Result?.created) {
            console.error(
              `[bm25] Created text_search symbol_index for project ${projectId}`,
            );
          } else if (bm25Result?.error) {
            console.error(
              `[bm25] symbol_index unavailable: ${bm25Result.error}`,
            );
          }
        })
        .catch((err) => {
          // Phase 4.5: Track background build errors for diagnostics
          const context = `mode=${mode}, projectId=${projectId}`;
          this.recordBuildError(projectId, err, context);

          const errorMsg = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          console.error(
            `[Phase4.5] Background build failed for project ${projectId} (${mode}): ${errorMsg}`,
          );
          if (stack) {
            console.error(`[Phase4.5] Stack trace: ${stack.substring(0, 500)}`);
          }
        });

      this.lastGraphRebuildAt = new Date().toISOString();
      this.lastGraphRebuildMode = mode;

      // Return immediately with status
      return this.formatSuccess(
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
          runtimePathFallback: adapted.usedFallback,
          runtimePathFallbackReason: adapted.fallbackReason || null,
          message: `Graph rebuild ${mode} mode initiated. Processing ${mode === "full" ? "all" : "changed"} files in background...`,
          note: "Use graph_query tool to check progress or query results",
        },
        profile,
        `Graph rebuild queued in ${mode} mode for project ${projectId}.`,
        "graph_rebuild",
      );
    } catch (error) {
      return this.errorEnvelope(
        "GRAPH_REBUILD_FAILED",
        `Graph rebuild failed to start: ${String(error)}`,
        true,
      );
    }
  }

  async tools_list(args: any): Promise<string> {
    const profile = args?.profile ?? "compact";

    // Enumerate all callable tools by inspecting the prototype chain and dynamic bindings
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
      memory: [
        "episode_add",
        "episode_recall",
        "decision_query",
        "reflect",
        "context_pack",
      ],
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
        const bound = (this as any)[toolName];
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

    return this.formatSuccess(
      {
        summary: `${totalAvailable} tools available, ${totalUnavailable} unavailable in this session`,
        categories: result,
        note: "Unavailable tools may require missing configuration, a running engine, or a different server entrypoint.",
      },
      profile,
    );
  }

  async graph_health(args: any): Promise<string> {
    const profile = args?.profile || "compact";

    try {
      const { workspaceRoot, sourceDir, projectId } =
        this.getActiveProjectContext();

      // Phase 4.4: Optimize graph_health queries - combine N+1 queries into single batch
      // Single query returns all counts at once instead of 5 separate round-trips
      const healthStatsResult = await this.context.memgraph.executeCypher(
        `MATCH (n {projectId: $projectId})
         WITH count(n) AS totalNodes
         MATCH (n1 {projectId: $projectId})-[r]->(n2 {projectId: $projectId})
         WITH totalNodes, count(r) AS totalRels
         MATCH (f:FILE {projectId: $projectId})
         WITH totalNodes, totalRels, count(f) AS fileCount
         MATCH (fc:FUNCTION {projectId: $projectId})
         WITH totalNodes, totalRels, fileCount, count(fc) AS funcCount
         MATCH (c:CLASS {projectId: $projectId})
         RETURN totalNodes, totalRels, fileCount, funcCount, count(c) AS classCount`,
        { projectId },
      );

      // Extract values from optimized query
      const stats = healthStatsResult.data?.[0] || {};
      const memgraphNodeCount = this.toSafeNumber(stats.totalNodes) ?? 0;
      const memgraphRelCount = this.toSafeNumber(stats.totalRels) ?? 0;
      const memgraphFileCount = this.toSafeNumber(stats.fileCount) ?? 0;
      const memgraphFuncCount = this.toSafeNumber(stats.funcCount) ?? 0;
      const memgraphClassCount = this.toSafeNumber(stats.classCount) ?? 0;

      // Get index statistics for comparison
      const indexStats = this.context.index.getStatistics();
      const indexFileCount = this.context.index.getNodesByType("FILE").length;
      const indexFuncCount =
        this.context.index.getNodesByType("FUNCTION").length;
      const indexClassCount = this.context.index.getNodesByType("CLASS").length;
      const indexedSymbols = indexFileCount + indexFuncCount + indexClassCount;

      // Get embedding statistics: prefer Qdrant point counts (persisted across restarts)
      // over the in-memory cache (which is empty until generateAllEmbeddings() runs).
      let embeddingCount = 0;
      if (this.qdrant?.isConnected()) {
        try {
          const [fnColl, clsColl, fileColl] = await Promise.all([
            this.qdrant.getCollection("functions"),
            this.qdrant.getCollection("classes"),
            this.qdrant.getCollection("files"),
          ]);
          embeddingCount =
            (fnColl?.pointCount ?? 0) +
            (clsColl?.pointCount ?? 0) +
            (fileColl?.pointCount ?? 0);
        } catch {
          // Fall back to in-memory count below
        }
      }
      if (embeddingCount === 0) {
        // In-memory fallback (populated during current session only)
        embeddingCount =
          this.embeddingEngine
            ?.getAllEmbeddings()
            .filter((e) => e.projectId === projectId).length || 0;
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

      // Detect drift between systems
      const indexDrift = indexStats.totalNodes !== memgraphNodeCount;
      const embeddingDrift = embeddingCount < indexedSymbols;

      // Phase 4.4: Optimize transaction queries - combine into single query
      const txMetadataResult = await this.context.memgraph.executeCypher(
        `MATCH (tx:GRAPH_TX {projectId: $projectId})
         WITH tx ORDER BY tx.timestamp DESC
         WITH collect({id: tx.id, timestamp: tx.timestamp})[0] AS latestTx, count(*) AS txCount
         RETURN latestTx, txCount`,
        { projectId },
      );
      const txMetadata = txMetadataResult.data?.[0] || {};
      const latestTxRow = txMetadata.latestTx || {};
      const txCountRow = {
        txCount: this.toSafeNumber(txMetadata.txCount) ?? 0,
      };
      const watcher = this.getActiveWatcher();

      // Build recommendations
      const recommendations: string[] = [];
      if (indexDrift) {
        recommendations.push(
          "Index is out of sync with Memgraph - run graph_rebuild to synchronize",
        );
      }
      // Phase 4.3: Check per-project embedding readiness
      if (embeddingDrift && this.isProjectEmbeddingsReady(projectId)) {
        recommendations.push(
          "Some entities don't have embeddings - run semantic_search or graph_rebuild to generate them",
        );
      }

      return this.formatSuccess(
        {
          status: indexDrift ? "drift_detected" : "ok",
          projectId,
          workspaceRoot,
          sourceDir,
          memgraphConnected: this.context.memgraph.isConnected(),
          qdrantConnected: this.qdrant?.isConnected() || false,
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
            cachedNodes: indexStats.totalNodes,
            memgraphRels: memgraphRelCount,
            cachedRels: indexStats.totalRelationships,
            recommendation: indexDrift
              ? "Index out of sync - run graph_rebuild to refresh"
              : "Index synchronized",
          },
          embeddings: {
            // Phase 4.3: Report per-project embedding readiness
            ready: this.isProjectEmbeddingsReady(projectId),
            generated: embeddingCount,
            coverage: embeddingCoverage,
            driftDetected: embeddingDrift,
            recommendation:
              embeddingCount === 0 &&
              memgraphFuncCount + memgraphClassCount + memgraphFileCount > 0
                ? "No embeddings generated \u2014 run graph_rebuild (full mode) to enable semantic search"
                : embeddingDrift
                  ? "Embeddings incomplete - run semantic_search or rebuild to regenerate"
                  : "Embeddings complete",
          },
          retrieval: {
            bm25IndexExists: this.hybridRetriever?.bm25IndexKnownToExist ?? false,
            mode: this.hybridRetriever?.bm25Mode ?? "not_initialized",
          },
          summarizer: {
            configured: !!env.LXRAG_SUMMARIZER_URL,
            endpoint: env.LXRAG_SUMMARIZER_URL ? "[configured]" : null,
          },
          rebuild: {
            lastRequestedAt: this.lastGraphRebuildAt || null,
            lastMode: this.lastGraphRebuildMode || null,
            latestTxId: latestTxRow.id ?? null,
            latestTxTimestamp:
              this.toSafeNumber(latestTxRow.timestamp) ??
              latestTxRow.timestamp ??
              null,
            txCount: txCountRow.txCount ?? 0,
            // Phase 4.5: Include recent build errors in diagnostics
            recentErrors: this.getRecentBuildErrors(projectId, 3),
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
        indexDrift
          ? "Graph drift detected - see recommendations"
          : "Graph health is OK.",
        "graph_health",
      );
    } catch (error) {
      return this.errorEnvelope("GRAPH_HEALTH_FAILED", String(error), true);
    }
  }

  async diff_since(args: any): Promise<string> {
    const {
      since,
      types = ["FILE", "FUNCTION", "CLASS"],
      profile = "compact",
    } = args || {};

    if (!since || typeof since !== "string") {
      return this.errorEnvelope(
        "DIFF_SINCE_INVALID_INPUT",
        "Field 'since' is required and must be a string.",
        true,
        "Provide txId, ISO timestamp, git commit SHA, or agentId.",
      );
    }

    try {
      const active = this.getActiveProjectContext();
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
        return this.errorEnvelope(
          "DIFF_SINCE_INVALID_TYPES",
          "Field 'types' must include at least one of FILE, FUNCTION, CLASS.",
          true,
        );
      }

      const anchor = await this.resolveSinceAnchor(since, projectId);
      if (!anchor) {
        return this.errorEnvelope(
          "DIFF_SINCE_ANCHOR_NOT_FOUND",
          `Unable to resolve 'since' anchor: ${since}`,
          true,
          "Use a known txId, ISO timestamp, git commit SHA, or agentId with recorded GRAPH_TX entries.",
        );
      }

      const txResult = await this.context.memgraph.executeCypher(
        `MATCH (tx:GRAPH_TX {projectId: $projectId})
         WHERE tx.timestamp >= $sinceTs
         RETURN tx.id AS id
         ORDER BY tx.timestamp ASC`,
        { projectId, sinceTs: anchor.sinceTs },
      );
      const txIds = (txResult.data || [])
        .map((row) => String(row.id || ""))
        .filter(Boolean);

      const addedResult = await this.context.memgraph.executeCypher(
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

      const removedResult = await this.context.memgraph.executeCypher(
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

      const modifiedResult = await this.context.memgraph.executeCypher(
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
          validFrom: this.toSafeNumber(row.validFrom),
          validTo: this.toSafeNumber(row.validTo) ?? undefined,
        }));

      const added = mapDelta(addedResult.data || []);
      const removed = mapDelta(removedResult.data || []);
      const modified = mapDelta(modifiedResult.data || []);

      const summary = `${added.length} added, ${removed.length} removed, ${modified.length} modified since ${anchor.anchorValue}.`;

      return this.formatSuccess(
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
      return this.errorEnvelope("DIFF_SINCE_FAILED", String(error), true);
    }
  }

  async contract_validate(args: any): Promise<string> {
    const { tool, arguments: inputArgs = {}, profile = "compact" } = args || {};

    if (!tool || typeof tool !== "string") {
      return this.errorEnvelope(
        "CONTRACT_VALIDATE_INVALID_INPUT",
        "Field 'tool' is required and must be a string",
        true,
      );
    }

    try {
      const { normalized, warnings } = this.normalizeToolArgs(tool, inputArgs);
      return this.formatSuccess(
        {
          tool,
          input: inputArgs,
          normalized,
          warnings,
          valid: true,
        },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope(
        "CONTRACT_VALIDATE_FAILED",
        String(error),
        true,
      );
    }
  }

  async semantic_search(args: any): Promise<string> {
    const { query, type = "function", limit = 5, profile = "compact" } = args;

    try {
      await this.ensureEmbeddings();
      const { projectId } = this.getActiveProjectContext();
      const results = await this.embeddingEngine!.findSimilar(
        query,
        type,
        limit,
        projectId,
      );

      return this.formatSuccess(
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
      return this.errorEnvelope("SEMANTIC_SEARCH_FAILED", String(error), true);
    }
  }

  async find_similar_code(args: any): Promise<string> {
    const {
      elementId,
      threshold = 0.7,
      limit = 10,
      profile = "compact",
    } = args;

    try {
      await this.ensureEmbeddings();
      const { projectId } = this.getActiveProjectContext();
      const results = await this.embeddingEngine!.findSimilar(
        elementId,
        "function",
        limit,
        projectId,
      );
      const filtered = results.slice(0, limit);

      return this.formatSuccess(
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
      return this.errorEnvelope(
        "FIND_SIMILAR_CODE_FAILED",
        String(error),
        true,
      );
    }
  }

  async code_clusters(args: any): Promise<string> {
    const { type, count = 5, profile = "compact" } = args;

    try {
      await this.ensureEmbeddings();
      const { projectId } = this.getActiveProjectContext();
      const embeddings = this.embeddingEngine!.getAllEmbeddings()
        .filter((item) => item.type === type && item.projectId === projectId)
        .slice(0, 200);

      const clusters: Record<string, string[]> = {};
      for (const item of embeddings) {
        const path = item.metadata.path || "unknown";
        const key = path.split("/").slice(0, 2).join("/") || "root";
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

      return this.formatSuccess(
        { type, count: clusterRows.length, clusters: clusterRows },
        profile,
      );
    } catch (error) {
      return this.errorEnvelope("CODE_CLUSTERS_FAILED", String(error), true);
    }
  }

  async semantic_diff(args: any): Promise<string> {
    const { elementId1, elementId2, profile = "compact" } = args;

    try {
      const left = this.resolveElement(elementId1);
      const right = this.resolveElement(elementId2);

      if (!left || !right) {
        return this.errorEnvelope(
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
        (key) =>
          JSON.stringify(leftProps[key]) !== JSON.stringify(rightProps[key]),
      );

      return this.formatSuccess(
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
      return this.errorEnvelope("SEMANTIC_DIFF_FAILED", String(error), true);
    }
  }

  async suggest_tests(args: any): Promise<string> {
    const { elementId, limit = 5, profile = "compact" } = args;

    try {
      const resolved = this.resolveElement(elementId);
      const candidatePath =
        resolved?.properties.path ||
        resolved?.properties.filePath ||
        resolved?.properties.relativePath ||
        (typeof elementId === "string" && elementId.includes("/")
          ? elementId
          : undefined);

      if (!candidatePath) {
        return this.errorEnvelope(
          "SUGGEST_TESTS_ELEMENT_NOT_FOUND",
          `Unable to resolve file path for element: ${elementId}`,
          true,
        );
      }

      const selection = this.testEngine!.selectAffectedTests(
        [candidatePath],
        true,
        2,
      );
      const suggested = selection.selectedTests.slice(0, limit);

      return this.formatSuccess(
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
      return this.errorEnvelope("SUGGEST_TESTS_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // EPISODE MEMORY TOOLS (4)
  // ============================================================================

  async episode_add(args: any): Promise<string> {
    const {
      type,
      content,
      entities = [],
      taskId,
      outcome,
      metadata,
      sensitive = false,
      profile = "compact",
      agentId,
      sessionId,
    } = args || {};

    if (!type || !content) {
      return this.errorEnvelope(
        "EPISODE_ADD_INVALID_INPUT",
        "Fields 'type' and 'content' are required.",
        true,
        "Provide type (e.g. OBSERVATION) and content.",
      );
    }

    const normalizedType = String(type).toUpperCase();
    const normalizedEntities = Array.isArray(entities)
      ? entities.map((item) => String(item))
      : [];
    const normalizedMetadata =
      metadata && typeof metadata === "object" ? metadata : undefined;
    const validationError = this.validateEpisodeInput({
      type: normalizedType,
      outcome,
      entities: normalizedEntities,
      metadata: normalizedMetadata,
    });
    if (validationError) {
      return this.errorEnvelope(
        "EPISODE_ADD_INVALID_METADATA",
        validationError,
        true,
      );
    }

    try {
      const contextSessionId = this.getCurrentSessionId() || "session-unknown";
      const runtimeAgentId = String(agentId || env.LXRAG_AGENT_ID);
      const { projectId } = this.getActiveProjectContext();

      const episodeId = await this.episodeEngine!.add(
        {
          type: normalizedType as EpisodeType,
          content: String(content),
          entities: normalizedEntities,
          taskId: taskId ? String(taskId) : undefined,
          outcome,
          metadata: normalizedMetadata,
          sensitive: Boolean(sensitive),
          agentId: runtimeAgentId,
          sessionId: String(sessionId || contextSessionId),
        },
        projectId,
      );

      return this.formatSuccess(
        {
          episodeId,
          type: String(type).toUpperCase(),
          projectId,
          taskId: taskId || null,
        },
        profile,
        `Episode ${episodeId} persisted.`,
      );
    } catch (error) {
      return this.errorEnvelope("EPISODE_ADD_FAILED", String(error), true);
    }
  }

  async episode_recall(args: any): Promise<string> {
    const {
      query,
      agentId,
      taskId,
      types,
      entities,
      limit = 5,
      since,
      profile = "compact",
    } = args || {};

    if (!query || typeof query !== "string") {
      return this.errorEnvelope(
        "EPISODE_RECALL_INVALID_INPUT",
        "Field 'query' is required.",
        true,
      );
    }

    try {
      const sinceMs = this.toEpochMillis(since);
      const { projectId } = this.getActiveProjectContext();
      const explicitEntities = Array.isArray(entities)
        ? entities.map((item) => String(item))
        : [];
      const embeddingEntityHints = await this.inferEpisodeEntityHints(
        query,
        limit,
      );
      const mergedEntities = [
        ...new Set([...explicitEntities, ...embeddingEntityHints]),
      ];
      const episodes = await this.episodeEngine!.recall({
        query,
        projectId,
        agentId,
        taskId,
        types: Array.isArray(types)
          ? types.map((item) => String(item).toUpperCase() as EpisodeType)
          : undefined,
        entities: mergedEntities.length ? mergedEntities : undefined,
        limit,
        since: sinceMs || undefined,
      });

      return this.formatSuccess(
        {
          query,
          projectId,
          entityHints: profile === "debug" ? embeddingEntityHints : undefined,
          count: episodes.length,
          episodes,
        },
        profile,
        `Recalled ${episodes.length} episode(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("EPISODE_RECALL_FAILED", String(error), true);
    }
  }

  async decision_query(args: any): Promise<string> {
    const {
      query,
      affectedFiles = [],
      limit = 5,
      taskId,
      agentId,
      profile = "compact",
    } = args || {};

    if (!query || typeof query !== "string") {
      return this.errorEnvelope(
        "DECISION_QUERY_INVALID_INPUT",
        "Field 'query' is required.",
        true,
      );
    }

    try {
      const { projectId } = this.getActiveProjectContext();
      const decisions = await this.episodeEngine!.decisionQuery({
        query,
        projectId,
        taskId,
        agentId,
        entities: Array.isArray(affectedFiles)
          ? affectedFiles.map((item) => String(item))
          : undefined,
        limit,
      });

      return this.formatSuccess(
        {
          query,
          projectId,
          count: decisions.length,
          decisions,
        },
        profile,
        `Found ${decisions.length} decision episode(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("DECISION_QUERY_FAILED", String(error), true);
    }
  }

  async reflect(args: any): Promise<string> {
    const { taskId, agentId, limit = 20, profile = "compact" } = args || {};

    try {
      const { projectId } = this.getActiveProjectContext();
      const result = await this.episodeEngine!.reflect({
        taskId,
        agentId,
        limit,
        projectId,
      });

      return this.formatSuccess(
        result,
        profile,
        `Reflection completed with ${result.learningsCreated} learning(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("REFLECT_FAILED", String(error), true);
    }
  }

  // ============================================================================
  // COORDINATION TOOLS (4)
  // ============================================================================

  async agent_claim(args: any): Promise<string> {
    const {
      targetId,
      claimType = "task",
      intent,
      taskId,
      agentId,
      sessionId,
      profile = "compact",
    } = args || {};

    if (!targetId || !intent) {
      return this.errorEnvelope(
        "AGENT_CLAIM_INVALID_INPUT",
        "Fields 'targetId' and 'intent' are required.",
        true,
      );
    }

    try {
      const runtimeSessionId = this.getCurrentSessionId() || "session-unknown";
      const runtimeAgentId = String(agentId || env.LXRAG_AGENT_ID);
      const { projectId } = this.getActiveProjectContext();

      const result = await this.coordinationEngine!.claim({
        targetId: String(targetId),
        claimType: String(claimType).toLowerCase() as ClaimType,
        intent: String(intent),
        taskId: taskId ? String(taskId) : undefined,
        agentId: runtimeAgentId,
        sessionId: String(sessionId || runtimeSessionId),
        projectId,
      });

      return this.formatSuccess(
        {
          projectId,
          ...result,
        },
        profile,
        result.status === "CONFLICT"
          ? `Conflict detected for target ${targetId}.`
          : `Claim ${result.claimId} created for ${targetId}.`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_CLAIM_FAILED", String(error), true);
    }
  }

  async agent_release(args: any): Promise<string> {
    const { claimId, outcome, profile = "compact" } = args || {};

    if (!claimId) {
      return this.errorEnvelope(
        "AGENT_RELEASE_INVALID_INPUT",
        "Field 'claimId' is required.",
        true,
      );
    }

    try {
      await this.coordinationEngine!.release(String(claimId), outcome);

      return this.formatSuccess(
        {
          claimId: String(claimId),
          released: true,
          outcome: outcome || null,
        },
        profile,
        `Claim ${claimId} released.`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_RELEASE_FAILED", String(error), true);
    }
  }

  async agent_status(args: any): Promise<string> {
    const { agentId, profile = "compact" } = args || {};

    try {
      const { projectId } = this.getActiveProjectContext();

      // When agentId is omitted, return the fleet-wide overview (list-all case)
      if (!agentId || typeof agentId !== "string") {
        const overview = await this.coordinationEngine!.overview(projectId);
        return this.formatSuccess(
          {
            projectId,
            mode: "overview",
            ...overview,
          },
          profile,
          `Fleet: ${overview.activeClaims.length} active claim(s), ${overview.staleClaims.length} stale.`,
        );
      }

      const status = await this.coordinationEngine!.status(agentId, projectId);

      return this.formatSuccess(
        {
          projectId,
          ...status,
        },
        profile,
        `Agent ${agentId} has ${status.activeClaims.length} active claim(s).`,
      );
    } catch (error) {
      return this.errorEnvelope("AGENT_STATUS_FAILED", String(error), true);
    }
  }

  async coordination_overview(args: any): Promise<string> {
    const { profile = "compact" } = args || {};

    try {
      const { projectId } = this.getActiveProjectContext();
      const overview = await this.coordinationEngine!.overview(projectId);

      return this.formatSuccess(
        {
          projectId,
          ...overview,
        },
        profile,
        `Coordination overview: ${overview.activeClaims.length} active claim(s), ${overview.staleClaims.length} stale claim(s).`,
      );
    } catch (error) {
      return this.errorEnvelope(
        "COORDINATION_OVERVIEW_FAILED",
        String(error),
        true,
      );
    }
  }

  async context_pack(args: any): Promise<string> {
    const {
      task,
      taskId,
      agentId,
      profile = "compact",
      includeDecisions = true,
      includeLearnings = true,
      includeEpisodes = true,
    } = args || {};

    if (!task || typeof task !== "string") {
      return this.errorEnvelope(
        "CONTEXT_PACK_INVALID_INPUT",
        "Field 'task' is required.",
        true,
      );
    }

    try {
      const runtimeAgentId = String(agentId || env.LXRAG_AGENT_ID);
      const { projectId, workspaceRoot } = this.getActiveProjectContext();

      const seedIds = this.findSeedNodeIds(task, 5);
      const expandedSeedIds = await this.expandInterfaceSeeds(
        seedIds,
        projectId,
      );
      const pprResults = await runPPR(
        {
          projectId,
          seedIds: expandedSeedIds.length ? expandedSeedIds : seedIds,
          maxResults: 60,
        },
        this.context.memgraph,
      );

      const codeCandidates = pprResults.filter((item) =>
        ["FUNCTION", "CLASS", "FILE"].includes(
          String(item.type || "").toUpperCase(),
        ),
      );
      const coreSymbols = await this.materializeCoreSymbols(
        codeCandidates,
        workspaceRoot,
      );

      const selectedIds = coreSymbols.map((item) => item.nodeId);
      const activeBlockers = await this.findActiveBlockers(
        selectedIds,
        runtimeAgentId,
        projectId,
      );
      const decisions = includeDecisions
        ? await this.findDecisionEpisodes(selectedIds, projectId)
        : [];
      const learnings = includeLearnings
        ? await this.findLearnings(selectedIds, projectId)
        : [];
      const episodes = includeEpisodes
        ? await this.findRecentEpisodes(taskId, runtimeAgentId, projectId)
        : [];

      const entryPoint =
        coreSymbols[0]?.symbolName ||
        coreSymbols[0]?.file ||
        "No entry point found";
      const summary = `Task briefing for '${task}': start at ${entryPoint}. Focus on ${coreSymbols.length} high-relevance symbol(s) and resolve ${activeBlockers.length} active blocker(s).`;

      const pack: Record<string, unknown> = {
        summary,
        entryPoint,
        task,
        taskId: taskId || null,
        projectId,
        coreSymbols,
        dependencies: coreSymbols.flatMap((item) => [
          ...item.incomingCallers.map((caller: any) => ({
            from: caller.id,
            to: item.nodeId,
            type: "CALLS",
          })),
          ...item.outgoingCalls.map((callee: any) => ({
            from: item.nodeId,
            to: callee.id,
            type: "CALLS",
          })),
        ]),
        decisions,
        learnings,
        episodes,
        activeBlockers,
        plan: taskId
          ? {
              taskId,
              status: "unknown",
              note: "Plan-node integration deferred to later phase.",
            }
          : null,
        pprScores:
          profile === "debug"
            ? Object.fromEntries(
                pprResults.map((item) => [item.nodeId, item.score]),
              )
            : undefined,
      };

      const safeProfile: ResponseProfile =
        profile === "balanced" || profile === "debug" ? profile : "compact";
      const budget = makeBudget(safeProfile);
      this.trimContextPackToBudget(pack, budget.maxTokens);
      pack.tokenEstimate = estimateTokens(pack);

      return this.formatSuccess(pack, safeProfile, summary, "context_pack");
    } catch (error) {
      return this.errorEnvelope("CONTEXT_PACK_FAILED", String(error), true);
    }
  }

  async semantic_slice(args: any): Promise<string> {
    const {
      file,
      symbol,
      query,
      context = "body",
      pprScore,
      profile = "compact",
    } = args || {};

    if (!symbol && !query && !file) {
      return this.errorEnvelope(
        "SEMANTIC_SLICE_INVALID_INPUT",
        "Provide at least one of: symbol, query, or file.",
        true,
      );
    }

    try {
      const { workspaceRoot, projectId } = this.getActiveProjectContext();
      const resolved = this.resolveSemanticSliceAnchor({ file, symbol, query });
      if (!resolved) {
        return this.errorEnvelope(
          "SEMANTIC_SLICE_NOT_FOUND",
          "Unable to resolve a symbol or file anchor for semantic slicing.",
          true,
          "Provide symbol + file for exact lookup or a more specific query.",
        );
      }

      const { node, filePath, startLine, endLine } = resolved;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath);

      const sliceContext =
        context === "signature" ||
        context === "body" ||
        context === "with-deps" ||
        context === "full"
          ? context
          : "body";

      const [rangeStart, rangeEnd] = this.computeSliceRange(
        startLine,
        endLine,
        sliceContext,
      );
      const code = this.readExactLines(absolutePath, rangeStart, rangeEnd);

      const incomingCallers =
        sliceContext === "with-deps" || sliceContext === "full"
          ? this.context.index
              .getRelationshipsTo(node.id)
              .filter((rel) => rel.type === "CALLS")
              .slice(0, 10)
              .map((rel) => ({
                id: rel.from,
                name:
                  this.context.index.getNode(rel.from)?.properties?.name ||
                  rel.from,
              }))
          : [];

      const outgoingCalls =
        sliceContext === "with-deps" || sliceContext === "full"
          ? this.context.index
              .getRelationshipsFrom(node.id)
              .filter((rel) => rel.type === "CALLS")
              .slice(0, 10)
              .map((rel) => ({
                id: rel.to,
                name:
                  this.context.index.getNode(rel.to)?.properties?.name ||
                  rel.to,
              }))
          : [];

      const includeKnowledge = sliceContext === "full";
      const decisions = includeKnowledge
        ? await this.findDecisionEpisodes([node.id], projectId)
        : [];
      const learnings = includeKnowledge
        ? await this.findLearnings([node.id], projectId)
        : [];

      const response = {
        file: filePath,
        startLine: rangeStart,
        endLine: rangeEnd,
        code,
        symbolName: String(node.properties.name || path.basename(filePath)),
        pprScore: typeof pprScore === "number" ? pprScore : undefined,
        incomingCallers,
        outgoingCalls,
        relevantDecisions: decisions,
        relevantLearnings: learnings,
        validFrom: node.properties.validFrom || null,
        context: sliceContext,
        projectId,
      };

      const summary = `Semantic slice resolved ${response.symbolName} in ${response.file}:${response.startLine}-${response.endLine}.`;

      return this.formatSuccess(response, profile, summary, "semantic_slice");
    } catch (error) {
      return this.errorEnvelope("SEMANTIC_SLICE_FAILED", String(error), true);
    }
  }

  private findSeedNodeIds(task: string, limit: number): string[] {
    const tokens = task
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((token) => token.length >= 3);

    const candidates = [
      ...this.context.index.getNodesByType("FUNCTION"),
      ...this.context.index.getNodesByType("CLASS"),
      ...this.context.index.getNodesByType("FILE"),
    ];

    const scored = candidates
      .map((node) => {
        const haystack =
          `${node.id} ${node.properties.name || ""} ${node.properties.path || ""}`.toLowerCase();
        const score = tokens.reduce(
          (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
          0,
        );
        return { nodeId: node.id, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = scored.filter((item) => item.score > 0).slice(0, limit);
    if (selected.length) {
      return selected.map((item) => item.nodeId);
    }

    return candidates.slice(0, limit).map((node) => node.id);
  }

  private async expandInterfaceSeeds(
    seedIds: string[],
    projectId: string,
  ): Promise<string[]> {
    if (!seedIds.length) {
      return [];
    }

    const expanded = new Set(seedIds);
    const relationExpansion = await this.context.memgraph.executeCypher(
      `MATCH (iface {projectId: $projectId})
       WHERE iface.id IN $seedIds
         AND (toLower(coalesce(iface.kind, '')) IN ['interface', 'abstract'])
       OPTIONAL MATCH (iface)-[:IMPLEMENTED_BY]->(impl {projectId: $projectId})
       RETURN collect(DISTINCT impl.id) AS implIds`,
      { projectId, seedIds },
    );

    const implIds = relationExpansion.data?.[0]?.implIds;
    if (Array.isArray(implIds)) {
      for (const implId of implIds) {
        if (implId) {
          expanded.add(String(implId));
        }
      }
    }

    return [...expanded];
  }

  private async materializeCoreSymbols(
    pprResults: Array<{ nodeId: string; score: number }>,
    workspaceRoot: string,
  ): Promise<any[]> {
    const maxSymbols = 8;
    const selected = pprResults.slice(0, maxSymbols);
    const slices: any[] = [];

    for (const item of selected) {
      const resolved = this.resolveNodeForSlice(item.nodeId);
      if (!resolved) {
        continue;
      }

      const { node, filePath, startLine, endLine } = resolved;
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath);

      const code = this.readCodeSnippet(absolutePath, startLine, endLine, 800);
      const incomingCallers = this.context.index
        .getRelationshipsTo(node.id)
        .filter((rel) => rel.type === "CALLS")
        .slice(0, 5)
        .map((rel) => ({ id: rel.from }));
      const outgoingCalls = this.context.index
        .getRelationshipsFrom(node.id)
        .filter((rel) => rel.type === "CALLS")
        .slice(0, 5)
        .map((rel) => ({ id: rel.to }));

      slices.push({
        nodeId: node.id,
        file: filePath,
        startLine,
        endLine,
        code,
        symbolName: String(node.properties.name || path.basename(filePath)),
        pprScore: Number(item.score.toFixed(6)),
        incomingCallers,
        outgoingCalls,
        validFrom: node.properties.validFrom || null,
        relevantDecisions: [],
        relevantLearnings: [],
      });
    }

    return slices;
  }

  private resolveNodeForSlice(nodeId: string): {
    node: GraphNode;
    filePath: string;
    startLine: number;
    endLine: number;
  } | null {
    const node = this.context.index.getNode(nodeId);
    if (!node) {
      return null;
    }

    let filePath = String(
      node.properties.path || node.properties.filePath || "",
    );
    if (!filePath) {
      const parents = this.context.index
        .getRelationshipsTo(node.id)
        .filter((rel) => rel.type === "CONTAINS");
      const fileNode = parents
        .map((rel) => this.context.index.getNode(rel.from))
        .find((candidate) => candidate?.type === "FILE");
      filePath = String(
        fileNode?.properties.path || fileNode?.properties.filePath || "",
      );
    }

    if (!filePath) {
      filePath = node.id;
    }

    const startLine = Number(
      node.properties.startLine || node.properties.line || 1,
    );
    const endLine = Number(node.properties.endLine || startLine + 40);

    return {
      node,
      filePath,
      startLine,
      endLine,
    };
  }

  private readCodeSnippet(
    absolutePath: string,
    startLine: number,
    endLine: number,
    maxChars: number,
  ): string {
    try {
      if (!fs.existsSync(absolutePath)) {
        return "";
      }
      const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
      const snippet = lines
        .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
        .join("\n");
      return snippet.length > maxChars
        ? `${snippet.slice(0, maxChars - 3)}...`
        : snippet;
    } catch {
      return "";
    }
  }

  private async findActiveBlockers(
    selectedIds: string[],
    requestingAgentId: string,
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const blockers = await this.context.memgraph.executeCypher(
      `MATCH (c:CLAIM)-[:TARGETS]->(t)
       WHERE c.projectId = $projectId
         AND t.projectId = $projectId
         AND c.validTo IS NULL
         AND t.id IN $selectedIds
         AND c.agentId <> $requestingAgentId
       RETURN c.id AS claimId, c.agentId AS agentId, c.intent AS intent, t.id AS targetId, c.validFrom AS since
       ORDER BY c.validFrom DESC
       LIMIT 20`,
      { projectId, selectedIds, requestingAgentId },
    );

    return (blockers.data || []).map((row) => ({
      claimId: String(row.claimId || ""),
      agentId: String(row.agentId || "unknown"),
      intent: String(row.intent || ""),
      targetId: String(row.targetId || ""),
      since: Number(row.since || Date.now()),
    }));
  }

  private async findDecisionEpisodes(
    selectedIds: string[],
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (e:EPISODE {projectId: $projectId, type: 'DECISION'})-[:INVOLVES]->(n)
       WHERE n.projectId = $projectId AND n.id IN $selectedIds
       RETURN e.id AS id, e.content AS content, e.timestamp AS timestamp
       ORDER BY e.timestamp DESC
       LIMIT 10`,
      { projectId, selectedIds },
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      content: String(row.content || ""),
      timestamp: Number(row.timestamp || Date.now()),
    }));
  }

  private async findLearnings(
    selectedIds: string[],
    projectId: string,
  ): Promise<any[]> {
    if (!selectedIds.length) {
      return [];
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (l:LEARNING {projectId: $projectId})-[:APPLIES_TO]->(n)
       WHERE n.projectId = $projectId AND n.id IN $selectedIds
       RETURN l.id AS id, l.content AS content, l.confidence AS confidence
       ORDER BY l.confidence DESC
       LIMIT 10`,
      { projectId, selectedIds },
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      content: String(row.content || ""),
      confidence: Number(row.confidence || 0),
    }));
  }

  private async findRecentEpisodes(
    taskId: string | undefined,
    agentId: string,
    projectId: string,
  ): Promise<any[]> {
    const conditions: string[] = ["e.projectId = $projectId"];
    const params: Record<string, unknown> = { projectId };

    if (taskId) {
      conditions.push("e.taskId = $taskId");
      params.taskId = taskId;
    } else {
      conditions.push("e.agentId = $agentId");
      params.agentId = agentId;
    }

    const result = await this.context.memgraph.executeCypher(
      `MATCH (e:EPISODE)
       WHERE ${conditions.join(" AND ")}
       RETURN e.id AS id, e.type AS type, e.content AS content, e.timestamp AS timestamp
       ORDER BY e.timestamp DESC
       LIMIT 10`,
      params,
    );

    return (result.data || []).map((row) => ({
      id: String(row.id || ""),
      type: String(row.type || "OBSERVATION"),
      content: String(row.content || ""),
      timestamp: Number(row.timestamp || Date.now()),
    }));
  }

  private trimContextPackToBudget(
    pack: Record<string, any>,
    budget: number,
  ): void {
    if (!Number.isFinite(budget)) {
      return;
    }

    const pruneStep = () => {
      if (Array.isArray(pack.coreSymbols) && pack.coreSymbols.length > 1) {
        pack.coreSymbols.pop();
        return true;
      }
      if (Array.isArray(pack.decisions) && pack.decisions.length > 2) {
        pack.decisions.pop();
        return true;
      }
      if (Array.isArray(pack.learnings) && pack.learnings.length > 2) {
        pack.learnings.pop();
        return true;
      }
      if (Array.isArray(pack.episodes) && pack.episodes.length > 2) {
        pack.episodes.pop();
        return true;
      }
      if (Array.isArray(pack.coreSymbols)) {
        for (const symbol of pack.coreSymbols) {
          if (typeof symbol.code === "string" && symbol.code.length > 220) {
            symbol.code = `${symbol.code.slice(0, 217)}...`;
            return true;
          }
        }
      }
      return false;
    };

    let estimated = estimateTokens(pack);
    let guard = 0;
    while (estimated > budget && guard < 200) {
      const changed = pruneStep();
      if (!changed) {
        break;
      }
      estimated = estimateTokens(pack);
      guard += 1;
    }
  }

  private resolveSemanticSliceAnchor(input: {
    file?: string;
    symbol?: string;
    query?: string;
  }): {
    node: GraphNode;
    filePath: string;
    startLine: number;
    endLine: number;
  } | null {
    const normalizedFile = input.file ? String(input.file) : undefined;
    const normalizedSymbol = input.symbol ? String(input.symbol) : undefined;

    if (normalizedSymbol?.includes("::")) {
      const exact = this.resolveNodeForSlice(normalizedSymbol);
      if (exact) {
        return exact;
      }
    }

    if (normalizedSymbol && normalizedFile) {
      const fileNode = this.context.index
        .getNodesByType("FILE")
        .find((candidate) => {
          const candidatePath = String(
            candidate.properties.path || candidate.properties.filePath || "",
          );
          return (
            candidatePath === normalizedFile ||
            candidatePath.endsWith(normalizedFile) ||
            normalizedFile.endsWith(candidatePath)
          );
        });

      if (fileNode) {
        const childIds = this.context.index
          .getRelationshipsFrom(fileNode.id)
          .filter((rel) => rel.type === "CONTAINS")
          .map((rel) => rel.to);
        const targetName =
          normalizedSymbol.split(".").pop() || normalizedSymbol;
        const child = childIds
          .map((id) => this.context.index.getNode(id))
          .find((node) => node?.properties?.name === targetName);
        if (child) {
          return this.resolveNodeForSlice(child.id);
        }
      }
    }

    if (normalizedSymbol) {
      const targetName = normalizedSymbol.split(".").pop() || normalizedSymbol;
      const direct = [
        ...this.context.index.getNodesByType("FUNCTION"),
        ...this.context.index.getNodesByType("CLASS"),
        ...this.context.index.getNodesByType("FILE"),
      ].find((node) => {
        const name = String(node.properties.name || node.properties.path || "");
        return name === targetName || name.includes(targetName);
      });

      if (direct) {
        return this.resolveNodeForSlice(direct.id);
      }
    }

    if (input.query) {
      const fallbackId = this.findSeedNodeIds(String(input.query), 1)[0];
      if (fallbackId) {
        return this.resolveNodeForSlice(fallbackId);
      }
    }

    if (normalizedFile) {
      const fileNode = this.context.index
        .getNodesByType("FILE")
        .find((candidate) => {
          const candidatePath = String(
            candidate.properties.path || candidate.properties.filePath || "",
          );
          return (
            candidatePath === normalizedFile ||
            candidatePath.endsWith(normalizedFile) ||
            normalizedFile.endsWith(candidatePath)
          );
        });
      if (fileNode) {
        return this.resolveNodeForSlice(fileNode.id);
      }
    }

    return null;
  }

  private computeSliceRange(
    startLine: number,
    endLine: number,
    context: "signature" | "body" | "with-deps" | "full",
  ): [number, number] {
    if (context === "signature") {
      return [startLine, startLine];
    }
    return [startLine, Math.max(startLine, endLine)];
  }

  private readExactLines(
    absolutePath: string,
    startLine: number,
    endLine: number,
  ): string {
    if (!fs.existsSync(absolutePath)) {
      return "";
    }
    const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
    return lines
      .slice(Math.max(0, startLine - 1), Math.max(startLine, endLine))
      .join("\n");
  }

  // ── Docs/ADR tools ───────────────────────────────────────────────────────────

  async init_project_setup(args: any): Promise<string> {
    const {
      workspaceRoot,
      sourceDir,
      projectId,
      rebuildMode = "incremental",
      withDocs = true,
      profile = "compact",
    } = args ?? {};

    if (!workspaceRoot || typeof workspaceRoot !== "string") {
      return this.errorEnvelope(
        "INIT_MISSING_WORKSPACE",
        "workspaceRoot is required",
        false,
        "Provide the absolute path to the project you want to initialize.",
      );
    }

    const resolvedRoot = path.resolve(workspaceRoot);
    if (!fs.existsSync(resolvedRoot)) {
      return this.errorEnvelope(
        "INIT_WORKSPACE_NOT_FOUND",
        `Workspace path does not exist: ${resolvedRoot}`,
        false,
        "Ensure the project is accessible from this machine/container.",
      );
    }

    const steps: Array<{ step: string; status: string; detail?: string }> = [];

    try {
      // Step 1 — graph_set_workspace
      const setArgs: any = { workspaceRoot: resolvedRoot, profile };
      if (sourceDir) setArgs.sourceDir = sourceDir;
      if (projectId) setArgs.projectId = projectId;

      let setResult: string;
      try {
        setResult = await this.graph_set_workspace(setArgs);
        const setJson = JSON.parse(setResult);
        if (setJson?.error) {
          steps.push({
            step: "graph_set_workspace",
            status: "failed",
            detail: setJson.error,
          });
          return this.formatSuccess(
            { steps, abortedAt: "graph_set_workspace" },
            profile,
            "Initialization aborted at workspace setup",
            "init_project_setup",
          );
        }
        const ctx = setJson?.data?.projectContext ?? setJson?.data ?? {};
        steps.push({
          step: "graph_set_workspace",
          status: "ok",
          detail: `projectId=${ctx.projectId ?? "?"}, sourceDir=${ctx.sourceDir ?? "?"}`,
        });
      } catch (err) {
        steps.push({
          step: "graph_set_workspace",
          status: "failed",
          detail: String(err),
        });
        return this.formatSuccess(
          { steps, abortedAt: "graph_set_workspace" },
          profile,
          "Initialization aborted at workspace setup",
          "init_project_setup",
        );
      }

      // Step 2 — graph_rebuild
      const rebuildArgs: any = {
        workspaceRoot: resolvedRoot,
        mode: rebuildMode,
        indexDocs: withDocs,
        profile,
      };
      if (sourceDir) rebuildArgs.sourceDir = sourceDir;
      if (projectId) rebuildArgs.projectId = projectId;

      try {
        const rebuildResult = await this.graph_rebuild(rebuildArgs);
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

      // Step 3 — setup_copilot_instructions (generate if not present)
      const copilotPath = path.join(
        resolvedRoot,
        ".github",
        "copilot-instructions.md",
      );
      if (!fs.existsSync(copilotPath)) {
        try {
          await this.setup_copilot_instructions({
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

      const ctx = this.resolveProjectContext({
        workspaceRoot: resolvedRoot,
        ...(sourceDir ? { sourceDir } : {}),
        ...(projectId ? { projectId } : {}),
      });

      return this.formatSuccess(
        {
          projectId: ctx.projectId,
          workspaceRoot: ctx.workspaceRoot,
          sourceDir: ctx.sourceDir,
          steps,
          nextAction:
            "Call graph_health to confirm the rebuild completed, then graph_query to start exploring.",
        },
        profile,
        `Project ${ctx.projectId} initialized — graph rebuild queued`,
        "init_project_setup",
      );
    } catch (error) {
      return this.errorEnvelope(
        "INIT_PROJECT_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // setup_copilot_instructions — generate .github/copilot-instructions.md
  // ──────────────────────────────────────────────────────────────────────────

  async setup_copilot_instructions(args: any): Promise<string> {
    const {
      targetPath,
      projectName: forceProjectName,
      dryRun = false,
      overwrite = false,
      profile = "compact",
    } = args ?? {};

    // Resolve target (defaults to active workspace root)
    let resolvedTarget: string;
    if (targetPath && typeof targetPath === "string") {
      resolvedTarget = path.resolve(targetPath);
    } else {
      const ctx = this.resolveProjectContext({});
      resolvedTarget = ctx.workspaceRoot;
    }

    if (!fs.existsSync(resolvedTarget)) {
      return this.errorEnvelope(
        "COPILOT_INSTR_TARGET_NOT_FOUND",
        `Target path does not exist: ${resolvedTarget}`,
        false,
        "Provide an accessible absolute path via targetPath parameter.",
      );
    }

    const destFile = path.join(
      resolvedTarget,
      ".github",
      "copilot-instructions.md",
    );
    if (fs.existsSync(destFile) && !overwrite && !dryRun) {
      return this.formatSuccess(
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
      // ------ Gather project intelligence ------
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

      // Detect stack
      const stack: string[] = [];
      const isTypeScript =
        fs.existsSync(path.join(resolvedTarget, "tsconfig.json")) ||
        !!deps["typescript"];
      const isNode =
        !!pkgJson || fs.existsSync(path.join(resolvedTarget, "package.json"));
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

      // Key scripts
      const scripts = pkgJson?.scripts
        ? Object.entries(pkgJson.scripts)
            .slice(0, 10)
            .map(([k, v]) => `- \`${k}\`: \`${v}\``)
            .join("\n")
        : "";

      // Detect source dir
      const candidateSrcDirs = ["src", "lib", "app", "packages", "source"];
      const srcDir =
        candidateSrcDirs.find((d) =>
          fs.existsSync(path.join(resolvedTarget, d)),
        ) ?? "src";

      // Detect key sub-dirs
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
          /* ignore */
        }
      }

      // MCP endpoint detection
      const isMcpServer =
        !!deps["@modelcontextprotocol/sdk"] ||
        fs.existsSync(path.join(resolvedTarget, "src", "mcp-server.ts")) ||
        fs.existsSync(path.join(resolvedTarget, "src", "server.ts"));

      // Compose the instructions doc
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
          "## Required Session Flow (HTTP)",
          "",
          "1. Send `initialize`",
          "2. Capture `mcp-session-id` from response header",
          "3. Include `mcp-session-id` on all subsequent requests",
          "4. Call `graph_set_workspace` — or use `init_project_setup` for a one-shot setup",
          "5. Call `graph_rebuild`",
          "6. Validate via `graph_health` and `graph_query`",
        );
      } else {
        lines.push(
          "",
          "## Required Session Flow",
          "",
          "1. Call `init_project_setup` with the workspace path — this sets context, triggers graph rebuild, and creates copilot instructions in one step.",
          "2. Validate with `graph_health`",
          "3. Explore with `graph_query`",
        );
      }

      lines.push(
        "",
        "## Tool Priority",
        "",
        "- Discovery/counts/listing: `graph_query`",
        "- Dependency context: `code_explain`",
        "- Architecture checks: `arch_validate`, `arch_suggest`",
        "- Test impact: `impact_analyze`, `test_select`",
        "- Similarity/search: `semantic_search`, `find_similar_code`",
        "- Reference patterns: `ref_query` — query another repo on the same machine",
        "- Docs: `search_docs`, `index_docs`",
        "- Init: `init_project_setup` — one-shot workspace initialization",
      );

      lines.push(
        "",
        "## Output Requirements",
        "",
        "Always include:",
        "",
        "1. Active context (`projectId`, `workspaceRoot`)",
        "2. Whether results are final or pending async rebuild",
        "3. The single best next action",
      );

      lines.push(
        "",
        `## Source of Truth`,
        "",
        `For configuration and setup details, see \`README.md\` and \`QUICK_START.md\`.`,
      );

      const content = lines.join("\n") + "\n";

      if (dryRun) {
        return this.formatSuccess(
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

      // Write the file
      const githubDir = path.join(resolvedTarget, ".github");
      if (!fs.existsSync(githubDir)) {
        fs.mkdirSync(githubDir, { recursive: true });
      }
      fs.writeFileSync(destFile, content, "utf-8");

      return this.formatSuccess(
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
      return this.errorEnvelope(
        "SETUP_COPILOT_FAILED",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}

export default ToolHandlers;
