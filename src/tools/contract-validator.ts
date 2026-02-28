/**
 * @file tools/contract-validator
 * @description Zod-based schema validation for tool arguments.
 *
 * Provides a standalone `validateToolArgs` function that validates a raw
 * argument object against a tool's declared `inputShape`.  This module
 * statically imports `registry.ts` — that is safe because the import graph
 * only goes in one direction:
 *
 *   tool-handler-base → contract-validator → registry → handlers → types
 *
 * The handler files do NOT import
 * `tool-handler-base` or `contract-validator`, so there is no cycle.
 */

import * as z from "zod";
import { toolRegistryMap } from "./registry.js";

// ─── Public contract ────────────────────────────────────────────────────────

/**
 * The result of validating tool arguments against the declared schema.
 */
export interface ContractValidation {
  /** True when all required fields are present and have correct types. */
  valid: boolean;

  /**
   * Zod validation errors describing incorrect or missing fields.
   * Empty when `valid` is true.
   */
  errors: string[];

  /**
   * Fields present in the raw args that are not part of the tool's schema.
   * These can indicate typos in parameter names (e.g. `codeType` instead
   * of `type`) and are surfaced as warnings even when `valid` is true.
   */
  extraFields: string[];

  /**
   * Required schema fields that were absent from the raw args.
   * Derived from Zod issues with `received: "undefined"`.
   */
  missingRequired: string[];

  /**
   * Human-readable advisory messages (e.g. unknown field hints).
   * Does NOT indicate a validation failure on its own.
   */
  warnings: string[];
}

// ─── Implementation ─────────────────────────────────────────────────────────

/**
 * Validate `args` against the Zod `inputShape` registered for `toolName`.
 *
 * @param toolName - Canonical tool name as registered (e.g. `"semantic_diff"`).
 * @param args     - Raw unvalidated arguments object (may be `null` / `undefined`).
 * @returns        A {@link ContractValidation} describing the result.
 */
export function validateToolArgs(toolName: string, args: unknown): ContractValidation {
  const def = toolRegistryMap.get(toolName);

  if (!def) {
    return {
      valid: false,
      errors: [`Unknown tool: '${toolName}'. Use tools_list to see valid names.`],
      extraFields: [],
      missingRequired: [],
      warnings: [],
    };
  }

  const inputKeys =
    args !== null && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];

  const knownKeys = new Set(Object.keys(def.inputShape));
  const extraFields = inputKeys.filter((k) => !knownKeys.has(k));
  const warnings = extraFields.map(
    (k) =>
      `Unknown field '${k}' is not part of '${toolName}' schema — possible typo? Known fields: ${[...knownKeys].join(", ")}`,
  );

  // Build a strict Zod object schema to validate required/optional fields.
  // We intentionally do NOT use .strict() here so that pass-through of extra
  // fields does not cause a Zod error — we report them separately as warnings.
  const schema = z.object(def.inputShape as z.ZodRawShape);
  const result = schema.safeParse(args ?? {});

  if (result.success) {
    return {
      valid: true,
      errors: [],
      extraFields,
      missingRequired: [],
      warnings,
    };
  }

  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });

  // A field is "missing required" when the error references a top-level key
  // that was not supplied in the input at all.  This handles both string/number
  // (`invalid_type`) and enum (`invalid_value`) Zod v4 error codes.
  const argsObj: Record<string, unknown> =
    args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};

  const missingRequired = result.error.issues
    .filter((issue) => {
      if (issue.path.length === 0) return false;
      const topKey = String(issue.path[0]);
      return !(topKey in argsObj);
    })
    .map((issue) => String(issue.path[0]))
    .filter((key, idx, arr) => arr.indexOf(key) === idx); // deduplicate

  return {
    valid: false,
    errors,
    extraFields,
    missingRequired,
    warnings,
  };
}
