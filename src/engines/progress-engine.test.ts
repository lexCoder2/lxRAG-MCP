import { describe, expect, it, vi } from "vitest";
import GraphIndexManager from "../graph/index.js";
import { ProgressEngine, type Feature, type Task } from "./progress-engine.js";

function buildIndex(): GraphIndexManager {
  const index = new GraphIndexManager();

  index.addNode("proj-a:feature:f1", "FEATURE", {
    name: "Feature 1",
    status: "in-progress",
  });
  index.addNode("proj-a:task:t1", "TASK", {
    name: "Task 1",
    status: "completed",
    featureId: "proj-a:feature:f1",
  });
  index.addNode("proj-a:task:t2", "TASK", {
    name: "Task 2",
    status: "blocked",
    featureId: "proj-a:feature:f1",
    blockedBy: ["x", "y", "z"],
  });

  index.addNode("file:impl", "FILE", {
    path: "src/impl.ts",
    projectId: "proj-a",
  });
  index.addNode("fn:impl", "FUNCTION", { name: "run", projectId: "proj-a" });
  index.addNode("class:impl", "CLASS", { name: "Runner", projectId: "proj-a" });
  index.addNode("suite:1", "TEST_SUITE", {
    name: "impl suite",
    projectId: "proj-a",
  });
  index.addNode("case:1", "TEST_CASE", {
    name: "impl case",
    projectId: "proj-a",
  });

  index.addRelationship("r1", "proj-a:feature:f1", "file:impl", "IMPLEMENTS");
  index.addRelationship("r2", "file:impl", "fn:impl", "CONTAINS");
  index.addRelationship("r3", "file:impl", "class:impl", "CONTAINS");
  index.addRelationship("r4", "suite:1", "file:impl", "TESTS");
  index.addRelationship("r5", "case:1", "file:impl", "TESTS");

  return index;
}

describe("ProgressEngine", () => {
  it("aggregates feature status with implementing code and tests", () => {
    const engine = new ProgressEngine(buildIndex());
    const status = engine.getFeatureStatus("proj-a:feature:f1");

    expect(status).not.toBeNull();
    expect(status?.tasks).toHaveLength(2);
    expect(status?.implementingCode.files).toEqual(["src/impl.ts"]);
    expect(status?.implementingCode.functions).toBe(1);
    expect(status?.implementingCode.classes).toBe(1);
    expect(status?.testCoverage.testSuites).toBe(1);
    expect(status?.testCoverage.testCases).toBe(1);
    expect(status?.blockingIssues).toHaveLength(1);
    expect(status?.progressPercentage).toBe(50);
  });

  it("updates task timestamps for in-progress and completed transitions", () => {
    const engine = new ProgressEngine(buildIndex());

    const started = engine.updateTask("proj-a:task:t2", {
      status: "in-progress",
    });
    const completed = engine.updateTask("proj-a:task:t2", {
      status: "completed",
    });

    expect(started?.startedAt).toBeTypeOf("number");
    expect(completed?.completedAt).toBeTypeOf("number");
  });

  it("requires connected memgraph for feature creation", async () => {
    const memgraph = {
      isConnected: vi.fn().mockReturnValue(false),
    } as any;
    const engine = new ProgressEngine(buildIndex(), memgraph);

    const feature: Feature = {
      id: "proj-a:feature:new",
      name: "New Feature",
      status: "pending",
    };

    await expect(engine.createFeature(feature)).rejects.toThrow(
      "Memgraph is not connected",
    );
  });

  it("reload filters features/tasks by project id", () => {
    const index = buildIndex();
    index.addNode("proj-b:feature:f2", "FEATURE", {
      name: "Feature 2",
      status: "pending",
    });
    index.addNode("proj-b:task:t3", "TASK", {
      name: "Task 3",
      status: "pending",
      featureId: "proj-b:feature:f2",
    });

    const engine = new ProgressEngine(index);
    engine.reload(index, "proj-a");

    const featureQuery = engine.query("feature");
    const taskQuery = engine.query("task");

    expect(
      featureQuery.items.every((item) => item.id.startsWith("proj-a:")),
    ).toBe(true);
    expect(taskQuery.items.every((item) => item.id.startsWith("proj-a:"))).toBe(
      true,
    );
  });

  it("returns false when persisting task update fails", async () => {
    const memgraph = {
      isConnected: vi.fn().mockReturnValue(true),
      executeCypher: vi
        .fn()
        .mockResolvedValue({ error: "write failed", data: [] }),
    } as any;
    const engine = new ProgressEngine(buildIndex(), memgraph);

    const ok = await engine.persistTaskUpdate("proj-a:task:t1", {
      status: "completed",
    } as Partial<Task>);

    expect(ok).toBe(false);
  });
});
