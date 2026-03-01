/**
 * @file tools/handlers/core-utility-tools
 * @description Utility tool definitions — tools_list, contract_validate.
 */

import * as z from "zod";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";

export const coreUtilityToolDefinitions: ToolDefinition[] = [
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
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const profile = args?.profile ?? "compact";

      const KNOWN_CATEGORIES: Record<string, string[]> = {
        setup: ["init_project_setup", "setup_copilot_instructions"],
        graph: [
          "graph_set_workspace",
          "graph_rebuild",
          "graph_query",
          "graph_health",
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
          "diff_since",
        ],
        utility: ["tools_list", "contract_validate"],
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
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
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
];
