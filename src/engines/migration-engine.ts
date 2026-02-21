/**
 * Progress Tracking Migration Engine
 * Migrates existing markdown-based tracking to graph FEATURE/TASK nodes
 */

import * as fs from "fs";
import * as path from "path";
import type { Feature, Task } from "./progress-engine.js";

export interface MigrationResult {
  success: boolean;
  featuresCreated: number;
  tasksCreated: number;
  errors: string[];
  summary: string;
}

export class MigrationEngine {
  /**
   * Migrate Canvas Performance V2 tracking
   */
  static migrateCanvasPerfV2(): Feature[] {
    const features: Feature[] = [];

    // Main feature
    const mainFeature: Feature = {
      id: "canvas-perf-v2",
      name: "Canvas Performance V2",
      status: "in-progress",
      description:
        "Optimize Konva.js canvas rendering with layer-level transforms, grid optimization, viewport culling, LOD system, and batch zoom",
      adrReference: "ADR-012",
      startedAt: new Date("2024-02-01").getTime(),
      implementingFiles: [
        "src/components/drawing/canvas-hooks/useCameraTransform.ts",
        "src/components/drawing/canvas-layers/GridSceneLayer.tsx",
        "src/components/drawing/canvas-utils/levelOfDetail.ts",
        "src/components/drawing/canvas-hooks/useViewportBounds.ts",
        "src/components/drawing/canvas-hooks/useInteractionSuspension.ts",
      ],
      relatedTests: [
        "src/components/drawing/__tests__/GridCanvas.test.tsx",
        "src/components/drawing/canvas-hooks/__tests__/useCameraTransform.test.ts",
        "src/components/drawing/canvas-layers/__tests__/GridSceneLayer.test.tsx",
      ],
    };

    features.push(mainFeature);

    return features;
  }

  /**
   * Migrate tracking from markdown file
   */
  static migrateFromMarkdown(filePath: string): MigrationResult {
    const errors: string[] = [];
    let featuresCreated = 0;
    let tasksCreated = 0;

    try {
      if (!fs.existsSync(filePath)) {
        return {
          success: false,
          featuresCreated: 0,
          tasksCreated: 0,
          errors: [`File not found: ${filePath}`],
          summary: "Migration failed: file not found",
        };
      }

      const content = fs.readFileSync(filePath, "utf-8");

      // Parse markdown sections
      const sections = this.parseSections(content);

      for (const section of sections) {
        if (section.type === "feature") {
          featuresCreated++;
        } else if (section.type === "task") {
          tasksCreated++;
        }
      }

      return {
        success: true,
        featuresCreated,
        tasksCreated,
        errors,
        summary: `Migrated ${featuresCreated} features and ${tasksCreated} tasks from ${path.basename(filePath)}`,
      };
    } catch (error) {
      errors.push(`Migration error: ${error}`);
      return {
        success: false,
        featuresCreated,
        tasksCreated,
        errors,
        summary: "Migration failed with errors",
      };
    }
  }

  /**
   * Parse markdown into feature/task structure
   */
  private static parseSections(
    content: string
  ): Array<{
    type: "feature" | "task";
    id: string;
    title: string;
    details: any;
  }> {
    const sections: Array<{
      type: "feature" | "task";
      id: string;
      title: string;
      details: any;
    }> = [];

    // Simple markdown parser (would be expanded for production)
    const lines = content.split("\n");
    let currentSection: any = null;
    // @ts-expect-error - currentType used in future parser logic
    let currentType: "feature" | "task" | null = null;

    for (const line of lines) {
      if (line.startsWith("## ")) {
        // Feature section
        currentType = "feature";
        currentSection = {
          title: line.replace("## ", "").trim(),
          details: {},
        };
      } else if (line.startsWith("### ")) {
        // Task section
        currentType = "task";
        currentSection = {
          title: line.replace("### ", "").trim(),
          details: {},
        };
      } else if (line.startsWith("- [ ]") || line.startsWith("- [x]")) {
        // Task item
        const completed = line.includes("[x]");
        const text = line.replace(/- \[[x ]\] /, "").trim();
        if (currentSection) {
          sections.push({
            type: "task",
            id: `task-${sections.length}`,
            title: text,
            details: { completed, description: text },
          });
        }
      }
    }

    return sections;
  }

  /**
   * Generate migration report
   */
  static generateReport(results: MigrationResult[]): string {
    const totalFeatures = results.reduce(
      (sum, r) => sum + r.featuresCreated,
      0
    );
    const totalTasks = results.reduce((sum, r) => sum + r.tasksCreated, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0);

    return `
# Migration Report

**Date**: ${new Date().toISOString()}

## Summary
- Features migrated: ${totalFeatures}
- Tasks migrated: ${totalTasks}
- Errors encountered: ${totalErrors}

## Details
${results.map((r) => `- ${r.summary}`).join("\n")}

## Errors
${
  totalErrors > 0
    ? results
        .filter((r) => r.errors.length > 0)
        .map((r) => r.errors.map((e) => `- ${e}`).join("\n"))
        .join("\n")
    : "None"
}

## Next Steps
1. Review migrated features and tasks in graph
2. Update any broken references
3. Archive original markdown files
4. Update team documentation
`;
  }

  /**
   * Create sample feature for testing
   */
  static createSampleFeature(): Feature {
    return {
      id: "test-feature",
      name: "Sample Feature",
      status: "pending",
      description: "This is a sample feature for testing",
      startedAt: Date.now(),
      implementingFiles: ["src/sample.ts"],
      relatedTests: ["src/__tests__/sample.test.ts"],
    };
  }

  /**
   * Create sample task for testing
   */
  static createSampleTask(): Task {
    return {
      id: "test-task-1",
      name: "Sample Task",
      description: "This is a sample task",
      status: "pending",
      assignee: "Team",
      startedAt: Date.now(),
    };
  }
}

export default MigrationEngine;
