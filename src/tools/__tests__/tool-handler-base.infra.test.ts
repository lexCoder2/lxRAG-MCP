/**
 * @file tool-handler-base.infra.test.ts
 * @description Unit tests for the infrastructure concerns that remain in
 * ToolHandlerBase after the SOLID refactor:
 *
 *   1. Session lifecycle        (cleanupSession, cleanupAllSessions)
 *   2. File Watcher lifecycle   (startActiveWatcher, stopActiveWatcher)
 *   3. Build error tracking     (recordBuildError, getRecentBuildErrors)
 *   4. callTool edge cases      (TOOL_NOT_FOUND, re-throw on exception)
 *   5. initializeIndexFromMemgraph
 *   6. Delegation contracts     (each public method delegates to its collaborator)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import GraphIndexManager from "../../graph/index.js";
import { ToolHandlers } from "../tool-handlers.js";
import { runWithRequestContext } from "../../request-context.js";

// ── FileWatcher module mock ───────────────────────────────────────────────────
// Must be declared before any imports that pull in the watcher.
vi.mock("../../graph/watcher.js", () => {
  // Must use a regular function (not arrow) so `new MockFileWatcher()` works.
  const MockFileWatcher = vi.fn(function (this: Record<string, unknown>) {
    this.start = vi.fn();
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.pendingChanges = 0;
    this.state = "idle";
  });
  return { default: MockFileWatcher, FileWatcher: MockFileWatcher };
});

import FileWatcher from "../../graph/watcher.js";

// ── Shared factory ─────────────────────────────────────────────────────────────

type HandlerOverrides = {
  executeCypher?: ReturnType<typeof vi.fn>;
  isConnected?: ReturnType<typeof vi.fn>;
  loadProjectGraph?: ReturnType<typeof vi.fn>;
  config?: object;
  orchestrator?: object;
};

function makeHandlers(overrides: HandlerOverrides = {}) {
  const index = new GraphIndexManager();
  const executeCypher =
    overrides.executeCypher ?? vi.fn().mockResolvedValue({ data: [], error: undefined });
  const isConnected = overrides.isConnected ?? vi.fn().mockReturnValue(true);
  const loadProjectGraph =
    overrides.loadProjectGraph ??
    vi.fn().mockResolvedValue({ nodes: [], relationships: [] });

  const handlers = new ToolHandlers({
    index,
    memgraph: {
      executeCypher,
      queryNaturalLanguage: vi.fn(),
      isConnected,
      loadProjectGraph,
    } as any,
    config: overrides.config ?? {},
    orchestrator: overrides.orchestrator,
  });

  return { handlers, index, executeCypher, isConnected, loadProjectGraph };
}

// ── Fake watcher helper ────────────────────────────────────────────────────────

function makeMockWatcher() {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    pendingChanges: 0,
    state: "idle" as const,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1 — Session Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — cleanupSession", () => {
  it("T1: stops watcher and removes project context for the given sessionId", async () => {
    const { handlers } = makeHandlers();
    const watcher = makeMockWatcher();
    const ctx = { workspaceRoot: "/tmp", sourceDir: "/tmp/src", projectId: "p1" };

    (handlers as any).sessionWatchers.set("sess-1", watcher);
    (handlers as any).sessionProjectContexts.set("sess-1", ctx);

    await handlers.cleanupSession("sess-1");

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect((handlers as any).sessionWatchers.has("sess-1")).toBe(false);
    expect((handlers as any).sessionProjectContexts.has("sess-1")).toBe(false);
  });

  it("T2: is a no-op when sessionId is an empty string", async () => {
    const { handlers } = makeHandlers();
    // Should not throw, nothing to clean up
    await expect(handlers.cleanupSession("")).resolves.toBeUndefined();
  });

  it("T3: does not throw when watcher.stop() rejects", async () => {
    const { handlers } = makeHandlers();
    const watcher = {
      ...makeMockWatcher(),
      stop: vi.fn().mockRejectedValue(new Error("chokidar exploded")),
    };
    (handlers as any).sessionWatchers.set("bad-sess", watcher);
    (handlers as any).sessionProjectContexts.set("bad-sess", {
      workspaceRoot: "/tmp",
      sourceDir: "/tmp/src",
      projectId: "px",
    });

    // Should catch internally and not propagate
    await expect(handlers.cleanupSession("bad-sess")).resolves.toBeUndefined();
  });
});

describe("ToolHandlerBase — cleanupAllSessions", () => {
  it("T4: stops all watchers and clears both maps", async () => {
    const { handlers } = makeHandlers();
    const w1 = makeMockWatcher();
    const w2 = makeMockWatcher();

    (handlers as any).sessionWatchers.set("s1", w1);
    (handlers as any).sessionWatchers.set("s2", w2);
    (handlers as any).sessionProjectContexts.set("s1", {
      workspaceRoot: "/a",
      sourceDir: "/a/src",
      projectId: "pa",
    });
    (handlers as any).sessionProjectContexts.set("s2", {
      workspaceRoot: "/b",
      sourceDir: "/b/src",
      projectId: "pb",
    });

    await handlers.cleanupAllSessions();

    expect(w1.stop).toHaveBeenCalledOnce();
    expect(w2.stop).toHaveBeenCalledOnce();
    expect((handlers as any).sessionWatchers.size).toBe(0);
    expect((handlers as any).sessionProjectContexts.size).toBe(0);
  });

  it("T5: continues cleaning remaining watchers even when one stop() rejects", async () => {
    const { handlers } = makeHandlers();
    const wOk = makeMockWatcher();
    const wBad = {
      ...makeMockWatcher(),
      stop: vi.fn().mockRejectedValue(new Error("bad stop")),
    };

    (handlers as any).sessionWatchers.set("ok", wOk);
    (handlers as any).sessionWatchers.set("bad", wBad);

    await expect(handlers.cleanupAllSessions()).resolves.toBeUndefined();
    expect(wOk.stop).toHaveBeenCalledOnce();
    expect(wBad.stop).toHaveBeenCalledOnce();
    expect((handlers as any).sessionWatchers.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2 — File Watcher Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — startActiveWatcher / stopActiveWatcher", () => {
  beforeEach(() => {
    vi.mocked(FileWatcher).mockClear();
  });

  it("T6: does nothing when watcherEnabledForRuntime() returns false", async () => {
    const { handlers } = makeHandlers();
    vi.spyOn(handlers as any, "watcherEnabledForRuntime").mockReturnValue(false);

    await handlers.startActiveWatcher({
      workspaceRoot: "/tmp",
      sourceDir: "/tmp/src",
      projectId: "p1",
    });

    expect(FileWatcher).not.toHaveBeenCalled();
    expect((handlers as any).sessionWatchers.size).toBe(0);
  });

  it("T7: constructs FileWatcher with correct options and stores it under the session key", async () => {
    const { handlers } = makeHandlers();
    vi.spyOn(handlers as any, "watcherEnabledForRuntime").mockReturnValue(true);

    await handlers.startActiveWatcher({
      workspaceRoot: "/repo",
      sourceDir: "/repo/src",
      projectId: "myproj",
    });

    expect(FileWatcher).toHaveBeenCalledOnce();
    const [opts] = vi.mocked(FileWatcher).mock.calls[0];
    expect(opts).toMatchObject({
      workspaceRoot: "/repo",
      sourceDir: "/repo/src",
      projectId: "myproj",
    });

    const key = (handlers as any).watcherKey();
    expect((handlers as any).sessionWatchers.has(key)).toBe(true);
  });

  it("T8: stops any pre-existing watcher before starting a new one", async () => {
    const { handlers } = makeHandlers();
    vi.spyOn(handlers as any, "watcherEnabledForRuntime").mockReturnValue(true);

    const existing = makeMockWatcher();
    const key = (handlers as any).watcherKey();
    (handlers as any).sessionWatchers.set(key, existing);

    await handlers.startActiveWatcher({
      workspaceRoot: "/repo",
      sourceDir: "/repo/src",
      projectId: "p2",
    });

    expect(existing.stop).toHaveBeenCalledOnce();
    // A new watcher replaces it
    expect(FileWatcher).toHaveBeenCalledOnce();
  });

  it("T9: stopActiveWatcher calls stop() and removes the watcher from the map", async () => {
    const { handlers } = makeHandlers();
    const watcher = makeMockWatcher();
    const key = (handlers as any).watcherKey();
    (handlers as any).sessionWatchers.set(key, watcher);

    await handlers.stopActiveWatcher();

    expect(watcher.stop).toHaveBeenCalledOnce();
    expect((handlers as any).sessionWatchers.has(key)).toBe(false);
  });

  it("T10: stopActiveWatcher is a no-op when no watcher is stored", async () => {
    const { handlers } = makeHandlers();
    // Should not throw and should be silent
    await expect(handlers.stopActiveWatcher()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3 — Build Error Tracking
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — recordBuildError + getRecentBuildErrors", () => {
  it("T11: stores error with timestamp, message, and optional context", () => {
    const { handlers } = makeHandlers();
    const before = Date.now();
    handlers.recordBuildError("proj-a", new Error("oops"), "during-rebuild");
    const after = Date.now();

    const [entry] = handlers.getRecentBuildErrors("proj-a", 1);
    expect(entry.error).toBe("oops");
    expect(entry.context).toBe("during-rebuild");
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  it("T12: accepts an Error instance and a plain string equally", () => {
    const { handlers } = makeHandlers();
    handlers.recordBuildError("proj-b", new Error("typed-error"));
    handlers.recordBuildError("proj-b", "raw-string-error");

    const errors = handlers.getRecentBuildErrors("proj-b");
    expect(errors.map((e) => e.error)).toEqual(["typed-error", "raw-string-error"]);
  });

  it("T13: caps history at maxBuildErrorsPerProject (10) by evicting the oldest", () => {
    const { handlers } = makeHandlers();
    for (let i = 0; i < 12; i++) {
      handlers.recordBuildError("cap-proj", `error-${i}`);
    }
    const all = handlers.getRecentBuildErrors("cap-proj", 20);
    expect(all.length).toBe(10);
    // Oldest two (error-0, error-1) should have been evicted
    expect(all[0].error).toBe("error-2");
    expect(all[9].error).toBe("error-11");
  });

  it("T14: isolates errors per projectId — different projects don't share lists", () => {
    const { handlers } = makeHandlers();
    handlers.recordBuildError("alpha", "alpha-err");
    handlers.recordBuildError("beta", "beta-err");

    expect(handlers.getRecentBuildErrors("alpha")).toHaveLength(1);
    expect(handlers.getRecentBuildErrors("beta")).toHaveLength(1);
    expect(handlers.getRecentBuildErrors("alpha")[0].error).toBe("alpha-err");
    expect(handlers.getRecentBuildErrors("beta")[0].error).toBe("beta-err");
  });

  it("T15: getRecentBuildErrors returns the last N errors (default 5)", () => {
    const { handlers } = makeHandlers();
    for (let i = 0; i < 8; i++) {
      handlers.recordBuildError("proj-c", `err-${i}`);
    }
    const recent = handlers.getRecentBuildErrors("proj-c"); // default limit = 5
    expect(recent).toHaveLength(5);
    expect(recent[0].error).toBe("err-3");
    expect(recent[4].error).toBe("err-7");
  });

  it("T16: returns empty array for an unknown projectId", () => {
    const { handlers } = makeHandlers();
    expect(handlers.getRecentBuildErrors("unknown-proj")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4 — callTool Edge Cases
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — callTool edge cases", () => {
  it("T17: returns TOOL_NOT_FOUND envelope when the named method is absent", async () => {
    const { handlers } = makeHandlers();
    const response = JSON.parse(await handlers.callTool("nonexistent_tool", {}));
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("TOOL_NOT_FOUND");
  });

  it("T18: TOOL_NOT_FOUND envelope has recoverable=false", async () => {
    const { handlers } = makeHandlers();
    const response = JSON.parse(await handlers.callTool("__no_such_tool__", {}));
    expect(response.error?.recoverable).toBe(false);
  });

  it("T19: re-throws when the target method throws (no error swallowing)", async () => {
    const { handlers } = makeHandlers();
    (handlers as any).exploding_tool = vi.fn().mockRejectedValue(new Error("kaboom"));

    await expect(handlers.callTool("exploding_tool", {})).rejects.toThrow("kaboom");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5 — initializeIndexFromMemgraph
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — initializeIndexFromMemgraph", () => {
  it("T20: loads nodes and relationships into context.index when connected", async () => {
    const loadProjectGraph = vi.fn().mockResolvedValue({
      nodes: [
        { id: "n1", type: "FILE", properties: { name: "foo.ts" } },
        { id: "n2", type: "FUNCTION", properties: { name: "doWork" } },
      ],
      relationships: [
        { id: "r1", from: "n1", to: "n2", type: "CONTAINS", properties: {} },
      ],
    });

    const { handlers, index } = makeHandlers({ loadProjectGraph });

    // initializeIndexFromMemgraph is called fire-and-forget in the constructor;
    // give the microtask queue a chance to drain
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(index.getNode("n1")).toBeDefined();
    expect(index.getNode("n2")).toBeDefined();
  });

  it("T21: skips loading when isConnected() returns false", async () => {
    const loadProjectGraph = vi.fn().mockResolvedValue({ nodes: [], relationships: [] });
    const { handlers, index } = makeHandlers({
      isConnected: vi.fn().mockReturnValue(false),
      loadProjectGraph,
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(loadProjectGraph).not.toHaveBeenCalled();
  });

  it("T22: makes no index mutations when graph is empty", async () => {
    const { handlers, index } = makeHandlers({
      loadProjectGraph: vi.fn().mockResolvedValue({ nodes: [], relationships: [] }),
    });

    const addNode = vi.spyOn(index, "addNode");
    const addRelationship = vi.spyOn(index, "addRelationship");

    // Directly call the method to test it in isolation
    await (handlers as any).initializeIndexFromMemgraph();

    expect(addNode).not.toHaveBeenCalled();
    expect(addRelationship).not.toHaveBeenCalled();
  });

  it("T23: catches Memgraph errors and does not throw (fire-and-forget resilience)", async () => {
    const { handlers } = makeHandlers({
      loadProjectGraph: vi.fn().mockRejectedValue(new Error("DB connection refused")),
    });

    // Must not throw
    await expect((handlers as any).initializeIndexFromMemgraph()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6 — Delegation Contracts
// Each test: spy on the collaborator → call the base method → verify forwarding.
// ═══════════════════════════════════════════════════════════════════════════════

describe("ToolHandlerBase — delegation contracts", () => {
  it("T24: errorEnvelope delegates to responseFormatter.errorEnvelope", () => {
    const { handlers } = makeHandlers();
    const spy = vi.spyOn((handlers as any).responseFormatter, "errorEnvelope");
    handlers.errorEnvelope("MY_CODE", "my reason", false, "a hint");
    expect(spy).toHaveBeenCalledWith("MY_CODE", "my reason", false, "a hint");
  });

  it("T25: formatSuccess delegates to responseFormatter.formatSuccess", () => {
    const { handlers } = makeHandlers();
    const spy = vi.spyOn((handlers as any).responseFormatter, "formatSuccess");
    handlers.formatSuccess({ x: 1 }, "debug", "summary", "my_tool");
    expect(spy).toHaveBeenCalledWith({ x: 1 }, "debug", "summary", "my_tool");
  });

  it("T26: canonicalizePaths delegates to responseFormatter.canonicalizePaths", () => {
    const { handlers } = makeHandlers();
    const spy = vi.spyOn((handlers as any).responseFormatter, "canonicalizePaths");
    handlers.canonicalizePaths("/workspace/foo");
    expect(spy).toHaveBeenCalledWith("/workspace/foo");
  });

  it("T27: applyTemporalFilterToCypher delegates to temporalQueryBuilder", () => {
    const { handlers } = makeHandlers();
    const spy = vi.spyOn(
      (handlers as any).temporalQueryBuilder,
      "applyTemporalFilterToCypher",
    );
    handlers.applyTemporalFilterToCypher("MATCH (n) RETURN n");
    expect(spy).toHaveBeenCalledWith("MATCH (n) RETURN n");
  });

  it("T28: resolveSinceAnchor delegates to temporalQueryBuilder with context.memgraph", async () => {
    const { handlers } = makeHandlers();
    const spy = vi
      .spyOn((handlers as any).temporalQueryBuilder, "resolveSinceAnchor")
      .mockResolvedValue(null);
    await handlers.resolveSinceAnchor("2025-01-01", "proj-x");
    expect(spy).toHaveBeenCalledWith(
      "2025-01-01",
      "proj-x",
      (handlers as any).context.memgraph,
    );
  });

  it("T29: validateEpisodeInput delegates to episodeValidator.validateEpisodeInput", () => {
    const { handlers } = makeHandlers();
    const spy = vi
      .spyOn((handlers as any).episodeValidator, "validateEpisodeInput")
      .mockReturnValue(null);
    const args = { type: "DECISION", outcome: "success", metadata: { rationale: "x" } };
    handlers.validateEpisodeInput(args);
    expect(spy).toHaveBeenCalledWith(args);
  });

  it("T30: inferEpisodeEntityHints delegates to episodeValidator.inferEntityHints with projectId", async () => {
    const { handlers } = makeHandlers();
    const spy = vi
      .spyOn((handlers as any).episodeValidator, "inferEntityHints")
      .mockResolvedValue([]);
    await handlers.inferEpisodeEntityHints("some query", 5);
    expect(spy).toHaveBeenCalledWith(
      "some query",
      5,
      (handlers as any).embeddingEngine,
      expect.any(String), // active projectId
      expect.any(Function), // ensureEmbeddings callback
    );
  });

  it("T31: resolveElement delegates to elementResolver.resolve with index + projectId", () => {
    const { handlers } = makeHandlers();
    const spy = vi
      .spyOn((handlers as any).elementResolver, "resolve")
      .mockReturnValue(undefined);
    handlers.resolveElement("foo.ts:myFn:10");
    expect(spy).toHaveBeenCalledWith(
      "foo.ts:myFn:10",
      (handlers as any).context.index,
      expect.any(String), // active projectId
    );
  });

  it("T32: ensureEmbeddings delegates to embeddingMgr.ensureEmbeddings with resolved projectId", async () => {
    const { handlers } = makeHandlers();
    const spy = vi
      .spyOn((handlers as any).embeddingMgr, "ensureEmbeddings")
      .mockResolvedValue(undefined);
    await handlers.ensureEmbeddings("explicit-proj");
    expect(spy).toHaveBeenCalledWith("explicit-proj", (handlers as any).embeddingEngine);
  });

  it("T33: isProjectEmbeddingsReady / setProjectEmbeddingsReady round-trip through embeddingMgr", () => {
    const { handlers } = makeHandlers();
    const isReadySpy = vi.spyOn((handlers as any).embeddingMgr, "isReady");
    const setReadySpy = vi.spyOn((handlers as any).embeddingMgr, "setReady");

    handlers.setProjectEmbeddingsReady("proj-z", true);
    handlers.isProjectEmbeddingsReady("proj-z");

    expect(setReadySpy).toHaveBeenCalledWith("proj-z", true);
    expect(isReadySpy).toHaveBeenCalledWith("proj-z");
  });
});
