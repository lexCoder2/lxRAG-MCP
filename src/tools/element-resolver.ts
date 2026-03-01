/**
 * ElementResolver
 * Single responsibility: resolve an element ID string to the corresponding
 * GraphNode in the in-memory index, applying multiple fallback strategies.
 * Extracted from ToolHandlerBase (SRP / SOLID refactor).
 */
import * as path from "path";
import type { GraphNode, GraphIndexManager } from "../graph/index.js";

export class ElementResolver {
  resolve(
    elementId: string,
    index: GraphIndexManager,
    projectId: string,
  ): GraphNode | undefined {
    const requested = String(elementId || "").trim();
    if (!requested) return undefined;

    // Exact match first, then try with active projectId prefix
    const exact =
      index.getNode(requested) ||
      (projectId && !requested.startsWith(`${projectId}:`)
        ? index.getNode(`${projectId}:${requested}`)
        : undefined);
    if (exact) return exact;

    const normalizedPath = requested.replace(/\\/g, "/");
    const basename = path.basename(normalizedPath);

    // Parse structured IDs like "file.ts:symbolName:lineNum"
    const parts = requested.split(":");
    const scopedTail = parts.length > 1 ? parts[parts.length - 1] : requested;
    const scopedName =
      parts.length > 2 && /^\d+$/.test(scopedTail) ? parts[parts.length - 2] : scopedTail;
    const symbolTail = requested.includes("::") ? requested.split("::").slice(-1)[0] : scopedName;

    const files = index.getNodesByType("FILE");
    const functions = index.getNodesByType("FUNCTION");
    const classes = index.getNodesByType("CLASS");

    return (
      files.find((node) => {
        const nodePath = String(
          node.properties.path || node.properties.filePath || node.properties.relativePath || "",
        ).replace(/\\/g, "/");
        return (
          nodePath === normalizedPath ||
          nodePath.endsWith(normalizedPath) ||
          normalizedPath.endsWith(nodePath) ||
          path.basename(nodePath) === basename ||
          node.id === requested ||
          node.id.endsWith(`:${normalizedPath}`)
        );
      }) ||
      functions.find((node) => {
        const name = String(node.properties.name || "");
        return (
          name === requested ||
          name === scopedTail ||
          name === scopedName ||
          name === symbolTail ||
          node.id === requested ||
          node.id.endsWith(`:${requested}`)
        );
      }) ||
      classes.find((node) => {
        const name = String(node.properties.name || "");
        return (
          name === requested ||
          name === scopedTail ||
          name === scopedName ||
          name === symbolTail ||
          node.id === requested ||
          node.id.endsWith(`:${requested}`)
        );
      })
    );
  }
}
