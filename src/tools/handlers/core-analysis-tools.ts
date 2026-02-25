/**
 * @file tools/handlers/core-analysis-tools
 * @description Analysis-focused subset of the canonical core tool definitions.
 */

import type { ToolDefinition } from "../types.js";
import { coreToolDefinitionsAll } from "./core-tools-all.js";

const CORE_ANALYSIS_TOOL_NAMES = ["code_explain", "find_pattern"] as const;

/**
 * Analysis tool definitions selected from `coreToolDefinitionsAll`.
 */
export const coreAnalysisToolDefinitions: ToolDefinition[] =
  CORE_ANALYSIS_TOOL_NAMES.map((name) => {
    const definition = coreToolDefinitionsAll.find(
      (tool) => tool.name === name,
    );
    if (!definition) {
      throw new Error(`Missing core analysis tool definition: ${name}`);
    }
    return definition;
  });
