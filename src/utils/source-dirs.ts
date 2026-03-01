/**
 * @file utils/source-dirs
 * @description Shared source directory candidate list used by both
 * session-manager (resolveProjectContext) and setup_copilot_instructions.
 */

/**
 * Ordered list of conventional source directory names to probe.
 * The first existing directory is used; falls back to "src" if none exist.
 */
export const CANDIDATE_SOURCE_DIRS = ["src", "lib", "app", "packages", "source"] as const;
