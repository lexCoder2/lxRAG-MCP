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

  // ── F2 regressions ───────────────────────────────────────────────────────────

  it("F2: bm25IndexKnownToExist is false before ensureBM25Index() is called", () => {
    const retriever = new HybridRetriever(seedIndex());
    expect(retriever.bm25IndexKnownToExist).toBe(false);
  });

  it("F2: ensureBM25Index() sets bm25IndexKnownToExist=true when index already exists", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockResolvedValue({
        data: [{ name: "symbol_index" }, { name: "docs_index" }],
      }),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);

    const result = await retriever.ensureBM25Index();
    expect(result.alreadyExists).toBe(true);
    expect(retriever.bm25IndexKnownToExist).toBe(true);
  });

  it("F2: ensureBM25Index() sets bm25IndexKnownToExist=true when index is freshly created", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        // list_indices returns nothing (no existing indices)
        .mockResolvedValueOnce({ data: [] })
        // create_index calls succeed
        .mockResolvedValue({ data: [] }),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);

    const result = await retriever.ensureBM25Index();
    expect(result.created).toBe(true);
    expect(retriever.bm25IndexKnownToExist).toBe(true);
  });

  it("F2: bm25IndexKnownToExist stays false when ensureBM25Index() errors", async () => {
    const memgraph = {
      executeCypher: vi.fn().mockRejectedValue(new Error("text_search module not loaded")),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);

    const result = await retriever.ensureBM25Index();
    expect(result.error).toBeDefined();
    expect(retriever.bm25IndexKnownToExist).toBe(false);
  });

  it("F2: bm25Mode stays lexical_fallback even after ensureBM25Index() succeeds (index ≠ query success)", async () => {
    const memgraph = {
      executeCypher: vi
        .fn()
        .mockResolvedValue({ data: [{ name: "symbol_index" }, { name: "docs_index" }] }),
    } as any;
    const retriever = new HybridRetriever(seedIndex(), undefined, memgraph);
    await retriever.ensureBM25Index();

    // bm25IndexKnownToExist should be true (index confirmed present)
    expect(retriever.bm25IndexKnownToExist).toBe(true);
    // bm25Mode is still lexical_fallback — it only flips to "native" on successful query
    expect(retriever.bm25Mode).toBe("lexical_fallback");
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
