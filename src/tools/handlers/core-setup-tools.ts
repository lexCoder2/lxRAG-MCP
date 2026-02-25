/**
 * @file tools/handlers/core-setup-tools
 * @description Project setup/onboarding subset of the canonical core tool definitions.
 */

import type { ToolDefinition } from "../types.js";
import { coreToolDefinitionsAll } from "./core-tools-all.js";

const CORE_SETUP_TOOL_NAMES = [
  "init_project_setup",
  "setup_copilot_instructions",
] as const;

/**
 * Setup tool definitions selected from `coreToolDefinitionsAll`.
 */
export const coreSetupToolDefinitions: ToolDefinition[] =
  CORE_SETUP_TOOL_NAMES.map((name) => {
    const definition = coreToolDefinitionsAll.find(
      (tool) => tool.name === name,
    );
    if (!definition) {
      throw new Error(`Missing core setup tool definition: ${name}`);
    }
    return definition;
  });
