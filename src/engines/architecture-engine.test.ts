import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import GraphIndexManager from "../graph/index.js";
import {
  ArchitectureEngine,
  type ArchitectureRule,
  type LayerDefinition,
} from "./architecture-engine.js";

const layers: LayerDefinition[] = [
  {
    id: "core",
    name: "Core",
    paths: ["src/core/**"],
    canImport: ["*"],
    description: "Core",
  },
  {
    id: "feature",
    name: "Feature",
    paths: ["src/feature/**"],
    canImport: ["core"],
    cannotImport: ["ui"],
    description: "Feature",
  },
  {
    id: "ui",
    name: "UI",
    paths: ["src/ui/**"],
    canImport: ["feature", "core"],
    description: "UI",
  },
];

const rules: ArchitectureRule[] = [
  {
    id: "no-forbidden-imports",
    severity: "error",
    pattern: "*",
    description: "No forbidden imports",
  },
];

describe("ArchitectureEngine", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it("reports forbidden layer imports", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-engine-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "feature"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "ui"), { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, "feature", "feature-a.ts"),
      "import { view } from '../ui/view';\nexport const x = view;\n",
    );
    fs.writeFileSync(
      path.join(srcDir, "ui", "view.ts"),
      "export const view = 1;\n",
    );

    process.chdir(root);

    const engine = new ArchitectureEngine(
      layers,
      rules,
      new GraphIndexManager(),
    );
    const result = await engine.validate([
      "src/feature/feature-a.ts",
      "src/ui/view.ts",
    ]);

    expect(result.success).toBe(false);
    expect(result.violations.some((v) => v.type === "layer-violation")).toBe(
      true,
    );
    expect(
      result.violations.some((v) => v.message.includes("explicitly forbidden")),
    ).toBe(true);
  });

  it("detects circular dependencies during validation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "arch-cycle-"));
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "feature"), { recursive: true });

    fs.writeFileSync(
      path.join(srcDir, "feature", "a.ts"),
      "import { b } from './b';\nexport const a = b;\n",
    );
    fs.writeFileSync(
      path.join(srcDir, "feature", "b.ts"),
      "import { a } from './a';\nexport const b = a;\n",
    );

    process.chdir(root);

    const engine = new ArchitectureEngine(
      layers,
      rules,
      new GraphIndexManager(),
    );
    const result = await engine.validate();

    expect(result.violations.some((v) => v.type === "circular")).toBe(true);
  });

  it("returns placement suggestion when dependencies are allowed", () => {
    const engine = new ArchitectureEngine(
      layers,
      rules,
      new GraphIndexManager(),
    );
    const suggestion = engine.getSuggestion("Data", "service", ["core"]);

    expect(suggestion).not.toBeNull();
    expect(suggestion?.suggestedLayer.id).toBe("core");
    expect(suggestion?.suggestedPath.startsWith("src/core/")).toBe(true);
  });

  // ── T18 / T19 — arch_suggest regressions (A3) ──────────────────────────────

  // Realistic layer config matching audit-23 code-visual scenario
  const realisticLayers: LayerDefinition[] = [
    {
      id: "components",
      name: "Components",
      paths: ["src/components/**"],
      canImport: ["hooks", "state", "lib", "types", "config"],
      description: "UI components",
    },
    {
      id: "hooks",
      name: "Hooks",
      paths: ["src/hooks/**"],
      canImport: ["state", "lib", "types", "config"],
      description: "React hooks",
    },
    {
      id: "state",
      name: "State",
      paths: ["src/state/**"],
      canImport: ["lib", "types", "config"],
      description: "Application state",
    },
    {
      id: "lib",
      name: "Lib",
      paths: ["src/lib/**"],
      canImport: ["types", "config"],
      description: "Shared library code",
    },
    {
      id: "types",
      name: "Types",
      paths: ["src/types/**"],
      canImport: [],
      description: "Type definitions",
    },
    {
      id: "config",
      name: "Config",
      paths: ["src/config/**"],
      canImport: [],
      description: "Configuration",
    },
  ];

  it("T18: arch_suggest(type=service) does not return src/types/ layer", () => {
    const engine = new ArchitectureEngine(
      realisticLayers,
      rules,
      new GraphIndexManager(),
    );
    // External package deps are not layer IDs and must not restrict layer selection
    const suggestion = engine.getSuggestion("GraphDataService", "service", [
      "react",
      "zustand",
      "d3-force",
    ]);

    expect(suggestion).not.toBeNull();
    expect(
      suggestion!.suggestedPath,
      `Expected path NOT under src/types/ — got: ${suggestion!.suggestedPath}`,
    ).not.toMatch(/^src\/types\//);
    // Should be under src/lib/ (closest match for "service" affinity)
    expect(suggestion!.suggestedPath).toMatch(/^src\/lib\//);
  });

  it("T19: arch_suggest does not duplicate Service suffix in filename", () => {
    const engine = new ArchitectureEngine(
      realisticLayers,
      rules,
      new GraphIndexManager(),
    );
    const suggestion = engine.getSuggestion("GraphDataService", "service", []);

    expect(suggestion).not.toBeNull();
    const suggestedPath = suggestion!.suggestedPath;
    expect(
      suggestedPath,
      `Name must not become GraphDataServiceService — got: ${suggestedPath}`,
    ).not.toContain("GraphDataServiceService");
    // Should end with GraphDataService.ts
    expect(suggestedPath).toMatch(/GraphDataService\.ts$/);
  });

  it("T18b: arch_suggest reasoning string is non-empty", () => {
    const engine = new ArchitectureEngine(
      realisticLayers,
      rules,
      new GraphIndexManager(),
    );
    const suggestion = engine.getSuggestion("MyService", "service", []);

    expect(suggestion).not.toBeNull();
    expect(suggestion!.reasoning.trim().length).toBeGreaterThan(0);
  });

  // ── N7 regression — arch_validate uses workspaceRoot, not process.cwd() ───

  it("N7: validate() scans workspaceRoot, not process.cwd()", async () => {
    // Create two separate temp directories
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arch-n7-target-"));
    const decoyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arch-n7-decoy-"));

    // Put a .ts file with a layer violation in targetRoot
    const srcDir = path.join(targetRoot, "src");
    fs.mkdirSync(path.join(srcDir, "feature"), { recursive: true });
    fs.mkdirSync(path.join(srcDir, "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(srcDir, "feature", "bad.ts"),
      "import { view } from '../ui/view';\nexport const x = view;\n",
    );
    fs.writeFileSync(path.join(srcDir, "ui", "view.ts"), "export const view = 1;\n");

    // decoyRoot has no src/ files — if validate() scans it, result would be clean
    // Set process.cwd() to decoyRoot to verify engine ignores it
    process.chdir(decoyRoot);

    const engine = new ArchitectureEngine(
      layers,
      rules,
      new GraphIndexManager(),
      targetRoot, // explicit workspaceRoot — must be used instead of process.cwd()
    );

    const result = await engine.validate(); // no files arg → must scan targetRoot
    // Must find the layer violation in targetRoot (not the clean decoyRoot)
    expect(result.violations.some((v) => v.type === "layer-violation")).toBe(true);
  });

  it("N7: reload() updates workspaceRoot for subsequent validate() calls", async () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "arch-n7-r1-"));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "arch-n7-r2-"));

    // root2 has a layer violation; root1 is clean
    const src2 = path.join(root2, "src");
    fs.mkdirSync(path.join(src2, "feature"), { recursive: true });
    fs.mkdirSync(path.join(src2, "ui"), { recursive: true });
    fs.writeFileSync(
      path.join(src2, "feature", "bad.ts"),
      "import { view } from '../ui/view';\nexport const x = view;\n",
    );
    fs.writeFileSync(path.join(src2, "ui", "view.ts"), "export const view = 1;\n");

    const index = new GraphIndexManager();
    const engine = new ArchitectureEngine(layers, rules, index, root1);

    // First validate: root1 is clean
    const result1 = await engine.validate();
    expect(result1.violations.filter((v) => v.type === "layer-violation")).toHaveLength(0);

    // After reload with root2, validate must scan root2 and find the violation
    engine.reload(index, "proj2", root2);
    const result2 = await engine.validate();
    expect(result2.violations.some((v) => v.type === "layer-violation")).toBe(true);
  });

  it("external package names in deps do not constrain layer selection", () => {
    const engine = new ArchitectureEngine(
      realisticLayers,
      rules,
      new GraphIndexManager(),
    );
    // With no deps, all layers are eligible; with external deps, same result
    const noDepSuggestion = engine.getSuggestion("MyHook", "hook", []);
    const withExternal = engine.getSuggestion("MyHook", "hook", [
      "react",
      "react-dom",
    ]);

    // External package deps must not block any layer from being selected
    expect(noDepSuggestion?.suggestedLayer.id).toBe(
      withExternal?.suggestedLayer.id,
    );
  });
});
