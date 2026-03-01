import { describe, expect, it, vi } from "vitest";
import GraphIndexManager from "../../graph/index.js";
import EmbeddingEngine from "../embedding-engine.js";

function buildIndex(): GraphIndexManager {
  const index = new GraphIndexManager();
  index.addNode("proj-a:function:sum", "FUNCTION", {
    name: "sum",
    description: "compute sum",
    kind: "function",
    parameters: ["a", "b"],
    path: "src/math/sum.ts",
  });
  index.addNode("proj-a:class:Calc", "CLASS", {
    name: "Calculator",
    description: "math helper",
    extends: "Base",
    path: "src/math/calculator.ts",
  });
  index.addNode("proj-a:file:math", "FILE", {
    path: "src/math/index.ts",
    exports: ["sum"],
  });
  return index;
}

describe("EmbeddingEngine", () => {
  it("generates embeddings for functions, classes, and files", async () => {
    const qdrant = {
      isConnected: vi.fn().mockReturnValue(false),
      createCollection: vi.fn(),
      upsertPoints: vi.fn(),
      search: vi.fn(),
    } as any;

    const engine = new EmbeddingEngine(buildIndex(), qdrant);
    const counts = await engine.generateAllEmbeddings();
    const embeddings = engine.getAllEmbeddings();

    expect(counts).toEqual({ functions: 1, classes: 1, files: 1 });
    expect(embeddings).toHaveLength(3);
    expect(embeddings.every((e) => e.vector.length === 128)).toBe(true);
    expect(embeddings.some((e) => e.projectId === "proj-a")).toBe(true);
  });

  it("uses local cosine ranking fallback when qdrant is disconnected", async () => {
    const qdrant = {
      isConnected: vi.fn().mockReturnValue(false),
      createCollection: vi.fn(),
      upsertPoints: vi.fn(),
      search: vi.fn(),
    } as any;

    const engine = new EmbeddingEngine(buildIndex(), qdrant);
    await engine.generateAllEmbeddings();

    const results = await engine.findSimilar("sum function", "function", 3, "proj-a");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toContain("sum");
  });

  it("filters qdrant-connected results by projectId and missing IDs", async () => {
    const qdrant = {
      isConnected: vi.fn().mockReturnValue(true),
      createCollection: vi.fn(),
      upsertPoints: vi.fn(),
      search: vi.fn().mockResolvedValue([
        { id: "proj-a:function:sum", score: 0.9, payload: {} },
        { id: "missing:id", score: 0.8, payload: {} },
      ]),
    } as any;

    const engine = new EmbeddingEngine(buildIndex(), qdrant);
    await engine.generateAllEmbeddings();

    const results = await engine.findSimilar("sum", "function", 5, "proj-a");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("proj-a:function:sum");
  });

  it("stores embeddings in qdrant only when connected", async () => {
    const qdrantDisconnected = {
      isConnected: vi.fn().mockReturnValue(false),
      createCollection: vi.fn(),
      upsertPoints: vi.fn(),
      search: vi.fn(),
    } as any;
    const engineA = new EmbeddingEngine(buildIndex(), qdrantDisconnected);
    await engineA.generateAllEmbeddings();
    await engineA.storeInQdrant("test-project");
    expect(qdrantDisconnected.createCollection).not.toHaveBeenCalled();

    const qdrantConnected = {
      isConnected: vi.fn().mockReturnValue(true),
      createCollection: vi.fn().mockResolvedValue(undefined),
      upsertPoints: vi.fn().mockResolvedValue(undefined),
      deleteByFilter: vi.fn().mockResolvedValue(undefined),
      search: vi.fn(),
    } as any;
    const engineB = new EmbeddingEngine(buildIndex(), qdrantConnected);
    await engineB.generateAllEmbeddings();
    await engineB.storeInQdrant("test-project");

    expect(qdrantConnected.createCollection).toHaveBeenCalledTimes(3);
    expect(qdrantConnected.upsertPoints).toHaveBeenCalledTimes(3);
  });
});
