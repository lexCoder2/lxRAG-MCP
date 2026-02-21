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
  semantic_slice: [
    {
      key: "symbolName",
      priority: "required",
      description: "Resolved symbol name",
    },
    {
      key: "file",
      priority: "required",
      description: "Source file path",
    },
    {
      key: "startLine",
      priority: "required",
      description: "Slice start line",
    },
    {
      key: "endLine",
      priority: "required",
      description: "Slice end line",
    },
    {
      key: "code",
      priority: "high",
      description: "Extracted source code",
    },
    {
      key: "incomingCallers",
      priority: "medium",
      description: "Callers of the selected symbol",
    },
    {
      key: "outgoingCalls",
      priority: "medium",
      description: "Callees of the selected symbol",
    },
    {
      key: "relevantDecisions",
      priority: "low",
      description: "Related decision episodes",
    },
    {
      key: "relevantLearnings",
      priority: "low",
      description: "Related learning nodes",
    },
  ],
  diff_since: [
    {
      key: "summary",
      priority: "required",
      description: "Human-readable change summary",
    },
    {
      key: "projectId",
      priority: "required",
      description: "Project scope",
    },
    {
      key: "since",
      priority: "high",
      description: "Resolved anchor details",
    },
    {
      key: "added",
      priority: "high",
      description: "Added nodes since anchor",
    },
    {
      key: "removed",
      priority: "high",
      description: "Removed nodes since anchor",
    },
    {
      key: "modified",
      priority: "high",
      description: "Modified nodes since anchor",
    },
    {
      key: "txIds",
      priority: "medium",
      description: "Covered transaction ids",
    },
  ],
  episode_add: [
    { key: "episodeId", priority: "required", description: "Persisted episode id" },
    { key: "type", priority: "required", description: "Episode type" },
    { key: "projectId", priority: "high", description: "Project scope" },
    { key: "taskId", priority: "medium", description: "Optional task id" },
  ],
  episode_recall: [
    { key: "query", priority: "required", description: "Recall query" },
    { key: "count", priority: "required", description: "Episode count" },
    { key: "episodes", priority: "high", description: "Ranked recall results" },
    { key: "projectId", priority: "medium", description: "Project scope" },
    { key: "entityHints", priority: "low", description: "Embedding-derived entity hints" },
  ],
  decision_query: [
    { key: "query", priority: "required", description: "Decision query" },
    { key: "count", priority: "required", description: "Decision count" },
    { key: "decisions", priority: "high", description: "Decision episodes" },
    { key: "projectId", priority: "medium", description: "Project scope" },
  ],
  reflect: [
    { key: "reflectionId", priority: "required", description: "Reflection episode id" },
    { key: "insight", priority: "high", description: "Reflection summary" },
    { key: "learningsCreated", priority: "high", description: "Number of learnings" },
    { key: "patterns", priority: "medium", description: "Recurring entities" },
  ],
  agent_claim: [
    { key: "status", priority: "required", description: "Claim outcome status" },
    { key: "claimId", priority: "high", description: "Claim identifier" },
    { key: "projectId", priority: "high", description: "Project scope" },
    { key: "conflicts", priority: "medium", description: "Conflicting claims" },
  ],
  agent_release: [
    { key: "claimId", priority: "required", description: "Released claim id" },
    { key: "released", priority: "required", description: "Release success flag" },
    { key: "outcome", priority: "medium", description: "Optional release outcome" },
  ],
  agent_status: [
    { key: "agentId", priority: "required", description: "Agent identifier" },
    { key: "activeClaims", priority: "high", description: "Open claims" },
    { key: "recentEpisodes", priority: "medium", description: "Recent episode ids" },
    { key: "projectId", priority: "high", description: "Project scope" },
  ],
  coordination_overview: [
    { key: "activeClaims", priority: "required", description: "Active claim set" },
    { key: "staleClaims", priority: "high", description: "Stale claims" },
    { key: "conflicts", priority: "high", description: "Current conflicts" },
    { key: "projectId", priority: "high", description: "Project scope" },
  ],
  graph_set_workspace: [
    { key: "success", priority: "required", description: "Operation success" },
    { key: "projectContext", priority: "required", description: "Active project context" },
    { key: "watcherState", priority: "high", description: "Watcher runtime state" },
    { key: "pendingChanges", priority: "high", description: "Queued filesystem changes" },
    { key: "message", priority: "medium", description: "Operation summary" },
  ],
  contract_validate: [
    { key: "tool", priority: "required", description: "Validated tool name" },
    { key: "normalized", priority: "required", description: "Normalized arguments" },
    { key: "warnings", priority: "high", description: "Normalization warnings" },
    { key: "valid", priority: "high", description: "Validation result" },
  ],
  progress_query: [
    { key: "type", priority: "required", description: "Progress entity type" },
    { key: "count", priority: "high", description: "Returned items" },
    { key: "items", priority: "high", description: "Progress records" },
  ],
  task_update: [
    { key: "success", priority: "required", description: "Update success" },
    { key: "task", priority: "high", description: "Updated task payload" },
    { key: "postActions", priority: "medium", description: "Triggered side effects" },
  ],
  feature_status: [
    { key: "id", priority: "required", description: "Feature identifier" },
    { key: "status", priority: "required", description: "Feature status" },
    { key: "tasks", priority: "high", description: "Linked tasks" },
  ],
  blocking_issues: [
    { key: "totalBlocked", priority: "required", description: "Blocked item count" },
    { key: "blockingIssues", priority: "high", description: "Blocking issue list" },
    { key: "recommendation", priority: "medium", description: "Suggested next action" },
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
