import { describe, expect, it } from "vitest";
import GraphIndexManager from "../index.js";

describe("GraphIndexManager syncFrom", () => {
  it("preserves existing node properties when overwrite is false", () => {
    const index = new GraphIndexManager();

    index.addNode("fn:sum", "FUNCTION", {
      name: "sum",
      summary: "old",
      LOC: 10,
    });

    index.addNode(
      "fn:sum",
      "FUNCTION",
      {
        summary: "new",
        LOC: 20,
      },
      false,
    );

    const node = index.getNode("fn:sum");
    expect(node).toBeDefined();
    expect(node!.properties.summary).toBe("old");
    expect(node!.properties.LOC).toBe(10);
  });

  it("updates existing node properties when syncFrom is called", () => {
    const target = new GraphIndexManager();
    target.addNode("fn:sum", "FUNCTION", {
      name: "sum",
      summary: "old",
      LOC: 10,
    });

    const source = new GraphIndexManager();
    source.addNode("fn:sum", "FUNCTION", {
      name: "sum",
      summary: "new",
      LOC: 20,
    });

    const result = target.syncFrom(source);

    expect(result.nodesSynced).toBe(1);
    const node = target.getNode("fn:sum");
    expect(node).toBeDefined();
    expect(node!.properties.summary).toBe("new");
    expect(node!.properties.LOC).toBe(20);
    expect(target.getStatistics().totalNodes).toBe(1);
  });

  it("can move a node to a different type when overwrite is enabled", () => {
    const index = new GraphIndexManager();

    index.addNode("entity:alpha", "FUNCTION", { name: "alpha" });
    index.addNode("entity:alpha", "CLASS", { name: "AlphaClass" }, true);

    expect(index.getNodesByType("FUNCTION")).toHaveLength(0);
    expect(index.getNodesByType("CLASS")).toHaveLength(1);
    expect(index.getNode("entity:alpha")?.type).toBe("CLASS");
  });
});
