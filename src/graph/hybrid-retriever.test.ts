import { describe, expect, it, vi } from "vitest";
import GraphIndexManager from "./index.js";
import { HybridRetriever } from "./hybrid-retriever.js";

function seedIndex(): GraphIndexManager {
  const index = new GraphIndexManager();
  index.addNode("fn:1", "FUNCTION", {
    name: "computeResult",
    path: "src/core/compute.ts",
    projectId: "proj-a",
    summary: "Compute result",
  });
  index.addNode("class:1", "CLASS", {
    name: "ResultBuilder",
    path: "src/core/result-builder.ts",
    projectId: "proj-a",
    summary: "Builds result",
  });
  index.addNode("fn:2", "FUNCTION", {
    name: "otherProject",
    path: "src/other.ts",
    projectId: "proj-b",
    summary: "Other project",
  });
  return index;
}

describe("HybridRetriever", () => {
  it("uses native bm25 when memgraph text search returns rows", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        .mockResolvedValue({ data: [{ nodeId: "fn:1", score: 5.2 }] }),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);

    const result = await retriever.retrieve({
      query: "compute",
      projectId: "proj-a",
      mode: "bm25",
      limit: 5,
    });

    expect(retriever.bm25Mode).toBe("native");
    expect(result).toHaveLength(1);
    expect(result[0].nodeId).toBe("fn:1");
    expect(result[0].scores.bm25).toBe(5.2);
  });

  it("falls back to lexical search when memgraph bm25 fails", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockRejectedValue(new Error("memgraph down")),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);

    const result = await retriever.retrieve({
      query: "result",
      projectId: "proj-a",
      mode: "bm25",
      limit: 5,
    });

    expect(retriever.bm25Mode).toBe("lexical_fallback");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((row) => row.nodeId !== "fn:2")).toBe(true);
  });
});
