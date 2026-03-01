import * as fs from "fs";
import * as env from "../env.js";
import path from "path";
import { logger } from "../utils/logger";
import type { ProjectContext, runtimeContextResult, ToolContext } from "./handler.interface";
import { resolvePersistedProjectId } from "../utils/project-id";
import { getRequestContext } from "../request-context";
import type { ProgressEngine } from "../engines/progress-engine";
import type { TestEngine } from "../engines/test-engine";
import type ArchitectureEngine from "../engines/architecture-engine";
import { computeProjectFingerprint } from "../utils/validation";
import { CANDIDATE_SOURCE_DIRS } from "../utils/source-dirs";

export abstract class SessionManager {
  protected defaultActiveProjectContext: ProjectContext;
  protected sessionProjectContexts = new Map<string, ProjectContext>();

  constructor(public readonly context: ToolContext) {
    this.defaultActiveProjectContext = this.defaultProjectContext();
  }
  public getCurrentSessionId(): string | undefined {
    const sessionId = getRequestContext().sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return undefined;
    }

    return sessionId;
  }

  public getActiveProjectContext(): ProjectContext {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      return this.defaultActiveProjectContext;
    }

    return this.sessionProjectContexts.get(sessionId) || this.defaultActiveProjectContext;
  }

  public setActiveProjectContext(context: ProjectContext): void {
    const sessionId = this.getCurrentSessionId();
    if (!sessionId) {
      this.defaultActiveProjectContext = context;
    } else {
      this.sessionProjectContexts.set(sessionId, context);
    }

    // Reload engines with new project context
    this.reloadEnginesForContext(context);
  }

  protected reloadEnginesForContext(
    context: ProjectContext,
    progressEngine?: ProgressEngine,
    testEngine?: TestEngine,
    archEngine?: ArchitectureEngine,
  ): void {
    logger.error(`[ToolHandlers] Reloading engines for project context: ${context.projectId}`);

    try {
      progressEngine?.reload(this.context.index, context.projectId);
      testEngine?.reload(this.context.index, context.projectId);
      if (archEngine) {
        archEngine.reload(this.context.index, context.projectId, context.workspaceRoot);
      }
    } catch (error) {
      logger.error("[ToolHandlers] Failed to reload engines:", error);
    }
  }

  protected defaultProjectContext(): ProjectContext {
    const workspaceRoot = env.LXDIG_WORKSPACE_ROOT;
    const sourceDir = env.GRAPH_SOURCE_DIR;
    const projectId = env.LXDIG_PROJECT_ID;

    return {
      workspaceRoot,
      sourceDir,
      projectId,
      projectFingerprint: computeProjectFingerprint(workspaceRoot),
    };
  }

  public resolveProjectContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
    const base = this.getActiveProjectContext() || this.defaultProjectContext();
    const workspaceProvided =
      typeof overrides.workspaceRoot === "string" && overrides.workspaceRoot.trim().length > 0;
    const workspaceInput = workspaceProvided
      ? (overrides.workspaceRoot as string)
      : base.workspaceRoot;
    const workspaceRoot = path.resolve(workspaceInput);
    const sourceInput =
      overrides.sourceDir ||
      CANDIDATE_SOURCE_DIRS.map((d) => path.join(workspaceRoot, d)).find((p) =>
        fs.existsSync(p),
      ) ||
      path.join(workspaceRoot, "src");
    const sourceDir = path.isAbsolute(sourceInput)
      ? sourceInput
      : path.resolve(workspaceRoot, sourceInput);
    // The user-supplied projectId is treated as a human-readable label only.
    // The canonical graph key is always the 4-char base-36 fingerprint stored
    // in .lxdig/project.json, ensuring uniqueness across same-named directories.
    const friendlyName =
      overrides.projectId || (workspaceProvided ? undefined : env.LXDIG_PROJECT_ID) || undefined;
    const projectId = resolvePersistedProjectId(workspaceRoot, friendlyName);

    return {
      workspaceRoot,
      sourceDir,
      projectId,
      projectFingerprint: projectId, // fingerprint IS the canonical id now
    };
  }

  public adaptWorkspaceForRuntime(context: ProjectContext): runtimeContextResult {
    if (fs.existsSync(context.workspaceRoot)) {
      return { context, usedFallback: false };
    }

    const fallbackRoot = env.LXDIG_WORKSPACE_ROOT;
    if (!fallbackRoot || !fs.existsSync(fallbackRoot)) {
      return { context, usedFallback: false };
    }

    let mappedSourceDir = context.sourceDir;
    if (path.isAbsolute(context.sourceDir) && context.sourceDir.startsWith(context.workspaceRoot)) {
      const relativeSource = path.relative(context.workspaceRoot, context.sourceDir);
      mappedSourceDir = path.resolve(fallbackRoot, relativeSource);
    }

    return {
      usedFallback: true,
      fallbackReason:
        "Requested workspace path is not directly accessible in current runtime; using mounted workspace root.",
      context: {
        ...context,
        workspaceRoot: fallbackRoot,
        sourceDir: mappedSourceDir,
      },
    };
  }

  public runtimePathFallbackAllowed(): boolean {
    return env.LXDIG_ALLOW_RUNTIME_PATH_FALLBACK;
  }

  public watcherEnabledForRuntime(): boolean {
    return env.MCP_TRANSPORT === "http" || env.LXDIG_ENABLE_WATCHER;
  }
}
