import { afterEach, describe, expect, it, vi } from "vitest";
import { FileWatcher } from "./watcher.js";

describe("FileWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces multiple file events into a single batch", async () => {
    vi.useFakeTimers();
    const onBatch = vi.fn().mockResolvedValue(undefined);

    const watcher = new FileWatcher(
      {
        projectId: "proj-a",
        workspaceRoot: "/tmp/workspace",
        sourceDir: "src",
        debounceMs: 100,
      },
      onBatch,
    );

    (watcher as any).queue("src/a.ts");
    (watcher as any).queue("src/b.ts");
    (watcher as any).queue("src/a.ts");

    expect(watcher.state).toBe("debouncing");
    expect(watcher.pendingChanges).toBe(2);

    await vi.advanceTimersByTimeAsync(101);

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledWith({
      projectId: "proj-a",
      workspaceRoot: "/tmp/workspace",
      sourceDir: "src",
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(watcher.state).toBe("idle");
    expect(watcher.pendingChanges).toBe(0);

    await watcher.stop();
  });

  it("schedules a follow-up flush when files change during processing", async () => {
    vi.useFakeTimers();

    let resolveFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const onBatch = vi
      .fn()
      .mockImplementationOnce(() => firstDone)
      .mockResolvedValueOnce(undefined);

    const watcher = new FileWatcher(
      {
        projectId: "proj-a",
        workspaceRoot: "/tmp/workspace",
        sourceDir: "src",
        debounceMs: 50,
      },
      onBatch,
    );

    (watcher as any).queue("src/first.ts");
    await vi.advanceTimersByTimeAsync(51);

    expect(watcher.state).toBe("rebuilding");
    expect(onBatch).toHaveBeenCalledTimes(1);

    (watcher as any).queue("src/second.ts");
    expect(watcher.pendingChanges).toBe(1);

    resolveFirst?.();
    await Promise.resolve();

    expect(watcher.state).toBe("debouncing");
    await vi.advanceTimersByTimeAsync(51);

    expect(onBatch).toHaveBeenCalledTimes(2);
    expect(onBatch.mock.calls[1][0].changedFiles).toEqual(["src/second.ts"]);
    expect(watcher.state).toBe("idle");

    await watcher.stop();
  });
});
