/**
 * Documentation Tools
 * Registry-backed documentation tool definitions.
 *
 * Tools:
 * - index_docs: index documentation files in workspace
 * - search_docs: search indexed documentation
 */

import * as z from "zod";
import type { HandlerBridge, ToolDefinition , ToolArgs } from "../types.js";

export const docsToolDefinitions: ToolDefinition[] = [
  {
    name: "index_docs",
    category: "docs",
    description:
      "Discover and index all markdown documentation files (README, ADRs, guides, CHANGELOG, ARCHITECTURE) under the workspace root into DOCUMENT and SECTION graph nodes. Supports incremental mode (skips unchanged files). Emits DOC_DESCRIBES edges linking sections to the code symbols they mention.",
    inputShape: {
      workspaceRoot: z
        .string()
        .optional()
        .describe("Workspace root path (defaults to active session context)"),
      projectId: z.string().optional().describe("Project ID (defaults to active session context)"),
      incremental: z
        .boolean()
        .default(true)
        .describe("Skip files whose hash has not changed (default: true)"),
      withEmbeddings: z
        .boolean()
        .default(false)
        .describe("Also embed section content into Qdrant vector store"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const {
        workspaceRoot: argsRoot,
        projectId: argsProject,
        incremental = true,
        withEmbeddings = false,
      } = args ?? {};
      try {
        const { workspaceRoot, projectId } = ctx.resolveProjectContext({
          workspaceRoot: argsRoot,
          projectId: argsProject,
        });

        const docsEngine = ctx.engines.docs as
          | {
              indexWorkspace: (
                workspaceRoot: string,
                projectId: string,
                options: { incremental: boolean; withEmbeddings: boolean },
              ) => Promise<{
                indexed: number;
                skipped: number;
                errors: unknown[];
                durationMs: number;
              }>;
            }
          | undefined;

        if (!docsEngine) {
          return ctx.errorEnvelope("ENGINE_UNAVAILABLE", "DocsEngine not initialised", false);
        }

        const result = await docsEngine.indexWorkspace(workspaceRoot, projectId, {
          incremental,
          withEmbeddings,
        });

        return ctx.formatSuccess(
          {
            ok: true,
            indexed: result.indexed,
            skipped: result.skipped,
            errorCount: result.errors.length,
            errors: result.errors.slice(0, 10),
            durationMs: result.durationMs,
            projectId,
            workspaceRoot,
          },
          "compact",
        );
      } catch (err) {
        return ctx.errorEnvelope(
          "INDEX_DOCS_ERROR",
          err instanceof Error ? err.message : String(err),
          true,
        );
      }
    },
  },
  {
    name: "search_docs",
    category: "docs",
    description:
      "Search indexed documentation sections by full-text query or by code symbol name. Returns matching SECTION nodes with heading, source document, kind (readme/adr/guide/…), line number, relevance score, and a short content excerpt. Run index_docs first to populate the index.",
    inputShape: {
      query: z
        .string()
        .optional()
        .describe("Full-text search query (cannot be combined with symbol)"),
      symbol: z
        .string()
        .optional()
        .describe(
          "Symbol name to look up (finds Sections that document this function/class/file via DOC_DESCRIBES edges)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe("Maximum number of results to return"),
      projectId: z.string().optional().describe("Project ID (defaults to active session context)"),
    },
    async impl(rawArgs: ToolArgs, ctx: HandlerBridge): Promise<string> {
      // Args validated by Zod inputShape; local alias preserves existing acc patterns
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args: any = rawArgs;
      const { query, symbol, limit = 10, projectId: argsProject } = args ?? {};
      try {
        const { projectId } = ctx.resolveProjectContext({
          projectId: argsProject,
        });

        const docsEngine = ctx.engines.docs as
          | {
              getDocsBySymbol: (
                symbol: string,
                projectId: string,
                options: { limit: number },
              ) => Promise<any[]>;
              searchDocs: (
                query: string,
                projectId: string,
                options: { limit: number },
              ) => Promise<any[]>;
            }
          | undefined;

        if (!docsEngine) {
          return ctx.errorEnvelope("ENGINE_UNAVAILABLE", "DocsEngine not initialised", false);
        }

        let results;
        if (typeof symbol === "string" && symbol.trim().length > 0) {
          results = await docsEngine.getDocsBySymbol(symbol.trim(), projectId, {
            limit,
          });
        } else if (typeof query === "string" && query.trim().length > 0) {
          results = await docsEngine.searchDocs(query.trim(), projectId, {
            limit,
          });
        } else {
          return ctx.errorEnvelope(
            "MISSING_PARAM",
            "Provide either `query` (full-text search) or `symbol` (symbol lookup)",
            true,
          );
        }

        return ctx.formatSuccess(
          {
            ok: true,
            count: results.length,
            results: results.map((r: Record<string, unknown>) => ({
              heading: r.heading,
              doc: r.docRelativePath,
              kind: r.kind,
              startLine: r.startLine,
              score: r.score,
              excerpt: String(r.content || "").slice(0, 200),
            })),
            projectId,
          },
          "compact",
        );
      } catch (err) {
        return ctx.errorEnvelope(
          "SEARCH_DOCS_ERROR",
          err instanceof Error ? err.message : String(err),
          true,
        );
      }
    },
  },
];
