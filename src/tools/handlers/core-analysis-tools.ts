/**
 * @file tools/handlers/core-analysis-tools
 * @description Code-analysis tool definitions — code_explain, find_pattern.
 */

import * as z from "zod";
import type { GraphNode, GraphRelationship } from "../../graph/index.js";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";

export const coreAnalysisToolDefinitions: ToolDefinition[] = [
  {
    name: "code_explain",
    category: "code",
    description: "Explain code element with dependency context",
    inputShape: {
      element: z.string().describe("File path, class or function name"),
      depth: z.number().min(1).max(3).default(2).describe("Analysis depth"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { element, depth = 2, profile = "compact" } = args;

      try {
        const files = ctx.context.index.getNodesByType("FILE");
        const funcs = ctx.context.index.getNodesByType("FUNCTION");
        const classes = ctx.context.index.getNodesByType("CLASS");

        const targetNode =
          files.find((n: GraphNode) => n.properties.path?.includes(element)) ||
          funcs.find((n: GraphNode) => n.properties.name === element) ||
          classes.find((n: GraphNode) => n.properties.name === element);

        if (!targetNode) {
          return ctx.errorEnvelope(
            "ELEMENT_NOT_FOUND",
            `Element not found: ${element}`,
            true,
            "Provide a file path, class name, or function name present in the index.",
          );
        }

        const dependencies: Array<{ type: string; target: string }> = [];
        const dependents: Array<{ type: string; source: string }> = [];
        const explanation: Record<string, unknown> = {
          element: targetNode.properties.name || targetNode.properties.path,
          type: targetNode.type,
          properties: targetNode.properties,
          dependencies,
          dependents,
        };

        const outgoing = ctx.context.index.getRelationshipsFrom(targetNode.id);
        for (const rel of outgoing.slice(0, depth * 10)) {
          const target = ctx.context.index.getNode(rel.to);
          if (target) {
            dependencies.push({
              type: rel.type,
              target: target.properties.name || target.properties.path || target.id,
            });
          }
        }

        const incoming = ctx.context.index.getRelationshipsTo(targetNode.id);
        for (const rel of incoming.slice(0, depth * 10)) {
          const source = ctx.context.index.getNode(rel.from);
          if (source) {
            dependents.push({
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
    name: "find_pattern",
    category: "code",
    description:
      "Find architectural patterns or violations in code. Requires pattern (a search string describing what to find, e.g. 'circular dependencies', 'unused files', 'layer violation'). Optional type selects the detection mode: 'circular' = circular dependency detection, 'unused' = files with no relationships, 'violation' = architecture layer rule violations, 'pattern' = general semantic pattern search.",
    inputShape: {
      pattern: z.string().describe("Search string describing what to find (e.g. 'circular dependencies', 'unused files', 'layer violations')"),
      type: z
        .enum(["pattern", "violation", "unused", "circular"])
        .default("pattern")
        .describe("Detection mode: circular | unused | violation | pattern"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { pattern, type = "pattern", profile = "compact" } = args;

      const archEngine = ctx.engines.arch as
        | {
            validate: () => Promise<{ violations: unknown[] }>;
          }
        | undefined;

      try {
        let matches: unknown[] = [];
        const results: Record<string, unknown> = {
          pattern,
          type,
          matches,
        };

        if (type === "violation") {
          if (!archEngine) {
            return "Architecture engine not initialized";
          }
          const result = await archEngine.validate();
          matches = result.violations.slice(0, 10);
        } else if (type === "unused") {
          const files = ctx.context.index.getNodesByType("FILE");
          for (const file of files) {
            const rels = ctx.context.index.getRelationshipsFrom(file.id);
            if (rels.length === 0) {
              matches.push({
                path: file.properties.path,
                reason: "No incoming or outgoing relationships",
              });
            }
          }
        } else if (type === "circular") {
          const { projectId } = ctx.getActiveProjectContext();
          const allFiles = ctx.context.index.getNodesByType("FILE");
          let files = allFiles.filter((node: GraphNode) => {
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

          const fileIds = new Set(files.map((f: GraphNode) => f.id));
          const adjacency = new Map<string, Set<string>>();

          for (const file of files) {
            const targets = new Set<string>();
            const importRels = ctx.context.index
              .getRelationshipsFrom(file.id)
              .filter((rel: GraphRelationship) => rel.type === "IMPORTS");

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
                .filter((rel: GraphRelationship) => rel.type === "REFERENCES");
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

          matches = cycles.slice(0, 20).map((cycle) => ({
            cycle: cycle.map((id) => {
              const node = ctx.context.index.getNode(id);
              return String(node?.properties.path || id);
            }),
            length: Math.max(1, cycle.length - 1),
          }));

          if (!matches.length && !files.length && ctx.context.memgraph.isConnected()) {
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
              matches = cypherCycles.data.map((row: Record<string, unknown>) => ({
                cycle: [String(row.fileA), String(row.fileB), String(row.fileA)],
                length: 2,
                source: "cypher",
              }));
            }
          }

          if (!matches.length) {
            matches.push({
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
            matches = (searchResult.data || []).map((row: Record<string, unknown>) => ({
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
            matches = allNodes
              .filter((n: GraphNode) => {
                const name = String(n.properties.name || n.properties.path || n.id);
                return name.toLowerCase().includes(lp);
              })
              .slice(0, 20)
              .map((n: GraphNode) => ({
                type: n.type,
                name: String(n.properties.name || n.properties.path || n.id),
                location: String(n.properties.relativePath || n.properties.path || ""),
              }));
          }
        }

        results.matches = matches;
        return ctx.formatSuccess(results, profile);
      } catch (error) {
        return ctx.errorEnvelope("PATTERN_SEARCH_FAILED", String(error), true);
      }
    },
  },
];
