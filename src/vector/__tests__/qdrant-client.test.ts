import { afterEach, describe, expect, it, vi } from "vitest";
import QdrantClient from "../qdrant-client.js";

describe("QdrantClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects successfully when root endpoint is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const client = new QdrantClient("localhost", 6333);
    await client.connect();

    expect(client.isConnected()).toBe(true);
  });

  it("stays disconnected when connect throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));

    const client = new QdrantClient("localhost", 6333);
    await client.connect();

    expect(client.isConnected()).toBe(false);
  });

  it("returns empty search results when disconnected", async () => {
    const client = new QdrantClient("localhost", 6333);
    const result = await client.search("functions", [0.1, 0.2], 3);
    expect(result).toEqual([]);
  });

  it("creates/upserts/searches/deletes/gets collection when connected", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          result: [{ id: "p1", score: 0.75, payload: { n: 1 } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          result: {
            config: { params: { vectors: { size: 128 } } },
            points_count: 5,
          },
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const client = new QdrantClient("localhost", 6333);
    await client.connect();
    await client.createCollection("functions", 128);
    await client.upsertPoints("functions", [{ id: "p1", vector: [0.1, 0.2], payload: { n: 1 } }]);
    const search = await client.search("functions", [0.1, 0.2], 3);
    await client.deleteCollection("functions");
    const collection = await client.getCollection("functions");

    expect(search).toEqual([{ id: "p1", score: 0.75, payload: { n: 1 } }]);
    expect(collection).toEqual({
      name: "functions",
      vectorSize: 128,
      pointCount: 5,
    });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("handles qdrant search and collection errors gracefully", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("search failed"))
      .mockRejectedValueOnce(new Error("collection failed"));

    vi.stubGlobal("fetch", fetchMock);

    const client = new QdrantClient("localhost", 6333);
    await client.connect();
    const search = await client.search("functions", [0.1], 1);
    const collection = await client.getCollection("functions");

    expect(search).toEqual([]);
    expect(collection).toBeNull();
  });

  it("E2: upsertPoints sends deterministic UUID string IDs, not integers", async () => {
    // Capture the body sent to Qdrant via fetch
    let capturedBody: any = null;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // connect
      .mockImplementationOnce(async (_url: string, opts: { body: string }) => {
        capturedBody = JSON.parse(opts.body);
        return { ok: true };
      }); // upsertPoints

    vi.stubGlobal("fetch", fetchMock);

    const client = new QdrantClient("localhost", 6333);
    await client.connect();
    await client.upsertPoints("functions", [
      { id: "proj-a:function:sum", vector: [0.1, 0.2], payload: { projectId: "proj-a" } },
    ]);

    expect(capturedBody).not.toBeNull();
    const sentId = capturedBody.points[0].id;

    // Must be a UUID-format string (8-4-4-4-12 hex), not a number
    expect(typeof sentId).toBe("string");
    expect(sentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Must preserve original ID in payload for recovery
    expect(capturedBody.points[0].payload.originalId).toBe("proj-a:function:sum");
  });

  it("E2: stableUuid produces the same UUID for the same input", async () => {
    // Two clients with same input should produce identical IDs (deterministic)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const clientA = new QdrantClient();
    const clientB = new QdrantClient();
    await clientA.connect();
    await clientB.connect();

    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true })
        .mockImplementationOnce(async (_u: string, o: { body: string }) => {
          bodies.push(JSON.parse(o.body));
          return { ok: true };
        })
        .mockImplementationOnce(async (_u: string, o: { body: string }) => {
          bodies.push(JSON.parse(o.body));
          return { ok: true };
        }),
    );

    await clientA.connect();
    await clientB.connect();
    const point = { id: "test:fn:foo", vector: [0.1], payload: {} };
    await clientA.upsertPoints("functions", [point]);
    await clientB.upsertPoints("functions", [point]);

    expect(bodies[0].points[0].id).toBe(bodies[1].points[0].id);
  });
});
