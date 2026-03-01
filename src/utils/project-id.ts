/**
 * Project ID persistence
 *
 * Resolves a stable, hash-based 4-char base-36 project identifier from the
 * workspace path and persists it in `.lxdig/project.json`. Subsequent calls
 * with the same workspace return the same ID, preventing collisions between
 * projects that share the same directory basename.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { computeProjectFingerprint } from "./validation.js";

const LXDIG_DIR = ".lxdig";
const PROJECT_FILE = "project.json";

interface ProjectMeta {
  /** 4-char base-36 hash of workspaceRoot — the canonical project identifier */
  projectId: string;
  /** Human-readable label (folder name or user-supplied); not used as a key */
  name: string;
  workspaceRoot: string;
  createdAt: string;
}

/**
 * Return the canonical projectId for a workspace, reading from
 * `.lxdig/project.json` when it exists or generating and persisting a new one.
 *
 * @param workspaceRoot - Absolute path to the project root.
 * @param friendlyName  - Optional human-readable label (stored in project.json
 *                        as `name`, never used as a graph key).
 */
export function resolvePersistedProjectId(
  workspaceRoot: string,
  friendlyName?: string,
): string {
  const lxdigDir = path.join(workspaceRoot, LXDIG_DIR);
  const projectFile = path.join(lxdigDir, PROJECT_FILE);

  if (existsSync(projectFile)) {
    try {
      const meta: ProjectMeta = JSON.parse(readFileSync(projectFile, "utf-8"));
      if (meta.projectId && typeof meta.projectId === "string") {
        return meta.projectId;
      }
    } catch {
      // Corrupt file — fall through to regenerate
    }
  }

  const projectId = computeProjectFingerprint(workspaceRoot);
  const defaultName = path.basename(workspaceRoot).toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const meta: ProjectMeta = {
    projectId,
    name: friendlyName || defaultName,
    workspaceRoot,
    createdAt: new Date().toISOString(),
  };

  try {
    mkdirSync(lxdigDir, { recursive: true });
    writeFileSync(projectFile, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  } catch (err) {
    // Non-fatal: project.json creation failed (e.g., read-only FS).
    // The hash is still returned and used for this session.
  }

  return projectId;
}
