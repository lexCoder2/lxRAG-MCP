/**
 * @file tools/handlers/core-utility-tools
 * @description Utility-focused subset of the canonical core tool definitions.
 */

import type { ToolDefinition } from "../types.js";
import { coreToolDefinitionsAll } from "./core-tools-all.js";

const CORE_UTILITY_TOOL_NAMES = ["tools_list", "contract_validate"] as const;

/**
 * Utility tool definitions selected from `coreToolDefinitionsAll`.
 */
export const coreUtilityToolDefinitions: ToolDefinition[] =
  CORE_UTILITY_TOOL_NAMES.map((name) => {
    const definition = coreToolDefinitionsAll.find(
      (tool) => tool.name === name,
    );
    if (!definition) {
      throw new Error(`Missing core utility tool definition: ${name}`);
    }
    return definition;
  });
