/**
 * @file tools/handlers/core-setup-tools
 * @description Project setup/onboarding tool definitions — init_project_setup, setup_copilot_instructions.
 */

import * as fs from "fs";
import * as path from "path";
import * as z from "zod";
import type { HandlerBridge, ToolDefinition, ToolArgs } from "../types.js";
import { CANDIDATE_SOURCE_DIRS } from "../../utils/source-dirs.js";

export const coreSetupToolDefinitions: ToolDefinition[] = [
  {
    name: "init_project_setup",
    category: "setup",
    description:
      "One-shot project initialization: sets workspace context, triggers graph rebuild, and generates .github/copilot-instructions.md if not present. Use this as the first step when onboarding a new project or starting a fresh session.",
    inputShape: {
      workspaceRoot: z.string().describe("Absolute path to the project root to initialize"),
      sourceDir: z
        .string()
        .optional()
        .describe("Source directory relative to workspaceRoot (default: src)"),
      projectId: z
        .string()
        .optional()
        .describe("Project identifier (default: basename of workspaceRoot)"),
      rebuildMode: z
        .enum(["incremental", "full"])
        .default("incremental")
        .describe("incremental = changed files only; full = rebuild entire graph"),
      withDocs: z.boolean().default(true).describe("Also index markdown docs during rebuild"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        workspaceRoot,
        sourceDir,
        projectId,
        rebuildMode = "incremental",
        withDocs = true,
        profile = "compact",
      } = args ?? {};

      if (!workspaceRoot || typeof workspaceRoot !== "string") {
        return ctx.errorEnvelope(
          "INIT_MISSING_WORKSPACE",
          "workspaceRoot is required",
          false,
          "Provide the absolute path to the project you want to initialize.",
        );
      }

      const resolvedRoot = path.resolve(workspaceRoot);
      if (!fs.existsSync(resolvedRoot)) {
        return ctx.errorEnvelope(
          "INIT_WORKSPACE_NOT_FOUND",
          `Workspace path does not exist: ${resolvedRoot}`,
          false,
          "Ensure the project is accessible from this machine/container.",
        );
      }

      const steps: Array<{ step: string; status: string; detail?: string }> = [];

      try {
        const setArgs: any = { workspaceRoot: resolvedRoot, profile };
        if (sourceDir) setArgs.sourceDir = sourceDir;
        if (projectId) setArgs.projectId = projectId;

        let setResult: string;
        try {
          setResult = await ctx.callTool("graph_set_workspace", setArgs);
          const setJson = JSON.parse(setResult);
          if (setJson?.error) {
            steps.push({
              step: "graph_set_workspace",
              status: "failed",
              detail: setJson.error?.reason ?? setJson.error,
            });
            return ctx.errorEnvelope(
              "INIT_WORKSPACE_SETUP_FAILED",
              `Workspace setup failed: ${setJson.error?.reason ?? JSON.stringify(setJson.error)}`,
              false,
              "Check workspaceRoot and sourceDir parameters.",
            );
          }
          const setCtx = setJson?.data?.projectContext ?? setJson?.data ?? {};
          steps.push({
            step: "graph_set_workspace",
            status: "ok",
            detail: `projectId=${setCtx.projectId ?? "?"}, sourceDir=${setCtx.sourceDir ?? "?"}`,
          });
        } catch (err) {
          steps.push({
            step: "graph_set_workspace",
            status: "failed",
            detail: String(err),
          });
          return ctx.errorEnvelope(
            "INIT_WORKSPACE_SETUP_FAILED",
            `Workspace setup failed: ${String(err)}`,
            false,
            "Check workspaceRoot and sourceDir parameters.",
          );
        }

        const rebuildArgs: any = {
          workspaceRoot: resolvedRoot,
          mode: rebuildMode,
          indexDocs: withDocs,
          profile,
        };
        if (sourceDir) rebuildArgs.sourceDir = sourceDir;
        if (projectId) rebuildArgs.projectId = projectId;

        try {
          const rebuildResult = await ctx.callTool("graph_rebuild", rebuildArgs);
          const rebuildJson = JSON.parse(rebuildResult);
          if (rebuildJson?.error) {
            steps.push({
              step: "graph_rebuild",
              status: "failed",
              detail: rebuildJson.error?.reason ?? rebuildJson.error,
            });
            return ctx.errorEnvelope(
              "INIT_REBUILD_FAILED",
              `Graph rebuild failed: ${rebuildJson.error?.reason ?? JSON.stringify(rebuildJson.error)}`,
              true,
              "Check that the source directory exists and contains parseable source files.",
            );
          } else {
            steps.push({
              step: "graph_rebuild",
              status: "queued",
              detail: `mode=${rebuildMode}, indexDocs=${withDocs}`,
            });
          }
        } catch (err) {
          steps.push({
            step: "graph_rebuild",
            status: "failed",
            detail: String(err),
          });
          return ctx.errorEnvelope(
            "INIT_REBUILD_FAILED",
            `Graph rebuild failed: ${String(err)}`,
            true,
            "Check that the source directory exists and contains parseable source files.",
          );
        }

        const copilotPath = path.join(resolvedRoot, ".github", "copilot-instructions.md");
        if (!fs.existsSync(copilotPath)) {
          const ciResult = await ctx.callTool("setup_copilot_instructions", {
            targetPath: resolvedRoot,
            dryRun: false,
            overwrite: false,
            profile: "compact",
          });
          try {
            const ciJson = JSON.parse(ciResult);
            if (ciJson?.error) {
              steps.push({
                step: "setup_copilot_instructions",
                status: "failed",
                detail: ciJson.error?.reason ?? String(ciJson.error),
              });
            } else {
              steps.push({
                step: "setup_copilot_instructions",
                status: "created",
                detail: ciJson?.data?.path ?? ".github/copilot-instructions.md",
              });
            }
          } catch {
            steps.push({
              step: "setup_copilot_instructions",
              status: "created",
              detail: ".github/copilot-instructions.md",
            });
          }
        } else {
          steps.push({
            step: "setup_copilot_instructions",
            status: "exists",
            detail: "File already present — skipped",
          });
        }

        const projCtx = ctx.resolveProjectContext({
          workspaceRoot: resolvedRoot,
          ...(sourceDir ? { sourceDir } : {}),
          ...(projectId ? { projectId } : {}),
        });

        return ctx.formatSuccess(
          {
            projectId: projCtx.projectId,
            workspaceRoot: projCtx.workspaceRoot,
            sourceDir: projCtx.sourceDir,
            steps,
            nextAction:
              "Call graph_health to confirm the rebuild completed, then graph_query to start exploring.",
          },
          profile,
          `Project ${projCtx.projectId} initialized — graph rebuild queued`,
          "init_project_setup",
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "INIT_PROJECT_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  },
  {
    name: "setup_copilot_instructions",
    category: "setup",
    description:
      "Analyze a repository and generate two files: a lean .github/copilot-instructions.md (project-specific facts only — stack, commands, lxDIG bootstrap) and a .github/lxdig-agent-guide.md (full tool-reference guide with correct signatures, decision table, pitfalls, and usage patterns). The guide is read on demand so it does not saturate the ambient instruction context.",
    inputShape: {
      targetPath: z
        .string()
        .optional()
        .describe("Absolute path to the target repository (defaults to the active workspace)"),
      projectName: z.string().optional().describe("Override the detected project name"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Return the generated content without writing the file"),
      overwrite: z.boolean().default(false).describe("Replace an existing copilot-instructions.md"),
      profile: z
        .enum(["compact", "balanced", "debug"])
        .default("compact")
        .describe("Response profile"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        targetPath,
        projectName: forceProjectName,
        dryRun = false,
        overwrite = false,
        profile = "compact",
      } = args ?? {};

      let resolvedTarget: string;
      if (targetPath && typeof targetPath === "string") {
        resolvedTarget = path.resolve(targetPath);
      } else {
        const active = ctx.resolveProjectContext({});
        resolvedTarget = active.workspaceRoot;
      }

      if (!fs.existsSync(resolvedTarget) || !fs.statSync(resolvedTarget).isDirectory()) {
        return ctx.errorEnvelope(
          "COPILOT_INSTR_TARGET_NOT_FOUND",
          `Target path does not exist or is not a directory: ${resolvedTarget}`,
          false,
          "Provide an accessible absolute directory path via targetPath parameter.",
        );
      }

      const destFile = path.join(resolvedTarget, ".github", "copilot-instructions.md");
      // copilot-instructions.md is optional / user-owned: skip if exists unless overwrite is set.
      // lxdig-agent-guide.md is lxDIG-owned and always regenerated.
      const skipCopilotInstructions = fs.existsSync(destFile) && !overwrite && !dryRun;

      try {
        const repoName = forceProjectName || path.basename(resolvedTarget);
        const pkgPath = path.join(resolvedTarget, "package.json");
        const pkgJson: any = fs.existsSync(pkgPath)
          ? JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
          : null;

        const name = forceProjectName || pkgJson?.name || repoName;
        const description = pkgJson?.description || "";
        const deps: Record<string, string> = {
          ...(pkgJson?.dependencies ?? {}),
          ...(pkgJson?.devDependencies ?? {}),
        };

        const stack: string[] = [];
        const isTypeScript =
          fs.existsSync(path.join(resolvedTarget, "tsconfig.json")) || !!deps["typescript"];
        const isNode = !!pkgJson || fs.existsSync(path.join(resolvedTarget, "package.json"));
        const isPython =
          fs.existsSync(path.join(resolvedTarget, "pyproject.toml")) ||
          fs.existsSync(path.join(resolvedTarget, "setup.py")) ||
          fs.existsSync(path.join(resolvedTarget, "requirements.txt"));
        const isGo = fs.existsSync(path.join(resolvedTarget, "go.mod"));
        const isRust = fs.existsSync(path.join(resolvedTarget, "Cargo.toml"));
        const isJava =
          fs.existsSync(path.join(resolvedTarget, "pom.xml")) ||
          fs.existsSync(path.join(resolvedTarget, "build.gradle"));
        const isReact = !!deps["react"];
        const isNextJs = !!deps["next"];
        const isDocker =
          fs.existsSync(path.join(resolvedTarget, "Dockerfile")) ||
          fs.existsSync(path.join(resolvedTarget, "docker-compose.yml"));

        if (isTypeScript) stack.push("TypeScript");
        else if (isNode) stack.push("JavaScript / Node.js");
        if (isPython) stack.push("Python");
        if (isGo) stack.push("Go");
        if (isRust) stack.push("Rust");
        if (isJava) stack.push("Java");
        if (isNextJs) stack.push("Next.js");
        else if (isReact) stack.push("React");
        if (isDocker) stack.push("Docker");

        const scripts = pkgJson?.scripts
          ? Object.entries(pkgJson.scripts)
              .slice(0, 10)
              .map(([k, v]) => `- \`${k}\`: \`${v}\``)
              .join("\n")
          : "";

        const srcDir =
          CANDIDATE_SOURCE_DIRS.find((d) => fs.existsSync(path.join(resolvedTarget, d))) ?? "src";

        const srcPath = path.join(resolvedTarget, srcDir);
        let subDirs: string[] = [];
        if (fs.existsSync(srcPath)) {
          try {
            subDirs = fs
              .readdirSync(srcPath, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .slice(0, 10);
          } catch {
            // ignore
          }
        }

        const isMcpServer =
          !!deps["@modelcontextprotocol/sdk"] ||
          fs.existsSync(path.join(resolvedTarget, "src", "mcp-server.ts")) ||
          fs.existsSync(path.join(resolvedTarget, "src", "server.ts"));

        // ── copilot-instructions.md — lean, project-specific facts only ──────────
        // The detailed lxDIG tool reference lives in .github/lxdig-agent-guide.md
        // so it doesn't saturate the ambient instruction context.
        const lines: string[] = [`# ${name}`, ""];
        if (description) {
          lines.push(description, "");
        }

        if (stack.length > 0) {
          lines.push("## Stack & Build", "");
          lines.push(`- **Stack**: ${stack.join(", ")}`);
          lines.push(`- **Source root**: \`${srcDir}/\``);
          if (subDirs.length > 0) {
            lines.push(
              `- **Key directories**: ${subDirs.map((d) => `\`${srcDir}/${d}\``).join(", ")}`,
            );
          }
        }
        if (scripts) {
          lines.push("", "## Commands", "", scripts);
        }

        // One-shot bootstrap — minimal, just enough to get the agent started.
        lines.push(
          "",
          "## lxDIG Agent Bootstrap",
          "",
          "This project is indexed by lxDIG. Start every session with:",
          "```",
          `init_project_setup({ projectId: "${name}", workspaceRoot: "/abs/path/to/${path.basename(resolvedTarget)}" })`,
          `graph_health({ profile: "balanced" })`,
          "```",
          "",
          isMcpServer
            ? "**HTTP transport:** capture `mcp-session-id` from `initialize` and include it on every request."
            : "",
          "",
          "> For lxDIG tool reference, correct signatures, common pitfalls, and usage patterns",
          "> → read `.github/lxdig-agent-guide.md`",
        );

        const content =
          lines
            .filter((l) => l !== undefined)
            .join("\n")
            .trimEnd() + "\n";

        // ── .github/lxdig-agent-guide.md — detailed reference, read on demand ──
        const guideLines: string[] = [
          `# lxDIG Agent Guide — ${name}`,
          "",
          "Reference for agents working with this codebase via lxDIG tools.",
          "Read this file when you need tool details — do not inline it into copilot-instructions.md.",
          "",
          "## Tool Decision Guide",
          "",
          "| Goal | First choice | Fallback |",
          "|---|---|---|",
          "| Count/list nodes | `graph_query` (Cypher) | `graph_health` |",
          "| Understand a symbol | `code_explain` (symbol name) | `semantic_slice` |",
          "| Find related code | `find_similar_code` | `semantic_search` |",
          "| Check arch violations | `arch_validate` | `blocking_issues` |",
          "| Place new code | `arch_suggest` | — |",
          "| Docs lookup | `search_docs` → `index_docs` if count=0 | file read |",
          "| Tests for changed code | `test_select` → `test_run` | `suggest_tests` |",
          "| Record a design choice | `episode_add` (type: DECISION) | — |",
          "| Release an agent lock | `agent_release` with `claimId` | — |",
          "",
          "## Correct Tool Signatures",
          "",
          "```jsonc",
          "// Session start",
          `init_project_setup({ "projectId": "proj", "workspaceRoot": "/abs/path" })`,
          `graph_health({ "profile": "balanced" })`,
          "",
          "// Graph — capture txId from graph_rebuild for use in diff_since",
          `graph_rebuild({ "projectId": "proj", "mode": "full" })   // → { txId }`,
          `diff_since({ "since": "<txId | ISO-8601>" })             // NOT a git ref`,
          "",
          "// Semantic",
          `code_explain({ "element": "SymbolName", "depth": 2 })    // symbol name, NOT qualified ID`,
          `semantic_diff({ "elementId1": "...", "elementId2": "..." })  // NOT elementA/elementB`,
          `semantic_slice({ "symbol": "MyClass" })                  // NOT entryPoint`,
          `find_similar_code({ "description": "...", "type": "function" })`,
          "",
          "// Architecture",
          `code_clusters({ "type": "file" })  // type: "function"|"class"|"file"  NOT granularity`,
          `arch_suggest({ "name": "NewEngine", "codeType": "engine" })  // NOT codeName`,
          `arch_validate({ "files": ["src/x.ts"] })`,
          "",
          "// Memory — DECISION requires metadata.rationale; all types are UPPERCASE",
          `episode_add({ "type": "DECISION", "content": "...", "outcome": "success",`,
          `             "metadata": { "rationale": "because..." } })`,
          `episode_add({ "type": "LEARNING", "content": "..." })`,
          `decision_query({ "query": "..." })   // NOT topic`,
          `progress_query({ "query": "..." })   // query is required, NOT status`,
          `context_pack({ "task": "Description..." })  // task string is REQUIRED`,
          "",
          "// Coordination — capture claimId from agent_claim, pass it to agent_release",
          `agent_claim({ "agentId": "a1", "targetId": "src/file.ts", "intent": "edit X" })  // NOT target`,
          `agent_release({ "claimId": "claim-xxx" })  // NOT agentId/taskId`,
          "",
          "// Tests — suggest_tests needs a fully-qualified element ID",
          `suggest_tests({ "elementId": "proj:file.ts:symbolName:line" })`,
          `test_select({ "changedFiles": ["src/x.ts"] })`,
          `test_run({ "testFiles": ["..."] })`,
          "```",
          "",
          "## Common Pitfalls",
          "",
          "| Wrong | Correct |",
          "|---|---|",
          '| `code_explain({ elementId: ... })` | `code_explain({ element: "SymbolName" })` |',
          "| `semantic_diff({ elementA, elementB })` | `semantic_diff({ elementId1, elementId2 })` |",
          '| `code_clusters({ granularity: "module" })` | `code_clusters({ type: "file" })` |',
          '| `arch_suggest({ codeName: "X" })` | `arch_suggest({ name: "X" })` |',
          '| `episode_add({ type: "decision" })` | `episode_add({ type: "DECISION" })` (uppercase) |',
          '| DECISION without `metadata.rationale` | always include `metadata: { rationale: "..." }` |',
          '| `decision_query({ topic: "X" })` | `decision_query({ query: "X" })` |',
          '| `agent_claim({ target: "f.ts" })` | `agent_claim({ targetId: "f.ts" })` |',
          '| `agent_release({ agentId, taskId })` | `agent_release({ claimId: "claim-xxx" })` |',
          '| `diff_since({ since: "HEAD~3" })` | `diff_since({ since: "<txId from graph_rebuild>" })` |',
          "",
          "## Usage Patterns",
          "",
          "### Explore an unfamiliar codebase",
          "```",
          "1. init_project_setup({ projectId, workspaceRoot })",
          '2. graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 10", language: "cypher" })',
          '3. code_explain({ element: "MainEntryPoint" })',
          '4. code_clusters({ type: "file" })   // identify module groups',
          "```",
          "",
          "### Safe refactor with impact analysis",
          "```",
          '1. impact_analyze({ changedFiles: ["src/x.ts"] })',
          '2. test_select({ changedFiles: ["src/x.ts"] })',
          '3. arch_validate({ files: ["src/x.ts"] })',
          "4. // make your changes",
          "5. test_run({ testFiles: [...from test_select...] })",
          '6. episode_add({ type: "DECISION", content: "why I changed X",',
          '               metadata: { rationale: "..." } })',
          "```",
          "",
          "### Multi-agent safe edit (claim → change → release)",
          "```",
          '1. agent_claim({ agentId: "me", targetId: "src/file.ts", intent: "refactor Y" }) → { claimId }',
          "2. // make changes",
          "3. agent_release({ claimId })  // always release, even on error",
          "```",
          "",
          "### Docs cold start",
          "```",
          '1. search_docs({ query: "topic" })           // if count=0:',
          '2. index_docs({ paths: ["/abs/README.md"] })',
          '3. search_docs({ query: "topic" })           // now returns results',
          "```",
        ];
        const guideContent = guideLines.join("\n") + "\n";

        if (dryRun) {
          return ctx.formatSuccess(
            {
              dryRun: true,
              targetPath: destFile,
              agentGuidePath: path.join(resolvedTarget, ".github", "lxdig-agent-guide.md"),
              content,
              agentGuideContent: guideContent,
            },
            profile,
            "Dry run — copilot-instructions.md + lxdig-agent-guide.md generated (not written)",
            "setup_copilot_instructions",
          );
        }

        const githubDir = path.join(resolvedTarget, ".github");
        if (!fs.existsSync(githubDir)) {
          fs.mkdirSync(githubDir, { recursive: true });
        }
        const alreadyExisted = fs.existsSync(destFile);

        if (!skipCopilotInstructions) {
          fs.writeFileSync(destFile, content, "utf-8");
        }

        // Always write/overwrite the agent guide — it is lxDIG-owned and must stay current.
        const guideFile = path.join(githubDir, "lxdig-agent-guide.md");
        fs.writeFileSync(guideFile, guideContent, "utf-8");

        return ctx.formatSuccess(
          {
            status: skipCopilotInstructions ? "copilot_instructions_skipped" : "created",
            path: destFile,
            agentGuidePath: guideFile,
            projectName: name,
            stackDetected: stack,
            overwritten: overwrite && alreadyExisted,
            note: skipCopilotInstructions
              ? "copilot-instructions.md was not changed (already exists — use overwrite=true to replace). lxdig-agent-guide.md refreshed."
              : "copilot-instructions.md is project-specific; lxdig-agent-guide.md holds the tool reference.",
          },
          profile,
          skipCopilotInstructions
            ? `lxdig-agent-guide.md refreshed; copilot-instructions.md unchanged (pass overwrite=true to replace)`
            : `Copilot instructions written to ${path.relative(resolvedTarget, destFile)}`,
          "setup_copilot_instructions",
        );
      } catch (error) {
        return ctx.errorEnvelope(
          "SETUP_COPILOT_FAILED",
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    },
  },
];
