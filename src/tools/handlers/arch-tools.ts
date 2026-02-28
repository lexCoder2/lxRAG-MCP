/**
 * Architecture Validation Tools
 * Registry-backed architecture tool definitions.
 *
 * Tools:
 * - arch_validate: validate code against architecture rules
 * - arch_suggest: suggest appropriate layer for code
 */

import * as z from "zod";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";

export const archToolDefinitions: ToolDefinition[] = [
  {
    name: "arch_validate",
    category: "arch",
    description: "Validate code against layer rules",
    inputShape: {
      files: z.array(z.string()).optional().describe("Files to validate"),
      strict: z.boolean().default(false).describe("Strict validation mode"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { files, strict = false, profile = "compact" } = args;

      const archEngine = ctx.engines.arch as
        | {
            validate: (files?: string[]) => Promise<any>;
          }
        | undefined;

      if (!archEngine) {
        return ctx.errorEnvelope(
          "ARCH_ENGINE_UNAVAILABLE",
          "Architecture engine not initialized",
          true,
        );
      }

      try {
        const result = await archEngine.validate(files);

        const output = {
          success: result.success,
          violations: result.violations.slice(0, 20),
          statistics: result.statistics,
          severity: strict ? "error" : "warning",
        };

        return ctx.formatSuccess(output, profile);
      } catch (error) {
        return ctx.errorEnvelope("ARCH_VALIDATE_FAILED", String(error), true);
      }
    },
  },
  {
    name: "arch_suggest",
    category: "arch",
    description: "Suggest best location for new code",
    inputShape: {
      name: z.string().describe("Code name/identifier"),
      type: z
        .enum(["component", "hook", "service", "context", "utility", "engine", "class", "module"])
        .describe("Code type"),
      dependencies: z.array(z.string()).optional().describe("Required dependencies"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { name, type, dependencies = [], profile = "compact" } = args;

      const archEngine = ctx.engines.arch as
        | {
            getSuggestion: (
              name: string,
              type: string,
              dependencies: string[],
            ) =>
              | {
                  suggestedLayer: string;
                  suggestedPath: string;
                  reasoning: string;
                }
              | undefined;
          }
        | undefined;

      if (!archEngine) {
        return ctx.errorEnvelope(
          "ARCH_ENGINE_UNAVAILABLE",
          "Architecture engine not initialized",
          true,
        );
      }

      try {
        const suggestion = archEngine.getSuggestion(name, type, dependencies);

        if (!suggestion) {
          return ctx.formatSuccess(
            {
              success: false,
              message: "No suitable layer found for this code",
              reason: `No layer can import from all dependencies: ${dependencies.join(", ")}`,
            },
            profile,
          );
        }

        return ctx.formatSuccess(
          {
            success: true,
            suggestedLayer: suggestion.suggestedLayer,
            suggestedPath: suggestion.suggestedPath,
            reasoning: suggestion.reasoning,
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("ARCH_SUGGEST_FAILED", String(error), true);
      }
    },
  },
];
