import { describe, expect, it, vi } from "vitest";
import GraphIndexManager from "../graph/index.js";
import { ToolHandlers } from "./tool-handlers.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHandlers() {
  const index = new GraphIndexManager();
  const handlers = new ToolHandlers({
    index,
    memgraph: {
      executeCypher: vi.fn().mockResolvedValue({ data: [], error: undefined }),
      executeBatch: vi.fn().mockResolvedValue([{ data: [], error: undefined }]),
      queryNaturalLanguage: vi.fn().mockResolvedValue({ data: [] }),
      isConnected: vi.fn().mockReturnValue(false),
    } as any,
    config: {},
  });
  return handlers;
}

function okDocsResult(overrides = {}) {
  return {
    indexed: 3,
    skipped: 0,
    errors: [],
    durationMs: 42,
    ...overrides,
  };
}

// ─── index_docs ───────────────────────────────────────────────────────────────

describe("ToolHandlers.index_docs", () => {
  it("calls docsEngine.indexWorkspace and returns ok:true", async () => {
    const handlers = makeHandlers();
    const indexWorkspace = vi.fn().mockResolvedValue(okDocsResult());
    (handlers as any).docsEngine = { indexWorkspace };

    const raw = await handlers.index_docs({});
    const parsed = JSON.parse(raw);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.indexed).toBe(3);
    expect(parsed.data.skipped).toBe(0);
    expect(parsed.data.errorCount).toBe(0);
    expect(indexWorkspace).toHaveBeenCalled();
  });

  it("passes incremental and withEmbeddings flags from args", async () => {
    const handlers = makeHandlers();
    const indexWorkspace = vi.fn().mockResolvedValue(okDocsResult());
    (handlers as any).docsEngine = { indexWorkspace };

    await handlers.index_docs({ incremental: false, withEmbeddings: true });

    const opts = indexWorkspace.mock.calls[0][2];
    expect(opts.incremental).toBe(false);
    expect(opts.withEmbeddings).toBe(true);
  });

  it("defaults incremental=true and withEmbeddings=false", async () => {
    const handlers = makeHandlers();
    const indexWorkspace = vi.fn().mockResolvedValue(okDocsResult());
    (handlers as any).docsEngine = { indexWorkspace };

    await handlers.index_docs({});

    const opts = indexWorkspace.mock.calls[0][2];
    expect(opts.incremental).toBe(true);
    expect(opts.withEmbeddings).toBe(false);
  });

  it("returns error envelope when docsEngine not initialised", async () => {
    const handlers = makeHandlers();
    (handlers as any).docsEngine = undefined;

    const raw = await handlers.index_docs({});
    const parsed = JSON.parse(raw);
    // Error envelope has ok:false or contains error info
    expect(raw).toMatch(/ENGINE_UNAVAILABLE|error/i);
  });

  it("includes error list when engine reports errors", async () => {
    const handlers = makeHandlers();
    const indexWorkspace = vi
      .fn()
      .mockResolvedValue(
        okDocsResult({ errors: [{ file: "broken.md", error: "ENOENT" }] }),
      );
    (handlers as any).docsEngine = { indexWorkspace };

    const raw = await handlers.index_docs({});
    const parsed = JSON.parse(raw);
    expect(parsed.data.errorCount).toBe(1);
    expect(parsed.data.errors[0].file).toBe("broken.md");
  });
});

// ─── search_docs ──────────────────────────────────────────────────────────────

describe("ToolHandlers.search_docs", () => {
  const sampleSection = {
    sectionId: "proj:sec:README.md:0",
    heading: "Architecture",
    docRelativePath: "README.md",
    kind: "readme",
    content: "The graph is built on Memgraph.",
    score: 0.9,
    startLine: 3,
  };

  it("dispatches to searchDocs when query provided", async () => {
    const handlers = makeHandlers();
    const searchDocs = vi.fn().mockResolvedValue([sampleSection]);
    (handlers as any).docsEngine = { searchDocs, getDocsBySymbol: vi.fn() };

    const raw = await handlers.search_docs({ query: "graph architecture" });
    const parsed = JSON.parse(raw);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(1);
    expect(searchDocs).toHaveBeenCalledWith(
      "graph architecture",
      expect.any(String),
      expect.objectContaining({ limit: 10 }),
    );
  });

  it("dispatches to getDocsBySymbol when symbol provided", async () => {
    const handlers = makeHandlers();
    const getDocsBySymbol = vi.fn().mockResolvedValue([sampleSection]);
    (handlers as any).docsEngine = {
      searchDocs: vi.fn(),
      getDocsBySymbol,
    };

    const raw = await handlers.search_docs({ symbol: "MemgraphClient" });
    const parsed = JSON.parse(raw);

    expect(parsed.ok).toBe(true);
    expect(getDocsBySymbol).toHaveBeenCalledWith(
      "MemgraphClient",
      expect.any(String),
      expect.objectContaining({ limit: 10 }),
    );
    expect(parsed.data.count).toBe(1);
  });

  it("result items have the expected shape", async () => {
    const handlers = makeHandlers();
    const searchDocs = vi.fn().mockResolvedValue([sampleSection]);
    (handlers as any).docsEngine = { searchDocs, getDocsBySymbol: vi.fn() };

    const raw = await handlers.search_docs({ query: "architecture" });
    const parsed = JSON.parse(raw);
    const item = parsed.data.results[0];

    expect(item).toHaveProperty("heading");
    expect(item).toHaveProperty("doc");
    expect(item).toHaveProperty("kind");
    expect(item).toHaveProperty("startLine");
    expect(item).toHaveProperty("score");
    expect(item).toHaveProperty("excerpt");
    expect(item.excerpt.length).toBeLessThanOrEqual(200);
  });

  it("returns error envelope when neither query nor symbol provided", async () => {
    const handlers = makeHandlers();
    const searchDocs = vi.fn().mockResolvedValue([]);
    (handlers as any).docsEngine = { searchDocs, getDocsBySymbol: vi.fn() };

    const raw = await handlers.search_docs({});
    expect(raw).toMatch(/MISSING_PARAM|error/i);
  });

  it("passes limit to engine correctly", async () => {
    const handlers = makeHandlers();
    const searchDocs = vi.fn().mockResolvedValue([]);
    (handlers as any).docsEngine = { searchDocs, getDocsBySymbol: vi.fn() };

    await handlers.search_docs({ query: "test", limit: 5 });

    expect(searchDocs).toHaveBeenCalledWith(
      "test",
      expect.any(String),
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("returns error envelope when docsEngine not initialised", async () => {
    const handlers = makeHandlers();
    (handlers as any).docsEngine = undefined;

    const raw = await handlers.search_docs({ query: "something" });
    expect(raw).toMatch(/ENGINE_UNAVAILABLE|error/i);
  });
});
