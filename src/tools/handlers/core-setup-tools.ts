/**
 * @file tools/handlers/core-setup-tools
 * @description Project setup/onboarding tool definitions — init_project_setup, setup_copilot_instructions.
 */

import * as fs from "fs";
import * as path from "path";
import * as z from "zod";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";
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
      "Analyze a repository and generate a tailored .github/copilot-instructions.md file with tech-stack detection, key commands, required session flow, and tool-usage guidance. Makes it immediately efficient to work with the repo via Copilot or any AI assistant.",
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
      if (fs.existsSync(destFile) && !overwrite && !dryRun) {
        return ctx.formatSuccess(
          {
            status: "already_exists",
            path: destFile,
            hint: "Pass overwrite=true to replace it.",
          },
          profile,
          ".github/copilot-instructions.md already exists — skipped",
          "setup_copilot_instructions",
        );
      }

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

        const lines: string[] = [`# Copilot Instructions for ${name}`, ""];
        if (description) {
          lines.push(description, "");
        }

        lines.push("## Primary Goal", "");
        lines.push(
          "Understand the codebase before making changes. Use graph-backed tools first for code intelligence, then fall back to file reads only when needed.",
          "",
        );

        if (stack.length > 0) {
          lines.push("## Runtime Truths", "");
          lines.push(`- **Stack**: ${stack.join(", ")}`);
          lines.push(`- **Source root**: \`${srcDir}/\``);
          if (subDirs.length > 0) {
            lines.push(
              `- **Key directories**: ${subDirs.map((d) => `\`${srcDir}/${d}\``).join(", ")}`,
            );
          }
        }
        if (scripts) {
          lines.push("", "## Available Commands", "", scripts);
        }

        if (isMcpServer) {
          lines.push(
            "",
            "## Required Session Flow",
            "",
            "**One-shot (recommended):**",
            "```",
            'init_project_setup({ projectId: "my-proj", workspaceRoot: "/abs/path" })',
            "```",
            "",
            "**Manual:**",
            "1. `graph_set_workspace({ projectId, workspaceRoot })` — anchor the session",
            '2. `graph_rebuild({ projectId, mode: "full", workspaceRoot })` — capture `txId` from response',
            '3. `graph_health({ profile: "balanced" })` — verify nodes > 0',
            '4. `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) LIMIT 8", language: "cypher", projectId })` — confirm data',
            "",
            "**HTTP transport only:** capture `mcp-session-id` from `initialize` response and include on every request.",
          );
        } else {
          lines.push(
            "",
            "## Required Session Flow",
            "",
            "1. Call `init_project_setup({ projectId, workspaceRoot })` — sets context, triggers graph rebuild, writes copilot instructions.",
            '2. Validate with `graph_health({ profile: "balanced" })`',
            '3. Explore with `graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 10", language: "cypher" })`',
          );
        }

        lines.push(
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
          "| Docs lookup | `search_docs` → `index_docs` if empty | file read |",
          "| Tests after change | `test_select` → `test_run` | `suggest_tests` |",
          "| Track decisions | `episode_add` (DECISION) | — |",
          "| Release agent lock | `agent_release` with `claimId` | — |",
        );

        lines.push(
          "",
          "## Correct Tool Signatures (verified)",
          "",
          "```jsonc",
          `// graph — capture txId from graph_rebuild response for diff_since`,
          `graph_rebuild({ "projectId": "proj", "mode": "full" })  // → { txId }`,
          `diff_since({ "since": "<txId | ISO-8601>" })            // NOT git refs like HEAD~3`,
          "",
          `// semantic`,
          `code_explain({ "element": "SymbolName", "depth": 2 })   // symbol name, NOT qualified ID`,
          `semantic_diff({ "elementId1": "...", "elementId2": "..." })  // NOT elementA/elementB`,
          `semantic_slice({ "symbol": "MyClass" })                 // NOT entryPoint`,
          "",
          `// clustering`,
          `code_clusters({ "type": "file" })  // type: "function"|"class"|"file"  NOT granularity`,
          `arch_suggest({ "name": "NewEngine", "codeType": "engine" })  // NOT codeName`,
          "",
          `// memory — DECISION requires metadata.rationale, type is uppercase`,
          `episode_add({ "type": "DECISION", "content": "...", "outcome": "success",`,
          `             "metadata": { "rationale": "because..." } })`,
          `episode_add({ "type": "LEARNING", "content": "..." })`,
          `decision_query({ "query": "..." })   // NOT topic`,
          `progress_query({ "query": "..." })   // query is required, NOT status`,
          "",
          `// coordination — capture claimId from agent_claim for release`,
          `agent_claim({ "agentId": "a1", "targetId": "src/file.ts", "intent": "..." })  // NOT target`,
          `agent_release({ "claimId": "claim-xxx" })   // NOT agentId/taskId`,
          `context_pack({ "task": "Description..." }) // task string is REQUIRED`,
          "",
          `// tests — suggest_tests needs fully-qualified element ID`,
          `suggest_tests({ "elementId": "proj:file.ts:symbolName:line" })`,
          "```",
        );

        lines.push(
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
        );

        lines.push(
          "",
          "## Copilot Skills — Usage Patterns",
          "",
          "### Explore unfamiliar codebase",
          "```",
          "1. init_project_setup({ projectId, workspaceRoot })",
          '2. graph_query({ query: "MATCH (n) RETURN labels(n)[0], count(n) ORDER BY count(n) DESC LIMIT 10", language: "cypher" })',
          '3. code_explain({ element: "MainEntryPoint" })',
          "```",
          "",
          "### Safe refactor + test impact",
          "```",
          '1. impact_analyze({ changedFiles: ["src/x.ts"] })',
          '2. test_select({ changedFiles: ["src/x.ts"] })',
          '3. arch_validate({ files: ["src/x.ts"] })',
          "4. test_run({ testFiles: [...from test_select...] })",
          '5. episode_add({ type: "DECISION", content: "...", metadata: { rationale: "..." } })',
          "```",
          "",
          "### Multi-agent safe edit",
          "```",
          '1. agent_claim({ agentId, targetId: "src/file.ts", intent: "..." })  → save claimId',
          "2. ... make changes ...",
          '3. agent_release({ claimId, outcome: "done" })',
          "```",
          "",
          "### Docs cold start",
          "```",
          '1. search_docs({ query: "topic" })           — if count=0:',
          '2. index_docs({ paths: ["/abs/README.md"] })',
          '3. search_docs({ query: "topic" })           — now returns results',
          "```",
        );

        lines.push(
          "",
          "## Source of Truth",
          "",
          "`README.md`, `QUICK_START.md`, `ARCHITECTURE.md`.",
        );

        const content = lines.join("\n") + "\n";

        if (dryRun) {
          return ctx.formatSuccess(
            {
              dryRun: true,
              targetPath: destFile,
              content,
            },
            profile,
            "Dry run — copilot-instructions.md content generated (not written)",
            "setup_copilot_instructions",
          );
        }

        const githubDir = path.join(resolvedTarget, ".github");
        if (!fs.existsSync(githubDir)) {
          fs.mkdirSync(githubDir, { recursive: true });
        }
        const alreadyExisted = fs.existsSync(destFile);
        fs.writeFileSync(destFile, content, "utf-8");

        return ctx.formatSuccess(
          {
            status: "created",
            path: destFile,
            projectName: name,
            stackDetected: stack,
            overwritten: overwrite && alreadyExisted,
          },
          profile,
          `Copilot instructions written to ${path.relative(resolvedTarget, destFile)}`,
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
