import { afterEach, describe, expect, it, vi } from "vitest";
import QdrantClient from "./qdrant-client.js";

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
    await client.upsertPoints("functions", [
      { id: "p1", vector: [0.1, 0.2], payload: { n: 1 } },
    ]);
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
});
