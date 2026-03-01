/**
 * TemporalQueryBuilder
 * Single responsibility: build and rewrite temporal Cypher predicates, and
 * resolve "since" anchor strings to epoch-millisecond timestamps.
 * Extracted from ToolHandlerBase (SRP / SOLID refactor).
 */
import type MemgraphClient from "../graph/client.js";
import { toEpochMillis, toSafeNumber } from "../utils/conversions";

export class TemporalQueryBuilder {
  buildTemporalPredicateForVars(variables: string[]): string {
    const unique = [...new Set(variables.filter(Boolean))];
    return unique
      .map(
        (name) =>
          `(${name}.validFrom <= $asOfTs AND (${name}.validTo IS NULL OR ${name}.validTo > $asOfTs))`,
      )
      .join(" AND ");
  }

  extractMatchVariables(segment: string): string[] {
    const vars: string[] = [];
    const regex = /\(([A-Za-z_][A-Za-z0-9_]*)\s*(?::|\)|\{)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(segment)) !== null) {
      vars.push(match[1]);
    }
    return vars;
  }

  applyTemporalFilterToCypher(query: string): string {
    const matchSegmentRegex =
      /((?:OPTIONAL\s+MATCH|MATCH)\b[\s\S]*?)(?=\n\s*(?:OPTIONAL\s+MATCH|MATCH|WITH|RETURN|UNWIND|CALL|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|ORDER\s+BY|LIMIT|SKIP|UNION)\b|$)/gi;

    let touched = false;
    const rewritten = query.replace(matchSegmentRegex, (segment) => {
      const vars = this.extractMatchVariables(segment);
      if (!vars.length) return segment;

      const predicate = this.buildTemporalPredicateForVars(vars);
      if (!predicate) return segment;

      touched = true;
      const inlineClauseRegex =
        /\b(?:WITH|RETURN|UNWIND|CALL|CREATE|MERGE|SET|DELETE|REMOVE|FOREACH|ORDER\s+BY|LIMIT|SKIP|UNION)\b/i;
      const boundaryIndex = segment.search(inlineClauseRegex);
      const whereMatch = /\bWHERE\b/i.exec(segment);

      if (whereMatch) {
        if (boundaryIndex > whereMatch.index) {
          const head = segment.slice(0, boundaryIndex).trimEnd();
          const tail = segment.slice(boundaryIndex).trimStart();
          return `${head} AND ${predicate}\n${tail}`;
        }
        return `${segment} AND ${predicate}`;
      }

      if (boundaryIndex > 0) {
        const head = segment.slice(0, boundaryIndex).trimEnd();
        const tail = segment.slice(boundaryIndex).trimStart();
        return `${head} WHERE ${predicate}\n${tail}`;
      }

      return `${segment}\nWHERE ${predicate}`;
    });

    return touched ? rewritten : query;
  }

  async resolveSinceAnchor(
    since: string,
    projectId: string,
    memgraph: MemgraphClient,
  ): Promise<{
    sinceTs: number;
    mode: "txId" | "timestamp" | "gitCommit" | "agentId";
    anchorValue: string;
  } | null> {
    const trimmed = since.trim();
    if (!trimmed) return null;

    const txIdPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (txIdPattern.test(trimmed) || trimmed.startsWith("tx-")) {
      const txLookup = await memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId, id: $id}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
        { projectId, id: trimmed },
      );
      const ts = toSafeNumber(txLookup.data?.[0]?.timestamp);
      if (ts !== null) return { sinceTs: ts, mode: "txId", anchorValue: trimmed };
      return null;
    }

    const timestamp = toEpochMillis(trimmed);
    if (timestamp !== null) return { sinceTs: timestamp, mode: "timestamp", anchorValue: trimmed };

    if (/^[a-f0-9]{7,40}$/i.test(trimmed)) {
      const commitLookup = await memgraph.executeCypher(
        "MATCH (tx:GRAPH_TX {projectId: $projectId, gitCommit: $gitCommit}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
        { projectId, gitCommit: trimmed },
      );
      const ts = toSafeNumber(commitLookup.data?.[0]?.timestamp);
      if (ts !== null) return { sinceTs: ts, mode: "gitCommit", anchorValue: trimmed };
      return null;
    }

    const agentLookup = await memgraph.executeCypher(
      "MATCH (tx:GRAPH_TX {projectId: $projectId, agentId: $agentId}) RETURN tx.timestamp AS timestamp ORDER BY tx.timestamp DESC LIMIT 1",
      { projectId, agentId: trimmed },
    );
    const agentTs = toSafeNumber(agentLookup.data?.[0]?.timestamp);
    if (agentTs !== null) return { sinceTs: agentTs, mode: "agentId", anchorValue: trimmed };

    return null;
  }
}
