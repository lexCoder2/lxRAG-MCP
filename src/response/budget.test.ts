import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_BUDGETS,
  estimateTokens,
  fillSlot,
  makeBudget,
} from "./budget.js";

describe("response/budget", () => {
  it("makeBudget returns profile defaults", () => {
    const compact = makeBudget("compact");
    const balanced = makeBudget("balanced");
    const debug = makeBudget("debug");

    expect(compact.maxTokens).toBe(DEFAULT_TOKEN_BUDGETS.compact);
    expect(balanced.maxTokens).toBe(DEFAULT_TOKEN_BUDGETS.balanced);
    expect(debug.maxTokens).toBe(DEFAULT_TOKEN_BUDGETS.debug);
    expect(compact.allocation).toEqual({
      coreCode: 0.4,
      dependencies: 0.25,
      decisions: 0.2,
      plan: 0.1,
      episodeHistory: 0.05,
    });
  });

  it("makeBudget applies override maxTokens and allocation", () => {
    const allocation = {
      coreCode: 0.5,
      dependencies: 0.2,
      decisions: 0.15,
      plan: 0.1,
      episodeHistory: 0.05,
    };

    const custom = makeBudget("compact", {
      maxTokens: 999,
      allocation,
    });

    expect(custom.maxTokens).toBe(999);
    expect(custom.profile).toBe("compact");
    expect(custom.allocation).toEqual(allocation);
  });

  it("estimateTokens uses string length and rounds up", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("estimateTokens works for non-string values", () => {
    const value = { ok: true, count: 3, labels: ["a", "b"] };
    const expected = Math.ceil(JSON.stringify(value).length / 4);

    expect(estimateTokens(value)).toBe(expected);
  });

  it("fillSlot includes items while under budget and skips overflow", () => {
    const items = [
      { id: "a", cost: 2 },
      { id: "b", cost: 4 },
      { id: "c", cost: 3 },
      { id: "d", cost: 1 },
    ];

    const result = fillSlot(items, (item) => item.cost, 6);

    expect(result.selected.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.usedTokens).toBe(6);
  });

  it("fillSlot accepts exact-budget totals and handles zero budget", () => {
    const items = [1, 2, 3];

    const exact = fillSlot(items, (n) => n, 6);
    expect(exact.selected).toEqual([1, 2, 3]);
    expect(exact.usedTokens).toBe(6);

    const zeroBudget = fillSlot(items, (n) => n, 0);
    expect(zeroBudget.selected).toEqual([]);
    expect(zeroBudget.usedTokens).toBe(0);
  });
});
