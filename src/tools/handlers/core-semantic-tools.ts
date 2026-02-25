/**
 * @file tools/handlers/core-semantic-tools
 * @description Semantic/code-intelligence subset of the canonical core tool definitions.
 */

import type { ToolDefinition } from "../types.js";
import { coreToolDefinitionsAll } from "./core-tools-all.js";

const CORE_SEMANTIC_TOOL_NAMES = [
  "semantic_search",
  "find_similar_code",
  "code_clusters",
  "semantic_diff",
  "suggest_tests",
  "context_pack",
  "semantic_slice",
] as const;

/**
 * Semantic tool definitions selected from `coreToolDefinitionsAll`.
 */
export const coreSemanticToolDefinitions: ToolDefinition[] =
  CORE_SEMANTIC_TOOL_NAMES.map((name) => {
    const definition = coreToolDefinitionsAll.find(
      (tool) => tool.name === name,
    );
    if (!definition) {
      throw new Error(`Missing core semantic tool definition: ${name}`);
    }
    return definition;
  });
