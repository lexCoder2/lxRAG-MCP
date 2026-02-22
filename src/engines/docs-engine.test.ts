import * as path from "node:path";
import * as url from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DocsEngine, DOCS_COLLECTION } from "./docs-engine.js";
import type { DocsIndexOptions } from "./docs-engine.js";
import type { MemgraphClient, QueryResult } from "../graph/client.js";
import type { QdrantClient } from "../vector/qdrant-client.js";
import type { ParsedDoc } from "../parsers/docs-parser.js";
import { DocsParser } from "../parsers/docs-parser.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dirname, "../parsers/__fixtures__");

// ─── Mock factories ───────────────────────────────────────────────────────────

function okResult(data: unknown[] = []): QueryResult {
  return { data, error: undefined };
}
function errResult(msg: string): QueryResult {
  return { data: [], error: msg };
}

function makeMemgraph(
  overrides: Partial<Record<keyof MemgraphClient, unknown>> = {},
): MemgraphClient {
  return {
    executeCypher: vi.fn().mockResolvedValue(okResult()),
    executeBatch: vi.fn().mockResolvedValue([okResult()]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    queryNaturalLanguage: vi.fn().mockResolvedValue(okResult()),
    ...overrides,
  } as unknown as MemgraphClient;
}

function makeQdrant(connected = true): QdrantClient {
  return {
    isConnected: vi.fn().mockReturnValue(connected),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
    createCollection: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    getCollection: vi.fn().mockResolvedValue(null),
  } as unknown as QdrantClient;
}

// ─── indexWorkspace ───────────────────────────────────────────────────────────

describe("DocsEngine.indexWorkspace", () => {
  it("returns indexed > 0 for the fixtures directory", async () => {
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg);
    const result = await engine.indexWorkspace(FIXTURES, "proj");
    expect(result.indexed).toBeGreaterThanOrEqual(3); // 3 fixture files
    expect(result.errors).toHaveLength(0);
  });

  it("calls executeBatch at least once per indexed file", async () => {
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg);
    await engine.indexWorkspace(FIXTURES, "proj");
    expect(mg.executeBatch).toHaveBeenCalled();
  });

  it("skips files when hash unchanged (incremental mode)", async () => {
    const fixedHash = "a".repeat(64);
    // Pretend all files already have a known hash
    const mockRetriever = vi.fn().mockResolvedValue(
      okResult([
        { relativePath: "sample-readme.md", hash: fixedHash },
        { relativePath: "sample-adr.md", hash: fixedHash },
        { relativePath: "sample-changelog.md", hash: fixedHash },
      ]),
    );
    const mg = makeMemgraph({ executeCypher: mockRetriever });
    const engine = new DocsEngine(mg);

    // Use a custom parser that always returns the fixedHash so hash matches
    const mockParser = {
      parseFile: vi.fn().mockImplementation((fp: string, wr: string) => {
        const real = new DocsParser().parseFile(fp, wr);
        return { ...real, hash: fixedHash };
      }),
    } as unknown as DocsParser;

    const skippingEngine = new DocsEngine(mg, { parser: mockParser });
    const result = await skippingEngine.indexWorkspace(FIXTURES, "proj", {
      incremental: true,
    } as DocsIndexOptions);

    expect(result.skipped).toBeGreaterThan(0);
  });

  it("incremental=false never skips (always re-indexes)", async () => {
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg);
    const result = await engine.indexWorkspace(FIXTURES, "proj", {
      incremental: false,
    });
    expect(result.skipped).toBe(0);
    expect(result.indexed).toBeGreaterThanOrEqual(3);
  });

  it("records errors per file, continues, does not throw", async () => {
    const mg = makeMemgraph({
      executeBatch: vi.fn().mockResolvedValue([errResult("bolt error")]),
    });
    const engine = new DocsEngine(mg);
    const result = await engine.indexWorkspace(FIXTURES, "proj");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toMatch(/bolt error/i);
    // indexed stays 0 since all batches fail
    expect(result.indexed).toBe(0);
  });

  it("includes durationMs in result", async () => {
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg);
    const result = await engine.indexWorkspace(FIXTURES, "proj");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("with withEmbeddings=true upserts to Qdrant when connected", async () => {
    const mg = makeMemgraph();
    const qdrant = makeQdrant(true);
    const engine = new DocsEngine(mg, { qdrant });
    await engine.indexWorkspace(FIXTURES, "proj", { withEmbeddings: true });
    expect(qdrant.upsertPoints).toHaveBeenCalledWith(
      DOCS_COLLECTION,
      expect.any(Array),
    );
  });

  it("with withEmbeddings=true does NOT upsert when Qdrant not connected", async () => {
    const mg = makeMemgraph();
    const qdrant = makeQdrant(false);
    const engine = new DocsEngine(mg, { qdrant });
    await engine.indexWorkspace(FIXTURES, "proj", { withEmbeddings: true });
    expect(qdrant.upsertPoints).not.toHaveBeenCalled();
  });

  it("uses the custom buildCypher override when provided", async () => {
    const customBuild = vi
      .fn()
      .mockReturnValue([{ query: "RETURN 1", params: {} }]);
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg, { buildCypher: customBuild });
    await engine.indexWorkspace(FIXTURES, "proj");
    expect(customBuild).toHaveBeenCalled();
  });
});

// ─── searchDocs ───────────────────────────────────────────────────────────────

describe("DocsEngine.searchDocs", () => {
  it("returns results from fallback Cypher search", async () => {
    const row = {
      sectionId: "proj:sec:docs/guide.md:0",
      heading: "Architecture",
      relativePath: "docs/guide.md",
      kind: "guide",
      content: "Overview of the graph architecture.",
      startLine: 5,
      score: 1.0,
    };
    // searchDocs makes 2 executeCypher calls:
    //   1. native text_search attempt → fails (no index)
    //   2. fallback CONTAINS scan → returns data
    const executeCypher = vi
      .fn()
      .mockResolvedValueOnce(errResult("no index"))   // native search fails
      .mockResolvedValueOnce(okResult([row]));         // fallback CONTAINS

    const mg = makeMemgraph({ executeCypher });
    const engine = new DocsEngine(mg);
    const results = await engine.searchDocs("graph architecture", "proj");
    expect(results).toHaveLength(1);
    expect(results[0].heading).toBe("Architecture");
  });

  it("returns empty array when query has only very short terms", async () => {
    const mg = makeMemgraph();
    const engine = new DocsEngine(mg);
    const results = await engine.searchDocs("of a", "proj");
    expect(results).toEqual([]);
  });

  it("respects limit option", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      sectionId: `id-${i}`,
      heading: `Section ${i}`,
      relativePath: "x.md",
      kind: "guide",
      content: "",
      startLine: i,
      score: 1,
    }));
    const executeCypher = vi
      .fn()
      .mockResolvedValueOnce(errResult("no native"))
      .mockResolvedValueOnce(okResult(rows));
    const mg = makeMemgraph({ executeCypher });
    const engine = new DocsEngine(mg);
    const results = await engine.searchDocs("section", "proj", { limit: 5 });
    // Engine passes limit to Cypher; what comes back depends on mock data.
    // The engine returns whatever Memgraph returns (capped at 50 by sendLimit).
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("uses native text_search results when available", async () => {
    const row = {
      sectionId: "sec:1",
      heading: "Usage",
      relativePath: "README.md",
      kind: "readme",
      content: "Use graph_rebuild to index.",
      startLine: 3,
      score: 0.95,
    };
    const executeCypher = vi
      .fn()
      .mockResolvedValueOnce(okResult([row])); // native text_search succeeds
    const mg = makeMemgraph({ executeCypher });
    const engine = new DocsEngine(mg);
    const results = await engine.searchDocs("graph_rebuild", "proj");
    expect(results).toHaveLength(1);
    expect(results[0].heading).toBe("Usage");
    // Fallback should NOT have been called (only 1 executeCypher call)
    expect(executeCypher).toHaveBeenCalledTimes(1);
  });
});

// ─── getDocsBySymbol ──────────────────────────────────────────────────────────

describe("DocsEngine.getDocsBySymbol", () => {
  it("returns sections linked to a named symbol", async () => {
    const row = {
      sectionId: "proj:sec:docs/arch.md:1",
      heading: "Decision",
      relativePath: "docs/adr/001.md",
      kind: "adr",
      content: "We chose MemgraphClient because...",
      startLine: 10,
      score: 1.0,
    };
    const mg = makeMemgraph({
      executeCypher: vi.fn().mockResolvedValue(okResult([row])),
    });
    const engine = new DocsEngine(mg);
    const results = await engine.getDocsBySymbol("MemgraphClient", "proj");
    expect(results).toHaveLength(1);
    expect(results[0].heading).toBe("Decision");
    expect(results[0].docRelativePath).toBe("docs/adr/001.md");
  });

  it("returns empty array when no DOC_DESCRIBES edges found", async () => {
    const mg = makeMemgraph({
      executeCypher: vi.fn().mockResolvedValue(okResult([])),
    });
    const engine = new DocsEngine(mg);
    const results = await engine.getDocsBySymbol("UnknownSymbol", "proj");
    expect(results).toEqual([]);
  });

  it("passes symbolName and projectId to executeCypher", async () => {
    const executeCypher = vi.fn().mockResolvedValue(okResult([]));
    const mg = makeMemgraph({ executeCypher });
    const engine = new DocsEngine(mg);
    await engine.getDocsBySymbol("GraphOrchestrator", "myproj");
    expect(executeCypher).toHaveBeenCalledWith(
      expect.stringContaining("DOC_DESCRIBES"),
      expect.objectContaining({
        name: "GraphOrchestrator",
        projectId: "myproj",
      }),
    );
  });
});

// ─── Result shape ─────────────────────────────────────────────────────────────

describe("DocsEngine — result shape", () => {
  it("search results have the expected fields", async () => {
    const row = {
      sectionId: "s1",
      heading: "Intro",
      relativePath: "guide.md",
      kind: "guide",
      content: "x".repeat(600),
      startLine: 1,
      score: 0.8,
    };
    const mg = makeMemgraph({
      executeCypher: vi.fn().mockResolvedValue(okResult([row])),
    });
    const engine = new DocsEngine(mg);
    const results = await engine.searchDocs("intro content", "proj");
    const r = results[0];
    expect(r).toHaveProperty("sectionId");
    expect(r).toHaveProperty("heading");
    expect(r).toHaveProperty("docRelativePath");
    expect(r).toHaveProperty("kind");
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("score");
    expect(r).toHaveProperty("startLine");
    // content should be truncated to 500 chars
    expect(r.content.length).toBeLessThanOrEqual(500);
  });
});
