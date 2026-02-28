/**
 * @file tools/handlers/task-tools
 * @description Task and progress-related MCP tool definitions.
 * @remarks These tools delegate to `ProgressEngine`, with optional coordination hooks.
 */

import * as z from "zod";
import * as env from "../../env.js";
import type { HandlerBridge, ToolDefinition, ToolArgs } from "../types.js";
import { logger } from "../../utils/logger.js";

/**
 * Registry definitions for task/progress tool endpoints.
 */
export const taskToolDefinitions: ToolDefinition[] = [
  {
    name: "progress_query",
    category: "task",
    description: "Query progress tracking data",
    inputShape: {
      query: z.string().describe("Progress query"),
      status: z
        .enum(["all", "active", "blocked", "completed"])
        .optional()
        .describe("Filter by status"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .optional()
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const profile = args?.profile || "compact";
      const status = args?.status || args?.filter?.status;
      const queryText = String(args?.query || args?.type || "task").toLowerCase();
      const type: "feature" | "task" = queryText.includes("feature") ? "feature" : "task";

      const normalizedStatus =
        status === "active" ? "in-progress" : status === "all" ? undefined : status;

      const filter = {
        ...(args?.filter || {}),
        ...(normalizedStatus ? { status: normalizedStatus } : {}),
      };

      const progressEngine = ctx.engines.progress as
        | {
            query: (type: "feature" | "task", filter?: Record<string, unknown>) => unknown;
          }
        | undefined;

      try {
        const result = progressEngine!.query(type, filter);
        return ctx.formatSuccess(result, profile);
      } catch (error) {
        return ctx.errorEnvelope("PROGRESS_QUERY_FAILED", String(error), true);
      }
    },
  },
  {
    name: "task_update",
    category: "task",
    description: "Update task status",
    inputShape: {
      taskId: z.string().describe("Task ID"),
      status: z.string().describe("New status"),
      notes: z.string().optional().describe("Optional notes"),
      assignee: z.string().optional().describe("Task assignee"),
      dueDate: z.string().optional().describe("Task due date"),
      agentId: z.string().optional().describe("Agent identifier"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { taskId, status, assignee, dueDate, notes, profile = "compact" } = args;

      const progressEngine = ctx.engines.progress as
        | {
            updateTask: (
              taskId: string,
              updates: { status?: string; assignee?: string; dueDate?: string },
            ) => unknown;
            persistTaskUpdate: (
              taskId: string,
              updates: { status?: string; assignee?: string; dueDate?: string },
            ) => Promise<boolean>;
          }
        | undefined;

      const coordinationEngine = ctx.engines.coordination as
        | {
            onTaskCompleted: (taskId: string, agentId: string, projectId: string) => Promise<void>;
          }
        | undefined;

      const episodeEngine = ctx.engines.episode as
        | {
            reflect: (args: {
              taskId: string;
              agentId: string;
              projectId: string;
              limit: number;
            }) => Promise<{ reflectionId?: string; learningsCreated?: number }>;
            add: (
              args: {
                type: string;
                content: string;
                taskId: string;
                outcome: "success" | "failure" | "partial";
                agentId: string;
                sessionId: string;
                metadata: Record<string, unknown>;
              },
              projectId: string,
            ) => Promise<string>;
          }
        | undefined;

      try {
        const updated = progressEngine!.updateTask(taskId, {
          status,
          assignee,
          dueDate,
        });

        if (!updated) {
          return ctx.errorEnvelope(
            "TASK_NOT_FOUND",
            `Task not found: ${taskId}`,
            false,
            "Use feature_status to list valid task IDs",
          );
        }

        if (status || assignee || dueDate) {
          const persistedSuccessfully = await progressEngine!.persistTaskUpdate(taskId, {
            status,
            assignee,
            dueDate,
          });
          if (!persistedSuccessfully) {
            logger.warn(`[task_update] Failed to persist task update to Memgraph for ${taskId}`);
          }
        }

        const postActions: Record<string, unknown> = {};
        if (String(status || "").toLowerCase() === "completed") {
          const sessionId = ctx.getCurrentSessionId() || "session-unknown";
          const runtimeAgentId = String(assignee || args?.agentId || env.LXDIG_AGENT_ID);
          const { projectId } = ctx.getActiveProjectContext();

          try {
            await coordinationEngine!.onTaskCompleted(String(taskId), runtimeAgentId, projectId);
            postActions.claimsReleased = true;
          } catch (error) {
            postActions.claimsReleased = false;
            postActions.claimReleaseError = String(error);
          }

          try {
            const reflection = await episodeEngine!.reflect({
              taskId: String(taskId),
              agentId: runtimeAgentId,
              projectId,
              limit: 20,
            });
            postActions.reflection = {
              reflectionId: reflection.reflectionId,
              learningsCreated: reflection.learningsCreated,
            };
          } catch (error) {
            postActions.reflectionError = String(error);
          }

          try {
            const decisionEpisodeId = await episodeEngine!.add(
              {
                type: "DECISION",
                content:
                  `Task ${taskId} marked completed. ${notes ? `Notes: ${String(notes)}` : ""}`.trim(),
                taskId: String(taskId),
                outcome: "success",
                agentId: runtimeAgentId,
                sessionId,
                metadata: {
                  source: "task_update",
                  status: String(status),
                  rationale: `Task ${taskId} transitioned to status '${status}' via task_update.${notes ? ` Notes: ${String(notes)}` : ""}`,
                },
              },
              projectId,
            );
            postActions.decisionEpisodeId = decisionEpisodeId;
          } catch (error) {
            postActions.decisionEpisodeError = String(error);
          }
        }

        return ctx.formatSuccess({ success: true, task: updated, notes, postActions }, profile);
      } catch (error) {
        return ctx.errorEnvelope("TASK_UPDATE_FAILED", String(error), true);
      }
    },
  },
  {
    name: "feature_status",
    category: "task",
    description: "Get feature implementation status",
    inputShape: {
      featureId: z.string().describe("Feature ID"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { featureId, profile = "compact" } = args;

      const progressEngine = ctx.engines.progress as
        | {
            query: (type: "feature" | "task") => {
              items: Array<{ id: string; name?: string; status?: string }>;
            };
            getFeatureStatus: (featureId: string) => unknown;
          }
        | undefined;

      try {
        const allFeatures = progressEngine!.query("feature").items;

        const requested = String(featureId || "").trim();
        if (!requested || requested === "*" || requested.toLowerCase() === "list") {
          return ctx.formatSuccess(
            {
              success: true,
              totalFeatures: allFeatures.length,
              features: allFeatures.slice(0, 100).map((feature) => ({
                id: feature.id,
                name: feature.name || "",
                status: feature.status || "unknown",
              })),
            },
            profile,
          );
        }

        let resolvedFeatureId = requested;
        let status = progressEngine!.getFeatureStatus(resolvedFeatureId);

        if (!status) {
          const lowered = requested.toLowerCase();
          const matched = allFeatures.find((feature) => {
            const name = String(feature.name || "").toLowerCase();
            return (
              feature.id === requested ||
              feature.id.endsWith(`:${requested}`) ||
              feature.id.toLowerCase().endsWith(`:${lowered}`) ||
              name === lowered
            );
          });

          if (matched) {
            resolvedFeatureId = matched.id;
            status = progressEngine!.getFeatureStatus(resolvedFeatureId);
          }
        }

        if (!status) {
          return ctx.formatSuccess(
            {
              success: false,
              error: `Feature not found: ${featureId}`,
              availableFeatureIds: allFeatures.map((feature) => feature.id).slice(0, 50),
              hint: "Use feature_status with featureId='list' to inspect available IDs",
            },
            profile,
          );
        }

        return ctx.formatSuccess(
          {
            ...(status as Record<string, unknown>),
            resolvedFeatureId,
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("FEATURE_STATUS_FAILED", String(error), true);
      }
    },
  },
  {
    name: "blocking_issues",
    category: "task",
    description: "Find blocking issues",
    inputShape: {
      type: z.enum(["all", "feature", "task"]).optional().describe("Scope of blockers"),
      context: z.string().optional().describe("Issue context"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const type = args?.type ?? "all";
      const profile = args?.profile || "compact";

      const progressEngine = ctx.engines.progress as
        | {
            getBlockingIssues: (type: string) => unknown[];
          }
        | undefined;

      try {
        const issues = progressEngine!.getBlockingIssues(type);

        return ctx.formatSuccess(
          {
            type,
            blockingIssues: issues.slice(0, 20),
            totalBlocked: issues.length,
            recommendation:
              issues.length > 0
                ? `Address ${issues.length} blocking issue(s)`
                : "No blocking issues",
          },
          profile,
        );
      } catch (error) {
        return ctx.errorEnvelope("BLOCKING_ISSUES_FAILED", String(error), true);
      }
    },
  },
];
