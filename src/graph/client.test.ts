import { describe, expect, it, vi } from "vitest";
import { MemgraphClient } from "./client.js";

describe("MemgraphClient", () => {
  it("falls back to localhost when initial host is unresolved", async () => {
    const client = new MemgraphClient({ host: "memgraph", port: 7687 });

    const failingSession = {
      run: vi.fn().mockRejectedValue(new Error("ENOTFOUND memgraph")),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const successSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const firstDriver = {
      session: vi.fn().mockReturnValue(failingSession),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondDriver = {
      session: vi.fn().mockReturnValue(successSession),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (client as any).driver = firstDriver;
    (client as any).createDriver = vi.fn().mockReturnValue(secondDriver);

    await client.connect();

    expect((client as any).createDriver).toHaveBeenCalledWith("localhost");
    expect(client.isConnected()).toBe(true);
  });

  it("sanitizes undefined query params to null", async () => {
    const client = new MemgraphClient();

    const run = vi.fn().mockResolvedValue({
      records: [{ toObject: () => ({ ok: 1 }) }],
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const session = { run, close };

    (client as any).connected = true;
    (client as any).driver = {
      session: vi.fn().mockReturnValue(session),
    };

    const result = await client.executeCypher("RETURN $value", {
      value: undefined,
      keep: "x",
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([{ ok: 1 }]);
    expect(run).toHaveBeenCalledWith("RETURN $value", {
      value: null,
      keep: "x",
    });
  });

  it("returns per-statement results in executeBatch and continues on errors", async () => {
    const client = new MemgraphClient();
    const executeSpy = vi
      .spyOn(client, "executeCypher")
      .mockResolvedValueOnce({ data: [{ a: 1 }] })
      .mockResolvedValueOnce({ data: [], error: "boom" });

    const results = await client.executeBatch([
      { query: "RETURN 1", params: {} },
      { query: "RETURN 2", params: {} },
    ]);

    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0].data).toEqual([{ a: 1 }]);
    expect(results[1].error).toBe("boom");
  });

  it("returns empty graph when disconnected and maps rows when connected", async () => {
    const client = new MemgraphClient();

    (client as any).connected = false;
    expect(await client.loadProjectGraph("proj-a")).toEqual({
      nodes: [],
      relationships: [],
    });

    (client as any).connected = true;
    vi.spyOn(client, "executeCypher")
      .mockResolvedValueOnce({
        data: [{ id: "n1", type: "FILE", props: { path: "src/a.ts" } }],
      })
      .mockResolvedValueOnce({
        data: [{ from: "n1", to: "n2", type: "CALLS", props: { w: 1 } }],
      });

    const loaded = await client.loadProjectGraph("proj-a");
    expect(loaded.nodes).toEqual([
      { id: "n1", type: "FILE", properties: { path: "src/a.ts" } },
    ]);
    expect(loaded.relationships).toEqual([
      {
        id: "n1-CALLS-n2",
        from: "n1",
        to: "n2",
        type: "CALLS",
        properties: { w: 1 },
      },
    ]);
  });

  it("retries transient query errors once and succeeds", async () => {
    const client = new MemgraphClient();

    const firstSession = {
      run: vi
        .fn()
        .mockRejectedValue(
          new Error("ServiceUnavailable: temporary network hiccup"),
        ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const secondSession = {
      run: vi.fn().mockResolvedValue({
        records: [{ toObject: () => ({ ok: true }) }],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (client as any).connected = true;
    (client as any).driver = {
      session: vi
        .fn()
        .mockReturnValueOnce(firstSession)
        .mockReturnValueOnce(secondSession),
    };

    const result = await client.executeCypher("RETURN 1");

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([{ ok: true }]);
    expect((client as any).driver.session).toHaveBeenCalledTimes(2);
    expect(firstSession.close).toHaveBeenCalledTimes(1);
    expect(secondSession.close).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-transient query errors", async () => {
    const client = new MemgraphClient();

    const session = {
      run: vi.fn().mockRejectedValue(new Error("SyntaxError: invalid cypher")),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (client as any).connected = true;
    (client as any).driver = {
      session: vi.fn().mockReturnValue(session),
    };

    const result = await client.executeCypher("BROKEN QUERY");

    expect(result.data).toEqual([]);
    expect(String(result.error)).toContain("Query failed");
    expect((client as any).driver.session).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("returns connection failure envelope when auto-connect fails", async () => {
    const client = new MemgraphClient();
    vi.spyOn(client, "connect").mockRejectedValue(new Error("dial timeout"));

    (client as any).connected = false;

    const result = await client.executeCypher("RETURN 1");

    expect(result.data).toEqual([]);
    expect(String(result.error)).toContain("Connection failed: dial timeout");
  });
});
