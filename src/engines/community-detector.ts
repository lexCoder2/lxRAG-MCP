/**
 * @file engines/community-detector
 * @description Builds code communities from graph relationships for higher-level context retrieval.
 * @remarks Persists detected communities in Memgraph for query-time use.
 */

import type MemgraphClient from "../graph/client.js";

interface CommunityMember {
  id: string;
  filePath: string;
  name: string;
  type: string;
  communityId?: number;
}

type DetectionMode = "mage_leiden" | "directory_heuristic";

export interface CommunityRunResult {
  communities: number;
  members: number;
  mode: DetectionMode;
}

export default class CommunityDetector {
  constructor(private memgraph: MemgraphClient) {}

  async run(projectId: string): Promise<CommunityRunResult> {
    // --- Fetch member nodes -------------------------------------------
    const nodeResult = await this.memgraph.executeCypher(
      `MATCH (n)
       WHERE n.projectId = $projectId
         AND (n:FILE OR n:FUNCTION OR n:CLASS)
       OPTIONAL MATCH (parentFile:FILE)-[:CONTAINS]->(n)
       RETURN n.id AS id,
              labels(n)[0] AS type,
              coalesce(n.path, n.filePath, parentFile.path, '') AS filePath,
              coalesce(n.name, n.id) AS name`,
      { projectId },
    );

    const members: CommunityMember[] = (nodeResult.data || [])
      .map((row) => ({
        id: String(row.id || ""),
        filePath: String(row.filePath || ""),
        name: String(row.name || row.id || ""),
        type: String(row.type || "UNKNOWN"),
      }))
      .filter((row) => row.id.length > 0);

    if (!members.length) {
      return { communities: 0, members: 0, mode: "directory_heuristic" };
    }

    // --- Try MAGE Leiden community_detection.get() --------------------
    const mageResult = await this.tryMageCommunityDetection(projectId, members);
    if (mageResult) {
      return mageResult;
    }

    // --- Fallback: directory-grouping heuristic -----------------------
    return this.runDirectoryHeuristic(projectId, members);
  }

  /**
   * Attempt native MAGE Leiden algorithm.
   * Returns null if MAGE is not available or the query fails.
   */
  private async tryMageCommunityDetection(
    projectId: string,
    members: CommunityMember[],
  ): Promise<CommunityRunResult | null> {
    try {
      // community_detection.get() runs on the full in-memory graph.
      // We filter to only the nodes belonging to this project.
      const response = await this.memgraph.executeCypher(
        `CALL community_detection.get()
         YIELD node, community_id
         WHERE node.projectId = $projectId
           AND (node:FILE OR node:FUNCTION OR node:CLASS)
         RETURN toString(node.id) AS nodeId, toInteger(community_id) AS cid`,
        { projectId },
      );

      if (
        response.error ||
        !Array.isArray(response.data) ||
        response.data.length === 0
      ) {
        return null;
      }

      // Build nodeId → community_id map
      const communityMap = new Map<string, number>();
      for (const row of response.data) {
        const nodeId = String(row.nodeId || "");
        const cid = Number(row.cid ?? -1);
        if (nodeId && cid >= 0) {
          communityMap.set(nodeId, cid);
        }
      }

      if (communityMap.size === 0) return null;

      // Group members by Leiden community id
      const grouped = new Map<number, CommunityMember[]>();
      for (const member of members) {
        const cid = communityMap.get(member.id);
        if (cid === undefined) continue;
        if (!grouped.has(cid)) grouped.set(cid, []);
        grouped.get(cid)!.push({ ...member, communityId: cid });
      }

      await this.writeCommunities(projectId, grouped, "leiden");
      console.error(
        `[community] MAGE Leiden: ${grouped.size} communities across ${communityMap.size} member node(s) for project ${projectId}`,
      );
      return {
        communities: grouped.size,
        members: communityMap.size,
        mode: "mage_leiden",
      };
    } catch {
      // MAGE module not installed or unsupported Memgraph edition — fall through
      return null;
    }
  }

  /**
   * Directory-grouping heuristic (always-available fallback).
   */
  private async runDirectoryHeuristic(
    projectId: string,
    members: CommunityMember[],
  ): Promise<CommunityRunResult> {
    const grouped = new Map<string, CommunityMember[]>();
    for (const member of members) {
      const label = this.communityLabel(member.filePath);
      if (!grouped.has(label)) grouped.set(label, []);
      grouped.get(label)!.push(member);
    }

    // Convert string labels to numeric-keyed map for writeCommunities
    const numericGrouped = new Map<number, CommunityMember[]>();
    let idx = 0;
    for (const [, group] of grouped.entries()) {
      numericGrouped.set(idx, group);
      idx += 1;
    }

    await this.writeCommunities(projectId, numericGrouped, "dir");
    console.error(
      `[community] directory heuristic: ${grouped.size} communities across ${members.length} member node(s) for project ${projectId}`,
    );
    return {
      communities: grouped.size,
      members: members.length,
      mode: "directory_heuristic",
    };
  }

  /**
   * Write COMMUNITY nodes and BELONGS_TO edges for a set of computed groups.
   */
  private async writeCommunities(
    projectId: string,
    grouped: Map<number, CommunityMember[]>,
    prefix: string,
  ): Promise<void> {
    let idx = 0;
    for (const [cid, group] of grouped.entries()) {
      const communityId = `${projectId}::community::${prefix}::${cid}`;
      const label = this.labelForGroup(group);
      const summary = this.buildSummary(label, group);
      const centralNode = this.centralNode(group);

      await this.memgraph.executeCypher(
        `MERGE (c:COMMUNITY {id: $id, projectId: $projectId})
         SET c.label = $label,
             c.summary = $summary,
             c.memberCount = $memberCount,
             c.size = $memberCount,
             c.centralNode = $centralNode,
             c.computedAt = $computedAt`,
        {
          id: communityId,
          projectId,
          label,
          summary,
          memberCount: group.length,
          centralNode,
          computedAt: Date.now(),
        },
      );

      for (const member of group) {
        await this.memgraph.executeCypher(
          `MATCH (n {id: $nodeId, projectId: $projectId})
           MATCH (c:COMMUNITY {id: $communityId, projectId: $projectId})
           SET n.communityId = $communityId
           MERGE (n)-[:BELONGS_TO]->(c)`,
          { nodeId: member.id, projectId, communityId },
        );
      }

      idx += 1;
    }
  }

  private labelForGroup(group: CommunityMember[]): string {
    // For Leiden groups, infer a label from the most common path prefix
    const prefixes = group.map((m) => this.communityLabel(m.filePath));
    const freq = new Map<string, number>();
    for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "misc";
  }

  private communityLabel(filePath: string): string {
    const segments = filePath.split("/").filter(Boolean);
    // Look for a well-known source-root marker and return the directory that follows it.
    // This correctly handles absolute paths like /home/user/project/src/engines/foo.ts
    // by returning "engines" instead of "home".
    const sourceRoots = new Set([
      "src",
      "lib",
      "app",
      "pages",
      "packages",
      "components",
      "services",
    ]);
    const rootIdx = segments.findIndex((s) => sourceRoots.has(s));
    if (rootIdx >= 0 && rootIdx + 1 < segments.length) {
      const next = segments[rootIdx + 1];
      // If next segment is a filename (has extension), use the root marker itself
      return next.includes(".") ? segments[rootIdx] : next;
    }
    // Fallback: use the last non-trivial directory segment before the filename
    const dirSegments = segments.slice(0, -1);
    const trivial = new Set(["home", "root", "usr", "var", "tmp", "opt"]);
    return dirSegments.filter((s) => !trivial.has(s)).pop() || "misc";
  }

  private centralNode(group: CommunityMember[]): string {
    const withFunctionBias = group.find((item) => item.type === "FUNCTION");
    return withFunctionBias?.id || group[0]?.id || "";
  }

  private buildSummary(label: string, members: CommunityMember[]): string {
    const types = new Map<string, number>();
    for (const member of members) {
      types.set(member.type, (types.get(member.type) || 0) + 1);
    }
    const profile = [...types.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${count} ${type.toLowerCase()} node(s)`)
      .slice(0, 3)
      .join(", ");
    return `Community '${label}' groups ${members.length} code node(s): ${profile}.`;
  }
}
