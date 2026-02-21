export type FieldPriority = "required" | "high" | "medium" | "low";

export interface OutputField {
  key: string;
  priority: FieldPriority;
  description: string;
}

export const TOOL_OUTPUT_SCHEMAS: Record<string, OutputField[]> = {
  graph_query: [
    {
      key: "intent",
      priority: "required",
      description: "Detected query intent or cypher mode",
    },
    {
      key: "projectId",
      priority: "required",
      description: "Active project scope",
    },
    {
      key: "count",
      priority: "high",
      description: "Number of returned rows",
    },
    {
      key: "results",
      priority: "high",
      description: "Query result rows",
    },
    {
      key: "workspaceRoot",
      priority: "low",
      description: "Workspace path",
    },
  ],
  graph_health: [
    {
      key: "status",
      priority: "required",
      description: "Health state",
    },
    {
      key: "projectId",
      priority: "required",
      description: "Active project scope",
    },
    {
      key: "graphIndex",
      priority: "high",
      description: "Graph index counts",
    },
    {
      key: "embeddings",
      priority: "medium",
      description: "Embedding status",
    },
    {
      key: "freshness",
      priority: "medium",
      description: "Pending changes and watcher state",
    },
  ],
  graph_rebuild: [
    {
      key: "success",
      priority: "required",
      description: "Whether rebuild request was accepted",
    },
    {
      key: "status",
      priority: "required",
      description: "Queue/execution status",
    },
    {
      key: "projectId",
      priority: "high",
      description: "Project scope",
    },
    {
      key: "message",
      priority: "high",
      description: "Human-readable rebuild summary",
    },
    {
      key: "note",
      priority: "low",
      description: "Follow-up hint",
    },
  ],
  context_pack: [
    {
      key: "summary",
      priority: "required",
      description: "Task briefing summary",
    },
    {
      key: "entryPoint",
      priority: "required",
      description: "Best entry file/symbol",
    },
    {
      key: "coreSymbols",
      priority: "high",
      description: "Primary relevant symbols and code slices",
    },
    {
      key: "activeBlockers",
      priority: "high",
      description: "Claims from other agents that block work",
    },
    {
      key: "decisions",
      priority: "medium",
      description: "Relevant decision episodes",
    },
    {
      key: "learnings",
      priority: "medium",
      description: "Relevant learnings",
    },
    {
      key: "episodes",
      priority: "low",
      description: "Recent related episodes",
    },
    {
      key: "pprScores",
      priority: "low",
      description: "Debug PPR score map",
    },
  ],
};

const PRIORITY_ORDER: FieldPriority[] = ["low", "medium", "high"];

export function applyFieldPriority(
  data: Record<string, unknown>,
  schema: OutputField[],
  budget: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data };
  const required = new Set(
    schema.filter((field) => field.priority === "required").map((f) => f.key),
  );

  for (const priority of PRIORITY_ORDER) {
    if (Math.ceil(JSON.stringify(result).length / 4) <= budget) {
      break;
    }

    const candidates = schema
      .filter((field) => field.priority === priority)
      .map((field) => field.key);

    for (const key of candidates) {
      if (required.has(key)) {
        continue;
      }
      if (Math.ceil(JSON.stringify(result).length / 4) <= budget) {
        break;
      }
      if (key in result) {
        delete result[key];
      }
    }
  }

  return result;
}
