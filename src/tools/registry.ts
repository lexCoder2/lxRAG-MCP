/**
 * @file tools/registry
 * @description Central registry composition for all MCP tool definitions.
 * @remarks Registration order is explicit and should stay stable for predictability.
 */

import type { ToolDefinition } from "./types.js";
import { archToolDefinitions } from "./handlers/arch-tools.js";
import { docsToolDefinitions } from "./handlers/docs-tools.js";
import { refToolDefinitions } from "./handlers/ref-tools.js";
import { testToolDefinitions } from "./handlers/test-tools.js";
import { taskToolDefinitions } from "./handlers/task-tools.js";
import { memoryCoordinationToolDefinitions } from "./handlers/memory-coordination-tools.js";
import { coreGraphToolDefinitions } from "./handlers/core-graph-tools.js";
import { coreAnalysisToolDefinitions } from "./handlers/core-analysis-tools.js";
import { coreUtilityToolDefinitions } from "./handlers/core-utility-tools.js";
import { coreSemanticToolDefinitions } from "./handlers/core-semantic-tools.js";
import { coreSetupToolDefinitions } from "./handlers/core-setup-tools.js";

/**
 * Ordered list of all available tool definitions.
 */
export const toolRegistry: ToolDefinition[] = [
  ...coreGraphToolDefinitions,
  ...coreAnalysisToolDefinitions,
  ...coreUtilityToolDefinitions,
  ...coreSemanticToolDefinitions,
  ...coreSetupToolDefinitions,
  ...archToolDefinitions,
  ...docsToolDefinitions,
  ...refToolDefinitions,
  ...testToolDefinitions,
  ...taskToolDefinitions,
  ...memoryCoordinationToolDefinitions,
];

/**
 * Name-indexed lookup map for O(1) dispatch binding.
 */
export const toolRegistryMap = new Map<string, ToolDefinition>(
  toolRegistry.map((definition) => [definition.name, definition]),
);
