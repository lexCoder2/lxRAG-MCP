/**
 * @file response/shaper
 * @description Shapes tool responses to fit profile budgets and output schemas.
 * @remarks This module is pure formatting logic and should not perform I/O.
 */

import { estimateTokens, makeBudget, type ResponseProfile } from "./budget.js";
import { TOOL_OUTPUT_SCHEMAS, applyFieldPriority } from "./schemas.js";

/**
 * Canonical response envelope returned by tool handlers.
 */
export interface ToolResponse {
  ok: boolean;
  profile: ResponseProfile;
  summary: string;
  data?: unknown;
  _tokenEstimate: number;
  hint?: string;
  errorCode?: string;
}

/**
 * Truncates long strings while preserving a visible truncation marker.
 *
 * @param input - Original string value.
 * @param maxLength - Maximum number of characters allowed.
 * @returns The original string when within bounds, otherwise a truncated string.
 */
function truncateString(input: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength)}…(truncated)`;
}

/**
 * Recursively shapes values to stay within profile-specific depth and size limits.
 *
 * @param value - Value to transform for output safety.
 * @param profile - Output verbosity profile.
 * @param depth - Current recursion depth.
 * @returns A shaped value safe for transport in tool responses.
 */
function shapeValue(
  value: unknown,
  profile: ResponseProfile,
  depth = 0,
): unknown {
  const maxDepth = profile === "debug" ? 20 : 6;
  const maxArray =
    profile === "balanced"
      ? 30
      : profile === "debug"
        ? Number.POSITIVE_INFINITY
        : 10;
  const maxKeys =
    profile === "balanced"
      ? 50
      : profile === "debug"
        ? Number.POSITIVE_INFINITY
        : 20;
  const maxStrLen =
    profile === "balanced"
      ? 4000
      : profile === "debug"
        ? Number.POSITIVE_INFINITY
        : 1200;

  if (depth > maxDepth) {
    return "[…depth limit]";
  }

  if (typeof value === "string") {
    return truncateString(value, maxStrLen);
  }

  if (Array.isArray(value)) {
    const limited = value.slice(0, maxArray);
    const mapped = limited.map((item) => shapeValue(item, profile, depth + 1));
    if (value.length > maxArray) {
      mapped.push(`…${value.length - maxArray} more items`);
    }
    return mapped;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      maxKeys,
    );
    const shaped = Object.fromEntries(
      entries.map(([key, item]) => [key, shapeValue(item, profile, depth + 1)]),
    );
    const totalKeys = Object.keys(value as Record<string, unknown>).length;
    if (totalKeys > maxKeys) {
      (shaped as Record<string, unknown>)["…omitted"] =
        `${totalKeys - maxKeys} more keys`;
    }
    return shaped;
  }

  return value;
}

/**
 * Builds a successful tool response and applies profile-aware shaping.
 *
 * @param summary - Human-readable success summary.
 * @param data - Raw payload to include in response.
 * @param profile - Desired response profile.
 * @param toolName - Optional tool name for schema-priority shaping.
 * @param hint - Optional user-facing follow-up hint.
 * @returns A standardized success response envelope.
 */
export function formatResponse(
  summary: string,
  data: unknown,
  profile: ResponseProfile = "compact",
  toolName?: string,
  hint?: string,
): ToolResponse {
  const budget = makeBudget(profile);
  let shaped = shapeValue(data, profile);

  if (
    profile !== "debug" &&
    toolName &&
    shaped !== null &&
    typeof shaped === "object" &&
    !Array.isArray(shaped)
  ) {
    const schema = TOOL_OUTPUT_SCHEMAS[toolName];
    if (schema?.length) {
      shaped = applyFieldPriority(
        shaped as Record<string, unknown>,
        schema,
        budget.maxTokens,
      );
    }
  }

  return {
    ok: true,
    profile,
    summary,
    data: shaped,
    _tokenEstimate: estimateTokens(shaped),
    ...(hint ? { hint } : {}),
  };
}

/**
 * Builds a standardized error response envelope.
 *
 * @param errorCode - Stable machine-readable error code.
 * @param reason - Human-readable failure reason.
 * @param hint - Suggested next action for recovery.
 * @param profile - Response profile to include in envelope.
 * @returns A standardized error response envelope.
 */
export function errorResponse(
  errorCode: string,
  reason: string,
  hint: string,
  profile: ResponseProfile = "compact",
): ToolResponse {
  return {
    ok: false,
    profile,
    summary: reason,
    _tokenEstimate: estimateTokens(reason),
    hint,
    errorCode,
  };
}
