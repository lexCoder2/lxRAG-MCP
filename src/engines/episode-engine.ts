import type MemgraphClient from "../graph/client.js";

export type EpisodeType =
  | "OBSERVATION"
  | "DECISION"
  | "EDIT"
  | "TEST_RESULT"
  | "ERROR"
  | "REFLECTION"
  | "LEARNING";

export interface EpisodeInput {
  agentId: string;
  sessionId: string;
  taskId?: string;
  type: EpisodeType;
  content: string;
  entities?: string[];
  outcome?: "success" | "failure" | "partial";
  metadata?: Record<string, unknown>;
  sensitive?: boolean;
}

export interface Episode extends EpisodeInput {
  id: string;
  timestamp: number;
  projectId: string;
  relevance?: number;
}

export interface RecallQuery {
  query: string;
  projectId: string;
  agentId?: string;
  taskId?: string;
  types?: EpisodeType[];
  entities?: string[];
  limit?: number;
  since?: number;
}

export interface ReflectionResult {
  reflectionId: string;
  insight: string;
  learningsCreated: number;
  patterns: Array<{ file: string; count: number }>;
}

export default class EpisodeEngine {
  constructor(private memgraph: MemgraphClient) {}

  async add(input: EpisodeInput, projectId: string): Promise<string> {
    const id = this.makeId("ep");
    const timestamp = Date.now();
    const entities = (input.entities || []).slice(0, 100);

    await this.memgraph.executeCypher(
      `CREATE (e:EPISODE {
        id: $id,
        agentId: $agentId,
        sessionId: $sessionId,
        taskId: $taskId,
        type: $type,
        content: $content,
        timestamp: $timestamp,
        outcome: $outcome,
        metadata: $metadata,
        sensitive: $sensitive,
        entities: $entities,
        projectId: $projectId
      })`,
      {
        id,
        agentId: input.agentId,
        sessionId: input.sessionId,
        taskId: input.taskId || null,
        type: input.type,
        content: input.content,
        timestamp,
        outcome: input.outcome || null,
        metadata: JSON.stringify(input.metadata || {}),
        sensitive: Boolean(input.sensitive),
        entities,
        projectId,
      },
    );

    for (const entity of entities) {
      await this.memgraph.executeCypher(
        `MATCH (e:EPISODE {id: $episodeId, projectId: $projectId})
         MATCH (n {id: $entityId, projectId: $projectId})
         MERGE (e)-[:INVOLVES]->(n)`,
        {
          episodeId: id,
          entityId: entity,
          projectId,
        },
      );
    }

    await this.linkToPreviousEpisode(
      id,
      input.agentId,
      input.sessionId,
      projectId,
    );
    return id;
  }

  async recall(query: RecallQuery): Promise<Episode[]> {
    const conditions = [
      "e.projectId = $projectId",
      "(e.sensitive IS NULL OR e.sensitive = false)",
    ];
    const params: Record<string, unknown> = {
      projectId: query.projectId,
      limit: Math.max(1, Math.min(query.limit || 5, 50)),
    };

    if (query.agentId) {
      conditions.push("e.agentId = $agentId");
      params.agentId = query.agentId;
    }
    if (query.taskId) {
      conditions.push("e.taskId = $taskId");
      params.taskId = query.taskId;
    }
    if (query.types?.length) {
      conditions.push("e.type IN $types");
      params.types = query.types;
    }
    if (query.since) {
      conditions.push("e.timestamp >= $since");
      params.since = query.since;
    }

    const result = await this.memgraph.executeCypher(
      `MATCH (e:EPISODE)
       WHERE ${conditions.join(" AND ")}
       RETURN e
       ORDER BY e.timestamp DESC
       LIMIT 200`,
      params,
    );

    const episodes = result.data
      .map((row) => this.rowToEpisode(row, query.projectId))
      .filter((item): item is Episode => Boolean(item));

    const queryTerms = this.tokenize(query.query);
    const queryEntities = new Set(query.entities || []);
    const now = Date.now();

    const scored = episodes.map((episode) => {
      const contentTerms = this.tokenize(episode.content);
      const lexicalScore = this.jaccard(queryTerms, contentTerms);

      const ageDays = Math.max(0, (now - episode.timestamp) / 86400000);
      const temporalScore = Math.exp(-0.05 * ageDays);

      const episodeEntities = new Set(episode.entities || []);
      const graphScore =
        queryEntities.size > 0
          ? this.jaccard(queryEntities, episodeEntities)
          : 0;

      const relevance =
        0.5 * lexicalScore + 0.3 * temporalScore + 0.2 * graphScore;

      return { ...episode, relevance: Number(relevance.toFixed(4)) };
    });

    return scored
      .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
      .slice(0, params.limit as number);
  }

  async decisionQuery(query: Omit<RecallQuery, "types">): Promise<Episode[]> {
    return this.recall({ ...query, types: ["DECISION"] });
  }

  async reflect(opts: {
    taskId?: string;
    agentId?: string;
    limit?: number;
    projectId: string;
  }): Promise<ReflectionResult> {
    const episodes = await this.recall({
      query: opts.taskId || opts.agentId || "recent work",
      projectId: opts.projectId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      limit: opts.limit || 20,
    });

    const frequency = new Map<string, number>();
    for (const episode of episodes) {
      for (const entity of episode.entities || []) {
        frequency.set(entity, (frequency.get(entity) || 0) + 1);
      }
    }

    const patterns = [...frequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => ({ file, count }));

    const insight = patterns.length
      ? `Reflection over ${episodes.length} episodes: recurring focus on ${patterns
          .slice(0, 3)
          .map((item) => item.file)
          .join(", ")}.`
      : `Reflection over ${episodes.length} episodes: no dominant recurring entities detected.`;

    const reflectionId = await this.add(
      {
        agentId: opts.agentId || "system",
        sessionId: `reflect-${Date.now()}`,
        taskId: opts.taskId,
        type: "REFLECTION",
        content: insight,
        entities: patterns.map((p) => p.file),
        outcome: "partial",
        metadata: { sourceCount: episodes.length, patterns },
      },
      opts.projectId,
    );

    let learningsCreated = 0;
    for (const pattern of patterns.slice(0, 3)) {
      const learningId = this.makeId("learn");
      const learningText = `Repeated activity around ${pattern.file} (${pattern.count} related episodes).`;

      await this.memgraph.executeCypher(
        `CREATE (l:LEARNING {
          id: $id,
          content: $content,
          extractedAt: $timestamp,
          confidence: $confidence,
          projectId: $projectId,
          reflectionId: $reflectionId
        })`,
        {
          id: learningId,
          content: learningText,
          timestamp: Date.now(),
          confidence: Math.min(1, 0.5 + pattern.count / 10),
          projectId: opts.projectId,
          reflectionId,
        },
      );

      await this.memgraph.executeCypher(
        `MATCH (l:LEARNING {id: $learningId, projectId: $projectId})
         MATCH (n {id: $entityId, projectId: $projectId})
         MERGE (l)-[:APPLIES_TO]->(n)`,
        {
          learningId,
          entityId: pattern.file,
          projectId: opts.projectId,
        },
      );

      learningsCreated += 1;
    }

    return {
      reflectionId,
      insight,
      learningsCreated,
      patterns,
    };
  }

  private async linkToPreviousEpisode(
    episodeId: string,
    agentId: string,
    sessionId: string,
    projectId: string,
  ): Promise<void> {
    const prev = await this.memgraph.executeCypher(
      `MATCH (e:EPISODE)
       WHERE e.projectId = $projectId
         AND e.agentId = $agentId
         AND e.sessionId = $sessionId
         AND e.id <> $episodeId
       RETURN e.id AS id
       ORDER BY e.timestamp DESC
       LIMIT 1`,
      { projectId, agentId, sessionId, episodeId },
    );

    const prevId = prev.data?.[0]?.id;
    if (!prevId) {
      return;
    }

    await this.memgraph.executeCypher(
      `MATCH (prev:EPISODE {id: $prevId, projectId: $projectId})
       MATCH (curr:EPISODE {id: $episodeId, projectId: $projectId})
       MERGE (prev)-[:NEXT_EPISODE]->(curr)`,
      { prevId, episodeId, projectId },
    );
  }

  private rowToEpisode(
    row: Record<string, any>,
    projectId: string,
  ): Episode | null {
    const rawNode = row.e || row.episode || row;
    const node =
      rawNode && typeof rawNode === "object" && rawNode.properties
        ? rawNode.properties
        : rawNode;
    if (!node || typeof node !== "object") {
      return null;
    }

    return {
      id: String(node.id),
      agentId: String(node.agentId || "unknown"),
      sessionId: String(node.sessionId || "unknown"),
      taskId: node.taskId ? String(node.taskId) : undefined,
      type: (node.type || "OBSERVATION") as EpisodeType,
      content: String(node.content || ""),
      entities: Array.isArray(node.entities)
        ? node.entities.map((item: unknown) => String(item))
        : [],
      outcome: node.outcome || undefined,
      metadata: this.tryParseJson(node.metadata),
      sensitive: Boolean(node.sensitive),
      timestamp: Number(node.timestamp || Date.now()),
      projectId,
    };
  }

  private tryParseJson(input: unknown): Record<string, unknown> | undefined {
    if (!input || typeof input !== "string") {
      return undefined;
    }

    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((token) => token.length > 1),
    );
  }

  private jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 && right.size === 0) {
      return 1;
    }
    if (left.size === 0 || right.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const item of left) {
      if (right.has(item)) {
        intersection += 1;
      }
    }
    const union = left.size + right.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private makeId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
