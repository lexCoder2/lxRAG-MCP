import type MemgraphClient from "../graph/client.js";

interface CommunityMember {
  id: string;
  filePath: string;
  name: string;
  type: string;
}

export default class CommunityDetector {
  constructor(private memgraph: MemgraphClient) {}

  async run(
    projectId: string,
  ): Promise<{ communities: number; members: number }> {
    const result = await this.memgraph.executeCypher(
      `MATCH (n)
       WHERE n.projectId = $projectId
         AND (n:FILE OR n:FUNCTION OR n:CLASS)
       RETURN n.id AS id,
              labels(n)[0] AS type,
              coalesce(n.path, n.filePath, '') AS filePath,
              coalesce(n.name, n.id) AS name`,
      { projectId },
    );

    const rows = result.data || [];
    const members = rows
      .map((row) => ({
        id: String(row.id || ""),
        filePath: String(row.filePath || ""),
        name: String(row.name || row.id || ""),
        type: String(row.type || "UNKNOWN"),
      }))
      .filter((row) => row.id.length > 0);

    if (!members.length) {
      return { communities: 0, members: 0 };
    }

    const grouped = new Map<string, CommunityMember[]>();
    for (const member of members) {
      const label = this.communityLabel(member.filePath);
      if (!grouped.has(label)) {
        grouped.set(label, []);
      }
      grouped.get(label)!.push(member);
    }

    let communityIndex = 0;
    for (const [label, group] of grouped.entries()) {
      const communityId = `${projectId}::community::${communityIndex}`;
      const summary = this.buildSummary(label, group);
      const centralNode = this.centralNode(group);

      await this.memgraph.executeCypher(
        `MERGE (c:COMMUNITY {id: $id, projectId: $projectId})
         SET c.label = $label,
             c.summary = $summary,
             c.memberCount = $memberCount,
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
          {
            nodeId: member.id,
            projectId,
            communityId,
          },
        );
      }

      communityIndex += 1;
    }

    return {
      communities: grouped.size,
      members: members.length,
    };
  }

  private communityLabel(filePath: string): string {
    const segments = filePath.split("/").filter(Boolean);
    const ignored = new Set(["src", "lib", "dist", "build", "node_modules"]);
    const segment = segments.find((item) => !ignored.has(item));
    return segment || "misc";
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
