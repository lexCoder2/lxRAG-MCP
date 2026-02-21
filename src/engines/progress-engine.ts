/**
 * Progress Tracking Engine
 * Manages features, tasks, and milestones in the code graph
 */

import type { GraphIndexManager } from "../graph/index.js";
import type { MemgraphClient } from "../graph/client.js";
import type { CypherStatement } from "../graph/types.js";

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

    // Link tasks to features
    for (const task of this.tasks.values()) {
      if (task.featureId) {
        // @ts-expect-error - feature will be used for relationship population
        const feature = this.features.get(task.featureId);
        // This will be populated when loading relationships
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
    }
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
      (t) => t.featureId === featureId
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
      (t) => t.status === "blocked"
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
   */
  createFeature(feature: Feature): Feature {
    feature.startedAt = Date.now();
    this.features.set(feature.id, feature);
    return feature;
  }

  /**
   * Create a new task
   */
  createTask(task: Task): Task {
    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * Persist task update to Memgraph (Phase 5.3)
   */
  async persistTaskUpdate(
    taskId: string,
    updates: Partial<Task>
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
        statement.params
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
    updates: Partial<Feature>
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
        statement.params
      );
      return !result.error;
    } catch (error) {
      console.error("[ProgressEngine] Failed to persist feature update:", error);
      return false;
    }
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
            (f) => f.status === "completed"
          ).length,
          totalTasks: this.tasks.size,
          completedTasks: Array.from(this.tasks.values()).filter(
            (t) => t.status === "completed"
          ).length,
          blockedTasks: Array.from(this.tasks.values()).filter(
            (t) => t.status === "blocked"
          ).length,
        },
      },
      null,
      2
    );
  }
}

export default ProgressEngine;
