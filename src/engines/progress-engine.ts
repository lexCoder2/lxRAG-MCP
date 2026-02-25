/**
 * @file engines/progress-engine
 * @description Manages feature/task status and progress queries backed by graph state.
 * @remarks Provides both in-memory and Memgraph persistence pathways.
 */

import type { GraphIndexManager } from "../graph/index.js";
import type { MemgraphClient } from "../graph/client.js";
import type { CypherStatement } from "../graph/types.js";
import { extractProjectIdFromScopedId } from "../utils/validation.js";

export interface Feature {
  id: string;
  name: string;
  status: "pending" | "in-progress" | "completed" | "blocked";
  description?: string;
  adrReference?: string;
  startedAt?: number;
  completedAt?: number;
  implementingFiles?: string[];
  relatedTests?: string[];
}

export interface Task {
  id: string;
  name: string;
  description?: string;
  status: "pending" | "in-progress" | "completed" | "blocked";
  assignee?: string;
  featureId?: string;
  startedAt?: number;
  dueDate?: number;
  completedAt?: number;
  blockedBy?: string[]; // Task IDs
}

export interface ProgressQueryResult {
  items: (Feature | Task)[];
  totalCount: number;
  completedCount: number;
  inProgressCount: number;
  blockedCount: number;
}

export interface FeatureStatus {
  feature: Feature;
  tasks: Task[];
  implementingCode: {
    files: string[];
    functions: number;
    classes: number;
  };
  testCoverage: {
    testSuites: number;
    testCases: number;
  };
  blockingIssues: Task[];
  progressPercentage: number;
}

export class ProgressEngine {
  private features: Map<string, Feature>;
  private tasks: Map<string, Task>;
  private index: GraphIndexManager;
  private memgraph?: MemgraphClient;

  constructor(index: GraphIndexManager, memgraph?: MemgraphClient) {
    this.index = index;
    this.memgraph = memgraph;
    this.features = new Map();
    this.tasks = new Map();
    this.loadFromGraph();
  }

  /**
   * Load features and tasks from graph
   */
  private loadFromGraph(): void {
    // Load FEATURE nodes
    const featureNodes = this.index.getNodesByType("FEATURE");
    for (const node of featureNodes) {
      this.features.set(node.id, {
        id: node.id,
        name: node.properties.name,
        status: node.properties.status || "pending",
        description: node.properties.description,
        adrReference: node.properties.adrReference,
        startedAt: node.properties.startedAt,
        completedAt: node.properties.completedAt,
        implementingFiles: [],
        relatedTests: [],
      });
    }

    // Load TASK nodes
    const taskNodes = this.index.getNodesByType("TASK");
    for (const node of taskNodes) {
      this.tasks.set(node.id, {
        id: node.id,
        name: node.properties.name,
        description: node.properties.description,
        status: node.properties.status || "pending",
        assignee: node.properties.assignee,
        featureId: node.properties.featureId,
        startedAt: node.properties.startedAt,
        dueDate: node.properties.dueDate,
        completedAt: node.properties.completedAt,
        blockedBy: node.properties.blockedBy || [],
      });
    }

    // Link tasks to features via featureId relationship
    for (const task of this.tasks.values()) {
      if (task.featureId) {
        const feature = this.features.get(task.featureId);
        if (feature && Array.isArray((feature as any).taskIds)) {
          (feature as any).taskIds.push(task.id);
        }
      }
    }
  }

  /**
   * Query features or tasks by filter criteria
   */
  query(
    type: "feature" | "task",
    filter?: {
      status?: string;
      assignee?: string;
      featureId?: string;
    },
  ): ProgressQueryResult {
    const items: (Feature | Task)[] = [];

    if (type === "feature") {
      for (const feature of this.features.values()) {
        if (filter?.status && feature.status !== filter.status) continue;
        items.push(feature);
      }
    } else if (type === "task") {
      for (const task of this.tasks.values()) {
        if (filter?.status && task.status !== filter.status) continue;
        if (filter?.assignee && task.assignee !== filter.assignee) continue;
        if (filter?.featureId && task.featureId !== filter.featureId) continue;
        items.push(task);
      }
    }

    // Calculate statistics
    const completed = items.filter((i) => i.status === "completed").length;
    const inProgress = items.filter((i) => i.status === "in-progress").length;
    const blocked = items.filter((i) => i.status === "blocked").length;

    return {
      items,
      totalCount: items.length,
      completedCount: completed,
      inProgressCount: inProgress,
      blockedCount: blocked,
    };
  }

  /**
   * Update task status
   */
  updateTask(taskId: string, updates: Partial<Task>): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    Object.assign(task, updates);

    if (updates.status === "completed") {
      task.completedAt = Date.now();
    } else if (updates.status === "in-progress" && !task.startedAt) {
      task.startedAt = Date.now();
    }

    return task;
  }

  /**
   * Get detailed feature status
   */
  getFeatureStatus(featureId: string): FeatureStatus | null {
    const feature = this.features.get(featureId);
    if (!feature) return null;

    // Get tasks for this feature
    const tasks = Array.from(this.tasks.values()).filter(
      (t) => t.featureId === featureId,
    );

    // Get implementing files (linked via IMPLEMENTS relationship in graph)
    const implementingFiles: string[] = [];
    const fileRels = this.index
      .getRelationshipsFrom(featureId)
      .filter((r) => r.type === "IMPLEMENTS");
    for (const rel of fileRels) {
      const file = this.index.getNode(rel.to);
      if (file && file.properties.path) {
        implementingFiles.push(file.properties.path);
      }
    }

    // Count functions and classes in implementing files
    let functionCount = 0;
    let classCount = 0;

    for (const filePath of implementingFiles) {
      const fileNodes = this.index.getNodesByType("FILE");
      const fileNode = fileNodes.find((n) => n.properties.path === filePath);
      if (!fileNode) continue;

      const funcRels = this.index
        .getRelationshipsFrom(fileNode.id)
        .filter((r) => r.type === "CONTAINS");
      for (const rel of funcRels) {
        const node = this.index.getNode(rel.to);
        if (!node) continue;
        if (node.type === "FUNCTION") functionCount++;
        if (node.type === "CLASS") classCount++;
      }
    }

    // Get test coverage
    const testSuites = this.index.getNodesByType("TEST_SUITE").filter((n) => {
      const testsRels = this.index
        .getRelationshipsFrom(n.id)
        .filter((r) => r.type === "TESTS");
      return testsRels.some((r) => {
        const tested = this.index.getNode(r.to);
        return (
          tested && implementingFiles.includes(tested.properties.path || "")
        );
      });
    });

    const testCases = this.index.getNodesByType("TEST_CASE").filter((n) => {
      const testRels = this.index
        .getRelationshipsFrom(n.id)
        .filter((r) => r.type === "TESTS");
      return testRels.some((r) => {
        const tested = this.index.getNode(r.to);
        return (
          tested && implementingFiles.includes(tested.properties.path || "")
        );
      });
    });

    // Find blocking issues
    const blockingIssues = tasks.filter((t) => t.status === "blocked");

    // Calculate progress
    const completedTasks = tasks.filter((t) => t.status === "completed").length;
    const progressPercentage =
      tasks.length > 0 ? (completedTasks / tasks.length) * 100 : 0;

    return {
      feature,
      tasks,
      implementingCode: {
        files: implementingFiles,
        functions: functionCount,
        classes: classCount,
      },
      testCoverage: {
        testSuites: testSuites.length,
        testCases: testCases.length,
      },
      blockingIssues,
      progressPercentage: Math.round(progressPercentage * 100) / 100,
    };
  }

  /**
   * Find all blocking issues
   */
  getBlockingIssues(type?: "all" | "critical" | "features" | "tests"): Task[] {
    const blocked = Array.from(this.tasks.values()).filter(
      (t) => t.status === "blocked",
    );

    if (type === "critical") {
      return blocked.filter((t) => t.blockedBy && t.blockedBy.length > 2);
    }

    if (type === "features") {
      return blocked.filter((t) => {
        const feature = this.features.get(t.featureId || "");
        return feature && feature.status !== "completed";
      });
    }

    return blocked;
  }

  /**
   * Create a new feature
   * Phase 2d: Memgraph persistence is mandatory
   */
  async createFeature(feature: Feature): Promise<Feature> {
    if (!this.memgraph || !this.memgraph.isConnected()) {
      throw new Error(
        "[ProgressEngine] Cannot create feature: Memgraph is not connected. Feature persistence to database is mandatory.",
      );
    }

    feature.startedAt = Date.now();

    try {
      const result = await this.memgraph.executeCypher(
        `MERGE (f:FEATURE {id: $id})
         SET f.name = $name, f.status = $status,
             f.description = $description, f.startedAt = $startedAt,
             f.createdAt = $createdAt, f.projectId = $projectId`,
        {
          id: feature.id,
          name: feature.name,
          status: feature.status,
          description: feature.description ?? null,
          startedAt: feature.startedAt,
          createdAt: Date.now(),
          projectId: extractProjectIdFromScopedId(feature.id),
        },
      );

      if (result.error) {
        throw new Error(
          `[ProgressEngine] Failed to persist feature to Memgraph: ${result.error}`,
        );
      }

      // Only add to in-memory map after successful persistence
      this.features.set(feature.id, feature);
      console.error(
        `[Phase2d] Feature ${feature.id} created and persisted to Memgraph`,
      );
      return feature;
    } catch (err) {
      throw new Error(
        `[ProgressEngine] Failed to create feature: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Create a new task
   * Phase 2d: Memgraph persistence is mandatory
   */
  async createTask(task: Task): Promise<Task> {
    if (!this.memgraph || !this.memgraph.isConnected()) {
      throw new Error(
        "[ProgressEngine] Cannot create task: Memgraph is not connected. Task persistence to database is mandatory.",
      );
    }

    try {
      const result = await this.memgraph.executeCypher(
        `MERGE (t:TASK {id: $id})
         SET t.name = $name, t.status = $status,
             t.description = $description, t.createdAt = $createdAt,
             t.featureId = $featureId, t.assignee = $assignee,
             t.dueDate = $dueDate, t.projectId = $projectId`,
        {
          id: task.id,
          name: task.name,
          status: task.status,
          description: task.description ?? null,
          createdAt: Date.now(),
          featureId: task.featureId ?? null,
          assignee: task.assignee ?? null,
          dueDate: task.dueDate ?? null,
          projectId: extractProjectIdFromScopedId(task.id),
        },
      );

      if (result.error) {
        throw new Error(
          `[ProgressEngine] Failed to persist task to Memgraph: ${result.error}`,
        );
      }

      // Only add to in-memory map after successful persistence
      this.tasks.set(task.id, task);
      console.error(`[Phase2d] Task ${task.id} created and persisted to Memgraph`);
      return task;
    } catch (err) {
      throw new Error(
        `[ProgressEngine] Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Persist task update to Memgraph (Phase 5.3)
   */
  async persistTaskUpdate(
    taskId: string,
    updates: Partial<Task>,
  ): Promise<boolean> {
    if (!this.memgraph || !this.memgraph.isConnected()) {
      return false;
    }

    try {
      const statement: CypherStatement = {
        query: `
          MATCH (t:TASK {id: $taskId})
          SET t.status = $status,
              t.updatedAt = timestamp()
              ${updates.description ? ", t.description = $description" : ""}
              ${updates.startedAt ? ", t.startedAt = $startedAt" : ""}
              ${updates.completedAt ? ", t.completedAt = $completedAt" : ""}
        `,
        params: {
          taskId,
          status: updates.status,
          description: updates.description,
          startedAt: updates.startedAt,
          completedAt: updates.completedAt,
        },
      };

      const result = await this.memgraph.executeCypher(
        statement.query,
        statement.params,
      );
      return !result.error;
    } catch (error) {
      console.error("[ProgressEngine] Failed to persist task update:", error);
      return false;
    }
  }

  /**
   * Persist feature update to Memgraph (Phase 5.3)
   */
  async persistFeatureUpdate(
    featureId: string,
    updates: Partial<Feature>,
  ): Promise<boolean> {
    if (!this.memgraph || !this.memgraph.isConnected()) {
      return false;
    }

    try {
      const statement: CypherStatement = {
        query: `
          MATCH (f:FEATURE {id: $featureId})
          SET f.status = $status,
              f.updatedAt = timestamp()
              ${updates.description ? ", f.description = $description" : ""}
              ${updates.startedAt ? ", f.startedAt = $startedAt" : ""}
              ${updates.completedAt ? ", f.completedAt = $completedAt" : ""}
        `,
        params: {
          featureId,
          status: updates.status,
          description: updates.description,
          startedAt: updates.startedAt,
          completedAt: updates.completedAt,
        },
      };

      const result = await this.memgraph.executeCypher(
        statement.query,
        statement.params,
      );
      return !result.error;
    } catch (error) {
      console.error(
        "[ProgressEngine] Failed to persist feature update:",
        error,
      );
      return false;
    }
  }

  /**
   * Reload engine state from updated graph index
   * Called when project context changes to refresh feature/task data
   */
  reload(index: GraphIndexManager, projectId?: string): void {
    console.error(`[ProgressEngine] Reloading features and tasks (projectId=${projectId})`);

    this.index = index;
    this.features.clear();
    this.tasks.clear();
    this.loadFromGraph();

    // Filter by projectId if provided
    if (projectId) {
      for (const [id] of this.features.entries()) {
        if (!id.startsWith(`${projectId}:`)) {
          this.features.delete(id);
        }
      }

      for (const [id] of this.tasks.entries()) {
        if (!id.startsWith(`${projectId}:`)) {
          this.tasks.delete(id);
        }
      }
    }

    const featureCount = this.features.size;
    const taskCount = this.tasks.size;
    console.error(`[ProgressEngine] Reloaded ${featureCount} features and ${taskCount} tasks`);
  }

  /**
   * Export progress data to JSON
   */
  export(): string {
    return JSON.stringify(
      {
        features: Array.from(this.features.values()),
        tasks: Array.from(this.tasks.values()),
        statistics: {
          totalFeatures: this.features.size,
          completedFeatures: Array.from(this.features.values()).filter(
            (f) => f.status === "completed",
          ).length,
          totalTasks: this.tasks.size,
          completedTasks: Array.from(this.tasks.values()).filter(
            (t) => t.status === "completed",
          ).length,
          blockedTasks: Array.from(this.tasks.values()).filter(
            (t) => t.status === "blocked",
          ).length,
        },
      },
      null,
      2,
    );
  }
}

export default ProgressEngine;
