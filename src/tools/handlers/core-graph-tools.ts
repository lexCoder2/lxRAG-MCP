/**
 * @file tools/handlers/core-graph-tools
 * @description Graph-focused subset of the canonical core tool definitions.
 */

import type { ToolDefinition } from "../types.js";
import { coreToolDefinitionsAll } from "./core-tools-all.js";

const CORE_GRAPH_TOOL_NAMES = [
  "graph_query",
  "graph_rebuild",
  "graph_set_workspace",
  "graph_health",
  "diff_since",
] as const;

/**
 * Graph tool definitions selected from `coreToolDefinitionsAll`.
 */
export const coreGraphToolDefinitions: ToolDefinition[] =
  CORE_GRAPH_TOOL_NAMES.map((name) => {
    const definition = coreToolDefinitionsAll.find(
      (tool) => tool.name === name,
    );
    if (!definition) {
      throw new Error(`Missing core graph tool definition: ${name}`);
    }
    return definition;
  });
