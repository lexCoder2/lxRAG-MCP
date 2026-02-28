/**
 * Tool Handlers - Concrete Tool Implementations
 * Registry-backed runtime dispatch + complex helper implementations.
 *
 * Tool entrypoints are bound from `toolRegistry`; this class keeps shared helper logic
 * for implementations that require cross-cutting context assembly.
 */

import * as fs from "fs";
import * as path from "path";
import * as env from "../env.js";
import type { GraphNode } from "../graph/index.js";
import { runPPR } from "../graph/ppr.js";
import type { ResponseProfile } from "../response/budget.js";
import { estimateTokens, makeBudget } from "../response/budget.js";
import { ToolHandlerBase, type ToolContext } from "./tool-handler-base.js";
import { toolRegistryMap } from "./registry.js";
import type { ToolArgs, HandlerBridge } from "./types.js";

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
    // Bind migrated tools from centralized registry
    for (const [toolName, definition] of toolRegistryMap.entries()) {
      if (typeof (this as Record<string, unknown>)[toolName] === "function") {
        continue;
      }
      (this as Record<string, unknown>)[toolName] = (args: any) => definition.impl(args, this as unknown as HandlerBridge);
    }
  }

  // Core query/graph/search contract tools are now implemented in core-tools.ts
  // and bound via toolRegistry in the constructor.

  // Episode/coordination tools migrated to handler modules and bound via toolRegistry.

  public async core_context_pack_impl(args: ToolArgs): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = args;
    const {
      task,
      taskId,
      agentId,
      profile = "compact",
      includeDecisions = true,
      includeLearnings = true,
      includeEpisodes = true,
    } = a || {};

    if (!task || typeof task !== "string") {
      return this.errorEnvelope("CONTEXT_PACK_INVALID_INPUT", "Field 'task' is required.", true);
    }

    try {
      const runtimeAgentId = String(agentId || env.LXDIG_AGENT_ID);
      const { projectId, workspaceRoot } = this.getActiveProjectContext();

      const seedIds = this.findSeedNodeIds(task, 5);
      const expandedSeedIds = await this.expandInterfaceSeeds(seedIds, projectId);
      const pprResults = await runPPR(
        {
          projectId,
          seedIds: expandedSeedIds.length ? expandedSeedIds : seedIds,
          maxResults: 60,
        },
        this.context.memgraph,
      );

      const codeCandidates = pprResults.filter((item) =>
        ["FUNCTION", "CLASS", "FILE"].includes(String(item.type || "").toUpperCase()),
      );
      const coreSymbolsRaw = await this.materializeCoreSymbols(codeCandidates, workspaceRoot);
      type CoreSymbol = { nodeId: string; symbolName: string; file: string; incomingCallers: Array<{ id: string }>; outgoingCalls: Array<{ id: string }> };
      const coreSymbols = coreSymbolsRaw as unknown as CoreSymbol[];

      const selectedIds = coreSymbols.map((item) => item.nodeId);
      const activeBlockers = await this.findActiveBlockers(selectedIds, runtimeAgentId, projectId);
      const decisions = includeDecisions
        ? await this.findDecisionEpisodes(selectedIds, projectId)
        : [];
      const learnings = includeLearnings ? await this.findLearnings(selectedIds, projectId) : [];
      const episodes = includeEpisodes
        ? await this.findRecentEpisodes(taskId, runtimeAgentId, projectId)
        : [];

      const entryPoint =
        coreSymbols[0]?.symbolName || coreSymbols[0]?.file || "No entry point found";
      const summary = `Task briefing for '${task}': start at ${entryPoint}. Focus on ${coreSymbols.length} high-relevance symbol(s) and resolve ${activeBlockers.length} active blocker(s).`;

      const pack: Record<string, unknown> = {
        summary,
        entryPoint,
        task,
        taskId: taskId || null,
        projectId,
        coreSymbols,
        dependencies: coreSymbols.flatMap((item) => [
          ...item.incomingCallers.map((caller: Record<string, unknown>) => ({
            from: caller.id,
            to: item.nodeId,
            type: "CALLS",
          })),
          ...item.outgoingCalls.map((callee: Record<string, unknown>) => ({
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
            ? Object.fromEntries(pprResults.map((item) => [item.nodeId, item.score]))
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

  public async core_semantic_slice_impl(args: ToolArgs): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a: any = args;
    const { file, symbol, query, context = "body", pprScore, profile = "compact" } = a || {};

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

      const [rangeStart, rangeEnd] = this.computeSliceRange(startLine, endLine, sliceContext);
      const code = this.readExactLines(absolutePath, rangeStart, rangeEnd);

      const incomingCallers =
        sliceContext === "with-deps" || sliceContext === "full"
          ? this.context.index
              .getRelationshipsTo(node.id)
              .filter((rel) => rel.type === "CALLS")
              .slice(0, 10)
              .map((rel) => ({
                id: rel.from,
                name: this.context.index.getNode(rel.from)?.properties?.name || rel.from,
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
                name: this.context.index.getNode(rel.to)?.properties?.name || rel.to,
              }))
          : [];

      const includeKnowledge = sliceContext === "full";
      const decisions = includeKnowledge
        ? await this.findDecisionEpisodes([node.id], projectId)
        : [];
      const learnings = includeKnowledge ? await this.findLearnings([node.id], projectId) : [];

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
        const score = tokens.reduce((acc, token) => acc + (haystack.includes(token) ? 1 : 0), 0);
        return { nodeId: node.id, score };
      })
      .sort((a, b) => b.score - a.score);

    const selected = scored.filter((item) => item.score > 0).slice(0, limit);
    if (selected.length) {
      return selected.map((item) => item.nodeId);
    }

    return candidates.slice(0, limit).map((node) => node.id);
  }

  private async expandInterfaceSeeds(seedIds: string[], projectId: string): Promise<string[]> {
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
  ): Promise<Record<string, unknown>[]> {
    const maxSymbols = 8;
    const selected = pprResults.slice(0, maxSymbols);
    const slices: Record<string, unknown>[] = [];

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

    let filePath = String(node.properties.path || node.properties.filePath || "");
    if (!filePath) {
      const parents = this.context.index
        .getRelationshipsTo(node.id)
        .filter((rel) => rel.type === "CONTAINS");
      const fileNode = parents
        .map((rel) => this.context.index.getNode(rel.from))
        .find((candidate) => candidate?.type === "FILE");
      filePath = String(fileNode?.properties.path || fileNode?.properties.filePath || "");
    }

    if (!filePath) {
      filePath = node.id;
    }

    const startLine = Number(node.properties.startLine || node.properties.line || 1);
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
      return snippet.length > maxChars ? `${snippet.slice(0, maxChars - 3)}...` : snippet;
    } catch {
      return "";
    }
  }

  private async findActiveBlockers(
    selectedIds: string[],
    requestingAgentId: string,
    projectId: string,
  ): Promise<Record<string, unknown>[]> {
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

  private async findDecisionEpisodes(selectedIds: string[], projectId: string): Promise<Record<string, unknown>[]> {
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

  private async findLearnings(selectedIds: string[], projectId: string): Promise<Record<string, unknown>[]> {
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
  ): Promise<Record<string, unknown>[]> {
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

  private trimContextPackToBudget(pack: Record<string, any>, budget: number): void {
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

  private resolveSemanticSliceAnchor(input: { file?: string; symbol?: string; query?: string }): {
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
      const fileNode = this.context.index.getNodesByType("FILE").find((candidate) => {
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
        const targetName = normalizedSymbol.split(".").pop() || normalizedSymbol;
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
      const fileNode = this.context.index.getNodesByType("FILE").find((candidate) => {
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

  private readExactLines(absolutePath: string, startLine: number, endLine: number): string {
    if (!fs.existsSync(absolutePath)) {
      return "";
    }
    const lines = fs.readFileSync(absolutePath, "utf-8").split("\n");
    return lines.slice(Math.max(0, startLine - 1), Math.max(startLine, endLine)).join("\n");
  }

  // Setup tools are implemented in core-tools.ts and bound via toolRegistry.
}

export default ToolHandlers;
