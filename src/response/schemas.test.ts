import { describe, expect, it } from "vitest";
import {
  applyFieldPriority,
  TOOL_OUTPUT_SCHEMAS,
  type OutputField,
} from "./schemas.js";

function tokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

describe("response/schemas", () => {
  it("includes expected graph_query schema priorities", () => {
    const schema = TOOL_OUTPUT_SCHEMAS.graph_query;

    expect(schema.find((field) => field.key === "intent")?.priority).toBe(
      "required",
    );
    expect(schema.find((field) => field.key === "projectId")?.priority).toBe(
      "required",
    );
    expect(
      schema.find((field) => field.key === "workspaceRoot")?.priority,
    ).toBe("low");
  });

  it("returns unchanged data when already within budget", () => {
    const schema: OutputField[] = [
      { key: "required", priority: "required", description: "" },
      { key: "low", priority: "low", description: "" },
    ];
    const data = { required: "ok", low: "x" };

    const shaped = applyFieldPriority(data, schema, Number.POSITIVE_INFINITY);

    expect(shaped).toEqual(data);
  });

  it("drops low then medium fields to meet budget before high", () => {
    const schema: OutputField[] = [
      { key: "required", priority: "required", description: "" },
      { key: "high", priority: "high", description: "" },
      { key: "medium", priority: "medium", description: "" },
      { key: "low", priority: "low", description: "" },
    ];

    const data = {
      required: "r",
      high: "H".repeat(40),
      medium: "M".repeat(40),
      low: "L".repeat(40),
    };

    const budgetAfterDroppingLowAndMedium = tokens({
      required: data.required,
      high: data.high,
    });

    const shaped = applyFieldPriority(
      data,
      schema,
      budgetAfterDroppingLowAndMedium,
    );

    expect(shaped).toEqual({ required: data.required, high: data.high });
  });

  it("preserves required fields even when budget is too small", () => {
    const schema: OutputField[] = [
      { key: "required", priority: "required", description: "" },
      { key: "high", priority: "high", description: "" },
    ];

    const data = {
      required: "this must stay",
      high: "this can be removed",
    };

    const shaped = applyFieldPriority(data, schema, 0);

    expect(shaped).toEqual({ required: "this must stay" });
  });

  it("ignores schema keys not present in input data", () => {
    const schema: OutputField[] = [
      { key: "required", priority: "required", description: "" },
      { key: "missingLow", priority: "low", description: "" },
      { key: "presentHigh", priority: "high", description: "" },
    ];

    const data = {
      required: "r",
      presentHigh: "h".repeat(30),
    };

    const shaped = applyFieldPriority(data, schema, tokens({ required: "r" }));

    expect(shaped).toEqual({ required: "r" });
  });
});
