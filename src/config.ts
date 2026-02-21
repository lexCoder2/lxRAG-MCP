/**
 * Configuration loader
 */

import * as fs from "fs";
import * as path from "path";

export interface ArchitectureConfig {
  layers: LayerConfig[];
  rules: RuleConfig[];
}

export interface LayerConfig {
  id: string;
  name: string;
  paths: string[];
  canImport: string[];
  description?: string;
}

export interface RuleConfig {
  id: string;
  severity: "error" | "warn";
  pattern: string;
  description: string;
}

export interface ProgressConfig {
  features: Array<{
    id: string;
    name: string;
    status: "not-started" | "in-progress" | "blocked" | "completed";
    priority: "low" | "medium" | "high";
    description?: string;
    tasks?: string[];
  }>;
}

export interface Config {
  architecture: ArchitectureConfig;
  testing?: {
    categories: Array<{
      id: string;
      patterns: string[];
    }>;
  };
  progress?: ProgressConfig;
}

const DEFAULT_CONFIG: Config = {
  architecture: {
    layers: [
      {
        id: "types",
        name: "Types",
        paths: ["src/types/**"],
        canImport: [],
        description: "Core type definitions",
      },
      {
        id: "utils",
        name: "Utilities",
        paths: ["src/utils/**", "src/lib/**"],
        canImport: ["types"],
        description: "Utility functions and libraries",
      },
      {
        id: "engine",
        name: "Engine",
        paths: ["src/engine/**"],
        canImport: ["types", "utils"],
        description: "Business logic and calculations",
      },
      {
        id: "context",
        name: "Context",
        paths: ["src/context/**"],
        canImport: ["types", "utils", "engine", "hooks"],
        description: "React context providers",
      },
      {
        id: "hooks",
        name: "Hooks",
        paths: ["src/hooks/**"],
        canImport: ["types", "utils", "engine"],
        description: "Custom React hooks",
      },
      {
        id: "components",
        name: "Components",
        paths: ["src/components/**"],
        canImport: ["types", "utils", "engine", "context", "hooks"],
        description: "React UI components",
      },
    ],
    rules: [
      {
        id: "no-engine-in-context",
        severity: "error",
        pattern: "engine imports from context",
        description: "Context providers should not directly import engine code",
      },
      {
        id: "no-components-in-engine",
        severity: "error",
        pattern: "component imports from engine",
        description: "Engine code must remain UI-independent",
      },
    ],
  },
  testing: {
    categories: [
      {
        id: "unit",
        patterns: ["**/__tests__/**/*.test.ts", "!**/*.integration.test.ts"],
      },
      {
        id: "integration",
        patterns: ["**/__tests__/**/*.integration.test.ts"],
      },
    ],
  },
  progress: {
    features: [
      {
        id: "phase-1",
        name: "Code Graph MVP",
        status: "completed",
        priority: "high",
        description: "Parse codebase and build graph",
        tasks: ["parse-files", "build-graph", "validate-output"],
      },
      {
        id: "phase-2",
        name: "Architecture Validation",
        status: "completed",
        priority: "high",
        description: "Layer validation and constraint checking",
        tasks: ["layer-rules", "circular-detection", "pre-commit-hook"],
      },
      {
        id: "phase-3",
        name: "Test Intelligence",
        status: "completed",
        priority: "high",
        description: "Test selection and execution",
        tasks: ["test-extraction", "test-selection", "vitest-integration"],
      },
      {
        id: "phase-4",
        name: "MCP Tools",
        status: "completed",
        priority: "high",
        description: "Wire all 14 MCP tools",
        tasks: ["tool-schemas", "tool-handlers", "claude-integration"],
      },
      {
        id: "phase-5",
        name: "Progress Tracking",
        status: "in-progress",
        priority: "medium",
        description: "Track features and tasks",
        tasks: ["config-progress", "seed-nodes", "persistence"],
      },
    ],
  },
};

export async function loadConfig(): Promise<Config> {
  const configPath = path.join(process.cwd(), ".code-graph", "config.json");

  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn("[Config] Error loading config file:", error);
  }

  return DEFAULT_CONFIG;
}

export function saveConfig(config: Config, configPath?: string): void {
  const targetPath =
    configPath || path.join(process.cwd(), ".code-graph", "config.json");
  const dir = path.dirname(targetPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2));
}
