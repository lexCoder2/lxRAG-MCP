/**
 * @file tools/handlers/memory-coordination-tools
 * @description Memory episode and multi-agent coordination MCP tool definitions.
 * @remarks These handlers orchestrate `EpisodeEngine` and `CoordinationEngine` workflows.
 */

import * as z from "zod";
import * as env from "../../env.js";
import type { EpisodeType } from "../../engines/episode-engine.js";
import type { ClaimType } from "../../engines/coordination-engine.js";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";
import { logger } from "../../utils/logger.js";

/**
 * Registry definitions for memory and coordination tool endpoints.
 */
export const memoryCoordinationToolDefinitions: ToolDefinition[] = [
  {
    name: "episode_add",
    category: "memory",
    description: "Persist a structured episode in long-term agent memory",
    inputShape: {
      type: z
        .enum(["OBSERVATION", "DECISION", "EDIT", "TEST_RESULT", "ERROR", "REFLECTION", "LEARNING"])
        .describe("Episode type"),
      content: z.string().describe("Episode content"),
      entities: z.array(z.string()).optional().describe("Related graph entity IDs"),
      taskId: z.string().optional().describe("Related task ID"),
      outcome: z
        .enum(["success", "failure", "partial"])
        .optional()
        .describe("Outcome classification"),
      metadata: z.record(z.string(), z.any()).optional().describe("Extra metadata"),
      sensitive: z.boolean().optional().describe("Exclude from default recalls"),
      agentId: z.string().optional().describe("Agent identifier"),
      sessionId: z.string().optional().describe("Session identifier"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        type,
        content,
        entities = [],
        taskId,
        outcome,
        metadata,
        sensitive = false,
        profile = "compact",
        agentId,
        sessionId,
      } = args || {};

      logger.error(
        `[episode_add] ENTER rawType=${JSON.stringify(type)} content-length=${String(content ?? "").length} agentId=${agentId ?? "(none)"}`,
      );
      if (!type || !content) {
        logger.error(`[episode_add] REJECT missing type=${!type} missing content=${!content}`);
        return ctx.errorEnvelope(
          "EPISODE_ADD_INVALID_INPUT",
          "Fields 'type' and 'content' are required.",
          true,
          "Provide type (e.g. OBSERVATION) and content.",
        );
      }

      const normalizedType = String(type).toUpperCase();
      logger.error(`[episode_add] normalizedType=${normalizedType}`);
      const normalizedEntities = Array.isArray(entities)
        ? entities.map((item) => String(item))
        : [];
      const normalizedMetadata = metadata && typeof metadata === "object" ? metadata : undefined;
      const validationError = ctx.validateEpisodeInput({
        type: normalizedType,
        outcome,
        entities: normalizedEntities,
        metadata: normalizedMetadata,
      });
      if (validationError) {
        return ctx.errorEnvelope("EPISODE_ADD_INVALID_METADATA", validationError, true);
      }

      const episodeEngine = ctx.engines.episode as
        | {
            add: (
              args: {
                type: EpisodeType;
                content: string;
                entities?: string[];
                taskId?: string;
                outcome?: "success" | "failure" | "partial";
                metadata?: Record<string, unknown>;
                sensitive?: boolean;
                agentId: string;
                sessionId: string;
              },
              projectId: string,
            ) => Promise<string>;
          }
        | undefined;

      try {
        const contextSessionId = ctx.getCurrentSessionId() || "session-unknown";
        const runtimeAgentId = String(agentId || env.LXRAG_AGENT_ID);
        const { projectId } = ctx.getActiveProjectContext();

        const episodeId = await episodeEngine!.add(
          {
            type: normalizedType as EpisodeType,
            content: String(content),
            entities: normalizedEntities,
            taskId: taskId ? String(taskId) : undefined,
            outcome,
            metadata: normalizedMetadata,
            sensitive: Boolean(sensitive),
            agentId: runtimeAgentId,
            sessionId: String(sessionId || contextSessionId),
          },
          projectId,
        );

        return ctx.formatSuccess(
          {
            episodeId,
            type: String(type).toUpperCase(),
            projectId,
            taskId: taskId || null,
          },
          profile,
          `Episode ${episodeId} persisted.`,
        );
      } catch (error) {
        return ctx.errorEnvelope("EPISODE_ADD_FAILED", String(error), true);
      }
    },
  },
  {
    name: "episode_recall",
    category: "memory",
    description: "Recall episodes by semantic, temporal, and entity relevance",
    inputShape: {
      query: z.string().describe("Recall query"),
      agentId: z.string().optional().describe("Agent filter"),
      taskId: z.string().optional().describe("Task filter"),
      types: z.array(z.string()).optional().describe("Episode type filters"),
      entities: z.array(z.string()).optional().describe("Entity filters"),
      limit: z.number().default(5).describe("Result limit"),
      since: z.string().optional().describe("ISO timestamp or epoch ms"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        query,
        agentId,
        taskId,
        types,
        entities,
        limit = 5,
        since,
        profile = "compact",
      } = args || {};

      if (!query || typeof query !== "string") {
        return ctx.errorEnvelope(
          "EPISODE_RECALL_INVALID_INPUT",
          "Field 'query' is required.",
          true,
        );
      }

      const episodeEngine = ctx.engines.episode as
        | {
            recall: (args: {
              query: string;
              projectId: string;
              agentId?: string;
              taskId?: string;
              types?: EpisodeType[];
              entities?: string[];
              limit: number;
              since?: number;
            }) => Promise<unknown[]>;
          }
        | undefined;

      try {
        const sinceMs = ctx.toEpochMillis(since);
        const { projectId } = ctx.getActiveProjectContext();
        const explicitEntities = Array.isArray(entities)
          ? entities.map((item) => String(item))
          : [];
        const embeddingEntityHints = await ctx.inferEpisodeEntityHints(query, limit);
        const mergedEntities = [...new Set([...explicitEntities, ...embeddingEntityHints])];
        const episodes = await episodeEngine!.recall({
          query,
          projectId,
          agentId,
          taskId,
          types: Array.isArray(types)
            ? types.map((item) => String(item).toUpperCase() as EpisodeType)
            : undefined,
          entities: mergedEntities.length ? mergedEntities : undefined,
          limit,
          since: sinceMs || undefined,
        });

        return ctx.formatSuccess(
          {
            query,
            projectId,
            entityHints: profile === "debug" ? embeddingEntityHints : undefined,
            count: episodes.length,
            episodes,
          },
          profile,
          `Recalled ${episodes.length} episode(s).`,
        );
      } catch (error) {
        return ctx.errorEnvelope("EPISODE_RECALL_FAILED", String(error), true);
      }
    },
  },
  {
    name: "decision_query",
    category: "memory",
    description: "Query decision episodes for a target topic",
    inputShape: {
      query: z.string().describe("Decision query text"),
      affectedFiles: z.array(z.string()).optional().describe("Related files/entities"),
      taskId: z.string().optional().describe("Task filter"),
      agentId: z.string().optional().describe("Agent filter"),
      limit: z.number().default(5).describe("Result limit"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        query,
        affectedFiles = [],
        limit = 5,
        taskId,
        agentId,
        profile = "compact",
      } = args || {};

      if (!query || typeof query !== "string") {
        return ctx.errorEnvelope(
          "DECISION_QUERY_INVALID_INPUT",
          "Field 'query' is required.",
          true,
        );
      }

      const episodeEngine = ctx.engines.episode as
        | {
            decisionQuery: (args: {
              query: string;
              projectId: string;
              taskId?: string;
              agentId?: string;
              entities?: string[];
              limit: number;
            }) => Promise<unknown[]>;
          }
        | undefined;

      try {
        const { projectId } = ctx.getActiveProjectContext();
        const decisions = await episodeEngine!.decisionQuery({
          query,
          projectId,
          taskId,
          agentId,
          entities: Array.isArray(affectedFiles)
            ? affectedFiles.map((item) => String(item))
            : undefined,
          limit,
        });

        return ctx.formatSuccess(
          {
            query,
            projectId,
            count: decisions.length,
            decisions,
          },
          profile,
          `Found ${decisions.length} decision episode(s).`,
        );
      } catch (error) {
        return ctx.errorEnvelope("DECISION_QUERY_FAILED", String(error), true);
      }
    },
  },
  {
    name: "reflect",
    category: "memory",
    description: "Synthesize reflections and learning nodes from recent episodes",
    inputShape: {
      taskId: z.string().optional().describe("Task filter"),
      agentId: z.string().optional().describe("Agent filter"),
      limit: z.number().default(20).describe("Episodes to analyze"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { taskId, agentId, limit = 20, profile = "compact" } = args || {};

      const episodeEngine = ctx.engines.episode as
        | {
            reflect: (args: {
              taskId?: string;
              agentId?: string;
              limit: number;
              projectId: string;
            }) => Promise<{ learningsCreated: number }>;
          }
        | undefined;

      try {
        const { projectId } = ctx.getActiveProjectContext();
        const result = await episodeEngine!.reflect({
          taskId,
          agentId,
          limit,
          projectId,
        });

        return ctx.formatSuccess(
          result,
          profile,
          `Reflection completed with ${result.learningsCreated} learning(s).`,
        );
      } catch (error) {
        return ctx.errorEnvelope("REFLECT_FAILED", String(error), true);
      }
    },
  },
  {
    name: "agent_claim",
    category: "coordination",
    description: "Create a coordination claim for a task or code target with conflict detection",
    inputShape: {
      targetId: z.string().describe("Target task/code node id"),
      claimType: z
        .enum(["task", "file", "function", "feature"])
        .default("task")
        .describe("Claim target type"),
      intent: z.string().describe("Natural language intent"),
      taskId: z.string().optional().describe("Related task id"),
      agentId: z.string().optional().describe("Agent identifier"),
      sessionId: z.string().optional().describe("Session identifier"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        targetId,
        claimType = "task",
        intent,
        taskId,
        agentId,
        sessionId,
        profile = "compact",
      } = args || {};

      if (!targetId || !intent) {
        return ctx.errorEnvelope(
          "AGENT_CLAIM_INVALID_INPUT",
          "Fields 'targetId' and 'intent' are required.",
          true,
        );
      }

      const coordinationEngine = ctx.engines.coordination as
        | {
            claim: (args: {
              targetId: string;
              claimType: ClaimType;
              intent: string;
              taskId?: string;
              agentId: string;
              sessionId: string;
              projectId: string;
            }) => Promise<{ status: string; claimId?: string } & Record<string, unknown>>;
          }
        | undefined;

      try {
        const runtimeSessionId = ctx.getCurrentSessionId() || "session-unknown";
        const runtimeAgentId = String(agentId || env.LXRAG_AGENT_ID);
        const { projectId } = ctx.getActiveProjectContext();

        const result = await coordinationEngine!.claim({
          targetId: String(targetId),
          claimType: String(claimType).toLowerCase() as ClaimType,
          intent: String(intent),
          taskId: taskId ? String(taskId) : undefined,
          agentId: runtimeAgentId,
          sessionId: String(sessionId || runtimeSessionId),
          projectId,
        });

        return ctx.formatSuccess(
          {
            projectId,
            ...result,
          },
          profile,
          result.status === "CONFLICT"
            ? `Conflict detected for target ${targetId}.`
            : `Claim ${result.claimId} created for ${targetId}.`,
        );
      } catch (error) {
        return ctx.errorEnvelope("AGENT_CLAIM_FAILED", String(error), true);
      }
    },
  },
  {
    name: "agent_release",
    category: "coordination",
    description: "Release an active claim",
    inputShape: {
      claimId: z.string().describe("Claim id"),
      outcome: z.string().optional().describe("Optional outcome summary"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { claimId, outcome, profile = "compact" } = args || {};

      if (!claimId) {
        return ctx.errorEnvelope(
          "AGENT_RELEASE_INVALID_INPUT",
          "Field 'claimId' is required.",
          true,
        );
      }

      const coordinationEngine = ctx.engines.coordination as
        | {
            release: (
              claimId: string,
              outcome?: string,
            ) => Promise<{ found: boolean; alreadyClosed: boolean }>;
          }
        | undefined;

      try {
        const feedback = await coordinationEngine!.release(String(claimId), outcome);

        return ctx.formatSuccess(
          {
            claimId: String(claimId),
            released: feedback.found && !feedback.alreadyClosed,
            alreadyClosed: feedback.alreadyClosed,
            notFound: !feedback.found,
            outcome: outcome || null,
          },
          profile,
          feedback.found ? `Claim ${claimId} released.` : `Claim ${claimId} not found.`,
        );
      } catch (error) {
        return ctx.errorEnvelope("AGENT_RELEASE_FAILED", String(error), true);
      }
    },
  },
  {
    name: "agent_status",
    category: "coordination",
    description: "Get active claims and recent episodes for an agent",
    inputShape: {
      agentId: z.string().optional().describe("Agent identifier (omit to list all agents)"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { agentId, profile = "compact" } = args || {};

      const coordinationEngine = ctx.engines.coordination as
        | {
            overview: (projectId: string) => Promise<{
              activeClaims: unknown[];
              staleClaims: unknown[];
            }>;
            status: (
              agentId: string,
              projectId: string,
            ) => Promise<{ activeClaims: unknown[] } & Record<string, unknown>>;
          }
        | undefined;

      try {
        const { projectId } = ctx.getActiveProjectContext();

        if (!agentId || typeof agentId !== "string") {
          const overview = await coordinationEngine!.overview(projectId);
          return ctx.formatSuccess(
            {
              projectId,
              mode: "overview",
              ...overview,
            },
            profile,
            `Fleet: ${overview.activeClaims.length} active claim(s), ${overview.staleClaims.length} stale.`,
          );
        }

        const status = await coordinationEngine!.status(agentId, projectId);

        return ctx.formatSuccess(
          {
            projectId,
            ...status,
          },
          profile,
          `Agent ${agentId} has ${status.activeClaims.length} active claim(s).`,
        );
      } catch (error) {
        return ctx.errorEnvelope("AGENT_STATUS_FAILED", String(error), true);
      }
    },
  },
  {
    name: "coordination_overview",
    category: "coordination",
    description: "Fleet-wide claim view including active claims, stale claims, and conflicts",
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
      const { profile = "compact" } = args || {};

      const coordinationEngine = ctx.engines.coordination as
        | {
            overview: (projectId: string) => Promise<{
              activeClaims: unknown[];
              staleClaims: unknown[];
            }>;
          }
        | undefined;

      try {
        const { projectId } = ctx.getActiveProjectContext();
        const overview = await coordinationEngine!.overview(projectId);

        return ctx.formatSuccess(
          {
            projectId,
            ...overview,
          },
          profile,
          `Coordination overview: ${overview.activeClaims.length} active claim(s), ${overview.staleClaims.length} stale claim(s).`,
        );
      } catch (error) {
        return ctx.errorEnvelope("COORDINATION_OVERVIEW_FAILED", String(error), true);
      }
    },
  },
];
