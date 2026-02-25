import { describe, expect, it } from "vitest";
import * as z from "zod";
import { toolRegistry, toolRegistryMap } from "../registry.js";

describe("tool registry", () => {
  it("has unique tool names", () => {
    const names = toolRegistry.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("maps every tool name", () => {
    for (const tool of toolRegistry) {
      expect(toolRegistryMap.has(tool.name)).toBe(true);
    }
  });

  it("has valid zod raw shapes", () => {
    for (const tool of toolRegistry) {
      expect(() => z.object(tool.inputShape)).not.toThrow();
    }
  });

  it("includes migrated handler modules", () => {
    expect(toolRegistryMap.has("arch_validate")).toBe(true);
    expect(toolRegistryMap.has("arch_suggest")).toBe(true);
    expect(toolRegistryMap.has("graph_query")).toBe(true);
    expect(toolRegistryMap.has("code_explain")).toBe(true);
    expect(toolRegistryMap.has("graph_rebuild")).toBe(true);
    expect(toolRegistryMap.has("graph_set_workspace")).toBe(true);
    expect(toolRegistryMap.has("graph_health")).toBe(true);
    expect(toolRegistryMap.has("tools_list")).toBe(true);
    expect(toolRegistryMap.has("diff_since")).toBe(true);
    expect(toolRegistryMap.has("contract_validate")).toBe(true);
    expect(toolRegistryMap.has("find_pattern")).toBe(true);
    expect(toolRegistryMap.has("semantic_search")).toBe(true);
    expect(toolRegistryMap.has("find_similar_code")).toBe(true);
    expect(toolRegistryMap.has("code_clusters")).toBe(true);
    expect(toolRegistryMap.has("semantic_diff")).toBe(true);
    expect(toolRegistryMap.has("suggest_tests")).toBe(true);
    expect(toolRegistryMap.has("context_pack")).toBe(true);
    expect(toolRegistryMap.has("semantic_slice")).toBe(true);
    expect(toolRegistryMap.has("init_project_setup")).toBe(true);
    expect(toolRegistryMap.has("setup_copilot_instructions")).toBe(true);
    expect(toolRegistryMap.has("index_docs")).toBe(true);
    expect(toolRegistryMap.has("search_docs")).toBe(true);
    expect(toolRegistryMap.has("ref_query")).toBe(true);
    expect(toolRegistryMap.has("test_select")).toBe(true);
    expect(toolRegistryMap.has("test_categorize")).toBe(true);
    expect(toolRegistryMap.has("impact_analyze")).toBe(true);
    expect(toolRegistryMap.has("test_run")).toBe(true);
    expect(toolRegistryMap.has("progress_query")).toBe(true);
    expect(toolRegistryMap.has("task_update")).toBe(true);
    expect(toolRegistryMap.has("feature_status")).toBe(true);
    expect(toolRegistryMap.has("blocking_issues")).toBe(true);
    expect(toolRegistryMap.has("episode_add")).toBe(true);
    expect(toolRegistryMap.has("episode_recall")).toBe(true);
    expect(toolRegistryMap.has("decision_query")).toBe(true);
    expect(toolRegistryMap.has("reflect")).toBe(true);
    expect(toolRegistryMap.has("agent_claim")).toBe(true);
    expect(toolRegistryMap.has("agent_release")).toBe(true);
    expect(toolRegistryMap.has("agent_status")).toBe(true);
    expect(toolRegistryMap.has("coordination_overview")).toBe(true);
  });
});
