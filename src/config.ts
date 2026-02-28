/**
 * Configuration loader
 */

import * as fs from "fs";
import * as path from "path";
import { logger } from "./utils/logger.js";

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
    /**
     * Explicit test runner to invoke via `test_run` and `test:affected`.
     * When omitted the runner is auto-detected from the test file extensions
     * (e.g. .py → pytest, .rb → bundle exec rspec, .ts/.js → vitest).
     * @example { "command": "pytest", "args": ["--tb=short"] }
     */
    testRunner?: {
      command: string;
      args?: string[];
    };
    /**
     * Glob patterns used by the architecture engine to discover source files.
     * Defaults to ["src/**\/*.{ts,tsx}"] when not specified.
     * @example ["src/**\/*.py", "lib/**\/*.py"]
     */
    sourceGlobs?: string[];
    /**
     * Default file extension appended when generating new file paths (e.g. via
     * arch_suggest). Defaults to ".ts". Use ".py", ".rb", ".go", etc. for
     * non-TypeScript projects.
     */
    defaultExtension?: string;
  };
  progress?: ProgressConfig;
}

// Generic TypeScript server defaults — create .lxdig/config.json at your project root
// to override with project-specific layers and rules.
// Tip: run arch_suggest to get placement guidance; update this file if suggestions
// look wrong (e.g. always "src/types/").
const DEFAULT_CONFIG: Config = {
  architecture: {
    layers: [
      {
        id: "types",
        name: "Types",
        paths: ["src/types/**"],
        canImport: [],
        description: "Shared type definitions — no runtime dependencies",
      },
      {
        id: "utils",
        name: "Utilities",
        paths: ["src/utils/**", "src/lib/**", "src/helpers/**"],
        canImport: ["types"],
        description: "Stateless utility and helper functions",
      },
      {
        id: "parsers",
        name: "Parsers",
        paths: ["src/parsers/**"],
        canImport: ["types", "utils"],
        description: "File parsers and language-specific analysis",
      },
      {
        id: "graph",
        name: "Graph",
        paths: ["src/graph/**"],
        canImport: ["types", "utils", "parsers"],
        description: "Graph building, caching and Memgraph client",
      },
      {
        id: "vector",
        name: "Vector",
        paths: ["src/vector/**"],
        canImport: ["types", "utils", "graph"],
        description: "Embedding engine and Qdrant client",
      },
      {
        id: "engines",
        name: "Engines",
        paths: ["src/engines/**"],
        canImport: ["types", "utils", "parsers", "graph", "vector"],
        description: "Feature engines — architecture, community, docs, test, progress",
      },
      {
        id: "tools",
        name: "Tools",
        paths: ["src/tools/**"],
        canImport: ["types", "utils", "parsers", "graph", "vector", "engines"],
        description: "MCP tool handlers — highest-level layer, may use all lower layers",
      },
      {
        id: "server",
        name: "Server",
        paths: ["src/*.ts"],
        canImport: ["types", "utils", "graph", "vector", "engines", "tools"],
        description: "Server entry points — wires all layers together",
      },
    ],
    rules: [
      {
        id: "no-tools-in-engines",
        severity: "error",
        pattern: "engines imports from tools",
        description: "Engines must not import from tool handlers",
      },
      {
        id: "no-graph-in-parsers",
        severity: "warn",
        pattern: "parsers imports from graph",
        description: "Parsers should be graph-agnostic for reuse and testability",
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
  const configPath = path.join(process.cwd(), ".lxdig", "config.json");

  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    logger.warn("[Config] Error loading config file:", error);
  }

  return DEFAULT_CONFIG;
}

export function saveConfig(config: Config, configPath?: string): void {
  const targetPath = configPath || path.join(process.cwd(), ".lxdig", "config.json");
  const dir = path.dirname(targetPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2));
}
