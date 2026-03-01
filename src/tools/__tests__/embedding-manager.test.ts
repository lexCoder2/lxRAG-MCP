/**
 * EmbeddingManager tests — Phase E (Qdrant sync reliability)
 * Covers E7: concurrent ensureEmbeddings calls piggyback on the first sync.
 */
import { describe, expect, it, vi } from "vitest";
import { EmbeddingManager } from "../embedding-manager.js";

function buildMockEngine(delayMs = 0) {
  const generateAllEmbeddings = vi.fn().mockImplementation(async () => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return { functions: 1, classes: 0, files: 0 };
  });
  const storeInQdrant = vi.fn().mockResolvedValue(undefined);
  return { generateAllEmbeddings, storeInQdrant } as any;
}

describe("EmbeddingManager", () => {
  it("marks project ready after ensureEmbeddings completes", async () => {
    const mgr = new EmbeddingManager();
    const engine = buildMockEngine();

    expect(mgr.isReady("proj-a")).toBe(false);
    await mgr.ensureEmbeddings("proj-a", engine);
    expect(mgr.isReady("proj-a")).toBe(true);
  });

  it("skips generation when engine is not provided", async () => {
    const mgr = new EmbeddingManager();
    await mgr.ensureEmbeddings("proj-a", undefined);
    expect(mgr.isReady("proj-a")).toBe(false);
  });

  it("skips generation when project is already ready", async () => {
    const mgr = new EmbeddingManager();
    const engine = buildMockEngine();
    mgr.setReady("proj-a", true);

    await mgr.ensureEmbeddings("proj-a", engine);
    expect(engine.generateAllEmbeddings).not.toHaveBeenCalled();
  });

  it("E7: concurrent ensureEmbeddings calls piggyback — generateAllEmbeddings called only once", async () => {
    const mgr = new EmbeddingManager();
    const engine = buildMockEngine(20); // 20ms delay so second call arrives mid-flight

    // Fire two calls simultaneously
    const [r1, r2] = await Promise.all([
      mgr.ensureEmbeddings("proj-a", engine),
      mgr.ensureEmbeddings("proj-a", engine),
    ]);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    // Despite two calls, generation should only have run once
    expect(engine.generateAllEmbeddings).toHaveBeenCalledTimes(1);
    expect(engine.storeInQdrant).toHaveBeenCalledTimes(1);
    expect(mgr.isReady("proj-a")).toBe(true);
  });

  it("E7: different projects do not share the sync lock", async () => {
    const mgr = new EmbeddingManager();
    const engineA = buildMockEngine(10);
    const engineB = buildMockEngine(10);

    await Promise.all([
      mgr.ensureEmbeddings("proj-a", engineA),
      mgr.ensureEmbeddings("proj-b", engineB),
    ]);

    // Both projects get their own sync
    expect(engineA.generateAllEmbeddings).toHaveBeenCalledTimes(1);
    expect(engineB.generateAllEmbeddings).toHaveBeenCalledTimes(1);
    expect(mgr.isReady("proj-a")).toBe(true);
    expect(mgr.isReady("proj-b")).toBe(true);
  });

  it("clears readiness state", () => {
    const mgr = new EmbeddingManager();
    mgr.setReady("proj-a", true);
    mgr.clear("proj-a");
    expect(mgr.isReady("proj-a")).toBe(false);
  });
});
